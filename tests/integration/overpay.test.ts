import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { accounts, obligations, transfers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createWorkspace, resolveSession } from '@/lib/services/workspace';
import { createPlan, settledCreditMinor } from '@/lib/services/planning';
import { approvePlan, confirmAndExecute, transferStatus } from '@/lib/services/execution';
import { formatAmount, parseAmount } from '@/lib/domain/money';
import * as simulator from '@/lib/simulation/simulator';

const pool: pg.Pool = testPool(10);
const db = dbFor(pool);

beforeEach(async () => {
  process.env.EXECUTION_ENABLED = 'true';
  await truncateAll(pool);
});
afterAll(async () => { await pool.end(); });

describe('T28 an obligation cannot be overpaid', () => {
  it('refuses a second full payment for the same tuition', async () => {
    const created = await createWorkspace(db);
    const session = await resolveSession(db, created.token);

    // Give the account plenty of money, so the BALANCE is not what stops a
    // second payment. Only the obligation check can.
    await db.update(accounts)
      .set({ balanceMinor: parseAmount('50000.00', 'GBP') })
      .where(eq(accounts.id, created.sourceAccountId));

    const first = await createPlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
      routeId: 'route-b',
    });
    const g1 = await approvePlan(db, session, { planId: first.planId, expectedTermsHash: first.termsHash });
    const t1 = await confirmAndExecute(db, session, {
      planId: first.planId, expectedTermsHash: first.termsHash, nonce: g1.nonce, idempotencyKey: 'one',
    });

    // A second, entirely separate plan for the SAME obligation.
    const second = await createPlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
      routeId: 'route-c',
    });
    const g2 = await approvePlan(db, session, { planId: second.planId, expectedTermsHash: second.termsHash });

    await expect(
      confirmAndExecute(db, session, {
        planId: second.planId, expectedTermsHash: second.termsHash, nonce: g2.nonce, idempotencyKey: 'two',
      }),
    ).rejects.toThrow(/exceed the amount owed|already fully paid|already in progress/);

    expect(await db.select().from(transfers)).toHaveLength(1);

    // Settle the first one and confirm the tuition is credited exactly once.
    await simulator.advance(db, t1.id, 'deliver', new Date());
    await simulator.advance(db, t1.id, 'post', new Date());
    await transferStatus(db, session, t1.id);
    expect(formatAmount(await settledCreditMinor(db, created.obligationId), 'USD')).toBe('8000.00');
  });

  it('two concurrent plans for the same tuition settle at most one', async () => {
    const created = await createWorkspace(db);
    const session = await resolveSession(db, created.token);
    await db.update(accounts)
      .set({ balanceMinor: parseAmount('50000.00', 'GBP') })
      .where(eq(accounts.id, created.sourceAccountId));

    const a = await createPlan(db, session, {
      obligationId: created.obligationId, sourceAccountId: created.sourceAccountId, routeId: 'route-b',
    });
    const ga = await approvePlan(db, session, { planId: a.planId, expectedTermsHash: a.termsHash });
    const b = await createPlan(db, session, {
      obligationId: created.obligationId, sourceAccountId: created.sourceAccountId, routeId: 'route-c',
    });
    const gb = await approvePlan(db, session, { planId: b.planId, expectedTermsHash: b.termsHash });

    const settled = await Promise.allSettled([
      confirmAndExecute(db, session, {
        planId: a.planId, expectedTermsHash: a.termsHash, nonce: ga.nonce, idempotencyKey: 'ca',
      }),
      confirmAndExecute(db, session, {
        planId: b.planId, expectedTermsHash: b.termsHash, nonce: gb.nonce, idempotencyKey: 'cb',
      }),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(transfers)).toHaveLength(1);

    const row = (await db.select().from(obligations).where(eq(obligations.id, created.obligationId)))[0]!;
    expect(row.targetMinor).toBe(parseAmount('8000.00', 'USD'));
  });
});

describe('a released claim can be paid again', () => {
  it('after a rejection, a new payment for the same tuition is allowed', async () => {
    const created = await createWorkspace(db);
    const session = await resolveSession(db, created.token);

    const first = await createPlan(db, session, {
      obligationId: created.obligationId, sourceAccountId: created.sourceAccountId, routeId: 'route-b',
    });
    const g1 = await approvePlan(db, session, { planId: first.planId, expectedTermsHash: first.termsHash });
    const t1 = await confirmAndExecute(db, session, {
      planId: first.planId, expectedTermsHash: first.termsHash, nonce: g1.nonce, idempotencyKey: 'r1',
    });

    // The provider rejects it, the money comes back, and the claim is released.
    await simulator.advance(db, t1.id, 'reject', new Date(), 'simulated rejection');
    const rejected = await transferStatus(db, session, t1.id);
    expect(rejected.status).toBe('REJECTED');

    const second = await createPlan(db, session, {
      obligationId: created.obligationId, sourceAccountId: created.sourceAccountId, routeId: 'route-c',
    });
    const g2 = await approvePlan(db, session, { planId: second.planId, expectedTermsHash: second.termsHash });
    const t2 = await confirmAndExecute(db, session, {
      planId: second.planId, expectedTermsHash: second.termsHash, nonce: g2.nonce, idempotencyKey: 'r2',
    });
    expect(t2.status).toBe('SUBMITTED');
    expect(await db.select().from(transfers)).toHaveLength(2);
  });

  it('an unknown outcome still holds the claim, because it may have succeeded', async () => {
    const created = await createWorkspace(db);
    const session = await resolveSession(db, created.token);
    // Plenty of money, so only the obligation claim can refuse the second plan.
    await db.update(accounts)
      .set({ balanceMinor: parseAmount('50000.00', 'GBP') })
      .where(eq(accounts.id, created.sourceAccountId));

    const first = await createPlan(db, session, {
      obligationId: created.obligationId, sourceAccountId: created.sourceAccountId, routeId: 'route-b',
    });
    const g1 = await approvePlan(db, session, { planId: first.planId, expectedTermsHash: first.termsHash });
    const t1 = await confirmAndExecute(db, session, {
      planId: first.planId, expectedTermsHash: first.termsHash, nonce: g1.nonce, idempotencyKey: 'u1',
    });
    await db.update(transfers).set({ status: 'UNKNOWN_OUTCOME' }).where(eq(transfers.id, t1.id));

    const second = await createPlan(db, session, {
      obligationId: created.obligationId, sourceAccountId: created.sourceAccountId, routeId: 'route-c',
    });
    const g2 = await approvePlan(db, session, { planId: second.planId, expectedTermsHash: second.termsHash });
    await expect(
      confirmAndExecute(db, session, {
        planId: second.planId, expectedTermsHash: second.termsHash, nonce: g2.nonce, idempotencyKey: 'u2',
      }),
    ).rejects.toThrow(/already in progress|exceed the amount owed/);
  });
});
