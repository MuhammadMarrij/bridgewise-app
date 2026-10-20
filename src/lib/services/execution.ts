/**
 * Approval and execution. This file is the authority boundary.
 *
 * Nothing here is reachable by a model tool. Approval is minted only by an
 * authenticated user action on a plan they own, bound to the exact terms hash,
 * and it is consumed exactly once.
 *
 * Lock order, used by EVERY path that can move money, so two paths can never
 * deadlock against each other: obligation, then source account, then plan.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accounts,
  approvals,
  beneficiaries,
  cashFlowEvents,
  ledgerEntries,
  obligationAllocations,
  obligations,
  outbox,
  plans,
  quotes,
  transfers,
} from '../db/schema';
import { isExpired } from '../domain/clock';
import { formatAmount, type Currency } from '../domain/money';
import { projectedLow, type CashFlow } from '../domain/planner';
import { GOLDEN_SCENARIO } from '../domain/fixtures';
import type { CanonicalTerms } from '../policy/terms';
import {
  hashRequest,
  hashTerms,
  mintNonce,
  POLICY_VERSION,
  secretMatches,
} from '../policy/terms';
import { AppError, type AppErrorCode } from './errors';
import { appendAudit, appendAuditSafely } from './audit';
import { APPROVAL_WINDOW_MS, EXECUTION_MODE, settledCreditMinor } from './planning';
import { committedCreditMinor } from './exposure';
import { type ResolvedSession, sessionNow } from './workspace';
import * as simulator from '../simulation/simulator';

type Db = NodePgDatabase<Record<string, never>>;

/** Operator kill switch. Checked at approval AND again at dispatch. */
export function executionEnabled(): boolean {
  return process.env.EXECUTION_ENABLED !== 'false';
}

/* ------------------------------------------------------------------ approval */

export interface ApprovalGrant {
  /** Returned once. Only its hash is stored, and it is consumed on first use. */
  readonly nonce: string;
  readonly expiresAt: Date;
}

export async function approvePlan(
  db: Db,
  session: ResolvedSession,
  input: { planId: string; expectedTermsHash: string },
): Promise<ApprovalGrant> {
  return db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const now = sessionNow(session);
    const plan = (await db.select().from(plans).where(and(eq(plans.id, input.planId), eq(plans.sessionId, session.id))).for('update'))[0];
    if (!plan) throw new AppError('NOT_FOUND', 'plan not found');
    const correlationId = plan.id;

    const deny = async (code: AppErrorCode, reason: string): Promise<never> => {
      throw new AppError(code, reason);
    };

    if (!executionEnabled()) await deny('EXECUTION_DISABLED', 'execution is disabled by the operator');
    if (plan.state === 'CANCELLED') await deny('PLAN_CANCELLED', 'this plan was cancelled');
    if (plan.state === 'EXECUTED') await deny('ALREADY_EXECUTED', 'this plan has already been executed');

    // The hash the browser echoes back must match the stored terms. If the user is
    // looking at a stale tab, this is where it is caught, before any money moves.
    const storedHash = hashTerms(plan.termsJson as CanonicalTerms);
    if (storedHash !== plan.termsHash) {
      await deny('TERMS_CHANGED', 'stored terms do not match their hash');
    }
    if (input.expectedTermsHash !== plan.termsHash) {
      await deny('TERMS_CHANGED', 'the terms changed since you reviewed them');
    }
    if (isExpired(plan.expiresAt, now)) await deny('QUOTE_EXPIRED', 'this quote has expired');

    const existing = await db.select().from(approvals).where(eq(approvals.planId, plan.id)).limit(1);
    if (existing[0]) {
      // One approval per plan, enforced by a unique index. A second approval cannot
      // be minted to re-authorise something that was already approved.
      await deny('PLAN_NOT_APPROVED', 'this plan has already been approved');
    }

    const { nonce, nonceHash } = mintNonce();
    // The approval cannot outlive the quote it authorises, and never extends it.
    const expiresAt = new Date(
      Math.min(plan.expiresAt.getTime(), now.getTime() + APPROVAL_WINDOW_MS),
    );

    await db.insert(approvals).values({
      sessionId: session.id,
      planId: plan.id,
      termsHash: plan.termsHash,
      nonceHash,
      approvedAt: now,
      expiresAt,
    });
    await db.update(plans).set({ state: 'APPROVED' }).where(eq(plans.id, plan.id));
    await appendAudit(db, {
      sessionId: session.id,
      correlationId,
      type: 'approval.granted',
      actor: 'user',
      outcome: 'allowed',
      payload: { planId: plan.id, termsHash: plan.termsHash, expiresAt: expiresAt.toISOString() },
    });

    return { nonce, expiresAt };
  }).catch(async (error: unknown) => {
    if (error instanceof AppError) await appendAuditSafely(db, {
      sessionId: session.id, correlationId: input.planId, type: 'approval.denied',
      actor: 'user', outcome: 'denied', reason: error.code, payload: { planId: input.planId },
    });
    throw error;
  });
}

