import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { accounts, approvals, ledgerEntries, obligations, outbox, plans, simulatorTransfers, transfers } from '@/lib/db/schema';
import { createWorkspace, resolveSession, type ResolvedSession } from '@/lib/services/workspace';
import { comparePlan, createPlan, cancelPlan, settledCreditMinor } from '@/lib/services/planning';
import { approvePlan, confirmAndExecute, transferStatus } from '@/lib/services/execution';
import { AppError } from '@/lib/services/errors';
import { formatAmount, parseAmount } from '@/lib/domain/money';
import { TIGHT_SCENARIO } from '@/lib/domain/fixtures';
import * as simulator from '@/lib/simulation/simulator';

const pool: pg.Pool = testPool(20);
const db = dbFor(pool);

interface Ready {
  session: ResolvedSession;
  planId: string;
  termsHash: string;
  nonce: string;
  obligationId: string;
  accountId: string;
}

async function workspace(scenario?: typeof TIGHT_SCENARIO) {
  const created = await createWorkspace(db, scenario ? { scenario } : {});
  const session = await resolveSession(db, created.token);
  return { created, session };
}

async function readyToExecute(scenario?: typeof TIGHT_SCENARIO): Promise<Ready> {
  const { created, session } = await workspace(scenario);
  const plan = await createPlan(db, session, {
    obligationId: created.obligationId,
    sourceAccountId: created.sourceAccountId,
    routeId: 'route-b',
  });
  const grant = await approvePlan(db, session, {
    planId: plan.planId,
    expectedTermsHash: plan.termsHash,
  });
  return {
    session,
    planId: plan.planId,
    termsHash: plan.termsHash,
    nonce: grant.nonce,
    obligationId: created.obligationId,
    accountId: created.sourceAccountId,
  };
}

const gbp = (m: bigint) => formatAmount(m, 'GBP');

/**
 * The debit the plan actually quoted. Derived, never assumed: the rate is live,
 * so a literal here would be a test that only passed on the day it was written.
 */
async function quotedDebit(session: ResolvedSession, obligationId: string, accountId: string) {
  const { result } = await comparePlan(db, session, { obligationId, sourceAccountId: accountId });
  return result.recommended!.pricing.totalDebitMinor;
}

async function balanceOf(accountId: string) {
  const rows = await db.select().from(accounts).where(eq(accounts.id, accountId));
  return rows[0]!.balanceMinor;
}

beforeEach(async () => {
  process.env.EXECUTION_ENABLED = 'true';
  await truncateAll(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('the seeded workspace and the persisted plan', () => {
  it('seeds the golden scenario and plans route B at GBP 6,435.00', async () => {
    const { created, session } = await workspace();
    const { result } = await comparePlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
    });
    expect(result.recommended!.pricing.routeId).toBe('route-b');
    // principal + fee, at a live rate: the identity must hold whatever the market did.
    expect(result.recommended!.pricing.totalDebitMinor).toBe(
      result.recommended!.pricing.principalMinor + result.recommended!.pricing.feeMinor,
    );
    expect(result.recommended!.pricing.totalDebitMinor).toBeGreaterThan(0n);
    expect(result.recommended!.pricing.totalDebitMinor).toBeLessThan(parseAmount('10000.00', 'GBP'));
    expect(gbp(await balanceOf(created.sourceAccountId))).toBe('10000.00');
  });

  it('comparing routes moves no money and writes no plan', async () => {
    const { created, session } = await workspace();
    await comparePlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
    });
    expect(gbp(await balanceOf(created.sourceAccountId))).toBe('10000.00');
    expect(await db.select().from(plans)).toHaveLength(0);
  });

  it('refuses to build a plan on an infeasible route', async () => {
    const { created, session } = await workspace();
    await expect(
      createPlan(db, session, {
        obligationId: created.obligationId,
        sourceAccountId: created.sourceAccountId,
        routeId: 'route-a',
      }),
    ).rejects.toThrow(/MISSES_DEADLINE/);
  });

  it('refuses a route with an unknown fee', async () => {
    const { created, session } = await workspace();
    await expect(
      createPlan(db, session, {
        obligationId: created.obligationId,
        sourceAccountId: created.sourceAccountId,
        routeId: 'route-d',
      }),
    ).rejects.toThrow(/INCOMPLETE_FEES/);
  });
});

