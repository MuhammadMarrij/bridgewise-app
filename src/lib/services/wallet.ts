/**
 * The wallet: one pocket per currency, valued live, moved only on approval.
 *
 * This is BridgeWise's own core ledger. Moving money between a student's own
 * pockets is exactly what a bank does inside its books; nothing here pretends to
 * settle with an outside institution.
 *
 * The agent can PROPOSE a conversion. Only {@link executeProposal}, reached from
 * the student's approval, moves money — inside one transaction, with the pockets
 * locked, against a hash of the exact terms the student saw.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { accounts, actionProposals, beneficiaries, ledgerEntries, linkedSources, obligations, recipients, sessions } from '../db/schema';
import { push as connectorPush } from '../connectors';
import {
  CURRENCY_REGISTRY,
  formatAmount,
  parseAmount,
  parseRate,
  targetDeliverableFor,
  type Currency,
} from '../domain/money';
import { canonicalize, hashSecret } from '../policy/terms';
import { liveMidRate, rateTable, type RateTable } from '../rates/live';
import { appendAudit } from './audit';
import { AppError } from './errors';
import { postStatement } from './statement';
import type { ResolvedSession } from './workspace';

type Db = NodePgDatabase<Record<string, never>>;

/**
 * BridgeWise's own conversion spread, charged on wallet FX and disclosed on
 * every quote. Lower than most banks; this is the business model, stated.
 */
export const WALLET_FX_MARGIN_BPS = Number(process.env.WALLET_FX_MARGIN_BPS ?? 30);
const PROPOSAL_TTL_MS = 10 * 60_000;

/* ------------------------------------------------------------- onboarding */

export interface StudentProfile {
  readonly name: string;
  /** Where family money comes from, e.g. CNY. */
  readonly homeCurrency: Currency;
  /** Where tuition and rent are paid, e.g. GBP. */
  readonly studyCurrency: Currency;
  readonly homeBalance: string;
  readonly studyBalance: string;
}

export interface CreatedStudent {
  readonly sessionId: string;
  readonly token: string;
}

/**
 * Opens a student's account: a session and a pocket for each currency they
 * live in. Balances are whatever the student enters at onboarding.
 */
export async function openStudentAccount(db: Db, profile: StudentProfile): Promise<CreatedStudent> {
  if (profile.homeCurrency === profile.studyCurrency) {
    throw new AppError('VALIDATION_FAILED', 'home and study currencies should differ', {
      studyCurrency: 'pick the currency you pay tuition in',
    });
  }
  const token = randomBytes(32).toString('base64url');
  const sessionRows = await db
    .insert(sessions)
    .values({
      tokenHash: hashSecret(token),
      scenarioVersion: `student:${profile.homeCurrency}-${profile.studyCurrency}`,
      clockKind: 'real',
      scenarioNow: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
    })
    .returning();
  const session = sessionRows[0]!;

  const pockets = new Map<Currency, bigint>([
    [profile.studyCurrency, parseAmount(profile.studyBalance, profile.studyCurrency)],
    [profile.homeCurrency, parseAmount(profile.homeBalance, profile.homeCurrency)],
  ]);
  // A USD pocket is the common third currency for international students.
  if (!pockets.has('USD')) pockets.set('USD', 0n);

  const opened = await db.insert(accounts).values(
    [...pockets].map(([currency, balanceMinor]) => ({
      sessionId: session.id,
      label: `${currency} pocket`,
      currency,
      balanceMinor,
    })),
  ).returning();
  for (const a of opened) {
    if (a.balanceMinor <= 0n) continue;
    await db.insert(ledgerEntries).values([
      { bucket: 'student_account', accountId: a.id, currency: a.currency, signedMinor: a.balanceMinor },
      { bucket: 'funding', currency: a.currency, signedMinor: -a.balanceMinor },
    ]);
    await postStatement(db, {
      sessionId: session.id, accountId: a.id, kind: 'opening', description: 'Opening balance',
      category: 'income', currency: a.currency, amountMinor: a.balanceMinor, balanceAfterMinor: a.balanceMinor,
    });
  }

  await appendAudit(db, {
    sessionId: session.id,
    correlationId: session.id,
    type: 'account.opened',
    actor: 'user',
    outcome: 'allowed',
    payload: { name: profile.name.slice(0, 40), home: profile.homeCurrency, study: profile.studyCurrency },
  });

  return { sessionId: session.id, token };
}