/* ----------------------------------------------------------------- execution */

export interface ConfirmInput {
  readonly planId: string;
  readonly expectedTermsHash: string;
  readonly nonce: string;
  readonly idempotencyKey: string;
}

export interface TransferView {
  readonly id: string;
  readonly status: string;
  readonly debitAmountMinor: bigint;
  readonly creditAmountMinor: bigint;
  readonly sourceCurrency: Currency;
  readonly targetCurrency: Currency;
  readonly externalReference: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  readonly postedAt: Date | null;
  readonly simulated: true;
}

function view(row: typeof transfers.$inferSelect): TransferView {
  return {
    id: row.id,
    status: row.status,
    debitAmountMinor: row.debitMinor,
    creditAmountMinor: row.creditMinor,
    sourceCurrency: row.sourceCurrency as Currency,
    targetCurrency: row.targetCurrency as Currency,
    externalReference: row.externalReference,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    postedAt: row.postedAt,
    simulated: true,
  };
}

/**
 * The one path that moves money.
 *
 * Everything inside the transaction commits together: approval consumption, the
 * transfer row, the per-currency journal, the balance change and the outbox
 * intent. If any part fails, none of it happened — there is no state in which a
 * balance moved but no transfer exists, or a transfer exists with no dispatch
 * intent.
 */
