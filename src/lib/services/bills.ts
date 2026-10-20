/**
 * Bills: read an invoice, record it, pay it from the wallet.
 *
 * Extraction is deterministic on purpose. A language model reading "USD 8,000"
 * as 80,000 is an expensive mistake, so the numbers come from a parser the
 * student can see and correct; the assistant explains, it does not transcribe.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { actionProposals, beneficiaries, obligations, accounts } from '../db/schema';
import {
  CURRENCY_REGISTRY,
  formatAmount,
  parseAmount,
  parseRate,
  sourcePrincipalFor,
  type Currency,
} from '../domain/money';
import { canonicalize } from '../policy/terms';
import { liveMidRate } from '../rates/live';
import { AppError } from './errors';
import { createObligation, resolveDeadline } from './intake';
import { appendAudit } from './audit';
import { alipayIdentity } from '../connectors/live';
import { WALLET_FX_MARGIN_BPS, pocketsFor } from './wallet';
import type { ResolvedSession } from './workspace';

type Db = NodePgDatabase<Record<string, never>>;

/* -------------------------------------------------------------- extraction */

export interface ExtractedInvoice {
  readonly amount: string | null;
  readonly currency: Currency | null;
  readonly dueDate: string | null;
  readonly reference: string | null;
  readonly payee: string | null;
  /** Fields we could not find, so the interface can ask for exactly those. */
  readonly missing: readonly string[];
}