/* ------------------------------------------------------------------ wallet */

export interface Pocket {
  readonly id: string;
  readonly currency: Currency;
  readonly label: string;
  readonly balance: string;
  readonly available: string;
  /** Value in the student's display currency at the live rate, or null if unknown. */
  readonly valueInDisplay: string | null;
}

export interface WalletView {
  readonly pockets: readonly Pocket[];
  readonly displayCurrency: Currency;
  /** Total across pockets, in the display currency. Labelled indicative. */
  readonly totalInDisplay: string | null;
  readonly rates: Pick<RateTable, 'source' | 'asOf'> | null;
}

export async function pocketsFor(db: Db, sessionId: string) {
  return db.select().from(accounts).where(eq(accounts.sessionId, sessionId)).orderBy(asc(accounts.label));
}

/**
 * Every pocket, plus an indicative total in one currency at live rates. The
 * total is a valuation, not spendable money, and the interface says so.
 */
export async function getWallet(db: Db, sessionId: string, displayCurrency: Currency): Promise<WalletView> {
  const rows = await pocketsFor(db, sessionId);
  let table: RateTable | null = null;
  try {
    table = await rateTable(displayCurrency);
  } catch {
    table = null;
  }

  const displayExp = CURRENCY_REGISTRY[displayCurrency]?.exponent ?? 2;
  let totalMinor = 0n;
  let totalKnown = true;

  const pockets: Pocket[] = rows.map((a) => {
    const cur = a.currency as Currency;
    let valueInDisplay: string | null = null;
    if (cur === displayCurrency) {
      valueInDisplay = formatAmount(a.balanceMinor, cur);
      totalMinor += a.balanceMinor;
    } else if (table?.rates[cur]) {
      // table.rates[cur] is CUR per DISPLAY; value = balance / that rate.
      const perDisplay = parseRate(table.rates[cur]!, displayCurrency, cur);
      const valueMinor = targetDeliverableFor(
        a.balanceMinor,
        0n,
        // invert: DISPLAY per CUR
        { ...perDisplay, numerator: perDisplay.denominator, denominator: perDisplay.numerator, from: cur, to: displayCurrency },
      );
      valueInDisplay = formatAmount(valueMinor, displayCurrency);
      totalMinor += valueMinor;
    } else {
      totalKnown = false;
    }
    return {
      id: a.id,
      currency: cur,
      label: a.label,
      balance: formatAmount(a.balanceMinor, cur),
      available: formatAmount(a.balanceMinor - a.reservedMinor, cur),
      valueInDisplay,
    };
  });

  void displayExp;
  return {
    pockets,
    displayCurrency,
    totalInDisplay: totalKnown ? formatAmount(totalMinor, displayCurrency) : null,
    rates: table ? { source: table.source, asOf: table.asOf } : null,
  };
}

/* --------------------------------------------------------------- proposals */

export interface ConversionTerms {
  readonly kind: 'convert';
  readonly sessionId: string;
  readonly fromPocketId: string;
  readonly toPocketId: string;
  readonly from: Currency;
  readonly to: Currency;
  readonly sellAmount: string;
  readonly buyAmount: string;
  readonly midRate: string;
  readonly customerRate: string;
  readonly marginBps: number;
  readonly marginCostInTarget: string;
  readonly rateSource: string;
  readonly rateAsOf: string;
  readonly quotedAt: string;
}

function hashOf(terms: object): string {
  return createHash('sha256').update(canonicalize(terms)).digest('hex');
}

/** Customer rate = mid less our disclosed spread, in exact integer arithmetic. */
function withMargin(mid: string, bps: number): string {
  const places = 8;
  const scale = 10n ** BigInt(places);
  const [w = '0', f = ''] = mid.split('.');
  const midScaled = BigInt(w) * scale + BigInt((f + '0'.repeat(places)).slice(0, places));
  const customer = (midScaled * BigInt(10_000 - bps)) / 10_000n;
  return `${customer / scale}.${(customer % scale).toString().padStart(places, '0')}`;
}

/**
 * Prices a conversion between two of the student's pockets at the live rate and
 * records it as a PENDING proposal. Moves nothing.
 */
