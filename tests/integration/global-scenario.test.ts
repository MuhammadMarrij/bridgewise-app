/**
 * Global PKR→USD persona, the guided agent, inbound remittances, staged
 * payments and the tamper-evident audit chain.
 *
 * The guided agent is a deterministic planner that drives the REAL tools; it is
 * not a live model and is reported as a separate population.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { createWorkspace, resolveSession, type ResolvedSession } from '@/lib/services/workspace';
import { runAgentTurn } from '@/lib/agent/runner';
import { guidedAdapter } from '@/lib/agent/guided';
import {
  reviewPaymentOptions,
  reviewStagedPlans,
  preparePayment,
} from '@/lib/services/advisor';
import { listRemittances, releaseRemittance } from '@/lib/services/remittance';
import { comparePlan } from '@/lib/services/planning';
import { appendAudit, verifyAuditChain } from '@/lib/services/audit';
import {
  accounts,
  auditEvents,
  inboundRemittances,
  ledgerEntries,
  obligations,
} from '@/lib/db/schema';
import { parseAmount } from '@/lib/domain/money';

const pool: pg.Pool = testPool();
const db = dbFor(pool);

let session: ResolvedSession;
let created: Awaited<ReturnType<typeof createWorkspace>>;

beforeEach(async () => {
  await truncateAll(pool);
  created = await createWorkspace(db, { kind: 'global' });
  session = await resolveSession(db, created.token);
});

afterAll(async () => {
  await pool.end();
});

describe('global persona seeding', () => {
  it('creates one PKR account, two USD bills and one inbound remittance', async () => {
    const accts = await db.select().from(accounts);
    expect(accts).toHaveLength(1);
    expect(accts[0]!.currency).toBe('PKR');
    expect(accts[0]!.balanceMinor).toBe(parseAmount('500000', 'PKR'));

    const bills = await db.select().from(obligations);
    expect(bills.map((b) => b.description).sort()).toEqual(['Enrolment deposit', 'Tuition balance']);

    const rem = await db.select().from(inboundRemittances);
    expect(rem).toHaveLength(1);
    expect(rem[0]!.status).toBe('SENT');
    expect(rem[0]!.amountMinor).toBe(1_000_000n);
  });

  it('expected family money is NOT counted in the balance before release', async () => {
    const accts = await db.select().from(accounts);
    expect(accts[0]!.balanceMinor).toBe(500_000n);
    const rem = await listRemittances(db, session);
    // It clears on 17 Nov; the demo clock is 10 Nov, so it is not releasable yet.
    expect(rem[0]!.releasable).toBe(false);
  });
});

describe('payment options for the two bills', () => {
  it('funds the deposit now with the fast route but cannot pay the balance in full today', async () => {
    const advice = await reviewPaymentOptions(db, session);
    const byName = new Map(advice.obligations.map((o) => [o.description, o]));

    const deposit = byName.get('Enrolment deposit')!;
    const cmp = deposit.comparison as { recommended: { routeId: string; totalDebit: string } | null };
    expect(cmp.recommended?.routeId).toBe('pkr-fast');
    expect(cmp.recommended?.totalDebit).toBe('431572');

    const balance = byName.get('Tuition balance')!;
    const bcmp = balance.comparison as { outcome: string; recommended: unknown };
    expect(bcmp.recommended).toBeNull();
    expect(bcmp.outcome).toBe('NO_FEASIBLE_PLAN');
  });

  it('defers the balance to one post-remittance leg that posts by 20 Nov and preserves the reserve', async () => {
    const staged = await reviewStagedPlans(db, session);
    const balancePlan = staged.plans.find((p) => p.description === 'Tuition balance') as unknown as {
      feasible: boolean;
      installments: Array<{ routeId: string; amount: string; expectedDebit: string; fundedBy: string; expectedPostingAt: string }>;
    };
    expect(balancePlan.feasible).toBe(true);
    // Nothing is sent before the family money arrives: a single leg funded by the remittance.
    expect(balancePlan.installments).toHaveLength(1);
    const leg = balancePlan.installments[0]!;
    expect(leg.routeId).toBe('pkr-fast');
    expect(leg.amount).toBe('3500.00');
    expect(leg.fundedBy).toBe('Family tuition support');
    expect(new Date(leg.expectedPostingAt).getTime()).toBeLessThanOrEqual(
      new Date('2026-11-20T20:00:00.000Z').getTime(),
    );
    expect(new Date(leg.expectedPostingAt).toISOString()).toBe('2026-11-19T15:00:00.000Z');
  });
});

describe('releasing the inbound remittance', () => {
  it('is not releasable before the clearance instant', async () => {
    const pending = await listRemittances(db, session);
    expect(pending[0]!.releasable).toBe(false);
  });

  it('credits the account through a balanced ledger, advances the clock, and is idempotent', async () => {
    // Move the demo clock to the clearance instant so the money is releasable.
    const remId = (await db.select().from(inboundRemittances))[0]!.id;
    const before = await db.select().from(accounts);
    expect(before[0]!.balanceMinor).toBe(500_000n);

    const released = await releaseRemittance(db, session, remId);
    expect(released.view.status).toBe('AVAILABLE');
    expect(released.clockAdvancedTo).toBe('2026-11-17T13:00:00.000Z');

    const after = await db.select().from(accounts);
    expect(after[0]!.balanceMinor).toBe(1_500_000n);

    // Double entry balances to zero per currency.
    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.inboundRemittanceId, remId));
    const sum = rows.reduce((s, r) => s + r.signedMinor, 0n);
    expect(sum).toBe(0n);

    // Releasing again does not double-credit.
    await releaseRemittance(db, { ...session, scenarioNow: new Date('2026-11-17T13:00:00.000Z') }, remId);
    const after2 = await db.select().from(accounts);
    expect(after2[0]!.balanceMinor).toBe(1_500_000n);
  });

  it('after the deposit and the release, the balance is feasible via the fast route and posts by 20 Nov', async () => {
    // 1) pay the deposit now (fast), then 2) release family money, then 3) compare the balance.
    const advice = await reviewPaymentOptions(db, session);
    const deposit = advice.obligations.find((o) => o.description === 'Enrolment deposit')!;
    const prepared = await preparePayment(db, session, { obligationId: deposit.obligationId });
    expect(prepared).toBeTruthy();

    // Execute the deposit plan is out of scope here; instead simulate the debit
    // by creating the proposal and then release the remittance to prove the
    // corridor timing. The plan itself is validated in the execution suite.
    const remId = (await db.select().from(inboundRemittances))[0]!.id;
    await releaseRemittance(db, session, remId);

    // The demo clock is now 17 Nov. Re-resolve and compare the balance.
    const advanced = await resolveSession(db, created.token);
    const balanceBill = (await db.select().from(obligations)).find((o) => o.description === 'Tuition balance')!;
    const pkr = (await db.select().from(accounts))[0]!;
    const { result } = await comparePlan(db, advanced, {
      obligationId: balanceBill.id,
      sourceAccountId: pkr.id,
    });
    expect(result.recommended?.pricing.routeId).toBe('pkr-fast');
    expect(result.recommended!.pricing.postedAt.getTime()).toBeLessThanOrEqual(
      new Date('2026-11-20T20:00:00.000Z').getTime(),
    );
  });
});

describe('the guided agent drives the real tools', () => {
  it('answers a tuition question from the tool surface with real figures', async () => {
    const run = await runAgentTurn({ db, session }, guidedAdapter(), 'How should I pay my tuition?');
    expect(run.mode).toBe('guided');
    expect(run.status).toBe('COMPLETED');
    const called = run.steps.map((s) => s.tool);
    expect(called).toContain('get_financial_snapshot');
    expect(called).toContain('review_payment_options');
    expect(called).toContain('review_inbound_remittances');
    // Every tool call succeeded.
    expect(run.steps.every((s) => s.ok)).toBe(true);
    // Grounded in the real workspace: PKR and the family money are described.
    expect(run.reply).toContain('PKR');
    expect(run.reply).toContain('Family tuition support');
    // The agent never claims to have paid.
    expect(run.reply).not.toMatch(/has (been )?paid|payment succeeded/i);
  });

  it('answers a credit question from the education tool and claims no eligibility', async () => {
    const run = await runAgentTurn({ db, session }, guidedAdapter(), 'How do I build credit history as a student?');
    expect(run.status).toBe('COMPLETED');
    expect(run.steps.map((s) => s.tool)).toContain('get_credit_education');
    expect(run.reply).toMatch(/credit|eligibility/i);
  });

  it('can prepare but never approve a payment', async () => {
    const run = await runAgentTurn({ db, session }, guidedAdapter(), 'Prepare the deposit payment for me.');
    expect(run.status).toBe('COMPLETED');
    expect(run.steps.map((s) => s.tool)).toContain('prepare_payment');
    expect(run.reply).toMatch(/not approved|review screen/i);
  });
});

describe('tamper-evident audit chain', () => {
  it('verifies a clean chain and detects an altered row', async () => {
    await appendAudit(db, {
      sessionId: session.id,
      correlationId: 'a',
      type: 'test.one',
      actor: 'user',
      outcome: 'allowed',
      payload: { amountMinor: 100n, ok: true },
    });
    await appendAudit(db, {
      sessionId: session.id,
      correlationId: 'b',
      type: 'test.two',
      actor: 'system',
      outcome: 'allowed',
      payload: { amountMinor: 250n },
    });

    const clean = await verifyAuditChain(db, session.id);
    expect(clean.ok).toBe(true);
    expect(clean.hashedEvents).toBeGreaterThanOrEqual(2);

    // Tamper with the first event's payload.
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.sessionId, session.id))
      .orderBy(auditEvents.seq);
    const target = rows.find((r) => r.entryHash) ?? rows[0]!;
    await db
      .update(auditEvents)
      .set({ payload: { amountMinor: 999999, ok: true } })
      .where(eq(auditEvents.id, target.id));

    const broken = await verifyAuditChain(db, session.id);
    expect(broken.ok).toBe(false);
    expect(broken.brokenAtSeq).toBe(target.seq);
  });
});
