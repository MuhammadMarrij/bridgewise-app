import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { dbFor, testPool, truncateAll } from '../helpers/db';
import { accounts, ledgerEntries } from '@/lib/db/schema';
import { resolveSession } from '@/lib/services/workspace';
import {
  openStudentAccount, getWallet, proposeConversion, executeProposal, declineProposal, listProposals,
} from '@/lib/services/wallet';
import { formatAmount } from '@/lib/domain/money';

const pool: pg.Pool = testPool(8);
const db = dbFor(pool);

// Wallet pricing hits live rates. If the network is down these cannot run, and
// they say so rather than passing against a stub.
async function online() {
  try { await fetch('https://open.er-api.com/v6/latest/USD'); return true; } catch { return false; }
}

async function student() {
  const opened = await openStudentAccount(db, {
    name: 'Wei', homeCurrency: 'CNY', studyCurrency: 'GBP', homeBalance: '42000.00', studyBalance: '1850.00',
  });
  return resolveSession(db, opened.token);
}

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await pool.end(); });

describe('M1 wallet core', () => {
  it('opens one pocket per currency the student lives in', async () => {
    const s = await student();
    const pockets = await db.select().from(accounts).where(eq(accounts.sessionId, s.id));
    expect(pockets.map((p) => p.currency).sort()).toEqual(['CNY', 'GBP', 'USD']);
  });

  it('values the wallet in one currency at live rates', async () => {
    if (!(await online())) return console.warn('skipped: offline');
    const s = await student();
    const w = await getWallet(db, s.id, 'GBP');
    expect(w.totalInDisplay).not.toBeNull();
    // 1,850 GBP plus 42,000 CNY is worth more than 1,850 GBP alone.
    expect(Number(w.totalInDisplay)).toBeGreaterThan(1850);
    expect(w.rates?.source).toBeTruthy();
  });

  it('converts at a live rate only after approval, balanced per currency', async () => {
    if (!(await online())) return console.warn('skipped: offline');
    const s = await student();
    const p = await proposeConversion(db, s, { from: 'CNY', to: 'GBP', sellAmount: '10000.00', proposedBy: 'agent' });

    // Proposing moved nothing.
    let cny = (await db.select().from(accounts).where(eq(accounts.sessionId, s.id))).find((a) => a.currency === 'CNY')!;
    expect(formatAmount(cny.balanceMinor, 'CNY')).toBe('42000.00');

    const out = await executeProposal(db, s, p.id, p.termsHash);
    expect(out.replay).toBe(false);

    const after = await db.select().from(accounts).where(eq(accounts.sessionId, s.id));
    cny = after.find((a) => a.currency === 'CNY')!;
    const gbp = after.find((a) => a.currency === 'GBP')!;
    expect(formatAmount(cny.balanceMinor, 'CNY')).toBe('32000.00');
    const terms = p.termsJson as { buyAmount: string };
    expect(formatAmount(gbp.balanceMinor, 'GBP')).toBe(
      formatAmount(185000n + BigInt(terms.buyAmount.replace('.', '')), 'GBP'),
    );

    const entries = await db.select().from(ledgerEntries).where(eq(ledgerEntries.proposalId, p.id));
    for (const c of ['CNY', 'GBP']) {
      expect(entries.filter((e) => e.currency === c).reduce((a, e) => a + e.signedMinor, 0n)).toBe(0n);
    }
  });

  it('a replayed approval returns the original and moves nothing twice', async () => {
    if (!(await online())) return console.warn('skipped: offline');
    const s = await student();
    const p = await proposeConversion(db, s, { from: 'CNY', to: 'GBP', sellAmount: '5000.00', proposedBy: 'agent' });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => executeProposal(db, s, p.id, p.termsHash)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const cny = (await db.select().from(accounts).where(eq(accounts.sessionId, s.id))).find((a) => a.currency === 'CNY')!;
    expect(formatAmount(cny.balanceMinor, 'CNY')).toBe('37000.00');
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.proposalId, p.id))).toHaveLength(4);
  });

  it('refuses a tampered hash, another session, overdraft and a declined proposal', async () => {
    if (!(await online())) return console.warn('skipped: offline');
    const s = await student();
    const p = await proposeConversion(db, s, { from: 'CNY', to: 'GBP', sellAmount: '1000.00', proposedBy: 'agent' });
    await expect(executeProposal(db, s, p.id, 'f'.repeat(64))).rejects.toThrow(/terms changed/);

    const other = await student();
    await expect(executeProposal(db, other, p.id, p.termsHash)).rejects.toThrow(/no such proposal/);

    await expect(
      proposeConversion(db, s, { from: 'CNY', to: 'GBP', sellAmount: '999999.00', proposedBy: 'agent' }),
    ).rejects.toThrow(/available/);

    await declineProposal(db, s, p.id);
    await expect(executeProposal(db, s, p.id, p.termsHash)).rejects.toThrow(/declined/);
    expect((await listProposals(db, s.id, true))).toHaveLength(0);
  });
});