export async function proposeConversion(
  db: Db,
  session: ResolvedSession,
  input: { from: Currency; to: Currency; sellAmount: string; proposedBy: 'agent' | 'user' },
) {
  if (input.from === input.to) throw new AppError('VALIDATION_FAILED', 'pick two different currencies');
  const pockets = await pocketsFor(db, session.id);
  const fromPocket = pockets.find((p) => p.currency === input.from);
  if (!fromPocket) throw new AppError('NOT_FOUND', `you have no ${input.from} pocket`);
  let toPocket = pockets.find((p) => p.currency === input.to);
  if (!toPocket) {
    // Opening a pocket is free and moves no money, so it does not need approval.
    const made = await db
      .insert(accounts)
      .values({ sessionId: session.id, label: `${input.to} pocket`, currency: input.to, balanceMinor: 0n })
      .returning();
    toPocket = made[0]!;
  }

  const sellMinor = parseAmount(input.sellAmount, input.from);
  if (sellMinor <= 0n) throw new AppError('VALIDATION_FAILED', 'amount must be above zero');
  if (sellMinor > fromPocket.balanceMinor - fromPocket.reservedMinor) {
    throw new AppError('INSUFFICIENT_FUNDS', `you have ${formatAmount(fromPocket.balanceMinor - fromPocket.reservedMinor, input.from)} ${input.from} available`);
  }

  const mid = await liveMidRate(input.from, input.to);
  const customerRate = withMargin(mid.mid, WALLET_FX_MARGIN_BPS);
  const rateCustomer = parseRate(customerRate, input.from, input.to);
  const rateMid = parseRate(mid.mid, input.from, input.to);
  const buyMinor = targetDeliverableFor(sellMinor, 0n, rateCustomer);
  const atMid = targetDeliverableFor(sellMinor, 0n, rateMid);

  const terms: ConversionTerms = {
    kind: 'convert',
    sessionId: session.id,
    fromPocketId: fromPocket.id,
    toPocketId: toPocket.id,
    from: input.from,
    to: input.to,
    sellAmount: formatAmount(sellMinor, input.from),
    buyAmount: formatAmount(buyMinor, input.to),
    midRate: mid.mid,
    customerRate,
    marginBps: WALLET_FX_MARGIN_BPS,
    marginCostInTarget: formatAmount(atMid - buyMinor, input.to),
    rateSource: mid.source,
    rateAsOf: mid.asOf,
    quotedAt: new Date().toISOString(),
  };

  const rows = await db
    .insert(actionProposals)
    .values({
      sessionId: session.id,
      kind: 'convert',
      title: `Convert ${terms.sellAmount} ${input.from} to ${input.to}`,
      summary: `You get ${terms.buyAmount} ${input.to} at ${customerRate} (mid ${mid.mid}, our fee ${WALLET_FX_MARGIN_BPS / 100}%).`,
      termsJson: terms,
      termsHash: hashOf(terms),
      proposedBy: input.proposedBy,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    })
    .returning();
  return rows[0]!;
}

export async function listProposals(db: Db, sessionId: string, onlyPending = false) {
  const rows = await db
    .select()
    .from(actionProposals)
    .where(eq(actionProposals.sessionId, sessionId))
    .orderBy(desc(actionProposals.createdAt))
    .limit(30);
  const now = Date.now();
  return rows
    .map((p) => (p.status === 'PENDING' && p.expiresAt.getTime() <= now ? { ...p, status: 'EXPIRED' } : p))
    .filter((p) => !onlyPending || p.status === 'PENDING');
}

export async function declineProposal(db: Db, session: ResolvedSession, id: string) {
  const updated = await db
    .update(actionProposals)
    .set({ status: 'DECLINED', decidedAt: new Date() })
    .where(and(eq(actionProposals.id, id), eq(actionProposals.sessionId, session.id), eq(actionProposals.status, 'PENDING')))
    .returning();
  if (!updated[0]) throw new AppError('NOT_FOUND', 'no pending proposal with that id');
  await appendAudit(db, {
    sessionId: session.id, correlationId: id, type: 'proposal.declined', actor: 'user', outcome: 'allowed', payload: { id },
  });
}

/**
 * The only path from a proposal to money moving.
 *
 * Inside one transaction: lock the proposal, check it is still pending, unexpired,
 * owned, and that the hash the student approved is the hash stored; lock both
 * pockets in id order; re-check the balance; post a balanced entry per currency;
 * mark the proposal executed. A replayed approval finds it already executed and
 * returns the original result instead of moving money twice.
 */