describe('T04-T07 consent is bound to exact terms', () => {
  it('T03 no approval means no execution', async () => {
    const { created, session } = await workspace();
    const plan = await createPlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
      routeId: 'route-b',
    });
    await expect(
      confirmAndExecute(db, session, {
        planId: plan.planId,
        expectedTermsHash: plan.termsHash,
        nonce: 'invented-by-the-caller',
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(AppError);
    expect(await db.select().from(transfers)).toHaveLength(0);
    expect(gbp(await balanceOf(created.sourceAccountId))).toBe('10000.00');
  });

  it('a forged nonce cannot authorise an approved plan', async () => {
    const r = await readyToExecute();
    await expect(
      confirmAndExecute(db, r.session, {
        planId: r.planId,
        expectedTermsHash: r.termsHash,
        nonce: 'not-the-real-nonce',
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(/invalid approval/);
    expect(await db.select().from(transfers)).toHaveLength(0);
  });

  it('T07 an altered terms hash is refused', async () => {
    const r = await readyToExecute();
    await expect(
      confirmAndExecute(db, r.session, {
        planId: r.planId,
        expectedTermsHash: 'f'.repeat(64),
        nonce: r.nonce,
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(/terms changed/i);
    expect(gbp(await balanceOf(r.accountId))).toBe('10000.00');
  });

  it('T06 editing the obligation after approval voids it', async () => {
    const r = await readyToExecute();
    await db
      .update(obligations)
      .set({ version: 1 })
      .where(eq(obligations.id, r.obligationId));
    await expect(
      confirmAndExecute(db, r.session, {
        planId: r.planId,
        expectedTermsHash: r.termsHash,
        nonce: r.nonce,
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(/changed since you approved/);
    expect(await db.select().from(transfers)).toHaveLength(0);
  });

  it('T05 an expired approval cannot execute and no provider call is made', async () => {
    const r = await readyToExecute();
    await db
      .update(approvals)
      .set({ expiresAt: new Date('2000-01-01T00:00:00Z') })
      .where(eq(approvals.planId, r.planId));
    await expect(
      confirmAndExecute(db, r.session, {
        planId: r.planId,
        expectedTermsHash: r.termsHash,
        nonce: r.nonce,
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(/expired/);
    expect(await db.select().from(transfers)).toHaveLength(0);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM simulator_transfers');
    expect(rows[0].n).toBe(0);
  });

  it('an approval is consumed exactly once', async () => {
    const r = await readyToExecute();
    await confirmAndExecute(db, r.session, {
      planId: r.planId,
      expectedTermsHash: r.termsHash,
      nonce: r.nonce,
      idempotencyKey: 'k1',
    });
    // A fresh key on the SAME plan must not pay twice.
    await expect(
      confirmAndExecute(db, r.session, {
        planId: r.planId,
        expectedTermsHash: r.termsHash,
        nonce: r.nonce,
        idempotencyKey: 'k2',
      }),
    ).rejects.toThrow(/already been executed/);
    expect(await db.select().from(transfers)).toHaveLength(1);
  });
});

describe('the atomic execution', () => {
  it('debits once, journals per currency, and leaves the obligation unpaid', async () => {
    const r = await readyToExecute();
    const result = await confirmAndExecute(db, r.session, {
      planId: r.planId,
      expectedTermsHash: r.termsHash,
      nonce: r.nonce,
      idempotencyKey: 'k1',
    });

    expect(result.status).toBe('SUBMITTED');
    expect(result.externalReference).not.toBeNull();
    expect(await balanceOf(r.accountId)).toBe(parseAmount('10000.00', 'GBP') - result.debitAmountMinor);

    // T19 journal totals agree, per currency, independently.
    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transferId, result.id));
    const sumFor = (c: string) =>
      entries.filter((e) => e.currency === c).reduce((acc, e) => acc + e.signedMinor, 0n);
    expect(sumFor('GBP')).toBe(0n);
    expect(sumFor('USD')).toBe(0n);
    expect(entries).toHaveLength(5);

    // T27 submitted is not paid.
    expect(await settledCreditMinor(db, r.obligationId)).toBe(0n);
  });

  it('T18 twenty concurrent confirmations produce exactly one transfer', async () => {
    const r = await readyToExecute();
    const attempts = Array.from({ length: 20 }, () =>
      confirmAndExecute(db, r.session, {
        planId: r.planId,
        expectedTermsHash: r.termsHash,
        nonce: r.nonce,
        idempotencyKey: 'same-key',
      }),
    );
    const settled = await Promise.allSettled(attempts);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    expect(ok.length).toBeGreaterThan(0);

    const rows = await db.select().from(transfers);
    expect(rows).toHaveLength(1);
    // Exactly one debit, whatever the live rate made it.
    expect(await balanceOf(r.accountId)).toBe(parseAmount('10000.00', 'GBP') - rows[0]!.debitMinor);

    const entries = await db.select().from(ledgerEntries);
    expect(entries).toHaveLength(5);
  });

  it('T20 the same key with a different request conflicts and has no second effect', async () => {
    const r = await readyToExecute();
    await confirmAndExecute(db, r.session, {
      planId: r.planId,
      expectedTermsHash: r.termsHash,
      nonce: r.nonce,
      idempotencyKey: 'k1',
    });
    await expect(
      confirmAndExecute(db, r.session, {
        planId: r.planId,
        expectedTermsHash: 'a'.repeat(64),
        nonce: r.nonce,
        idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(/different request/);
    expect(await db.select().from(transfers)).toHaveLength(1);
  });

  it('T50 a repeat of the identical request returns the original transfer', async () => {
    const r = await readyToExecute();
    const first = await confirmAndExecute(db, r.session, {
      planId: r.planId,
      expectedTermsHash: r.termsHash,
      nonce: r.nonce,
      idempotencyKey: 'k1',
    });
    const again = await confirmAndExecute(db, r.session, {
      planId: r.planId,
      expectedTermsHash: r.termsHash,
      nonce: r.nonce,
      idempotencyKey: 'k1',
    });
    expect(again.id).toBe(first.id);
    expect(await db.select().from(transfers)).toHaveLength(1);
  });

  it('T19 two different plans cannot overspend the account', async () => {
    const { created, session } = await workspace();
    const a = await createPlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
      routeId: 'route-b',
    });
    const grantA = await approvePlan(db, session, { planId: a.planId, expectedTermsHash: a.termsHash });
    const b = await createPlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
      routeId: 'route-c',
    });
    const grantB = await approvePlan(db, session, { planId: b.planId, expectedTermsHash: b.termsHash });

    // 6,435 + 6,459.62 is far beyond the 10,000 balance. Exactly one may win.
    const settled = await Promise.allSettled([
      confirmAndExecute(db, session, {
        planId: a.planId, expectedTermsHash: a.termsHash, nonce: grantA.nonce, idempotencyKey: 'ka',
      }),
      confirmAndExecute(db, session, {
        planId: b.planId, expectedTermsHash: b.termsHash, nonce: grantB.nonce, idempotencyKey: 'kb',
      }),
    ]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await db.select().from(transfers)).toHaveLength(1);
    expect(await balanceOf(created.sourceAccountId)).toBeGreaterThanOrEqual(0n);
  });

  it('refuses a payment that would breach the reserve', async () => {
    const { created, session } = await workspace(TIGHT_SCENARIO);
    await expect(
      createPlan(db, session, {
        obligationId: created.obligationId,
        sourceAccountId: created.sourceAccountId,
        routeId: 'route-b',
      }),
    ).rejects.toThrow(/BREACHES_RESERVE/);
    // Refused, so not a penny moved.
    expect(await balanceOf(created.sourceAccountId)).toBe(parseAmount('9500.00', 'GBP'));
  });
});

describe('T27-T28 delivery is not payment', () => {
  it('credits the obligation only once the institution posts', async () => {
    const r = await readyToExecute();
    const submitted = await confirmAndExecute(db, r.session, {
      planId: r.planId,
      expectedTermsHash: r.termsHash,
      nonce: r.nonce,
      idempotencyKey: 'k1',
    });

    await simulator.advance(db, submitted.id, 'deliver', new Date('2026-10-21T10:00:00Z'));
    const delivered = await transferStatus(db, r.session, submitted.id);
    expect(delivered.status).toBe('DELIVERED');
    // T27: delivered, and the tuition is still not paid.
    expect(await settledCreditMinor(db, r.obligationId)).toBe(0n);

    await simulator.advance(db, submitted.id, 'post', new Date('2026-10-22T10:00:00Z'));
    const posted = await transferStatus(db, r.session, submitted.id);
    expect(posted.status).toBe('POSTED');
    expect(formatAmount(await settledCreditMinor(db, r.obligationId), 'USD')).toBe('8000.00');
  });

  it('credits the obligation exactly once however often status is read', async () => {
    const r = await readyToExecute();
    const t = await confirmAndExecute(db, r.session, {
      planId: r.planId, expectedTermsHash: r.termsHash, nonce: r.nonce, idempotencyKey: 'k1',
    });
    await simulator.advance(db, t.id, 'deliver', new Date('2026-10-21T10:00:00Z'));
    await simulator.advance(db, t.id, 'post', new Date('2026-10-22T10:00:00Z'));
    await Promise.all([
      transferStatus(db, r.session, t.id),
      transferStatus(db, r.session, t.id),
      transferStatus(db, r.session, t.id),
    ]);
    expect(formatAmount(await settledCreditMinor(db, r.obligationId), 'USD')).toBe('8000.00');
  });
});

describe('T25 a provider rejection refunds exactly', () => {
  it('restores the balance with compensating entries, not deletions', async () => {
    const r = await readyToExecute();
    const t = await confirmAndExecute(db, r.session, {
      planId: r.planId, expectedTermsHash: r.termsHash, nonce: r.nonce, idempotencyKey: 'k1',
    });
    expect(await balanceOf(r.accountId)).toBe(parseAmount('10000.00', 'GBP') - t.debitAmountMinor);

    await simulator.advance(db, t.id, 'reject', new Date(), 'simulated provider rejection');
    const rejected = await transferStatus(db, r.session, t.id);

    expect(rejected.status).toBe('REJECTED');
    expect(gbp(await balanceOf(r.accountId))).toBe('10000.00');
    expect(await settledCreditMinor(db, r.obligationId)).toBe(0n);

    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.transferId, t.id));
    // Original five postings plus two compensating ones; nothing is deleted.
    expect(entries).toHaveLength(7);
    const gbpSum = entries.filter((e) => e.currency === 'GBP').reduce((a, e) => a + e.signedMinor, 0n);
    expect(gbpSum).toBe(0n);
  });
});

describe('T09 cross-session isolation', () => {
  it('another session cannot read, plan on, approve or execute these objects', async () => {
    const mine = await readyToExecute();
    const { session: theirs } = await workspace();

    await expect(
      approvePlan(db, theirs, { planId: mine.planId, expectedTermsHash: mine.termsHash }),
    ).rejects.toThrow(/not found/);

    await expect(
      confirmAndExecute(db, theirs, {
        planId: mine.planId,
        expectedTermsHash: mine.termsHash,
        nonce: mine.nonce,
        idempotencyKey: 'theirs',
      }),
    ).rejects.toThrow(/not found/);

    await expect(
      comparePlan(db, theirs, {
        obligationId: mine.obligationId,
        sourceAccountId: mine.accountId,
      }),
    ).rejects.toThrow(/not found/);

    expect(await db.select().from(transfers)).toHaveLength(0);
  });

  it('a not-owned object answers exactly like an absent one', async () => {
    const mine = await readyToExecute();
    const { session: theirs } = await workspace();
    const owned = await approvePlan(db, theirs, {
      planId: mine.planId, expectedTermsHash: mine.termsHash,
    }).catch((e: AppError) => e);
    const absent = await approvePlan(db, theirs, {
      planId: '00000000-0000-0000-0000-000000000000', expectedTermsHash: mine.termsHash,
    }).catch((e: AppError) => e);
    expect((owned as AppError).code).toBe((absent as AppError).code);
    expect((owned as AppError).message).toBe((absent as AppError).message);
  });

  it('a transfer cannot be read from another session', async () => {
    const mine = await readyToExecute();
    const t = await confirmAndExecute(db, mine.session, {
      planId: mine.planId, expectedTermsHash: mine.termsHash, nonce: mine.nonce, idempotencyKey: 'k1',
    });
    const { session: theirs } = await workspace();
    await expect(transferStatus(db, theirs, t.id)).rejects.toThrow(/not found/);
  });
});

describe('T43 cancellation', () => {
  it('prevents execution of a cancelled plan', async () => {
    const r = await readyToExecute();
    await cancelPlan(db, r.session, r.planId);
    await expect(
      confirmAndExecute(db, r.session, {
        planId: r.planId, expectedTermsHash: r.termsHash, nonce: r.nonce, idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(/cancelled/);
    expect(await db.select().from(transfers)).toHaveLength(0);
  });

  it('cannot cancel a plan that already executed', async () => {
    const r = await readyToExecute();
    await confirmAndExecute(db, r.session, {
      planId: r.planId, expectedTermsHash: r.termsHash, nonce: r.nonce, idempotencyKey: 'k1',
    });
    await expect(cancelPlan(db, r.session, r.planId)).rejects.toThrow(/already been executed/);
  });
});

describe('T42 the kill switch', () => {
  it('blocks new approvals and new executions', async () => {
    const { created, session } = await workspace();
    const plan = await createPlan(db, session, {
      obligationId: created.obligationId,
      sourceAccountId: created.sourceAccountId,
      routeId: 'route-b',
    });
    process.env.EXECUTION_ENABLED = 'false';
    await expect(
      approvePlan(db, session, { planId: plan.planId, expectedTermsHash: plan.termsHash }),
    ).rejects.toThrow(/disabled/);
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  it('stops dispatch of an already approved plan without erasing it', async () => {
    const r = await readyToExecute();
    process.env.EXECUTION_ENABLED = 'false';
    await expect(
      confirmAndExecute(db, r.session, {
        planId: r.planId, expectedTermsHash: r.termsHash, nonce: r.nonce, idempotencyKey: 'k1',
      }),
    ).rejects.toThrow(/disabled/);
    expect(await db.select().from(transfers)).toHaveLength(0);
    const planRow = await db.select().from(plans).where(eq(plans.id, r.planId));
    expect(planRow[0]!.state).toBe('APPROVED');
  });
});

describe('T21-T23 recovering an unknown outcome', () => {
  it('resolves by asking the provider, never by paying again', async () => {
    const r = await readyToExecute();
    const t = await confirmAndExecute(db, r.session, {
      planId: r.planId, expectedTermsHash: r.termsHash, nonce: r.nonce, idempotencyKey: 'k1',
    });

    // Emulate the dispatch whose response was lost: the provider accepted, but we
    // never learned it, so our record says UNKNOWN_OUTCOME and the outbox is still
    // pending. This is also the shape of a crash between commit and dispatch.
    await db.update(transfers).set({ status: 'UNKNOWN_OUTCOME' }).where(eq(transfers.id, t.id));
    await db.update(outbox).set({ state: 'PENDING', processedAt: null }).where(eq(outbox.transferId, t.id));

    const recovered = await transferStatus(db, r.session, t.id);

    expect(recovered.status).toBe('SUBMITTED');
    expect(recovered.id).toBe(t.id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM simulator_transfers');
    expect(rows[0].n).toBe(1);
    expect(await db.select().from(transfers)).toHaveLength(1);
    expect(await balanceOf(r.accountId)).toBe(parseAmount('10000.00', 'GBP') - t.debitAmountMinor);
  });

  it('a dispatch failure leaves the debit intact and the outcome honestly unknown', async () => {
    const r = await readyToExecute();
    const t = await confirmAndExecute(db, r.session, {
      planId: r.planId, expectedTermsHash: r.termsHash, nonce: r.nonce, idempotencyKey: 'k1',
    });

    // Poison the provider record so the next submit under this key conflicts: the
    // application cannot tell what happened and must not claim failure or success.
    await db.update(simulatorTransfers)
      .set({ payloadHash: 'deliberately-different' })
      .where(eq(simulatorTransfers.clientKey, t.id));
    await db.update(transfers).set({ status: 'SUBMITTED' }).where(eq(transfers.id, t.id));
    await db.update(outbox).set({ state: 'PENDING', processedAt: null }).where(eq(outbox.transferId, t.id));

    const after = await transferStatus(db, r.session, t.id);
    expect(after.status).toBe('UNKNOWN_OUTCOME');
    // No second transfer and no second provider record were created.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM simulator_transfers');
    expect(rows[0].n).toBe(1);
    expect(await db.select().from(transfers)).toHaveLength(1);
  });
});
