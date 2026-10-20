import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { accounts } from '@/lib/db/schema';
import { resolveSession } from '@/lib/services/workspace';
import { openStudentAccount, executeProposal } from '@/lib/services/wallet';
import { linkSource, listSources, topUpFromSource, proposeWithdrawal, removeSource } from '@/lib/services/linked';
import { luhnValid, cardBrand } from '@/lib/connectors';
import { listTransactions } from '@/lib/services/money-ops';

const pool: pg.Pool = testPool(6);
const db = dbFor(pool);
const online = async () => { try { await fetch('https://open.er-api.com/v6/latest/USD'); return true; } catch { return false; } };

/** Completes a number with a valid Luhn check digit, for test bank cards. */
function withLuhn(body: string): string {
  for (let d = 0; d <= 9; d += 1) if (luhnValid(body + d)) return body + d;
  throw new Error('unreachable');
}

async function student() {
  const o = await openStudentAccount(db, { name: 'Wei', homeCurrency: 'CNY', studyCurrency: 'GBP', homeBalance: '10000.00', studyBalance: '500.00' });
  return resolveSession(db, o.token);
}
const balance = async (sessionId: string, c: string) =>
  (await db.select().from(accounts).where(eq(accounts.sessionId, sessionId))).find((a) => a.currency === c)?.balanceMinor;

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('card validation', () => {
  it('detects networks and checks the Luhn digit', () => {
    expect(cardBrand('4242424242424242')).toBe('visa');
    expect(cardBrand('5555555555554444')).toBe('mastercard');
    expect(cardBrand('6200000000000005')).toBe('unionpay');
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
  });
});

describe('linking a bank card', () => {
  it('stores only the token, brand and last four — never the full number', async () => {
    const s = await student();
    const card = await linkSource(db, s, { kind: 'card', number: '4242 4242 4242 4242', expiry: '12/30', cvc: '123', holder: 'Wei Zhang', currency: 'GBP' });
    expect(card).toMatchObject({ label: 'Visa ••4242', last4: '4242', brand: 'visa' });
    const { rows } = await pool.query('SELECT * FROM linked_sources');
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain('4242424242424242');
    expect(everything).not.toContain('"123"');
    expect((await listSources(db, s.id))[0]).not.toHaveProperty('token');
  });

  it('refuses a bad number, an expired card, and a wrong security code', async () => {
    const s = await student();
    const base = { kind: 'card' as const, expiry: '12/30', cvc: '123', holder: 'W', currency: 'GBP' as const };
    await expect(linkSource(db, s, { ...base, number: '4242424242424241' })).rejects.toThrow(/not valid/);
    await expect(linkSource(db, s, { ...base, number: '4242424242424242', expiry: '01/20' })).rejects.toThrow(/expired/);
    await expect(linkSource(db, s, { ...base, number: '4242424242424242', cvc: '12' })).rejects.toThrow(/security code/);
  });

  it('tops up from the card, and a declining card moves nothing', async () => {
    const s = await student();
    const ok = await linkSource(db, s, { kind: 'card', number: '4242424242424242', expiry: '12/30', cvc: '123', holder: 'W', currency: 'GBP' });
    await topUpFromSource(db, s, { sourceId: ok.id, amount: '200.00', idempotencyKey: 'card-top-1' });
    expect(await balance(s.id, 'GBP')).toBe(70000n);
    expect((await listTransactions(db, s.id))[0]).toMatchObject({ kind: 'topup', amount: '200.00' });

    const bad = await linkSource(db, s, { kind: 'card', number: '4000000000000002', expiry: '12/30', cvc: '123', holder: 'W', currency: 'GBP' });
    await expect(topUpFromSource(db, s, { sourceId: bad.id, amount: '50.00', idempotencyKey: 'card-top-2' })).rejects.toThrow(/declined/);
    expect(await balance(s.id, 'GBP')).toBe(70000n);
  });
});

describe('Alipay, WeChat Pay and Chinese banks', () => {
  it('links Alipay and WeChat Pay by mobile number, masked', async () => {
    const s = await student();
    const ali = await linkSource(db, s, { kind: 'wallet', provider: 'alipay', account: '138 1234 5678', holder: 'Zhang Wei' });
    const wx = await linkSource(db, s, { kind: 'wallet', provider: 'wechatpay', account: '+8613912345678', holder: 'Zhang Wei' });
    expect(ali).toMatchObject({ label: 'Alipay ••5678', currency: 'CNY' });
    expect(wx).toMatchObject({ label: 'WeChat Pay ••5678', currency: 'CNY' });
    await expect(linkSource(db, s, { kind: 'wallet', provider: 'wechatpay', account: '12345', holder: 'Z' })).rejects.toThrow(/mobile number/);
  });

  it('links a CCB debit card, refuses an invalid one, and tops up in CNY', async () => {
    const s = await student();
    const ccb = await linkSource(db, s, { kind: 'bank', bank: 'ccb', account: withLuhn('621700001234567890'), holder: 'Zhang Wei' });
    expect(ccb.label).toMatch(/^CCB ••\d{4}$/);
    await expect(linkSource(db, s, { kind: 'bank', bank: 'ccb', account: '6217000012345678901', holder: 'Z' })).rejects.toThrow();
    await topUpFromSource(db, s, { sourceId: ccb.id, amount: '5000.00', idempotencyKey: 'ccb-1' });
    expect(await balance(s.id, 'CNY')).toBe(1500000n);
  });

  it('moves money out to Alipay only on approval; a card cannot receive', async () => {
    if (!(await online())) return console.warn('skipped: offline');
    const s = await student();
    const ali = await linkSource(db, s, { kind: 'wallet', provider: 'alipay', account: '13812345678', holder: 'Zhang Wei' });
    const p = await proposeWithdrawal(db, s, { sourceId: ali.id, receiveAmount: '800.00', fromCurrency: 'GBP', proposedBy: 'agent' });
    expect(await balance(s.id, 'GBP')).toBe(50000n);
    await executeProposal(db, s, p.id, p.termsHash);
    expect(await balance(s.id, 'GBP')).toBeLessThan(50000n);
    expect((await listTransactions(db, s.id))[0]).toMatchObject({ kind: 'withdraw' });

    const card = await linkSource(db, s, { kind: 'card', number: '5555555555554444', expiry: '12/30', cvc: '123', holder: 'W', currency: 'GBP' });
    await expect(proposeWithdrawal(db, s, { sourceId: card.id, receiveAmount: '10.00', proposedBy: 'user' })).rejects.toThrow(/not a card/);
  });

  it('another student cannot use or remove my linked accounts, and a removed one voids its approval', async () => {
    const s = await student();
    const ali = await linkSource(db, s, { kind: 'wallet', provider: 'alipay', account: '13812345678', holder: 'Z' });
    const other = await student();
    await expect(topUpFromSource(db, other, { sourceId: ali.id, amount: '10.00', idempotencyKey: 'x-1' })).rejects.toThrow(/no such linked/);
    await expect(removeSource(db, other, ali.id)).rejects.toThrow(/no such linked/);

    const p = await proposeWithdrawal(db, s, { sourceId: ali.id, receiveAmount: '100.00', fromCurrency: 'CNY', proposedBy: 'user' });
    await removeSource(db, s, ali.id);
    await expect(executeProposal(db, s, p.id, p.termsHash)).rejects.toThrow(/changed or was removed/);
    expect(await balance(s.id, 'CNY')).toBe(1000000n);
  });
});