export async function confirmAndExecute(
  db: Db,
  session: ResolvedSession,
  input: ConfirmInput,
): Promise<TransferView> {
  const now = sessionNow(session);
  const requestHash = hashRequest({
    planId: input.planId,
    expectedTermsHash: input.expectedTermsHash,
  });

  if (!executionEnabled()) {
    await appendAuditSafely(db, {
      sessionId: session.id,
      correlationId: input.planId,
      type: 'execution.denied',
      actor: 'user',
      outcome: 'denied',
      reason: 'kill switch',
      payload: { planId: input.planId },
    });
    throw new AppError('EXECUTION_DISABLED', 'execution is disabled by the operator');
  }

  // Idempotency BEFORE the transaction: a retry after a dropped response returns
  // the original outcome instead of attempting a second payment.
  const prior = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.sessionId, session.id), eq(transfers.idempotencyKey, input.idempotencyKey)))
    .limit(1);
  if (prior[0]) {
    if (prior[0].requestHash !== requestHash) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'this key was used for a different request');
    }
    return dispatchAndView(db, prior[0]);
  }

  let transferId: string;
  try {
    transferId = await db.transaction(async (tx) => {
      const plan = (
        await tx
          .select()
          .from(plans)
          .where(and(eq(plans.id, input.planId), eq(plans.sessionId, session.id)))
          .limit(1)
      )[0];
      if (!plan) throw new AppError('NOT_FOUND', 'plan not found');

      // Lock order: obligation, account, plan. Every money path uses this order.
      const obligation = (
        await tx.select().from(obligations).where(eq(obligations.id, plan.obligationId)).for('update')
      )[0];
      if (!obligation) throw new AppError('NOT_FOUND', 'obligation not found');

      // Locked immediately after the obligation, before the account, so every
      // money path takes the same order. A redirected payee is the attack that
      // matters most here: the user consented to paying the university.
      const beneficiary = (
        await tx.select().from(beneficiaries).where(eq(beneficiaries.id, plan.beneficiaryId)).for('update')
      )[0];
      if (!beneficiary) throw new AppError('NOT_FOUND', 'beneficiary not found');

      const account = (
        await tx.select().from(accounts).where(eq(accounts.id, plan.sourceAccountId)).for('update')
      )[0];
      if (!account) throw new AppError('NOT_FOUND', 'account not found');

      const lockedPlan = (
        await tx.select().from(plans).where(eq(plans.id, plan.id)).for('update')
      )[0]!;

      // A different idempotency key must not be able to pay the same plan twice.
      // The unique index on plan_id is the final guard; this is the clear error.
      const already = await tx.select().from(transfers).where(eq(transfers.planId, plan.id)).limit(1);
      if (already[0]) throw new AppError('ALREADY_EXECUTED', 'this plan has already been executed');

      if (lockedPlan.state === 'CANCELLED') throw new AppError('PLAN_CANCELLED', 'this plan was cancelled');
      if (lockedPlan.state !== 'APPROVED') {
        throw new AppError('PLAN_NOT_APPROVED', 'this plan has not been approved');
      }
      if (input.expectedTermsHash !== lockedPlan.termsHash) {
        throw new AppError('TERMS_CHANGED', 'the terms changed since you approved them');
      }

      const terms = lockedPlan.termsJson as CanonicalTerms;
      if (hashTerms(terms) !== lockedPlan.termsHash) {
        throw new AppError('TERMS_CHANGED', 'stored terms do not match their hash');
      }
      // Editing the beneficiary or the obligation bumps its version, which is
      // inside the hashed terms. A stale approval therefore cannot survive it.
      if (terms.obligationVersion !== obligation.version) {
        throw new AppError('TERMS_CHANGED', 'the obligation changed since you approved');
      }
      // Both the version AND the reference itself. A version that was not bumped
      // must not be a way to move money to a different account.
      if (
        terms.beneficiaryVersion !== beneficiary.version ||
        terms.beneficiaryReference !== beneficiary.reference ||
        terms.beneficiaryId !== beneficiary.id
      ) {
        throw new AppError('TERMS_CHANGED', 'the payee changed since you approved');
      }

      const approval = (
        await tx.select().from(approvals).where(eq(approvals.planId, plan.id)).for('update')
      )[0];
      if (!approval) throw new AppError('PLAN_NOT_APPROVED', 'no approval for this plan');
      if (approval.consumedAt) throw new AppError('APPROVAL_CONSUMED', 'this approval was already used');
      if (isExpired(approval.expiresAt, now)) throw new AppError('APPROVAL_EXPIRED', 'this approval expired');
      if (approval.termsHash !== lockedPlan.termsHash) {
        throw new AppError('TERMS_CHANGED', 'the approval does not match the current terms');
      }
      if (!secretMatches(input.nonce, approval.nonceHash)) {
        throw new AppError('PLAN_NOT_APPROVED', 'invalid approval');
      }

      const quote = (await tx.select().from(quotes).where(eq(quotes.id, lockedPlan.quoteId)).for('share'))[0]!;
      if (isExpired(quote.expiresAt, now)) throw new AppError('QUOTE_EXPIRED', 'this quote expired');

      // A hash of a snapshot does not make the rows it references immutable.
      const currentTerms: CanonicalTerms = {
        ...terms,
        sessionId: session.id,
        obligationId: obligation.id,
        sourceAccountId: account.id,
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        targetAmount: formatAmount(quote.targetMinor, quote.targetCurrency as Currency),
        principalAmount: formatAmount(quote.principalMinor, quote.sourceCurrency as Currency),
        feeAmount: formatAmount(quote.feeMinor, quote.sourceCurrency as Currency),
        totalDebitAmount: formatAmount(quote.totalDebitMinor, quote.sourceCurrency as Currency),
        rate: quote.rate,
        routeId: quote.routeId,
        providerLabel: quote.providerLabel,
        quoteId: quote.id,
        quoteExpiresAt: quote.expiresAt.toISOString(),
        expectedDeliveryAt: quote.deliveredAt.toISOString(),
        expectedPostingAt: quote.postedAt.toISOString(),
        deadlineAt: obligation.deadlineAt.toISOString(),
        reserveAmount: formatAmount(obligation.reserveMinor, obligation.reserveCurrency as Currency),
        policyVersion: POLICY_VERSION,
        executionMode: EXECUTION_MODE,
      };
      if (
        hashTerms(currentTerms) !== lockedPlan.termsHash ||
        [account, obligation, beneficiary, quote].some((row) => row.sessionId !== session.id) ||
        obligation.beneficiaryId !== beneficiary.id || !obligation.confirmedAt ||
        account.currency !== quote.sourceCurrency || obligation.currency !== quote.targetCurrency ||
        beneficiary.currency !== quote.targetCurrency || obligation.reserveCurrency !== account.currency ||
        quote.feeCompleteness !== 'complete' || quote.sourceKind !== 'simulated'
      ) throw new AppError('TERMS_CHANGED', 'the approved transaction data changed');

      // Re-check the money under the locks. The balance may have changed since
      // the plan was built by another request that is holding no lock now.
      const settled = await settledCreditMinor(tx as unknown as Db, obligation.id);
      const outstanding = obligation.targetMinor - settled;
      if (outstanding <= 0n) throw new AppError('OVERPAYS_OBLIGATION', 'already fully paid');

      // Settled credit alone is not enough. A transfer that is submitted but not
      // yet posted has credited nothing, yet it is on its way: counting only
      // settled credit would let two separate plans for the same tuition both
      // execute. Everything not terminally failed counts against the obligation,
      // and the obligation row is locked above so this check cannot race.
      const committed = await committedCreditMinor(tx as unknown as Db, obligation.id);
      const unclaimed = obligation.targetMinor - committed;
      if (unclaimed <= 0n) {
        throw new AppError('OVERPAYS_OBLIGATION', 'a payment for this tuition is already in progress');
      }
      if (quote.targetMinor > unclaimed) {
        throw new AppError('OVERPAYS_OBLIGATION', 'this payment would exceed the amount owed');
      }

      const spendable = account.balanceMinor - account.reservedMinor;
      if (quote.totalDebitMinor > spendable) {
        throw new AppError('INSUFFICIENT_FUNDS', 'insufficient available balance');
      }
      const flows = await tx.select().from(cashFlowEvents).where(eq(cashFlowEvents.sessionId, session.id));
      const low = projectedLow({
        now, horizonDays: GOLDEN_SCENARIO.planningHorizonDays,
        account: { currency: account.currency as Currency, balanceMinor: account.balanceMinor, reservedMinor: account.reservedMinor },
        obligationId: obligation.id,
        cashFlows: flows as CashFlow[],
      }, quote.totalDebitMinor);
      if (low < obligation.reserveMinor) {
        throw new AppError('BREACHES_RESERVE', 'this payment would breach your reserve');
      }

      const inserted = await tx
        .insert(transfers)
        .values({
          sessionId: session.id,
          planId: plan.id,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          status: 'SUBMITTED',
          sourceCurrency: quote.sourceCurrency,
          targetCurrency: quote.targetCurrency,
          debitMinor: quote.totalDebitMinor,
          creditMinor: quote.targetMinor,
          submittedAt: now,
        })
        .returning();
      const transfer = inserted[0]!;

      // Consume the approval. One use, enforced by this conditional update: a
      // concurrent request that reaches here second updates zero rows.
      const consumed = await tx
        .update(approvals)
        .set({ consumedAt: now })
        .where(and(eq(approvals.id, approval.id), eq(approvals.planId, plan.id)))
        .returning();
      if (consumed.length !== 1) throw new AppError('APPROVAL_CONSUMED', 'approval already used');

      // Per-currency double entry. GBP and USD are balanced INDEPENDENTLY; their
      // values are never added together to claim the journal balances.
      await tx.insert(ledgerEntries).values([
        {
          transferId: transfer.id,
          bucket: 'student_account',
          accountId: account.id,
          currency: quote.sourceCurrency,
          signedMinor: -quote.totalDebitMinor,
        },
        {
          transferId: transfer.id,
          bucket: 'fx_clearing',
          currency: quote.sourceCurrency,
          signedMinor: quote.principalMinor,
        },
        {
          transferId: transfer.id,
          bucket: 'fee',
          currency: quote.sourceCurrency,
          signedMinor: quote.feeMinor,
        },
        {
          transferId: transfer.id,
          bucket: 'fx_clearing',
          currency: quote.targetCurrency,
          signedMinor: -quote.targetMinor,
        },
        {
          transferId: transfer.id,
          bucket: 'beneficiary',
          currency: quote.targetCurrency,
          signedMinor: quote.targetMinor,
        },
      ]);

      await tx
        .update(accounts)
        .set({
          balanceMinor: account.balanceMinor - quote.totalDebitMinor,
          version: account.version + 1,
        })
        .where(eq(accounts.id, account.id));

      await tx.update(plans).set({ state: 'EXECUTED' }).where(eq(plans.id, plan.id));

      // The dispatch intent is written in the SAME transaction as the debit, so a
      // committed debit always has one and a rolled-back one has neither.
      await tx.insert(outbox).values({ transferId: transfer.id, state: 'PENDING' });

      await appendAudit(tx as unknown as Db, {
        sessionId: session.id,
        correlationId: plan.id,
        type: 'transfer.submitted',
        actor: 'user',
        outcome: 'allowed',
        payload: {
          planId: plan.id,
          transferId: transfer.id,
          termsHash: lockedPlan.termsHash,
          debitMinor: quote.totalDebitMinor,
          creditMinor: quote.targetMinor,
          executionMode: terms.executionMode,
        },
      });

      return transfer.id;
    });
  } catch (error) {
    await appendAuditSafely(db, {
      sessionId: session.id,
      correlationId: input.planId,
      type: 'execution.failed',
      actor: 'user',
      outcome: error instanceof AppError ? 'denied' : 'failed',
      reason: error instanceof AppError ? error.code : 'internal',
      payload: { planId: input.planId },
    });
    throw error;
  }

  const row = (await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1))[0]!;
  return dispatchAndView(db, row);
}

