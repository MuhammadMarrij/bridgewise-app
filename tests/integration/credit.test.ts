import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { resolveSession } from '@/lib/services/workspace';
import { openStudentAccount } from '@/lib/services/wallet';
import { linkSource } from '@/lib/services/linked';
import { creditPlan, markCreditStep } from '@/lib/services/credit';
import { luhnValid } from '@/lib/connectors';

const pool: pg.Pool = testPool(4);
const db = dbFor(pool);
const withLuhn = (b: string) => { for (let d = 0; d <= 9; d += 1) if (luhnValid(b + d)) return b + d; throw new Error(); };

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('credit building in China', () => {
  it('detects steps from real account data and raises readiness', async () => {
    const o = await openStudentAccount(db, { name: 'Ali', homeCurrency: 'PKR', studyCurrency: 'CNY', homeBalance: '900000', studyBalance: '3200.00' });
    const s = await resolveSession(db, o.token);
    const before = await creditPlan(db, s, 'CNY');
    expect(before.steps.find((x) => x.id === 'cn-bank')!.done).toBe(false);

    await linkSource(db, s, { kind: 'bank', bank: 'ccb', account: withLuhn('621700001234567890'), holder: 'Ali' });
    await linkSource(db, s, { kind: 'wallet', provider: 'alipay', account: '13812345678', holder: 'Ali' });
    const after = await creditPlan(db, s, 'CNY');
    expect(after.steps.find((x) => x.id === 'cn-bank')).toMatchObject({ done: true, detectedBy: 'auto' });
    expect(after.steps.find((x) => x.id === 'alipay-realname')).toMatchObject({ done: true, detectedBy: 'auto' });
    expect(after.readiness).toBeGreaterThan(before.readiness);
    expect(after.readinessNote).toMatch(/not your 征信/);
  });

  it('lets the student mark manual steps, but not fake an automatic one', async () => {
    const o = await openStudentAccount(db, { name: 'Ali', homeCurrency: 'PKR', studyCurrency: 'CNY', homeBalance: '900000', studyBalance: '3200.00' });
    const s = await resolveSession(db, o.token);
    await markCreditStep(db, s, 'pboc-report', true);
    await markCreditStep(db, s, 'on-time', true); // derived from payments; must be ignored
    const plan = await creditPlan(db, s, 'CNY');
    expect(plan.steps.find((x) => x.id === 'pboc-report')).toMatchObject({ done: true, detectedBy: 'you' });
    expect(plan.steps.find((x) => x.id === 'on-time')!.done).toBe(false);
  });
});
