import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { openStudentAccount } from '@/lib/services/wallet';
import { liveBudget } from '@/lib/agent/budget';
import { agentRuns } from '@/lib/db/schema';

const pool: pg.Pool = testPool(4);
const db = dbFor(pool);

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const live = (sessionId: string, inputTokens: number, outputTokens: number) => ({
  sessionId, mode: 'live', modelName: 'claude-haiku-5-5', status: 'COMPLETED', toolCalls: 0, latencyMs: 1, inputTokens, outputTokens, trace: [],
});

describe('live AI spending cap', () => {
  it('lets a student use the live model until their daily turns run out', async () => {
    process.env.MODEL_TURNS_PER_STUDENT_DAY = '2';
    const a = await openStudentAccount(db, { name: 'A', homeCurrency: 'PKR', studyCurrency: 'CNY', homeBalance: '0', studyBalance: '0' });
    expect((await liveBudget(db, a.sessionId)).allowed).toBe(true);
    await db.insert(agentRuns).values([live(a.sessionId, 1000, 100), live(a.sessionId, 1000, 100)] as never);
    expect(await liveBudget(db, a.sessionId)).toMatchObject({ allowed: false, turnsToday: 2 });
    const b = await openStudentAccount(db, { name: 'B', homeCurrency: 'INR', studyCurrency: 'CNY', homeBalance: '0', studyBalance: '0' });
    expect((await liveBudget(db, b.sessionId)).allowed).toBe(true);
    delete process.env.MODEL_TURNS_PER_STUDENT_DAY;
  });

  it('stops every student once the daily dollar budget is spent', async () => {
    process.env.MODEL_DAILY_BUDGET_USD = '0.01';
    const a = await openStudentAccount(db, { name: 'A', homeCurrency: 'PKR', studyCurrency: 'CNY', homeBalance: '0', studyBalance: '0' });
    const b = await openStudentAccount(db, { name: 'B', homeCurrency: 'PKR', studyCurrency: 'CNY', homeBalance: '0', studyBalance: '0' });
    // 90,000 in x $0.10/M + 2,000 out x $0.50/M = $0.009 + $0.001 = $0.010
    await db.insert(agentRuns).values([live(a.sessionId, 90_000, 2_000)] as never);
    const r = await liveBudget(db, b.sessionId);
    expect(r.allowed).toBe(false);
    expect(r.spentTodayUsd).toBeCloseTo(0.01, 6);
    expect(r.reason).toMatch(/today's budget/);
    delete process.env.MODEL_DAILY_BUDGET_USD;
  });

  it('stops for good at the lifetime dollar budget', async () => {
    process.env.MODEL_TOTAL_BUDGET_USD = '0.005';
    const a = await openStudentAccount(db, { name: 'A', homeCurrency: 'PKR', studyCurrency: 'CNY', homeBalance: '0', studyBalance: '0' });
    await db.insert(agentRuns).values([live(a.sessionId, 50_000, 0)] as never); // $0.005
    expect(await liveBudget(db, a.sessionId)).toMatchObject({ allowed: false, reason: 'the live AI has used its whole budget' });
    delete process.env.MODEL_TOTAL_BUDGET_USD;
  });
});
