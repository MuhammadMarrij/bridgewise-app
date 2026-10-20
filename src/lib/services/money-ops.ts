/**
 * Everyday wallet operations: add money, pay for things, send money to people,
 * read the statement, see where the money goes.
 *
 * Two authority levels, deliberately different:
 *   - The STUDENT acting in the app (add money, record a payment) has already
 *     confirmed on screen; those execute directly, idempotently.
 *   - Anything the ASSISTANT initiates, and every outbound transfer, is a
 *     proposal that executes only on approval (see wallet.executeProposal).
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { accounts, actionProposals, budgets, ledgerEntries, recipients, walletTransactions } from '../db/schema';
import {
  CURRENCY_REGISTRY,
  formatAmount,
  parseAmount,
  parseRate,
  sourcePrincipalFor,
  targetDeliverableFor,
  type Currency,
} from '../domain/money';
import { canonicalize } from '../policy/terms';
import { liveMidRate, rateTable } from '../rates/live';
import { appendAudit } from './audit';
import { AppError } from './errors';
import { CATEGORIES, postStatement, type Category } from './statement';
import { WALLET_FX_MARGIN_BPS, pocketsFor } from './wallet';
import type { ResolvedSession } from './workspace';
import { alipayIdentity } from '../connectors/live';

type Db = NodePgDatabase<Record<string, never>>;

/** Largest single top-up of test funds, in major units, to keep demos sane. */
const MAX_TOPUP_MAJOR = 5_000_000;

async function ensurePocket(db: Db, sessionId: string, currency: Currency) {
  const existing = (await pocketsFor(db, sessionId)).find((p) => p.currency === currency);
  if (existing) return existing;
  const made = await db.insert(accounts).values({ sessionId, label: `${currency} pocket`, currency, balanceMinor: 0n }).returning();
  return made[0]!;
}

/* ------------------------------------------------------------- add money */

/**
 * Adds test funds to a pocket, as a bank transfer in from home would. Real
 * inbound rails are an integration point; the ledger effect is the same.
 */
export async function topUp(
  db: Db,
  session: ResolvedSession,
  input: { currency: Currency; amount: string; source: string; idempotencyKey: string; linkedSourceId?: string },
) {
  const amount = parseAmount(input.amount, input.currency);
  if (amount <= 0n) throw new AppError('VALIDATION_FAILED', 'amount must be above zero');
  const exp = CURRENCY_REGISTRY[input.currency]!.exponent;
  if (amount > BigInt(MAX_TOPUP_MAJOR) * 10n ** BigInt(exp)) {
    throw new AppError('VALIDATION_FAILED', `a single top-up is limited to ${MAX_TOPUP_MAJOR.toLocaleString()} ${input.currency}`);
  }
  const pocket = await ensurePocket(db, session.id, input.currency);

  return db.transaction(async (tx) => {
    const dup = await tx.select().from(walletTransactions)
      .where(and(eq(walletTransactions.sessionId, session.id), eq(walletTransactions.idempotencyKey, input.idempotencyKey)));
    if (dup[0]) return { replay: true, balance: formatAmount(dup[0].balanceAfterMinor, input.currency) };

    const locked = (await tx.select().from(accounts).where(eq(accounts.id, pocket.id)).for('update'))[0]!;
    const after = locked.balanceMinor + amount;
    await tx.update(accounts).set({ balanceMinor: after, version: locked.version + 1 }).where(eq(accounts.id, locked.id));
    await tx.insert(ledgerEntries).values([
      { bucket: 'student_account', accountId: locked.id, currency: input.currency, signedMinor: amount },
      { bucket: 'funding', currency: input.currency, signedMinor: -amount },
    ]);
    await postStatement(tx as unknown as Db, {
      sessionId: session.id, accountId: locked.id, kind: 'topup', description: `Money in · ${input.source}`,
      category: 'income', currency: input.currency, amountMinor: amount, balanceAfterMinor: after,
      counterparty: input.source, idempotencyKey: input.idempotencyKey, linkedSourceId: input.linkedSourceId ?? null,
    });
    await appendAudit(tx as unknown as Db, {
      sessionId: session.id, correlationId: input.idempotencyKey, type: 'wallet.topup', actor: 'user', outcome: 'allowed',
      payload: { currency: input.currency, amount: input.amount },
    });
    return { replay: false, balance: formatAmount(after, input.currency) };
  });
}

/* ------------------------------------------------------------------ spend */

