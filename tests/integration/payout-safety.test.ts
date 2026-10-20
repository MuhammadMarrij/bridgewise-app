import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type pg from 'pg';
import { eq } from 'drizzle-orm';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { resolveSession } from '@/lib/services/workspace';
import { openStudentAccount, reconcilePayouts } from '@/lib/services/wallet';
import { addRecipient, listTransactions, proposeSend } from '@/lib/services/money-ops';
import { alipayTransfer } from '@/lib/connectors/live';
import { accounts, payouts } from '@/lib/db/schema';

const pool: pg.Pool = testPool(4);
const db = dbFor(pool);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const PAYEE = { account: process.env.ALIPAY_SANDBOX_PAYEE ?? 'pybnum6156@sandbox.com', name: process.env.ALIPAY_SANDBOX_PAYEE_NAME ?? 'pybnum6156' };
const alipayReady = () => !!(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PUBLIC_KEY);

describe('payout safety net', () => {
  it('books a payout Alipay made even when our own booking was lost, and never pays twice', async () => {
    if (!alipayReady()) return console.warn('skipped: Alipay not configured');
    const o = await openStudentAccount(db, { name: 'Ali', homeCurrency: 'PKR', studyCurrency: 'CNY', homeBalance: '0', studyBalance: '500.00' });
    const s = await resolveSession(db, o.token);
    const r = await addRecipient(db, s, { name: 'Li Na', relationship: 'friend', country: 'CN', currency: 'CNY', alipayAccount: PAYEE.account, alipayName: PAYEE.name });
    const p = await proposeSend(db, s, { recipientId: r.id, receiveAmount: '3.00', fromCurrency: 'CNY', proposedBy: 'user' });

    // Simulate the crash: the pending record was written, Alipay paid, then our transaction died.
    await db.insert(payouts).values({ sessionId: s.id, proposalId: p.id, provider: 'alipay', currency: 'CNY', amountMinor: 300n, payee: '', status: 'PENDING', createdAt: new Date(Date.now() - 120_000) });
    await alipayTransfer({ outBizNo: p.id.replace(/-/g, ''), amount: '3.00', identity: PAYEE.account, name: PAYEE.name, title: 'test' });
    const pocket = async () => (await db.select().from(accounts).where(eq(accounts.sessionId, s.id))).find((a) => a.currency === 'CNY')!;
    expect((await pocket()).balanceMinor).toBe(50000n); // money left Alipay, books don't show it

    expect(await reconcilePayouts(db, s)).toBe(1);
    expect((await pocket()).balanceMinor).toBeLessThan(50000n);
    expect((await db.select().from(payouts).where(eq(payouts.proposalId, p.id)))[0]).toMatchObject({ status: 'PAID' });
    expect((await listTransactions(db, s.id)).filter((t) => t.kind === 'send')).toHaveLength(1);
    expect(await reconcilePayouts(db, s)).toBe(0); // nothing left to fix
  });
});