export async function executeProposal(
  db: Db,
  session: ResolvedSession,
  id: string,
  expectedTermsHash: string,
) {
  const result = await db.transaction(async (tx) => {
    const proposal = (
      await tx.select().from(actionProposals)
        .where(and(eq(actionProposals.id, id), eq(actionProposals.sessionId, session.id)))
        .for('update')
    )[0];
    if (!proposal) throw new AppError('NOT_FOUND', 'no such proposal');
    if (proposal.status === 'EXECUTED') return { replay: true, proposal };
    if (proposal.status !== 'PENDING') throw new AppError('PLAN_NOT_APPROVED', `this proposal is ${proposal.status.toLowerCase()}`);
    if (proposal.expiresAt.getTime() <= Date.now()) {
      await tx.update(actionProposals).set({ status: 'EXPIRED' }).where(eq(actionProposals.id, id));
      throw new AppError('QUOTE_EXPIRED', 'this quote expired; ask for a fresh one');
    }
    if (hashOf(proposal.termsJson as object) !== proposal.termsHash) {
      throw new AppError('TERMS_CHANGED', 'stored terms do not match their hash');
    }
    if (expectedTermsHash !== proposal.termsHash) {
      throw new AppError('TERMS_CHANGED', 'the terms changed since you reviewed them');
    }

    if (proposal.kind === 'withdraw') {
      return executeWithdraw(tx as unknown as Db, session, proposal);
    }
    if (proposal.kind === 'send') {
      return executeSend(tx as unknown as Db, session, proposal);
    }
    if (proposal.kind === 'pay_bill') {
      return executeBillPayment(tx as unknown as Db, session, proposal);
    }
    if (proposal.kind !== 'convert') {
      throw new AppError('UNSUPPORTED', `${proposal.kind} cannot be executed`);
    }
    const t = proposal.termsJson as ConversionTerms;
    if (t.sessionId !== session.id) throw new AppError('NOT_FOUND', 'no such proposal');

    // Lock both pockets in a fixed order so two conversions cannot deadlock.
    const ids = [t.fromPocketId, t.toPocketId].sort();
    const locked = await tx.select().from(accounts)
      .where(and(inArray(accounts.id, ids), eq(accounts.sessionId, session.id)))
      .orderBy(asc(accounts.id))
      .for('update');
    const src = locked.find((a) => a.id === t.fromPocketId);
    const dst = locked.find((a) => a.id === t.toPocketId);
    if (!src || !dst) throw new AppError('NOT_FOUND', 'pocket not found');

    const sell = parseAmount(t.sellAmount, t.from);
    const buy = parseAmount(t.buyAmount, t.to);
    if (sell > src.balanceMinor - src.reservedMinor) {
      throw new AppError('INSUFFICIENT_FUNDS', 'your balance changed since this was quoted');
    }

    await tx.update(accounts).set({ balanceMinor: src.balanceMinor - sell, version: src.version + 1 }).where(eq(accounts.id, src.id));
    await tx.update(accounts).set({ balanceMinor: dst.balanceMinor + buy, version: dst.version + 1 }).where(eq(accounts.id, dst.id));

    // Balanced per currency: the clearing account takes the other side of each.
    await tx.insert(ledgerEntries).values([
      { proposalId: id, bucket: 'student_account', accountId: src.id, currency: t.from, signedMinor: -sell },
      { proposalId: id, bucket: 'fx_clearing', currency: t.from, signedMinor: sell },
      { proposalId: id, bucket: 'fx_clearing', currency: t.to, signedMinor: -buy },
      { proposalId: id, bucket: 'student_account', accountId: dst.id, currency: t.to, signedMinor: buy },
    ]);

    await postStatement(tx as unknown as Db, {
      sessionId: session.id, accountId: src.id, kind: 'convert_out', description: `Converted to ${t.to}`,
      category: 'fx', currency: t.from, amountMinor: -sell, balanceAfterMinor: src.balanceMinor - sell, proposalId: id,
    });
    await postStatement(tx as unknown as Db, {
      sessionId: session.id, accountId: dst.id, kind: 'convert_in', description: `Converted from ${t.from}`,
      category: 'fx', currency: t.to, amountMinor: buy, balanceAfterMinor: dst.balanceMinor + buy, proposalId: id,
    });
    const outcome = { sold: `${t.sellAmount} ${t.from}`, bought: `${t.buyAmount} ${t.to}`, rate: t.customerRate };
    await tx.update(actionProposals)
      .set({ status: 'EXECUTED', decidedAt: new Date(), resultJson: outcome })
      .where(eq(actionProposals.id, id));

    await appendAudit(tx as unknown as Db, {
      sessionId: session.id, correlationId: id, type: 'wallet.converted', actor: 'user', outcome: 'allowed',
      payload: { proposalId: id, termsHash: proposal.termsHash, ...outcome },
    });
    return { replay: false, proposal: { ...proposal, status: 'EXECUTED', resultJson: outcome } };
  });
  return result;
}