/** A purchase or bill the student pays from a pocket in the app. */
export async function recordSpend(
  db: Db,
  session: ResolvedSession,
  input: { currency: Currency; amount: string; merchant: string; category: Category; idempotencyKey: string },
) {
  if (!CATEGORIES.includes(input.category)) throw new AppError('VALIDATION_FAILED', 'unknown category');
  const amount = parseAmount(input.amount, input.currency);
  if (amount <= 0n) throw new AppError('VALIDATION_FAILED', 'amount must be above zero');
  const pocket = (await pocketsFor(db, session.id)).find((p) => p.currency === input.currency);
  if (!pocket) throw new AppError('NOT_FOUND', `you have no ${input.currency} pocket`);

  return db.transaction(async (tx) => {
    const dup = await tx.select().from(walletTransactions)
      .where(and(eq(walletTransactions.sessionId, session.id), eq(walletTransactions.idempotencyKey, input.idempotencyKey)));
    if (dup[0]) return { replay: true, balance: formatAmount(dup[0].balanceAfterMinor, input.currency) };

    // Paid with cash, WeChat or another card: it counts towards budgets and the
    // runway, but no BridgeWise money moved, so the balance and ledger stay as they are.
    const current = (await tx.select().from(accounts).where(eq(accounts.id, pocket.id)))[0]!;
    await postStatement(tx as unknown as Db, {
      sessionId: session.id, accountId: current.id, kind: 'spend', description: input.merchant,
      category: input.category, currency: input.currency, amountMinor: -amount, balanceAfterMinor: current.balanceMinor,
      counterparty: input.merchant, idempotencyKey: input.idempotencyKey, reference: 'Paid elsewhere',
    });
    return { replay: false, balance: formatAmount(current.balanceMinor, input.currency) };
  });
}

/* -------------------------------------------------------------- statement */

export async function listTransactions(
  db: Db,
  sessionId: string,
  opts: { currency?: string; category?: string; limit?: number } = {},
) {
  const rows = await db.select().from(walletTransactions)
    .where(eq(walletTransactions.sessionId, sessionId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(Math.min(opts.limit ?? 100, 300));
  return rows
    .filter((r) => (!opts.currency || r.currency === opts.currency) && (!opts.category || r.category === opts.category))
    .map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      kind: r.kind,
      description: r.description,
      category: r.category,
      currency: r.currency,
      amount: formatAmount(r.amountMinor, r.currency as Currency),
      balanceAfter: formatAmount(r.balanceAfterMinor, r.currency as Currency),
      counterparty: r.counterparty,
      reference: r.reference,
    }));
}

/* ------------------------------------------------------------- recipients */

export async function addRecipient(
  db: Db,
  session: ResolvedSession,
  input: { name: string; relationship: string; country: string; currency: Currency; accountLabel?: string; alipayAccount?: string; alipayName?: string },
) {
  // An Alipay payee is paid for real through Alipay's transfer API, always in CNY.
  const alipayId = input.alipayAccount ? alipayIdentity(input.alipayAccount) : null;
  if (alipayId && !input.alipayName?.trim()) throw new AppError('VALIDATION_FAILED', 'Alipay checks the real name on the account; enter it');
  if (!alipayId && !input.accountLabel?.trim()) throw new AppError('VALIDATION_FAILED', 'enter where the money goes');
  const masked = alipayId ? (alipayId.includes('@') ? `${alipayId[0]}•••@${alipayId.split('@')[1]}` : `••${alipayId.slice(-4)}`) : '';
  const rows = await db.insert(recipients).values({
    sessionId: session.id,
    name: input.name.trim().slice(0, 80),
    relationship: input.relationship.slice(0, 30),
    country: alipayId ? 'CN' : input.country.slice(0, 2).toUpperCase(),
    currency: alipayId ? 'CNY' : input.currency,
    accountLabel: alipayId ? `Alipay ${masked}` : input.accountLabel!.trim().slice(0, 60),
    rail: alipayId ? 'alipay' : 'none',
    payoutIdentity: alipayId,
    payoutName: alipayId ? input.alipayName!.trim().slice(0, 60) : null,
  }).returning();
  await appendAudit(db, {
    sessionId: session.id, correlationId: rows[0]!.id, type: 'recipient.added', actor: 'user', outcome: 'allowed',
    payload: { recipientId: rows[0]!.id, currency: input.currency },
  });
  return rows[0]!;
}

export async function listRecipients(db: Db, sessionId: string) {
  return db.select().from(recipients).where(eq(recipients.sessionId, sessionId));
}

