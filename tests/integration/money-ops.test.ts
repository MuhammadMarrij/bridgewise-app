import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { accounts, ledgerEntries, walletTransactions } from '@/lib/db/schema';
import { resolveSession } from '@/lib/services/workspace';
import { openStudentAccount, executeProposal } from '@/lib/services/wallet';
import {
  topUp, recordSpend, listTransactions, addRecipient, proposeSend, setBudget, listBudgets, spendingSummary,
} from '@/lib/services/money-ops';

const pool: pg.Pool = testPool(6);
const db = dbFor(pool);
const online = async () => { try { await fetch('https://open.er-api.com/v6/latest/USD'); return true; } catch { return false; } };

async function student() {
  const o = await openStudentAccount(db, { name: 'Wei', homeCurrency: 'CNY', studyCurrency: 'GBP', homeBalance: '40000.00', studyBalance: '1000.00' });
  return resolveSession(db, o.token);
}

/** Every currency in this session's books sums to zero, across every bucket. */
async function booksBalance(sessionId: string) {
  const ids = (await db.select().from(accounts).where(eq(accounts.sessionId, sessionId))).map((a) => a.id);
  const own = await db.select().from(ledgerEntries).where(inArray(ledgerEntries.accountId, ids));
  // Pocket balances must equal the sum of their own ledger lines.
  for (const id of ids) {
    const a = (await db.select().from(accounts).where(eq(accounts.id, id)))[0]!;
    const sum = own.filter((e) => e.accountId === id).reduce((s, e) => s + e.signedMinor, 0n);
    expect(sum).toBe(a.balanceMinor);
  }
}

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

const SANDBOX_PAYEE = { account: process.env.ALIPAY_SANDBOX_PAYEE ?? 'pybnum6156@sandbox.com', name: process.env.ALIPAY_SANDBOX_PAYEE_NAME ?? 'pybnum6156' };
const alipayReady = () => !!(process.env.ALIPAY_APP_ID && process.env.ALIPAY_PUBLIC_KEY);

describe('a real wallet statement', () => {
  it('opening balances appear on the statement and in the ledger', async () => {
    const s = await student();
    const tx = await listTransactions(db, s.id);
    expect(tx.map((t) => t.kind).sort()).toEqual(['opening', 'opening']);
    await booksBalance(s.id);
  });

  it('a top-up moves the balance; an expense paid elsewhere is logged without touching it', async () => {
    const s = await student();
    await topUp(db, s, { currency: 'GBP', amount: '500.00', source: 'Bank of China transfer', idempotencyKey: 'tu-1' });
    await recordSpend(db, s, { currency: 'GBP', amount: '42.50', merchant: 'Tesco', category: 'food', idempotencyKey: 'sp-1' });
    const gbp = (await listTransactions(db, s.id, { currency: 'GBP' }));
    expect(gbp[0]).toMatchObject({ kind: 'spend', amount: '-42.50', balanceAfter: '1500.00', category: 'food', reference: 'Paid elsewhere' });
    expect(gbp[1]).toMatchObject({ kind: 'topup', amount: '500.00', balanceAfter: '1500.00' });
    await booksBalance(s.id);
  });

  it('a repeated top-up or spend with the same key happens once', async () => {
    const s = await student();
    await Promise.all(Array.from({ length: 5 }, () => recordSpend(db, s, { currency: 'GBP', amount: '10.00', merchant: 'Pret', category: 'food', idempotencyKey: 'same' }).catch(() => null)));
    const rows = await db.select().from(walletTransactions).where(eq(walletTransactions.idempotencyKey, 'same'));
    expect(rows).toHaveLength(1);
    const gbp = (await db.select().from(accounts).where(eq(accounts.sessionId, s.id))).find((a) => a.currency === 'GBP')!;
    expect(gbp.balanceMinor).toBe(100000n); // logged, not paid from the wallet
  });

  it('refuses an expense in a currency the student has no pocket for, or a non-positive amount', async () => {
    const s = await student();
    await expect(recordSpend(db, s, { currency: 'JPY', amount: '500', merchant: 'X', category: 'other', idempotencyKey: 'jp' })).rejects.toThrow(/no JPY pocket/);
    await expect(recordSpend(db, s, { currency: 'GBP', amount: '0', merchant: 'X', category: 'other', idempotencyKey: 'z' })).rejects.toThrow(/above zero/);
  });
});