/* ------------------------------------------------------------ bill payment */

interface BillTerms {
  obligationId: string; obligationVersion: number; beneficiaryId: string; beneficiaryReference: string;
  billAmount: string; billCurrency: Currency; fromPocketId: string; fromCurrency: Currency;
  debitAmount: string; sessionId: string; payee: string;
}

/**
 * Pays a bill from a pocket, inside the caller's transaction.
 *
 * Re-reads the bill AND the payee under lock and compares them with the
 * approved terms. A hash proves the stored terms did not change; it says
 * nothing about whether the bill or the payee changed underneath them, which is
 * exactly how a redirected payment happens.
 */
async function executeBillPayment(
  tx: Db,
  session: ResolvedSession,
  proposal: typeof actionProposals.$inferSelect,
) {
  const t = proposal.termsJson as BillTerms;
  if (t.sessionId !== session.id) throw new AppError('NOT_FOUND', 'no such proposal');

  // Lock order matches the rest of the system: obligation, beneficiary, account.
  const bill = (await tx.select().from(obligations).where(eq(obligations.id, t.obligationId)).for('update'))[0];
  if (!bill || bill.sessionId !== session.id) throw new AppError('NOT_FOUND', 'bill not found');
  if (bill.paidAt) throw new AppError('ALREADY_EXECUTED', 'this bill has already been paid');
  if (bill.version !== t.obligationVersion) throw new AppError('TERMS_CHANGED', 'the bill changed since you approved');

  const payee = (await tx.select().from(beneficiaries).where(eq(beneficiaries.id, t.beneficiaryId)).for('update'))[0];
  if (!payee || payee.id !== bill.beneficiaryId || payee.reference !== t.beneficiaryReference) {
    throw new AppError('TERMS_CHANGED', 'the payee changed since you approved');
  }

  const pocket = (
    await tx.select().from(accounts)
      .where(and(eq(accounts.id, t.fromPocketId), eq(accounts.sessionId, session.id)))
      .for('update')
  )[0];
  if (!pocket) throw new AppError('NOT_FOUND', 'pocket not found');

  const debit = parseAmount(t.debitAmount, t.fromCurrency);
  const credit = parseAmount(t.billAmount, t.billCurrency);
  const available = pocket.balanceMinor - pocket.reservedMinor;
  if (debit > available) throw new AppError('INSUFFICIENT_FUNDS', 'your balance changed since this was quoted');
  const reserve = bill.reserveCurrency === t.fromCurrency ? bill.reserveMinor : 0n;
  if (available - debit < reserve) throw new AppError('BREACHES_RESERVE', 'this would now breach your living reserve');

  await tx.update(accounts).set({ balanceMinor: pocket.balanceMinor - debit, version: pocket.version + 1 }).where(eq(accounts.id, pocket.id));

  const entries =
    t.fromCurrency === t.billCurrency
      ? [
          { proposalId: proposal.id, bucket: 'student_account', accountId: pocket.id, currency: t.fromCurrency, signedMinor: -debit },
          { proposalId: proposal.id, bucket: 'beneficiary', currency: t.billCurrency, signedMinor: credit },
        ]
      : [
          { proposalId: proposal.id, bucket: 'student_account', accountId: pocket.id, currency: t.fromCurrency, signedMinor: -debit },
          { proposalId: proposal.id, bucket: 'fx_clearing', currency: t.fromCurrency, signedMinor: debit },
          { proposalId: proposal.id, bucket: 'fx_clearing', currency: t.billCurrency, signedMinor: -credit },
          { proposalId: proposal.id, bucket: 'beneficiary', currency: t.billCurrency, signedMinor: credit },
        ];
  await tx.insert(ledgerEntries).values(entries);

  const now = new Date();
  await tx.update(obligations).set({ paidAt: now, paidProposalId: proposal.id }).where(eq(obligations.id, bill.id));
  await postStatement(tx, {
    sessionId: session.id, accountId: pocket.id, kind: 'bill', description: `${bill.description} · ref ${t.beneficiaryReference}`,
    category: /tuition/i.test(bill.description) ? 'tuition' : /rent/i.test(bill.description) ? 'rent' : 'bills',
    currency: t.fromCurrency, amountMinor: -debit, balanceAfterMinor: pocket.balanceMinor - debit,
    counterparty: t.payee, proposalId: proposal.id,
  });

  // "Sent" is what we know. The university confirming receipt is their fact.
  const outcome = {
    paid: `${t.billAmount} ${t.billCurrency}`,
    to: t.payee,
    reference: t.beneficiaryReference,
    debited: `${t.debitAmount} ${t.fromCurrency}`,
    status: 'SENT_TO_PAYEE',
  };
  await tx.update(actionProposals).set({ status: 'EXECUTED', decidedAt: now, resultJson: outcome }).where(eq(actionProposals.id, proposal.id));
  await appendAudit(tx, {
    sessionId: session.id, correlationId: proposal.id, type: 'bill.paid', actor: 'user', outcome: 'allowed',
    payload: { proposalId: proposal.id, termsHash: proposal.termsHash, ...outcome },
  });
  return { replay: false, proposal: { ...proposal, status: 'EXECUTED', resultJson: outcome } };
}

