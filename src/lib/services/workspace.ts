/**
 * Synthetic workspaces. Each judge gets their own isolated seeded session; there
 * is no shared mutable global student and no admin account.
 *
 * The session id is resolved SERVER-SIDE from a cryptographically random cookie.
 * It is never read from a request body, a query parameter, or a model tool
 * argument. Every query in the application filters by it.
 *
 * This is capability-based isolation for a demo. It is not verified personal
 * identity, MFA or KYC, and the security report says so.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accounts,
  beneficiaries,
  cashFlowEvents,
  inboundRemittances,
  obligations,
  sessions,
} from '../db/schema';
import { hashSecret } from '../policy/terms';
import { parseAmount } from '../domain/money';
import { DAY_MS } from '../domain/clock';
import {
  BALANCE_DEADLINE,
  GLOBAL_BENEFICIARY,
  GLOBAL_NOW,
  GLOBAL_SCENARIO,
  GLOBAL_VERSION,
  GOLDEN_SCENARIO,
  TIGHT_SCENARIO,
  DEPOSIT_DEADLINE,
  SCENARIO_NOW,
  SCENARIO_VERSION,
  SYNTHETIC_BENEFICIARY,
  TUITION_DEADLINE,
  TUITION_DEADLINE_TIMEZONE,
  type ScenarioFixture,
} from '../domain/fixtures';
import { AppError } from './errors';

type Db = NodePgDatabase<Record<string, never>>;

export const SESSION_COOKIE = 'bw_session';
const RETENTION_HOURS = Number(process.env.DEMO_RETENTION_HOURS ?? 24);

export interface CreatedWorkspace {
  readonly sessionId: string;
  /** Returned ONCE, to be set as an HttpOnly cookie. Never stored in plain form. */
  readonly token: string;
  /** The first/primary obligation the UI opens on. */
  readonly obligationId: string;
  readonly sourceAccountId: string;
  readonly beneficiaryId: string;
  /** Scenario kind that was seeded. */
  readonly kind: 'golden' | 'global';
  /** All obligation ids in the workspace (global has two). */
  readonly obligationIds: readonly string[];
}

export type ScenarioKind = 'golden' | 'tight' | 'global';

/**
 * Seeds a fresh synthetic workspace from a fixture. Idempotent only in the sense
 * that each call creates a NEW isolated scenario: it never mutates an existing one.
 */
export async function createWorkspace(
  db: Db,
  options: { kind?: ScenarioKind; scenario?: ScenarioFixture; useScenarioClock?: boolean } = {},
): Promise<CreatedWorkspace> {
  const kind: ScenarioKind = options.kind ?? 'golden';
  if (kind === 'global') return createGlobalWorkspace(db);
  const scenario = options.scenario ?? (kind === 'tight' ? TIGHT_SCENARIO : GOLDEN_SCENARIO);
  const useScenarioClock = options.useScenarioClock ?? true;
  const token = randomBytes(32).toString('base64url');

  const sessionRows = await db
    .insert(sessions)
    .values({
      tokenHash: hashSecret(token),
      scenarioVersion: SCENARIO_VERSION,
      clockKind: useScenarioClock ? 'scenario' : 'real',
      scenarioNow: useScenarioClock ? SCENARIO_NOW : null,
      expiresAt: new Date(Date.now() + RETENTION_HOURS * 60 * 60 * 1000),
    })
    .returning();
  const session = sessionRows[0]!;

  const accountRows = await db
    .insert(accounts)
    .values([
      {
        sessionId: session.id,
        label: 'Everyday account',
        currency: 'GBP',
        balanceMinor: parseAmount(scenario.gbpBalance, 'GBP'),
      },
      {
        sessionId: session.id,
        label: 'Travel account',
        currency: 'USD',
        balanceMinor: parseAmount(scenario.usdBalance, 'USD'),
      },
    ])
    .returning();
  const gbpAccount = accountRows.find((a) => a.currency === 'GBP')!;

  const beneficiaryRows = await db
    .insert(beneficiaries)
    .values({
      sessionId: session.id,
      displayName: SYNTHETIC_BENEFICIARY.displayName,
      reference: SYNTHETIC_BENEFICIARY.reference,
      currency: SYNTHETIC_BENEFICIARY.currency,
    })
    .returning();
  const beneficiary = beneficiaryRows[0]!;

  const obligationRows = await db
    .insert(obligations)
    .values({
      sessionId: session.id,
      beneficiaryId: beneficiary.id,
      description: 'Autumn term tuition',
      targetMinor: parseAmount(scenario.tuitionTarget, 'USD'),
      currency: 'USD',
      deadlineAt: TUITION_DEADLINE,
      deadlineTimezone: TUITION_DEADLINE_TIMEZONE,
      reserveMinor: parseAmount(scenario.emergencyReserve, 'GBP'),
      reserveCurrency: 'GBP',
      // The fixture's obligation is already confirmed. An obligation typed in by
      // hand is NOT confirmed until the user confirms its consequential fields.
      confirmedAt: new Date(),
    })
    .returning();
  const obligation = obligationRows[0]!;

  await db.insert(cashFlowEvents).values({
    sessionId: session.id,
    label: 'Rent',
    currency: 'GBP',
    direction: 'outflow',
    amountMinor: parseAmount(scenario.committedRent, 'GBP'),
    occursAt: scenario.rentDueAt,
    certain: true,
  });

  return {
    sessionId: session.id,
    token,
    obligationId: obligation.id,
    sourceAccountId: gbpAccount.id,
    beneficiaryId: beneficiary.id,
    kind: 'golden',
    obligationIds: [obligation.id],
  };
}

