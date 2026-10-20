import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { accounts, plans, quotes, transfers } from '@/lib/db/schema';
import { createWorkspace, resolveSession } from '@/lib/services/workspace';
import { cancelPlan, createPlan } from '@/lib/services/planning';
import { approvePlan, confirmAndExecute, reconcile, transferStatus } from '@/lib/services/execution';
import { resolveDeadline } from '@/lib/services/intake';
import { runTool } from '@/lib/agent/tools';
import { runAgentTurn } from '@/lib/agent/runner';
import { stubAdapter } from '@/lib/agent/adapter';
import * as simulator from '@/lib/simulation/simulator';

const pool = testPool(6);
const db = dbFor(pool);
beforeEach(async () => { await truncateAll(pool); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await pool.end(); });

async function ready() {
  const workspace = await createWorkspace(db);
  const session = await resolveSession(db, workspace.token);
  const plan = await createPlan(db, session, {
    obligationId: workspace.obligationId, sourceAccountId: workspace.sourceAccountId, routeId: 'route-b',
  });
  const grant = await approvePlan(db, session, { planId: plan.planId, expectedTermsHash: plan.termsHash });
  const input = { planId: plan.planId, expectedTermsHash: plan.termsHash, nonce: grant.nonce, idempotencyKey: 'review' };
  return { workspace, session, plan, input };
}

it('R04 rechecks rent and reserve after another debit reduces the balance', async () => {
  const r = await ready();
  await db.update(accounts).set({ balanceMinor: 950000n }).where(eq(accounts.id, r.workspace.sourceAccountId));
  await expect(confirmAndExecute(db, r.session, r.input)).rejects.toMatchObject({ code: 'BREACHES_RESERVE' });
  expect(await db.select().from(transfers)).toHaveLength(0);
});

it('R06 rejects quote fees changed after approval', async () => {
  const r = await ready();
  await db.update(quotes).set({ feeMinor: 4500n, totalDebitMinor: 644500n }).where(eq(quotes.id, r.plan.quoteId));
  await expect(confirmAndExecute(db, r.session, r.input)).rejects.toMatchObject({ code: 'TERMS_CHANGED' });
  expect(await db.select().from(transfers)).toHaveLength(0);
});

it('R10 model status reads cannot dispatch an interrupted outbox', async () => {
  const r = await ready();
  const submit = vi.spyOn(simulator, 'submit').mockRejectedValueOnce(new Error('interrupted before acceptance'));
  const transfer = await confirmAndExecute(db, r.session, r.input);
  expect(transfer.status).toBe('UNKNOWN_OUTCOME');
  submit.mockClear();
  const result = await runTool({ db, session: r.session }, 'get_transfer_status', { transferId: transfer.id });
  expect(result.ok).toBe(true);
  expect(submit.mock.calls.length).toBe(0);
  expect(await simulator.lookup(db, transfer.id)).toBeNull();
});

it('R09 a delayed DELIVERED observation cannot undo POSTED', async () => {
  const r = await ready();
  const transfer = await confirmAndExecute(db, r.session, r.input);
  await simulator.advance(db, transfer.id, 'deliver', new Date());
  const delivered = await simulator.lookup(db, transfer.id);
  const stale = (await db.select().from(transfers).where(eq(transfers.id, transfer.id)))[0]!;
  await simulator.advance(db, transfer.id, 'post', new Date());
  expect((await transferStatus(db, r.session, transfer.id)).status).toBe('POSTED');
  vi.spyOn(simulator, 'lookup').mockResolvedValueOnce(delivered);
  expect((await reconcile(db, stale)).status).toBe('POSTED');
});

it.each([
  ['2027-02-30', '17:00', 'UTC'],
  ['2027-03-14', '02:30', 'America/New_York'],
  ['2026-11-01', '01:30', 'America/New_York'],
])('R01 rejects invalid or ambiguous deadline %s %s %s', (date, time, zone) => {
  expect(() => resolveDeadline(date, time, zone)).toThrow();
});

it('R08 competing delivery and rejection cannot both succeed', async () => {
  const r = await ready();
  const transfer = await confirmAndExecute(db, r.session, r.input);
  const results = await Promise.allSettled([
    simulator.advance(db, transfer.id, 'deliver', new Date()),
    simulator.advance(db, transfer.id, 'reject', new Date()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
});

it('R06 cancellation racing confirmation cannot claim to cancel an executed plan', async () => {
  const r = await ready();
  const [sent, cancelled] = await Promise.allSettled([
    confirmAndExecute(db, r.session, r.input), cancelPlan(db, r.session, r.plan.planId),
  ]);
  expect([sent, cancelled].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const [plan] = await db.select().from(plans).where(eq(plans.id, r.plan.planId));
  expect(plan!.state).toBe(sent.status === 'fulfilled' ? 'EXECUTED' : 'CANCELLED');
});

it('R06 approval cannot resurrect a concurrently cancelled plan', async () => {
  const w = await createWorkspace(db);
  const s = await resolveSession(db, w.token);
  const p = await createPlan(db, s, { obligationId: w.obligationId, sourceAccountId: w.sourceAccountId, routeId: 'route-b' });
  const [, cancelled] = await Promise.allSettled([
    approvePlan(db, s, { planId: p.planId, expectedTermsHash: p.termsHash }), cancelPlan(db, s, p.planId),
  ]);
  expect(cancelled.status).toBe('fulfilled');
  expect((await db.select().from(plans).where(eq(plans.id, p.planId)))[0]!.state).toBe('CANCELLED');
});

it('R10 one model response cannot bypass the tool budget with a large batch', async () => {
  const w = await createWorkspace(db);
  const session = await resolveSession(db, w.token);
  const run = await runAgentTurn({ db, session }, stubAdapter([{
    text: null, stopReason: 'tool_use',
    toolCalls: Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: 'get_financial_snapshot', args: {} })),
  }]), 'Repeat forever');
  expect(run.status).toBe('STEP_LIMIT');
  expect(run.steps.length).toBeLessThanOrEqual(Number(process.env.MAX_RUN_STEPS ?? 6));
});