/* ------------------------------------------------------------------- send */

interface SendTermsLite {
  sessionId: string; recipientId: string; recipientName: string; accountLabel: string;
  receiveAmount: string; receiveCurrency: Currency; fromPocketId: string; fromCurrency: Currency; debitAmount: string;
}

/** Sends to a saved recipient inside the caller's transaction, re-checking the payee. */
async function executeSend(tx: Db, session: ResolvedSession, proposal: typeof actionProposals.$inferSelect) {
  const t = proposal.termsJson as SendTermsLite;
  if (t.sessionId !== session.id) throw new AppError('NOT_FOUND', 'no such proposal');
  const r = (await tx.select().from(recipients).where(eq(recipients.id, t.recipientId)).for('update'))[0];
  if (!r || r.sessionId !== session.id || r.name !== t.recipientName || r.accountLabel !== t.accountLabel) {
    throw new AppError('TERMS_CHANGED', 'the recipient changed since you approved');
  }
  const pocket = (await tx.select().from(accounts)
    .where(and(eq(accounts.id, t.fromPocketId), eq(accounts.sessionId, session.id))).for('update'))[0];
  if (!pocket) throw new AppError('NOT_FOUND', 'pocket not found');
  const debit = parseAmount(t.debitAmount, t.fromCurrency);
  const credit = parseAmount(t.receiveAmount, t.receiveCurrency);
  if (debit > pocket.balanceMinor - pocket.reservedMinor) {
    throw new AppError('INSUFFICIENT_FUNDS', 'your balance changed since this was quoted');
  }
  const after = pocket.balanceMinor - debit;
  await tx.update(accounts).set({ balanceMinor: after, version: pocket.version + 1 }).where(eq(accounts.id, pocket.id));
  await tx.insert(ledgerEntries).values(
    t.fromCurrency === t.receiveCurrency
      ? [
          { proposalId: proposal.id, bucket: 'student_account', accountId: pocket.id, currency: t.fromCurrency, signedMinor: -debit },
          { proposalId: proposal.id, bucket: 'beneficiary', currency: t.receiveCurrency, signedMinor: credit },
        ]
      : [
          { proposalId: proposal.id, bucket: 'student_account', accountId: pocket.id, currency: t.fromCurrency, signedMinor: -debit },
          { proposalId: proposal.id, bucket: 'fx_clearing', currency: t.fromCurrency, signedMinor: debit },
          { proposalId: proposal.id, bucket: 'fx_clearing', currency: t.receiveCurrency, signedMinor: -credit },
          { proposalId: proposal.id, bucket: 'beneficiary', currency: t.receiveCurrency, signedMinor: credit },
        ],
  );
  await postStatement(tx, {
    sessionId: session.id, accountId: pocket.id, kind: 'send', description: `To ${r.name} · ${r.accountLabel}`,
    category: r.relationship === 'family' ? 'family' : 'other', currency: t.fromCurrency,
    amountMinor: -debit, balanceAfterMinor: after, counterparty: r.name, proposalId: proposal.id,
  });
  const now = new Date();
  const outcome = { sent: `${t.receiveAmount} ${t.receiveCurrency}`, to: r.name, debited: `${t.debitAmount} ${t.fromCurrency}`, status: 'SENT' };
  await tx.update(actionProposals).set({ status: 'EXECUTED', decidedAt: now, resultJson: outcome }).where(eq(actionProposals.id, proposal.id));
  await appendAudit(tx, {
    sessionId: session.id, correlationId: proposal.id, type: 'transfer.sent', actor: 'user', outcome: 'allowed',
    payload: { proposalId: proposal.id, termsHash: proposal.termsHash, ...outcome },
  });
  return { replay: false, proposal: { ...proposal, status: 'EXECUTED', resultJson: outcome } };
}

