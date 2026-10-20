import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { hashPassword, signIn, signOut, signUp, verifyPassword } from '@/lib/services/auth';
import { resolveSession } from '@/lib/services/workspace';

const pool: pg.Pool = testPool(4);
const db = dbFor(pool);
const base = { email: 'Ali@Example.com', password: 'tuition2026', name: 'Ali', homeCurrency: 'PKR' as const, studyCurrency: 'CNY' as const, homeBalance: '900000', studyBalance: '3200.00' };

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('accounts', () => {
  it('stores a salted scrypt hash, never the password', async () => {
    const h1 = await hashPassword('tuition2026');
    const h2 = await hashPassword('tuition2026');
    expect(h1).not.toBe(h2);
    expect(h1).not.toContain('tuition2026');
    expect(await verifyPassword('tuition2026', h1)).toBe(true);
    expect(await verifyPassword('tuition2027', h1)).toBe(false);
    await signUp(db, base);
    const { rows } = await pool.query('SELECT password_hash FROM users');
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
  });

  it('signs in to the same wallet, case-insensitive email, and rotates the old token', async () => {
    const first = await signUp(db, base);
    const s1 = await resolveSession(db, first.token);
    const again = await signIn(db, 'ali@example.COM', 'tuition2026');
    const s2 = await resolveSession(db, again.token);
    expect(s2.id).toBe(s1.id);
    await expect(resolveSession(db, first.token)).rejects.toThrow();
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    await signUp(db, base);
    const a = await signIn(db, 'nobody@example.com', 'whatever1').catch((e) => e.message);
    const b = await signIn(db, 'ali@example.com', 'wrongpass1').catch((e) => e.message);
    expect(a).toBe(b);
  });

  it('refuses weak passwords and duplicate emails', async () => {
    await expect(signUp(db, { ...base, password: 'short1' })).rejects.toThrow(/8 characters/);
    await expect(signUp(db, { ...base, password: 'onlyletters' })).rejects.toThrow(/number/);
    await signUp(db, base);
    await expect(signUp(db, { ...base, email: 'ALI@example.com' })).rejects.toThrow(/already registered/);
  });

  it('signing out kills the token', async () => {
    const u = await signUp(db, base);
    const s = await resolveSession(db, u.token);
    await signOut(db, s.id);
    await expect(resolveSession(db, u.token)).rejects.toThrow();
  });
});
