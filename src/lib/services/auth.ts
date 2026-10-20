/**
 * Email + password accounts.
 *
 * Passwords: scrypt (memory-hard, in Node's standard library) with a random
 * 16-byte salt per user, compared in constant time. The plain password is never
 * stored or logged.
 *
 * Each user owns one wallet workspace. Signing in rotates that workspace's
 * session token, so a stolen old cookie stops working the moment the student
 * signs in again; signing out rotates it to a value nobody holds.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sessions, users } from '../db/schema';
import { hashSecret } from '../policy/terms';
import type { Currency } from '../domain/money';
import { appendAudit, appendAuditSafely } from './audit';
import { AppError } from './errors';
import { openStudentAccount } from './wallet';

type Db = NodePgDatabase<Record<string, never>>;
const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const N = 16384, R = 8, P = 1, LEN = 32;
export const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function checkPassword(pw: string) {
  if (pw.length < 8) throw new AppError('VALIDATION_FAILED', 'password must be at least 8 characters', { password: 'at least 8 characters' });
  if (pw.length > 200) throw new AppError('VALIDATION_FAILED', 'password is too long');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    throw new AppError('VALIDATION_FAILED', 'use letters and at least one number', { password: 'letters and a number' });
  }
}

const normEmail = (e: string) => e.trim().toLowerCase();

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
  homeCurrency: Currency;
  studyCurrency: Currency;
  homeBalance: string;
  studyBalance: string;
}

export async function signUp(db: Db, input: SignUpInput): Promise<{ token: string; userId: string }> {
  const email = normEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('VALIDATION_FAILED', 'enter a valid email', { email: 'invalid email' });
  checkPassword(input.password);
  const taken = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  // Same message whether the address exists or not would leak less, but a
  // sign-up form must say "already registered" to be usable; sign-in does not leak.
  if (taken[0]) throw new AppError('VALIDATION_FAILED', 'that email is already registered — sign in instead', { email: 'already registered' });

  const passwordHash = await hashPassword(input.password);
  const opened = await openStudentAccount(db, {
    name: input.name, homeCurrency: input.homeCurrency, studyCurrency: input.studyCurrency,
    homeBalance: input.homeBalance, studyBalance: input.studyBalance,
  });
  await db.update(sessions).set({ expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) }).where(eq(sessions.id, opened.sessionId));
  const rows = await db.insert(users).values({
    email, passwordHash, name: input.name.trim().slice(0, 40), sessionId: opened.sessionId, lastLoginAt: new Date(),
  }).returning();
  await appendAudit(db, {
    sessionId: opened.sessionId, correlationId: rows[0]!.id, type: 'user.signed_up', actor: 'user', outcome: 'allowed', payload: { userId: rows[0]!.id },
  });
  return { token: opened.token, userId: rows[0]!.id };
}

/** Rotates the workspace token and returns the new one. Same error for unknown email and wrong password. */
export async function signIn(db: Db, email: string, password: string): Promise<{ token: string; name: string }> {
  const u = (await db.select().from(users).where(sql`lower(${users.email}) = ${normEmail(email)}`))[0];
  // Verify against a dummy hash when the user does not exist, so timing does
  // not reveal which emails are registered.
  const ok = await verifyPassword(password, u?.passwordHash ?? DUMMY);
  if (!u || !ok) {
    if (u) {
      await appendAuditSafely(db, {
        sessionId: u.sessionId, correlationId: u.id, type: 'user.signin_failed', actor: 'user', outcome: 'denied', payload: {},
      });
    }
    throw new AppError('NO_SESSION', 'email or password is incorrect');
  }
  const token = randomBytes(32).toString('base64url');
  await db.update(sessions)
    .set({ tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) })
    .where(eq(sessions.id, u.sessionId));
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
  await appendAudit(db, {
    sessionId: u.sessionId, correlationId: u.id, type: 'user.signed_in', actor: 'user', outcome: 'allowed', payload: {},
  });
  return { token, name: u.name };
}

/** Invalidates the current token by rotating it to one nobody holds. */
export async function signOut(db: Db, sessionId: string): Promise<void> {
  await db.update(sessions).set({ tokenHash: hashSecret(randomBytes(32).toString('base64url')) }).where(eq(sessions.id, sessionId));
}

export async function userForSession(db: Db, sessionId: string) {
  const u = (await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.sessionId, sessionId)))[0];
  return u ?? null;
}

// A fixed, valid hash of a random value, used to keep sign-in timing uniform.
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
