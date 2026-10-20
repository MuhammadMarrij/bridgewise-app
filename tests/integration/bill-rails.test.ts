import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type pg from 'pg';
import { eq } from 'drizzle-orm';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { resolveSession } from '@/lib/services/workspace';
import { executeProposal, openStudentAccount } from '@/lib/services/wallet';
import { addBill, markBillPaid, proposeBillPayment } from '@/lib/services/bills';
import { accounts, payouts } from '@/lib/db/schema';

const pool: pg.Pool = testPool(4);
const db = dbFor(pool);
beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const SANDBOX_PAYEE = { account: process.env.ALIPAY_SANDBOX_PAYEE ?? 'pybnum6156@sandbox.com', name: process.env.ALIPAY_SANDBOX_PAYEE_NAME ?? 'pybnum6156' };
const alipayReady = () => !!(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PUBLIC_KEY);

async function student() {
  const o = await openStudentAccount(db, { name: 'Ali', homeCurrency: 'PKR', studyCurrency: 'CNY', homeBalance: '0', studyBalance: '30000.00' });
  return resolveSession(db, o.token);
}
const cny = async (sid: string) => (await db.select().from(accounts).where(eq(accounts.sessionId, sid))).find((a) => a.currency === 'CNY')!;
const due = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

describe('paying bills', () => {
  it('sets the money aside when no rail reaches the payee, and releases it when marked paid', async () => {
    const s = await student();
    const bill = await addBill(db, s, { description: 'Tuition', amount: '26000.00', currency: 'CNY', payee: 'Tsinghua University', reference: '2026080123', dueDate: due, reserve: '0', reserveCurrency: 'PKR' });
    const p = await proposeBillPayment(db, s, { obligationId: bill.obligationId, proposedBy: 'user' });
    expect(p.title).toMatch(/^Set aside 26000.00 CNY/);
    const done = await executeProposal(db, s, p.id, p.termsHash);
    expect(done.proposal.resultJson).toMatchObject({ status: 'SET_ASIDE' });
    let pocket = await cny(s.id);
    expect(pocket.balanceMinor).toBe(3000000n); // nothing left the wallet
    expect(pocket.reservedMinor).toBe(2600000n); // but it can't be spent
    await markBillPaid(db, s, bill.obligationId);
    pocket = await cny(s.id);
    expect(pocket.reservedMinor).toBe(0n);
    await expect(markBillPaid(db, s, bill.obligationId)).rejects.toThrow(/already paid/);
  });

  it('pays the bill for real when the payee has an Alipay account', async () => {
    if (!alipayReady()) return console.warn('skipped: Alipay not configured');
    const s = await student();
    const bill = await addBill(db, s, { description: 'Dorm deposit', amount: '12.00', currency: 'CNY', payee: 'Dorm office', reference: 'D-114', dueDate: due, reserve: '0', reserveCurrency: 'PKR', alipayAccount: SANDBOX_PAYEE.account, alipayName: SANDBOX_PAYEE.name });
    const p = await proposeBillPayment(db, s, { obligationId: bill.obligationId, proposedBy: 'user' });
    expect(p.title).toMatch(/through Alipay$/);
    const done = await executeProposal(db, s, p.id, p.termsHash);
    expect(done.proposal.resultJson).toMatchObject({ status: 'PAID' });
    expect((await cny(s.id)).balanceMinor).toBe(3000000n - 1200n);
    expect((await db.select().from(payouts).where(eq(payouts.proposalId, p.id)))[0]).toMatchObject({ status: 'PAID', provider: 'alipay' });
  });
});