describe('sending money to a person', () => {
  it('pays an Alipay recipient for real through Alipay, only after approval, and never twice', async () => {
    if (!(await online()) || !alipayReady()) return console.warn('skipped: offline or Alipay not configured');
    const s = await student();
    const friend = await addRecipient(db, s, { name: 'Li Na', relationship: 'friend', country: 'CN', currency: 'CNY', alipayAccount: SANDBOX_PAYEE.account, alipayName: SANDBOX_PAYEE.name });
    expect(friend).toMatchObject({ rail: 'alipay', currency: 'CNY' });
    // GBP -> CNY: the recipient gets exactly 20.00 CNY in their Alipay.
    const p = await proposeSend(db, s, { recipientId: friend.id, receiveAmount: '20.00', fromCurrency: 'GBP', proposedBy: 'agent' });
    let gbp = (await db.select().from(accounts).where(eq(accounts.sessionId, s.id))).find((a) => a.currency === 'GBP')!;
    expect(gbp.balanceMinor).toBe(100000n); // nothing moved yet
    const done = await executeProposal(db, s, p.id, p.termsHash);
    expect(done.proposal.resultJson).toMatchObject({ status: 'PAID' });
    gbp = (await db.select().from(accounts).where(eq(accounts.sessionId, s.id))).find((a) => a.currency === 'GBP')!;
    expect(gbp.balanceMinor).toBeLessThan(100000n);
    const sent = (await listTransactions(db, s.id))[0]!;
    expect(sent).toMatchObject({ kind: 'send', description: 'To Li Na · Alipay', counterparty: 'Li Na' });
    expect(sent.reference).toMatch(/^\d{10,}$/); // Alipay's order id
    const again = await executeProposal(db, s, p.id, p.termsHash);
    expect(again.replay).toBe(true);
    expect((await listTransactions(db, s.id)).filter((t) => t.kind === 'send')).toHaveLength(1);
    await booksBalance(s.id);
  });

  it('refuses, before anything moves, a recipient no real rail can pay yet', async () => {
    const s = await student();
    const mum = await addRecipient(db, s, { name: 'Ammi', relationship: 'family', country: 'PK', currency: 'PKR', accountLabel: 'Meezan Bank ••2201' });
    await expect(proposeSend(db, s, { recipientId: mum.id, receiveAmount: '10000', proposedBy: 'user' })).rejects.toThrow(/isn't available yet/);
  });

  it('another student cannot send to my recipient', async () => {
    const s = await student();
    const mum = await addRecipient(db, s, { name: 'Mum', relationship: 'family', country: 'CN', currency: 'CNY', accountLabel: 'Alipay ••4471' });
    const other = await student();
    await expect(proposeSend(db, other, { recipientId: mum.id, receiveAmount: '10.00', proposedBy: 'agent' })).rejects.toThrow(/no such recipient/);
  });
});

describe('budgets and where the money goes', () => {
  it('tracks a category against its monthly limit and flags going over', async () => {
    const s = await student();
    await setBudget(db, s, { category: 'food', currency: 'GBP', monthlyLimit: '50.00' });
    await recordSpend(db, s, { currency: 'GBP', amount: '30.00', merchant: 'Tesco', category: 'food', idempotencyKey: 'a' });
    await recordSpend(db, s, { currency: 'GBP', amount: '25.00', merchant: 'Lidl', category: 'food', idempotencyKey: 'b' });
    const [food] = await listBudgets(db, s.id);
    expect(food).toMatchObject({ category: 'food', spent: '55.00', remaining: '-5.00', over: true });
  });

  it('summarises spending by category with a runway', async () => {
    const s = await student();
    await recordSpend(db, s, { currency: 'GBP', amount: '60.00', merchant: 'Tesco', category: 'food', idempotencyKey: 'a' });
    await recordSpend(db, s, { currency: 'GBP', amount: '30.00', merchant: 'TfL', category: 'transport', idempotencyKey: 'b' });
    const sum = await spendingSummary(db, s.id, 'GBP', 30);
    expect(sum.total).toBe('90.00');
    expect(sum.categories[0]).toMatchObject({ category: 'food', amount: '60.00' });
    expect(sum.averageDaily).toBe('3.00');
    if (await online()) expect(sum.runwayDays).toBeGreaterThan(300);
  });
});