const SYMBOL: Record<string, Currency> = { '£': 'GBP', '$': 'USD', '€': 'EUR', '¥': 'CNY', '₹': 'INR', 'Rs': 'PKR' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

function findDate(text: string): string | null {
  const near = text.match(/(?:due|pay(?:ment)?\s+by|deadline|before)[^\n\d]{0,20}([^\n]{0,40})/i)?.[1] ?? text;
  for (const chunk of [near, text]) {
    let m = chunk.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
    m = chunk.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
    if (m && MONTHS.includes(m[2]!.slice(0, 3).toLowerCase())) return isoDate(+m[3]!, MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, +m[1]!);
    m = chunk.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
    if (m && MONTHS.includes(m[1]!.slice(0, 3).toLowerCase())) return isoDate(+m[3]!, MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, +m[2]!);
    m = chunk.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return isoDate(+m[3]!, +m[2]!, +m[1]!); // day-first, the international default
  }
  return null;
}

function findAmount(text: string): { amount: string; currency: Currency } | null {
  // Prefer a line that says what is owed, over any number on the page.
  const lines = text.split(/\n/);
  const ranked = [
    ...lines.filter((l) => /(amount\s+due|balance\s+due|total\s+due|total|amount|payable|fee)/i.test(l)),
    ...lines,
  ];
  for (const line of ranked) {
    const m =
      line.match(/\b([A-Z]{3})\s*([\d,]+(?:\.\d{1,3})?)/) ??
      line.match(/(£|\$|€|¥|₹|Rs\.?)\s*([\d,]+(?:\.\d{1,3})?)/) ??
      line.match(/([\d,]+(?:\.\d{1,3})?)\s*([A-Z]{3})\b/);
    if (!m) continue;
    let code = m[1]!;
    let num = m[2]!;
    if (/^[\d,]/.test(code)) [num, code] = [m[1]!, m[2]!];
    const currency = (SYMBOL[code.replace('.', '')] ?? code) as Currency;
    if (!CURRENCY_REGISTRY[currency]) continue;
    const value = num.replace(/,/g, '');
    const exp = CURRENCY_REGISTRY[currency]!.exponent;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    return { amount: exp === 0 ? Math.round(n).toString() : n.toFixed(exp), currency };
  }
  return null;
}

export function extractInvoice(text: string): ExtractedInvoice {
  const clean = text.slice(0, 8000);
  const money = findAmount(clean);
  const reference =
    clean.match(/(?:student\s*(?:id|no|number)|reference|ref\.?|invoice\s*(?:no|number|#))\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,30})/i)?.[1] ?? null;
  const payee =
    clean.match(/(?:pay(?:able)?\s+to|payee|beneficiary)\s*[:\-]?\s*([^\n]{3,80})/i)?.[1]?.trim() ??
    clean.match(/([A-Z][A-Za-z&.' ]{2,60}(?:University|College|Institute|School)[A-Za-z ]{0,30})/)?.[1]?.trim() ??
    null;
  const dueDate = findDate(clean);
  const out = { amount: money?.amount ?? null, currency: money?.currency ?? null, dueDate, reference, payee };
  return { ...out, missing: Object.entries(out).filter(([, v]) => !v).map(([k]) => k) };
}

/* ------------------------------------------------------------------ record */

export async function addBill(
  db: Db,
  session: ResolvedSession,
  input: {
    description: string;
    amount: string;
    currency: Currency;
    payee: string;
    reference: string;
    dueDate: string;
    dueTime?: string;
    timezone?: string;
    reserve: string;
    reserveCurrency: Currency;
    alipayAccount?: string;
    alipayName?: string;
  },
) {
  // A payee with an Alipay account is paid for real; Alipay checks the real name.
  const alipayId = input.alipayAccount ? alipayIdentity(input.alipayAccount) : null;
  if (alipayId && !input.alipayName?.trim()) throw new AppError('VALIDATION_FAILED', 'Alipay checks the real name on the account; enter it');
  if (alipayId && input.currency !== 'CNY') throw new AppError('VALIDATION_FAILED', 'Alipay pays in CNY; enter the bill in CNY');
  const made = await createObligation(db, session, {
    description: input.description,
    amount: input.amount,
    currency: input.currency,
    beneficiaryName: input.payee,
    beneficiaryReference: input.reference,
    deadlineDate: input.dueDate,
    deadlineTime: input.dueTime ?? '17:00',
    deadlineTimezone: input.timezone ?? 'UTC',
    reserveAmount: input.reserve,
    reserveCurrency: input.reserveCurrency,
  });
  if (alipayId) {
    const ob = (await db.select().from(obligations).where(eq(obligations.id, made.obligationId)))[0]!;
    await db.update(beneficiaries).set({ payoutIdentity: alipayId, payoutName: input.alipayName!.trim().slice(0, 60) })
      .where(eq(beneficiaries.id, ob.beneficiaryId));
  }
  return made;
}

/**
 * The student paid a set-aside bill through the payee's own channel. The
 * reservation is released and the bill is recorded as paid; no BridgeWise money moves.
 */
export async function markBillPaid(db: Db, session: ResolvedSession, obligationId: string) {
  return db.transaction(async (tx) => {
    const bill = (await tx.select().from(obligations)
      .where(and(eq(obligations.id, obligationId), eq(obligations.sessionId, session.id))).for('update'))[0];
    if (!bill) throw new AppError('NOT_FOUND', 'no such bill');
    if (bill.paidAt) throw new AppError('ALREADY_EXECUTED', 'this bill is already paid');
    if (bill.setAsideMinor > 0n && bill.setAsideAccountId) {
      const acct = (await tx.select().from(accounts).where(eq(accounts.id, bill.setAsideAccountId)).for('update'))[0]!;
      await tx.update(accounts).set({ reservedMinor: acct.reservedMinor - bill.setAsideMinor, version: acct.version + 1 }).where(eq(accounts.id, acct.id));
    }
    const now = new Date();
    await tx.update(obligations).set({ paidAt: now, setAsideMinor: 0n }).where(eq(obligations.id, bill.id));
    await appendAudit(tx as unknown as Db, {
      sessionId: session.id, correlationId: bill.id, type: 'bill.marked_paid', actor: 'user', outcome: 'allowed',
      payload: { obligationId: bill.id, released: bill.setAsideMinor.toString() },
    });
    return { paid: true };
  });
}

/* --------------------------------------------------------------------- pay */

export interface BillPaymentTerms {
  readonly kind: 'pay_bill';
  readonly sessionId: string;
  readonly obligationId: string;
  readonly obligationVersion: number;
  readonly beneficiaryId: string;
  readonly beneficiaryReference: string;
  readonly payee: string;
  readonly billAmount: string;
  readonly billCurrency: Currency;
  readonly fromPocketId: string;
  readonly fromCurrency: Currency;
  readonly debitAmount: string;
  readonly midRate: string | null;
  readonly customerRate: string | null;
  readonly marginBps: number;
  readonly leftInPocketAfter: string;
  readonly reserve: string;
  readonly dueAt: string;
  readonly quotedAt: string;
  /** alipay: paid for real into the payee's Alipay. set_aside: reserved until the student pays it elsewhere. */
  readonly rail: 'alipay' | 'set_aside';
  readonly payeeAccount: string | null;
}

const hashOf = (t: object) => createHash('sha256').update(canonicalize(t)).digest('hex');

function withMargin(mid: string, bps: number): string {
  const places = 8;
  const scale = 10n ** BigInt(places);
  const [w = '0', f = ''] = mid.split('.');
  const scaled = BigInt(w) * scale + BigInt((f + '0'.repeat(places)).slice(0, places));
  const c = (scaled * BigInt(10_000 - bps)) / 10_000n;
  return `${c / scale}.${(c % scale).toString().padStart(places, '0')}`;
}

/**
 * Prices paying a bill from one of the student's pockets and records it as a
 * PENDING proposal. If the pocket holds the bill's currency there is no FX;
 * otherwise the live rate less our disclosed spread. Refuses a payment that would
 * take the pocket below the living reserve the student set on the bill.
 */
export async function proposeBillPayment(
  db: Db,
  session: ResolvedSession,
  input: { obligationId: string; fromCurrency?: Currency; proposedBy: 'agent' | 'user' },
) {
  const bill = (
    await db.select().from(obligations)
      .where(and(eq(obligations.id, input.obligationId), eq(obligations.sessionId, session.id)))
  )[0];
  if (!bill) throw new AppError('NOT_FOUND', 'no such bill');
  if (bill.paidAt) throw new AppError('ALREADY_EXECUTED', 'this bill has already been paid');
  const payee = (await db.select().from(beneficiaries).where(eq(beneficiaries.id, bill.beneficiaryId)))[0];
  if (!payee) throw new AppError('NOT_FOUND', 'payee not found');

  const billCurrency = bill.currency as Currency;
  const pockets = await pocketsFor(db, session.id);
  // Default: the bill's own currency if it covers it, else the largest other pocket.
  const same = pockets.find((p) => p.currency === billCurrency && p.balanceMinor - p.reservedMinor >= bill.targetMinor);
  const pocket =
    (input.fromCurrency ? pockets.find((p) => p.currency === input.fromCurrency) : undefined) ??
    same ??
    [...pockets].filter((p) => p.currency !== billCurrency).sort((a, b) => (b.balanceMinor > a.balanceMinor ? 1 : -1))[0];
  if (!pocket) throw new AppError('INSUFFICIENT_FUNDS', 'no pocket can pay this');
  const from = pocket.currency as Currency;

  let debit = bill.targetMinor;
  let mid: string | null = null;
  let customer: string | null = null;
  if (from !== billCurrency) {
    const live = await liveMidRate(from, billCurrency);
    mid = live.mid;
    customer = withMargin(live.mid, WALLET_FX_MARGIN_BPS);
    debit = sourcePrincipalFor(bill.targetMinor, parseRate(customer, from, billCurrency));
  }

  const available = pocket.balanceMinor - pocket.reservedMinor;
  if (debit > available) {
    throw new AppError('INSUFFICIENT_FUNDS', `this needs ${formatAmount(debit, from)} ${from}; you have ${formatAmount(available, from)} available`);
  }
  const reserveMinor = bill.reserveCurrency === from ? bill.reserveMinor : 0n;
  if (available - debit < reserveMinor) {
    throw new AppError(
      'BREACHES_RESERVE',
      `paying this from ${from} would leave ${formatAmount(available - debit, from)}, below the ${formatAmount(reserveMinor, from)} you keep to live on`,
    );
  }

  const terms: BillPaymentTerms = {
    kind: 'pay_bill',
    sessionId: session.id,
    obligationId: bill.id,
    obligationVersion: bill.version,
    beneficiaryId: payee.id,
    beneficiaryReference: payee.reference,
    payee: payee.displayName,
    billAmount: formatAmount(bill.targetMinor, billCurrency),
    billCurrency,
    fromPocketId: pocket.id,
    fromCurrency: from,
    debitAmount: formatAmount(debit, from),
    midRate: mid,
    customerRate: customer,
    marginBps: from === billCurrency ? 0 : WALLET_FX_MARGIN_BPS,
    leftInPocketAfter: formatAmount(available - debit, from),
    reserve: formatAmount(bill.reserveMinor, bill.reserveCurrency as Currency),
    dueAt: bill.deadlineAt.toISOString(),
    quotedAt: new Date().toISOString(),
    rail: payee.payoutIdentity && billCurrency === 'CNY' ? 'alipay' : 'set_aside',
    payeeAccount: payee.payoutIdentity,
  };

  const rows = await db.insert(actionProposals).values({
    sessionId: session.id,
    kind: 'pay_bill',
    title: terms.rail === 'alipay'
      ? `Pay ${terms.billAmount} ${billCurrency} to ${payee.displayName} through Alipay`
      : `Set aside ${terms.billAmount} ${billCurrency} for ${payee.displayName}`,
    summary:
      from === billCurrency
        ? `From your ${from} pocket. Reference ${payee.reference}.`
        : `Costs ${terms.debitAmount} ${from} at ${customer} (mid ${mid}). Reference ${payee.reference}.`,
    termsJson: terms,
    termsHash: hashOf(terms),
    proposedBy: input.proposedBy,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  }).returning();
  return rows[0]!;
}

export { resolveDeadline, parseAmount };