/* ------------------------------------------------------------------- send */

export interface SendTerms {
  readonly kind: 'send';
  readonly sessionId: string;
  readonly recipientId: string;
  readonly recipientName: string;
  readonly accountLabel: string;
  readonly receiveAmount: string;
  readonly receiveCurrency: Currency;
  readonly fromPocketId: string;
  readonly fromCurrency: Currency;
  readonly debitAmount: string;
  readonly midRate: string | null;
  readonly customerRate: string | null;
  readonly marginBps: number;
  readonly feeAmount: string;
  readonly leftInPocketAfter: string;
  readonly note: string;
  readonly quotedAt: string;
}

/** Flat BridgeWise transfer fee, in the source currency's major units. */
const SEND_FEE_MAJOR = '0';

function withMargin(mid: string, bps: number): string {
  const places = 8;
  const scale = 10n ** BigInt(places);
  const [w = '0', f = ''] = mid.split('.');
  const scaled = BigInt(w) * scale + BigInt((f + '0'.repeat(places)).slice(0, places));
  const c = (scaled * BigInt(10_000 - bps)) / 10_000n;
  return `${c / scale}.${(c % scale).toString().padStart(places, '0')}`;
}

/**
 * Prices sending money to a saved recipient. The recipient receives exactly
 * `receiveAmount` in their currency; the student pays the live rate less the
 * disclosed spread. Creates a proposal; moves nothing.
 */
export async function proposeSend(
  db: Db,
  session: ResolvedSession,
  input: { recipientId: string; receiveAmount: string; fromCurrency?: Currency; note?: string; proposedBy: 'agent' | 'user' },
) {
  const r = (await db.select().from(recipients)
    .where(and(eq(recipients.id, input.recipientId), eq(recipients.sessionId, session.id))))[0];
  if (!r) throw new AppError('NOT_FOUND', 'no such recipient');
  if (r.rail !== 'alipay') {
    throw new AppError('UNSUPPORTED', `Sending to ${r.accountLabel} isn't available yet. BridgeWise pays Alipay accounts in China today.`);
  }
  const to = r.currency as Currency;
  const receive = parseAmount(input.receiveAmount, to);
  if (receive <= 0n) throw new AppError('VALIDATION_FAILED', 'amount must be above zero');

  const pockets = await pocketsFor(db, session.id);
  const pocket =
    (input.fromCurrency ? pockets.find((p) => p.currency === input.fromCurrency) : undefined) ??
    pockets.find((p) => p.currency === to && p.balanceMinor - p.reservedMinor >= receive) ??
    [...pockets].filter((p) => p.currency !== to).sort((a, b) => (b.balanceMinor > a.balanceMinor ? 1 : -1))[0];
  if (!pocket) throw new AppError('INSUFFICIENT_FUNDS', 'no pocket can fund this');
  const from = pocket.currency as Currency;

  let principal = receive;
  let mid: string | null = null;
  let customer: string | null = null;
  if (from !== to) {
    const live = await liveMidRate(from, to);
    mid = live.mid;
    customer = withMargin(live.mid, WALLET_FX_MARGIN_BPS);
    principal = sourcePrincipalFor(receive, parseRate(customer, from, to));
  }
  const fee = parseAmount(SEND_FEE_MAJOR, from);
  const debit = principal + fee;
  const available = pocket.balanceMinor - pocket.reservedMinor;
  if (debit > available) {
    throw new AppError('INSUFFICIENT_FUNDS', `this needs ${formatAmount(debit, from)} ${from}; you have ${formatAmount(available, from)}`);
  }

  const terms: SendTerms = {
    kind: 'send', sessionId: session.id,
    recipientId: r.id, recipientName: r.name, accountLabel: r.accountLabel,
    receiveAmount: formatAmount(receive, to), receiveCurrency: to,
    fromPocketId: pocket.id, fromCurrency: from,
    debitAmount: formatAmount(debit, from), midRate: mid, customerRate: customer,
    marginBps: from === to ? 0 : WALLET_FX_MARGIN_BPS, feeAmount: formatAmount(fee, from),
    leftInPocketAfter: formatAmount(available - debit, from),
    note: (input.note ?? '').slice(0, 80), quotedAt: new Date().toISOString(),
  };
  const hash = createHash('sha256').update(canonicalize(terms)).digest('hex');
  const rows = await db.insert(actionProposals).values({
    sessionId: session.id, kind: 'send',
    title: `Send ${terms.receiveAmount} ${to} to ${r.name}`,
    summary: from === to ? `From your ${from} pocket to ${r.accountLabel}.` : `Costs ${terms.debitAmount} ${from} at ${customer} (mid ${mid}).`,
    termsJson: terms, termsHash: hash, proposedBy: input.proposedBy,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  }).returning();
  return rows[0]!;
}