/* --------------------------------------------------------------- withdraw */

/** Moves money to the student's own linked wallet or bank, re-checking the source under lock. */
async function executeWithdraw(tx: Db, session: ResolvedSession, proposal: typeof actionProposals.$inferSelect) {
  const t = proposal.termsJson as {
    sessionId: string; sourceId: string; sourceLabel: string; sourceKind: string; receiveAmount: string;
    receiveCurrency: Currency; fromPocketId: string; fromCurrency: Currency; debitAmount: string;
  };
  if (t.sessionId !== session.id) throw new AppError('NOT_FOUND', 'no such proposal');
  const src = (await tx.select().from(linkedSources).where(eq(linkedSources.id, t.sourceId)).for('update'))[0];
  if (!src || src.sessionId !== session.id || src.status !== 'ACTIVE' || src.label !== t.sourceLabel) {
    throw new AppError('TERMS_CHANGED', 'that linked account changed or was removed since you approved');
  }
  const pocket = (await tx.select().from(accounts)
    .where(and(eq(accounts.id, t.fromPocketId), eq(accounts.sessionId, session.id))).for('update'))[0];
  if (!pocket) throw new AppError('NOT_FOUND', 'pocket not found');
  const debit = parseAmount(t.debitAmount, t.fromCurrency);
  const credit = parseAmount(t.receiveAmount, t.receiveCurrency);
  if (debit > pocket.balanceMinor - pocket.reservedMinor) throw new AppError('INSUFFICIENT_FUNDS', 'your balance changed since this was quoted');
  const out = connectorPush(src.kind as 'wallet' | 'bank', src.token, credit);
  const after = pocket.balanceMinor - debit;
  await tx.update(accounts).set({ balanceMinor: after, version: pocket.version + 1 }).where(eq(accounts.id, pocket.id));
  await tx.insert(ledgerEntries).values(
    t.fromCurrency === t.receiveCurrency
      ? [
          { proposalId: proposal.id, bucket: 'student_account', accountId: pocket.id, currency: t.fromCurrency, signedMinor: -debit },
          { proposalId: proposal.id, bucket: 'funding', currency: t.receiveCurrency, signedMinor: credit },
        ]
      : [
          { proposalId: proposal.id, bucket: 'student_account', accountId: pocket.id, currency: t.fromCurrency, signedMinor: -debit },
          { proposalId: proposal.id, bucket: 'fx_clearing', currency: t.fromCurrency, signedMinor: debit },
          { proposalId: proposal.id, bucket: 'fx_clearing', currency: t.receiveCurrency, signedMinor: -credit },
          { proposalId: proposal.id, bucket: 'funding', currency: t.receiveCurrency, signedMinor: credit },
        ],
  );
  await postStatement(tx, {
    sessionId: session.id, accountId: pocket.id, kind: 'withdraw', description: `To ${src.label} · ${out.reference}`,
    category: 'other', currency: t.fromCurrency, amountMinor: -debit, balanceAfterMinor: after,
    counterparty: src.label, proposalId: proposal.id, linkedSourceId: src.id,
  });
  const now = new Date();
  const outcome = { moved: `${t.receiveAmount} ${t.receiveCurrency}`, to: src.label, debited: `${t.debitAmount} ${t.fromCurrency}`, reference: out.reference, status: 'SENT' };
  await tx.update(actionProposals).set({ status: 'EXECUTED', decidedAt: now, resultJson: outcome }).where(eq(actionProposals.id, proposal.id));
  await appendAudit(tx, {
    sessionId: session.id, correlationId: proposal.id, type: 'wallet.withdrawn', actor: 'user', outcome: 'allowed',
    payload: { proposalId: proposal.id, termsHash: proposal.termsHash, ...outcome },
  });
  return { replay: false, proposal: { ...proposal, status: 'EXECUTED', resultJson: outcome } };
}