/**
 * Seeds the global PKR-funded persona: a zero-decimal home currency, a deposit
 * due before the family remittance arrives, and a later tuition balance.
 */
async function createGlobalWorkspace(db: Db): Promise<CreatedWorkspace> {
  const g = GLOBAL_SCENARIO;
  const token = randomBytes(32).toString('base64url');

  const sessionRows = await db
    .insert(sessions)
    .values({
      tokenHash: hashSecret(token),
      scenarioVersion: GLOBAL_VERSION,
      clockKind: 'scenario',
      scenarioNow: GLOBAL_NOW,
      expiresAt: new Date(Date.now() + RETENTION_HOURS * 60 * 60 * 1000),
    })
    .returning();
  const session = sessionRows[0]!;

  // One PKR funding account. No USD float: every dollar must be converted.
  const accountRows = await db
    .insert(accounts)
    .values({
      sessionId: session.id,
      label: 'Everyday account (PKR)',
      currency: 'PKR',
      balanceMinor: parseAmount(g.pkrBalance, 'PKR'),
    })
    .returning();
  const pkrAccount = accountRows[0]!;

  const beneficiaryRows = await db
    .insert(beneficiaries)
    .values({
      sessionId: session.id,
      displayName: GLOBAL_BENEFICIARY.displayName,
      reference: GLOBAL_BENEFICIARY.reference,
      currency: GLOBAL_BENEFICIARY.currency,
    })
    .returning();
  const beneficiary = beneficiaryRows[0]!;

  const makeObligation = async (description: string, target: string, deadlineAt: Date) =>
    (
      await db
        .insert(obligations)
        .values({
          sessionId: session.id,
          beneficiaryId: beneficiary.id,
          description,
          targetMinor: parseAmount(target, 'USD'),
          currency: 'USD',
          deadlineAt,
          deadlineTimezone: 'America/New_York',
          reserveMinor: parseAmount(g.emergencyReserve, 'PKR'),
          reserveCurrency: 'PKR',
          confirmedAt: new Date(),
        })
        .returning()
    )[0]!;

  const deposit = await makeObligation('Enrolment deposit', g.depositTarget, DEPOSIT_DEADLINE);
  const balance = await makeObligation('Tuition balance', g.balanceTarget, BALANCE_DEADLINE);

  // The family remittance is recorded but is NOT spendable until released.
  await db.insert(inboundRemittances).values({
    sessionId: session.id,
    accountId: pkrAccount.id,
    label: g.remittance.label,
    senderLabel: g.remittance.senderLabel,
    currency: 'PKR',
    amountMinor: parseAmount(g.remittance.amount, 'PKR'),
    status: g.remittance.status,
    expectedAvailableAt: g.remittance.expectedAvailableAt,
  });

  return {
    sessionId: session.id,
    token,
    obligationId: deposit.id,
    sourceAccountId: pkrAccount.id,
    beneficiaryId: beneficiary.id,
    kind: 'global',
    obligationIds: [deposit.id, balance.id],
  };
}

export interface ResolvedSession {
  readonly id: string;
  readonly clockKind: 'real' | 'scenario';
  readonly scenarioNow: Date | null;
  readonly scenarioVersion: string;
}

/** Resolves a cookie token to a session, or throws. Expired sessions are refused. */
export async function resolveSession(db: Db, token: string | undefined): Promise<ResolvedSession> {
  if (!token) throw new AppError('NO_SESSION', 'no session');
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hashSecret(token)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError('NO_SESSION', 'no session');
  if (row.expiresAt.getTime() <= Date.now()) throw new AppError('NO_SESSION', 'session expired');
  return {
    id: row.id,
    clockKind: row.clockKind as 'real' | 'scenario',
    scenarioNow: row.scenarioNow,
    scenarioVersion: row.scenarioVersion,
  };
}

/**
 * The clock a session plans with. A scenario session uses its pinned demo instant;
 * a real session uses actual server time. A real session is never silently frozen.
 */
export function sessionNow(session: ResolvedSession): Date {
  return session.clockKind === 'scenario' && session.scenarioNow
    ? new Date(session.scenarioNow)
    : new Date();
}

/** Deletes expired synthetic sessions. Everything else cascades from the session row. */
export async function purgeExpired(db: Db, now = new Date()): Promise<number> {
  const deleted = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning();
  return deleted.length;
}

/** A session-scoped lookup helper. Ownership is checked here, once, for every read. */
export async function ownedAccount(db: Db, sessionId: string, accountId: string) {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.sessionId, sessionId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'account not found');
  return row;
}

export async function ownedObligation(db: Db, sessionId: string, obligationId: string) {
  const rows = await db
    .select()
    .from(obligations)
    .where(and(eq(obligations.id, obligationId), eq(obligations.sessionId, sessionId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'obligation not found');
  return row;
}

export const SESSION_LIFETIME_MS = RETENTION_HOURS * 60 * 60 * 1000;
export { DAY_MS };