/* --------------------------------------------------------- spending + budget */

async function toDisplay(display: Currency) {
  const table = await rateTable(display).catch(() => null);
  return (minor: bigint, cur: Currency): bigint | null => {
    if (cur === display) return minor;
    const r = table?.rates[cur];
    if (!r) return null;
    const perDisplay = parseRate(r, display, cur);
    return targetDeliverableFor(minor, 0n, { ...perDisplay, numerator: perDisplay.denominator, denominator: perDisplay.numerator, from: cur, to: display });
  };
}

const OUTFLOW_KINDS = ['spend', 'bill', 'send'];

/** Where the money went in the last `days`, in one currency, by category. */
export async function spendingSummary(db: Db, sessionId: string, display: Currency, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.select().from(walletTransactions)
    .where(and(eq(walletTransactions.sessionId, sessionId), gte(walletTransactions.createdAt, since), inArray(walletTransactions.kind, OUTFLOW_KINDS)));
  const conv = await toDisplay(display);
  const by = new Map<string, bigint>();
  let total = 0n;
  let unconverted = 0;
  for (const r of rows) {
    const v = conv(-r.amountMinor, r.currency as Currency);
    if (v === null) { unconverted += 1; continue; }
    by.set(r.category, (by.get(r.category) ?? 0n) + v);
    total += v;
  }
  const categories = [...by].sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .map(([category, minor]) => ({ category, amount: formatAmount(minor, display), share: total ? Number((minor * 1000n) / total) / 10 : 0 }));

  // Runway: whole wallet in display currency over average daily outflow,
  // excluding one-off tuition so a single fee payment does not fake a crisis.
  const everyday = rows.filter((r) => r.category !== 'tuition');
  let daily = 0n;
  for (const r of everyday) daily += conv(-r.amountMinor, r.currency as Currency) ?? 0n;
  daily = days > 0 ? daily / BigInt(days) : 0n;
  const pockets = await db.select().from(accounts).where(eq(accounts.sessionId, sessionId));
  let wallet = 0n;
  for (const p of pockets) wallet += conv(p.balanceMinor, p.currency as Currency) ?? 0n;

  return {
    display,
    days,
    total: formatAmount(total, display),
    categories,
    transactions: rows.length,
    unconverted,
    averageDaily: formatAmount(daily, display),
    runwayDays: daily > 0n ? Number(wallet / daily) : null,
  };
}

export async function setBudget(db: Db, session: ResolvedSession, input: { category: Category; currency: Currency; monthlyLimit: string }) {
  if (!CATEGORIES.includes(input.category)) throw new AppError('VALIDATION_FAILED', 'unknown category');
  const limit = parseAmount(input.monthlyLimit, input.currency);
  if (limit <= 0n) throw new AppError('VALIDATION_FAILED', 'limit must be above zero');
  await db.insert(budgets)
    .values({ sessionId: session.id, category: input.category, currency: input.currency, monthlyLimitMinor: limit })
    .onConflictDoUpdate({ target: [budgets.sessionId, budgets.category], set: { currency: input.currency, monthlyLimitMinor: limit } });
}

/** Each budget with what has been spent against it this calendar month. */
export async function listBudgets(db: Db, sessionId: string) {
  const rows = await db.select().from(budgets).where(eq(budgets.sessionId, sessionId));
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const tx = await db.select().from(walletTransactions)
    .where(and(eq(walletTransactions.sessionId, sessionId), gte(walletTransactions.createdAt, start), inArray(walletTransactions.kind, OUTFLOW_KINDS)));
  const out = [];
  for (const b of rows) {
    const cur = b.currency as Currency;
    const conv = await toDisplay(cur);
    let spent = 0n;
    for (const t of tx.filter((x) => x.category === b.category)) spent += conv(-t.amountMinor, t.currency as Currency) ?? 0n;
    out.push({
      category: b.category, currency: cur,
      limit: formatAmount(b.monthlyLimitMinor, cur), spent: formatAmount(spent, cur),
      remaining: formatAmount(b.monthlyLimitMinor - spent, cur),
      percent: Number((spent * 1000n) / b.monthlyLimitMinor) / 10,
      over: spent > b.monthlyLimitMinor,
    });
  }
  return out;
}
