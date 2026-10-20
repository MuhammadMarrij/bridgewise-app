import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { obligations } from '@/lib/db/schema';
import { createWorkspace, resolveSession, type ResolvedSession } from '@/lib/services/workspace';
import { addCashFlow, confirmObligation, createObligation, resolveDeadline } from '@/lib/services/intake';
import { comparePlan } from '@/lib/services/planning';
import { formatAmount } from '@/lib/domain/money';
import { AppError } from '@/lib/services/errors';

const pool: pg.Pool = testPool(6);
const db = dbFor(pool);
let session: ResolvedSession;
let sourceAccountId: string;

const draft = (over: Partial<Parameters<typeof createObligation>[2]> = {}) => ({
  description: 'Spring term tuition',
  amount: '12500.00',
  currency: 'USD' as const,
  beneficiaryName: 'Westfield College (fictional)',
  beneficiaryReference: 'WF-2027-SPRING-119',
  deadlineDate: '2026-12-15',
  deadlineTime: '17:00',
  deadlineTimezone: 'America/New_York',
  reserveAmount: '1500.00',
  reserveCurrency: 'GBP' as const,
  ...over,
});

beforeEach(async () => {
  await truncateAll(pool);
  const created = await createWorkspace(db);
  session = await resolveSession(db, created.token);
  sourceAccountId = created.sourceAccountId;
});
afterAll(async () => { await pool.end(); });

describe('a student enters their own bill', () => {
  it('saves it, and it is NOT executable until confirmed', async () => {
    const created = await createObligation(db, session, draft());
    expect(created.confirmed).toBe(false);

    const row = (await db.select().from(obligations).where(eq(obligations.id, created.obligationId)))[0]!;
    expect(formatAmount(row.targetMinor, 'USD')).toBe('12500.00');
    expect(row.confirmedAt).toBeNull();

    // Planning against an unconfirmed obligation is refused: typing a number is
    // not the same as meaning it.
    await expect(
      comparePlan(db, session, { obligationId: created.obligationId, sourceAccountId }),
    ).rejects.toThrow(/confirm the obligation/i);
  });

  it('becomes executable once the student confirms what the server understood', async () => {
    const created = await createObligation(db, session, draft());
    await confirmObligation(db, session, created.obligationId, {
      amount: '12500.00',
      reference: 'WF-2027-SPRING-119',
      deadlineAt: created.deadlineAt.toISOString(),
    });
    const row = (await db.select().from(obligations).where(eq(obligations.id, created.obligationId)))[0]!;
    expect(row.confirmedAt).not.toBeNull();
    // Confirming bumps the version, so any plan built before it is invalidated.
    expect(row.version).toBe(1);
  });

  it('refuses a confirmation that does not match what was saved', async () => {
    const created = await createObligation(db, session, draft());
    await expect(
      confirmObligation(db, session, created.obligationId, {
        amount: '1250.00', // a transposed decimal
        reference: 'WF-2027-SPRING-119',
        deadlineAt: created.deadlineAt.toISOString(),
      }),
    ).rejects.toThrow(/do not match/);

    await expect(
      confirmObligation(db, session, created.obligationId, {
        amount: '12500.00',
        reference: 'WF-2027-SPRING-911', // a transposed reference
        deadlineAt: created.deadlineAt.toISOString(),
      }),
    ).rejects.toThrow(/do not match/);

    const row = (await db.select().from(obligations).where(eq(obligations.id, created.obligationId)))[0]!;
    expect(row.confirmedAt).toBeNull();
  });

  it('cannot confirm another session obligation', async () => {
    const created = await createObligation(db, session, draft());
    const other = await createWorkspace(db);
    const theirs = await resolveSession(db, other.token);
    await expect(
      confirmObligation(db, theirs, created.obligationId, {
        amount: '12500.00',
        reference: 'WF-2027-SPRING-119',
        deadlineAt: created.deadlineAt.toISOString(),
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('validation that would otherwise produce a confident wrong plan', () => {
  it('rejects an unsupported currency instead of assuming two decimals', async () => {
    // JPY is now a supported zero-decimal corridor; use a genuinely unknown code.
    await expect(
      createObligation(db, session, draft({ currency: 'XYZ' as never })),
    ).rejects.toThrow(AppError);
  });

  it('accepts a zero-decimal home currency without inventing a fraction', async () => {
    const created = await createObligation(db, session, draft({
      currency: 'PKR',
      reserveCurrency: 'PKR',
      amount: '1500000',
      reserveAmount: '100000',
    }));
    expect(created.details.amount).toBe('1500000');
  });

  it('rejects a deadline that has already passed', async () => {
    await expect(
      createObligation(db, session, draft({ deadlineDate: '2020-01-01' })),
    ).rejects.toThrow(/already passed/);
  });

  it('rejects an unknown timezone rather than silently using UTC', async () => {
    await expect(
      createObligation(db, session, draft({ deadlineTimezone: 'Mars/Olympus' })),
    ).rejects.toThrow(/unknown timezone/);
  });

  it.each(['-100.00', '1e4', '12,500.00', '12.345', 'NaN', ''])(
    'rejects the amount %s',
    async (amount) => {
      await expect(createObligation(db, session, draft({ amount }))).rejects.toThrow();
    },
  );

  it('rejects a reference too short to be real', async () => {
    await expect(
      createObligation(db, session, draft({ beneficiaryReference: 'x' })),
    ).rejects.toThrow(/reference/);
  });
});

describe('T13 the deadline is resolved in the stated timezone, not guessed', () => {
  it('reads 17:00 New York as 21:00 UTC during daylight time', () => {
    const at = resolveDeadline('2026-10-23', '17:00', 'America/New_York');
    expect(at.toISOString()).toBe('2026-10-23T21:00:00.000Z');
  });

  it('reads 17:00 New York as 22:00 UTC in standard time', () => {
    // After the November change. A fixed offset would be an hour wrong here,
    // which is the kind of error that silently moves a deadline.
    const at = resolveDeadline('2026-12-15', '17:00', 'America/New_York');
    expect(at.toISOString()).toBe('2026-12-15T22:00:00.000Z');
  });

  it('handles a zone with a half-hour offset', () => {
    const at = resolveDeadline('2026-11-01', '09:30', 'Asia/Kolkata');
    expect(at.toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });

  it('reads a Beijing deadline correctly', () => {
    const at = resolveDeadline('2026-10-20', '23:59', 'Asia/Shanghai');
    expect(at.toISOString()).toBe('2026-10-20T15:59:00.000Z');
  });

  it('rejects a malformed date or time', () => {
    expect(() => resolveDeadline('15-12-2026', '17:00', 'UTC')).toThrow();
    expect(() => resolveDeadline('2026-12-15', '5pm', 'UTC')).toThrow();
  });
});

describe('the student adds their own commitments', () => {
  it('records an outflow and the planner takes it into account', async () => {
    const id = await addCashFlow(db, session, {
      label: 'Rent',
      currency: 'GBP',
      direction: 'outflow',
      amount: '900.00',
      occursAt: '2026-10-25T09:00:00.000Z',
      certain: true,
    });
    expect(id).toBeTruthy();
  });

  it('rejects a zero or negative commitment', async () => {
    await expect(
      addCashFlow(db, session, {
        label: 'Nonsense', currency: 'GBP', direction: 'outflow',
        amount: '0.00', occursAt: '2026-10-25T09:00:00.000Z', certain: true,
      }),
    ).rejects.toThrow();
  });
});