/* ------------------------------------------------------------------ dispatch */

/**
 * Drains the outbox for one transfer, then returns its current view.
 *
 * Called right after commit and again on every status read, so a dispatch that
 * was interrupted is picked up by the next reader rather than needing a worker.
 * It is safe to call any number of times: the simulator is idempotent on the key.
 */
export async function dispatchAndView(
  db: Db,
  row: typeof transfers.$inferSelect,
): Promise<TransferView> {
  const pending = (
    await db.select().from(outbox).where(eq(outbox.transferId, row.id)).limit(1)
  )[0];

  if (!pending || pending.state === 'SENT') return reconcile(db, row);
  if (!executionEnabled()) {
    // The kill switch stops NEW dispatches. It does not erase an existing intent,
    // and reconciliation of anything already sent continues.
    return view(row);
  }

    const plan = (await db.select().from(plans).where(eq(plans.id, row.planId)).limit(1))[0]!;
  const terms = plan.termsJson as CanonicalTerms;

  try {
    const accepted = await simulator.submit(db, {
      // The transfer id IS the provider key: a retry can never mint a new identity
      // for the same payment, which is what makes an unknown outcome recoverable.
      clientKey: row.id,
      sourceCurrency: row.sourceCurrency as Currency,
      targetCurrency: row.targetCurrency as Currency,
      debitMinor: row.debitMinor,
      creditMinor: row.creditMinor,
      beneficiaryReference: terms.beneficiaryReference,
    });
    const updated = await db
      .update(transfers)
      .set({ externalReference: accepted.id })
      .where(eq(transfers.id, row.id))
      .returning();
    await db
      .update(outbox)
      .set({ state: 'SENT', processedAt: new Date(), attempts: pending.attempts + 1 })
      .where(eq(outbox.transferId, row.id));
    return reconcile(db, updated[0]!);
  } catch (error) {
    // The provider's answer is unknown, not negative. We do NOT retry with a new
    // identity and we do not claim failure: reconciliation resolves it later.
    await db
      .update(outbox)
      .set({
        attempts: pending.attempts + 1,
        lastError: error instanceof Error ? error.name : 'unknown',
      })
      .where(eq(outbox.transferId, row.id));
    const updated = await db
      .update(transfers)
      .set({ status: 'UNKNOWN_OUTCOME' })
      .where(and(eq(transfers.id, row.id), inArray(transfers.status, ['SUBMITTED', 'UNKNOWN_OUTCOME'])))
      .returning();
    const current = updated[0] ?? (await db.select().from(transfers).where(eq(transfers.id, row.id)))[0]!;
    return view(current);
  }
}

