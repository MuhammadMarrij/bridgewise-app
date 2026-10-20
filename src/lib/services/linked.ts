/**
 * Linked sources: cards, Alipay, WeChat Pay and bank accounts on the wallet.
 *
 * Adding money from a linked source is the student's own action and executes
 * directly (idempotently). Sending money OUT to one is a proposal, approved like
 * any other movement — including when the assistant suggests it.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { actionProposals, linkedSources } from '../db/schema';
import {
  CONNECTOR_MODE, ConnectorError, linkBank, linkCard, linkWallet, pull,
  type BankId, type LinkResult, type SourceKind, WALLET_PROVIDERS,
} from '../connectors';
import { formatAmount, parseAmount, parseRate, sourcePrincipalFor, type Currency } from '../domain/money';
import { canonicalize } from '../policy/terms';
import { liveMidRate } from '../rates/live';
import { appendAudit } from './audit';
import { AppError } from './errors';
import { topUp } from './money-ops';
import { WALLET_FX_MARGIN_BPS, pocketsFor } from './wallet';
import type { ResolvedSession } from './workspace';
import { alipayIdentity } from '../connectors/live';

type Db = NodePgDatabase<Record<string, never>>;

export type LinkInput =
  | { kind: 'card'; number: string; expiry: string; cvc: string; holder: string; currency: Currency }
  | { kind: 'wallet'; provider: keyof typeof WALLET_PROVIDERS; account: string; holder: string }
  | { kind: 'bank'; bank: BankId; account: string; holder: string };

function asAppError(e: unknown): never {
  if (e instanceof ConnectorError) {
    throw new AppError(
      e.code === 'DECLINED' ? 'INSUFFICIENT_FUNDS' : e.code === 'NOT_CONFIGURED' ? 'DEPENDENCY_UNAVAILABLE' : 'VALIDATION_FAILED',
      e.message,
    );
  }
  throw e;
}

export async function linkSource(db: Db, session: ResolvedSession, input: LinkInput) {
  let r: LinkResult;
  let provider: string;
  try {
    if (input.kind === 'card') { r = linkCard(input); provider = r.brand!; }
    else if (input.kind === 'wallet') { r = linkWallet(input); provider = input.provider; }
    else { r = linkBank(input); provider = input.bank; }
  } catch (e) { asAppError(e); }

  const dup = await db.select().from(linkedSources).where(and(
    eq(linkedSources.sessionId, session.id), eq(linkedSources.token, r!.token), eq(linkedSources.status, 'ACTIVE'),
  ));
  if (dup[0]) throw new AppError('VALIDATION_FAILED', `${dup[0].label} is already linked`);

  const rows = await db.insert(linkedSources).values({
    sessionId: session.id, kind: input.kind, provider: provider!, label: r!.label, last4: r!.last4, brand: r!.brand,
    currency: r!.currency, holder: r!.holder, expiry: r!.expiry, token: r!.token, connectorMode: CONNECTOR_MODE,
    payoutIdentity: input.kind === 'wallet' && input.provider === 'alipay' ? alipayIdentity(input.account) : null,
  }).returning();
  await appendAudit(db, {
    sessionId: session.id, correlationId: rows[0]!.id, type: 'source.linked', actor: 'user', outcome: 'allowed',
    payload: { kind: input.kind, provider: provider!, label: r!.label, mode: CONNECTOR_MODE },
  });
  const { token: _t, ...safe } = rows[0]!;
  return safe;
}

export async function listSources(db: Db, sessionId: string) {
  const rows = await db.select().from(linkedSources)
    .where(and(eq(linkedSources.sessionId, sessionId), eq(linkedSources.status, 'ACTIVE')));
  // The token never leaves the server.
  return rows.map(({ token: _t, ...safe }) => safe);
}

export async function removeSource(db: Db, session: ResolvedSession, id: string) {
  const out = await db.update(linkedSources).set({ status: 'REMOVED' })
    .where(and(eq(linkedSources.id, id), eq(linkedSources.sessionId, session.id))).returning();
  if (!out[0]) throw new AppError('NOT_FOUND', 'no such linked source');
}

async function ownedSource(db: Db, sessionId: string, id: string) {
  const s = (await db.select().from(linkedSources).where(and(
    eq(linkedSources.id, id), eq(linkedSources.sessionId, sessionId), eq(linkedSources.status, 'ACTIVE'),
  )))[0];
  if (!s) throw new AppError('NOT_FOUND', 'no such linked source');
  return s;
}

/** Charge a card or pull from Alipay / WeChat Pay / a bank into the pocket of that currency. */
export async function topUpFromSource(
  db: Db, session: ResolvedSession, input: { sourceId: string; amount: string; idempotencyKey: string },
) {
  const src = await ownedSource(db, session.id, input.sourceId);
  const cur = src.currency as Currency;
  const minor = parseAmount(input.amount, cur);
  const res = pull(src.kind as SourceKind, src.token, src.last4, minor);
  if (!res.ok) {
    await appendAudit(db, {
      sessionId: session.id, correlationId: input.idempotencyKey, type: 'topup.declined', actor: 'user', outcome: 'denied',
      reason: res.declineReason ?? 'declined', payload: { source: src.label },
    });
    throw new AppError('INSUFFICIENT_FUNDS', `${src.label}: ${res.declineReason}`);
  }
  return topUp(db, session, {
    currency: cur, amount: input.amount, source: `${src.label} · ${res.reference}`,
    idempotencyKey: input.idempotencyKey, linkedSourceId: src.id,
  });
}