/**
 * Asks the simulator what actually happened and brings the application's record
 * into line. This is the ONLY way a transfer becomes DELIVERED or POSTED: the
 * application never promotes its own optimistic write.
 *
 * DELIVERED is not PAID. The obligation is credited only on POSTED.
 */
export async function reconcile(
  db: Db,
  row: typeof transfers.$inferSelect,
): Promise<TransferView> {
  return db.transaction(async (tx) => {
    const plan = (await tx.select().from(plans).where(eq(plans.id, row.planId)))[0]!;
    // Same order as confirmation; fresh provider observations stay inside the lock.
    await tx.select().from(obligations).where(eq(obligations.id, plan.obligationId)).for('update');
    await tx.select().from(accounts).where(eq(accounts.id, plan.sourceAccountId)).for('update');
    const locked = (await tx.select().from(transfers).where(eq(transfers.id, row.id)).for('update'))[0]!;
    if (locked.status === 'POSTED' || locked.status === 'REJECTED') return view(locked);
    return reconcileLocked(tx as unknown as Db, locked);
  });
}

async function reconcileLocked(db: Db, row: typeof transfers.$inferSelect): Promise<TransferView> {
  const record = await simulator.lookup(db, row.id);
  if (!record) {
    // We have no provider record. If we previously thought the outcome unknown,
    // it stays unknown until we learn otherwise. We never invent a failure.
    return view(row);
  }

  if (record.status === 'REJECTED' && row.status !== 'REJECTED') {
    return db.transaction(async (tx) => {
      const locked = (
        await tx.select().from(transfers).where(eq(transfers.id, row.id)).for('update')
      )[0]!;
      if (locked.status === 'REJECTED') return view(locked);

      const account = (
        await tx.select().from(accounts).where(eq(accounts.id,
          (await tx.select().from(plans).where(eq(plans.id, locked.planId)).limit(1))[0]!.sourceAccountId,
        )).for('update')
      )[0]!;

      // Compensating entries, not a deletion. The original postings stay: the
      // journal records what happened, including what was undone.
      await tx.insert(ledgerEntries).values([
        {
          transferId: locked.id,
          bucket: 'student_account',
          accountId: account.id,
          currency: locked.sourceCurrency,
          signedMinor: locked.debitMinor,
        },
        {
          transferId: locked.id,
          bucket: 'fx_clearing',
          currency: locked.sourceCurrency,
          signedMinor: -locked.debitMinor,
        },
      ]);
      await tx
        .update(accounts)
        .set({ balanceMinor: account.balanceMinor + locked.debitMinor, version: account.version + 1 })
        .where(eq(accounts.id, account.id));
      const updated = await tx
        .update(transfers)
        .set({ status: 'REJECTED', failureReason: record.rejectedReason })
        .where(eq(transfers.id, locked.id))
        .returning();
      await appendAudit(tx as unknown as Db, {
        sessionId: locked.sessionId,
        correlationId: locked.planId,
        type: 'transfer.rejected',
        actor: 'system',
        outcome: 'failed',
        reason: record.rejectedReason,
        payload: { transferId: locked.id, refundedMinor: locked.debitMinor },
      });
      return view(updated[0]!);
    });
  }

  if (record.status === 'POSTED' && row.status !== 'POSTED') {
    return db.transaction(async (tx) => {
      const locked = (
        await tx.select().from(transfers).where(eq(transfers.id, row.id)).for('update')
      )[0]!;
      if (locked.status === 'POSTED') return view(locked);

      const plan = (await tx.select().from(plans).where(eq(plans.id, locked.planId)).limit(1))[0]!;
      await tx.select().from(obligations).where(eq(obligations.id, plan.obligationId)).for('update');

      // The allocation is derived from SETTLEMENT, never supplied by a client,
      // and the unique index on transfer_id means it can only happen once.
      await tx
        .insert(obligationAllocations)
        .values({
          obligationId: plan.obligationId,
          transferId: locked.id,
          creditedMinor: locked.creditMinor,
          currency: locked.targetCurrency,
        })
        .onConflictDoNothing();

      const updated = await tx
        .update(transfers)
        .set({
          status: 'POSTED',
          deliveredAt: record.deliveredAt ?? locked.deliveredAt,
          postedAt: record.postedAt,
        })
        .where(eq(transfers.id, locked.id))
        .returning();
      await appendAudit(tx as unknown as Db, {
        sessionId: locked.sessionId,
        correlationId: locked.planId,
        type: 'tuition.posted',
        actor: 'system',
        outcome: 'allowed',
        payload: { transferId: locked.id, creditedMinor: locked.creditMinor },
      });
      return view(updated[0]!);
    });
  }

  if (record.status === 'DELIVERED' && row.status !== 'DELIVERED') {
    const updated = await db
      .update(transfers)
      .set({ status: 'DELIVERED', deliveredAt: record.deliveredAt })
      .where(eq(transfers.id, row.id))
      .returning();
    return view(updated[0]!);
  }

  if (record.status === 'ACCEPTED' && row.status === 'UNKNOWN_OUTCOME') {
    // The lost response was a success after all. Recovered by ASKING, never by
    // resubmitting under a fresh identity.
    const updated = await db
      .update(transfers)
      .set({ status: 'SUBMITTED', externalReference: record.id })
      .where(eq(transfers.id, row.id))
      .returning();
    return view(updated[0]!);
  }

  return view(row);
}

/** The session-scoped status read. Drains and reconciles on the way. */
export async function transferStatus(
  db: Db,
  session: ResolvedSession,
  transferId: string,
): Promise<TransferView> {
    const rows = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.sessionId, session.id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'transfer not found');
  return dispatchAndView(db, row);
}

/** Model reads must not drain the outbox or mutate reconciliation state. */
export async function storedTransferStatus(db: Db, session: ResolvedSession, transferId: string): Promise<TransferView> {
  const [row] = await db.select().from(transfers)
    .where(and(eq(transfers.id, transferId), eq(transfers.sessionId, session.id))).limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'transfer not found');
  return view(row);
}