export interface WithdrawTerms {
  readonly kind: 'withdraw';
  readonly sessionId: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly sourceKind: string;
  readonly receiveAmount: string;
  readonly receiveCurrency: Currency;
  readonly fromPocketId: string;
  readonly fromCurrency: Currency;
  readonly debitAmount: string;
  readonly midRate: string | null;
  readonly customerRate: string | null;
  readonly leftInPocketAfter: string;
  readonly quotedAt: string;
}

function withMargin(mid: string, bps: number): string {
  const places = 8;
  const scale = 10n ** 8n;
  const [w = '0', f = ''] = mid.split('.');
  const c = ((BigInt(w) * scale + BigInt((f + '0'.repeat(places)).slice(0, places))) * BigInt(10_000 - bps)) / 10_000n;
  return `${c / scale}.${(c % scale).toString().padStart(places, '0')}`;
}

/** Prepare moving money out to the student's own Alipay, WeChat Pay or bank account. */
export async function proposeWithdrawal(
  db: Db, session: ResolvedSession,
  input: { sourceId: string; receiveAmount: string; fromCurrency?: Currency; proposedBy: 'agent' | 'user' },
) {
  const src = await ownedSource(db, session.id, input.sourceId);
  if (src.kind === 'card') throw new AppError('UNSUPPORTED', 'withdrawals go to a bank account or mobile wallet, not a card');
  if (src.provider !== 'alipay') throw new AppError('UNSUPPORTED', `Moving money to ${src.label} isn't available yet. BridgeWise can pay out to Alipay today.`);
  if (!src.payoutIdentity || !src.holder) throw new AppError('UNSUPPORTED', 'Link your Alipay again with its account and real name to move money out');
  const to = src.currency as Currency;
  const receive = parseAmount(input.receiveAmount, to);
  if (receive <= 0n) throw new AppError('VALIDATION_FAILED', 'amount must be above zero');
  const pockets = await pocketsFor(db, session.id);
  const pocket = (input.fromCurrency ? pockets.find((p) => p.currency === input.fromCurrency) : undefined)
    ?? pockets.find((p) => p.currency === to)
    ?? [...pockets].sort((a, b) => (b.balanceMinor > a.balanceMinor ? 1 : -1))[0];
  if (!pocket) throw new AppError('INSUFFICIENT_FUNDS', 'no pocket can fund this');
  const from = pocket.currency as Currency;
  let debit = receive;
  let mid: string | null = null;
  let customer: string | null = null;
  if (from !== to) {
    mid = (await liveMidRate(from, to)).mid;
    customer = withMargin(mid, WALLET_FX_MARGIN_BPS);
    debit = sourcePrincipalFor(receive, parseRate(customer, from, to));
  }
  const available = pocket.balanceMinor - pocket.reservedMinor;
  if (debit > available) {
    throw new AppError('INSUFFICIENT_FUNDS', `this needs ${formatAmount(debit, from)} ${from}; you have ${formatAmount(available, from)}`);
  }

  const terms: WithdrawTerms = {
    kind: 'withdraw', sessionId: session.id, sourceId: src.id, sourceLabel: src.label, sourceKind: src.kind,
    receiveAmount: formatAmount(receive, to), receiveCurrency: to, fromPocketId: pocket.id, fromCurrency: from,
    debitAmount: formatAmount(debit, from), midRate: mid, customerRate: customer,
    leftInPocketAfter: formatAmount(available - debit, from), quotedAt: new Date().toISOString(),
  };
  const rows = await db.insert(actionProposals).values({
    sessionId: session.id, kind: 'withdraw',
    title: `Move ${terms.receiveAmount} ${to} to ${src.label}`,
    summary: from === to ? `From your ${from} pocket.` : `Costs ${terms.debitAmount} ${from} at ${customer} (mid ${mid}).`,
    termsJson: terms, termsHash: createHash('sha256').update(canonicalize(terms)).digest('hex'),
    proposedBy: input.proposedBy, expiresAt: new Date(Date.now() + 10 * 60_000),
  }).returning();
  return rows[0]!;
}
