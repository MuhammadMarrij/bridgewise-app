/**
 * Turning a deterministic plan into persisted, immutable terms.
 *
 * Comparing routes writes nothing. Creating a plan writes a quote and a plan row
 * and still moves no money. Only the confirm endpoint moves money, and the model
 * cannot reach it.
 */
import { and, eq, sum } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accounts,
  beneficiaries,
  cashFlowEvents,
  obligationAllocations,
  obligations,
  plans,
  quotes,
  transfers,
} from '../db/schema';
import { planTuitionPayment, type CashFlow, type PlanRequest } from '../domain/planner';
import { formatAmount, type Currency } from '../domain/money';
import { GOLDEN_SCENARIO } from '../domain/fixtures';
import { routesForCorridor } from '../domain/corridors';
import { liveMidRate, type LiveRate } from '../rates/live';
import { realRoutesForTarget } from '../rates/real-routes';
import type { ProviderComparison } from '../rates/providers';
import type { SimulatedRoute } from '../domain/types';
import type { Candidate, PlanResult } from '../domain/types';
import { POLICY_VERSION, hashTerms, type CanonicalTerms } from '../policy/terms';
import { AppError } from './errors';
import { ownedAccount, ownedObligation, type ResolvedSession, sessionNow } from './workspace';

type Db = NodePgDatabase<Record<string, never>>;

export const EXECUTION_MODE = process.env.EXECUTION_MODE ?? 'SIMULATED';
/** A short approval lifetime. Capped further by the quote's own expiry. */
export const APPROVAL_WINDOW_MS = 5 * 60_000;

/** How much of an obligation has actually been POSTED. Proposals never count. */
export async function settledCreditMinor(db: Db, obligationId: string): Promise<bigint> {
    const rows = await db
    .select({ total: sum(obligationAllocations.creditedMinor) })
    .from(obligationAllocations)
    .where(eq(obligationAllocations.obligationId, obligationId));
  const total = rows[0]?.total;
  return total ? BigInt(total) : 0n;
}

export async function comparePlan(
  db: Db,
  session: ResolvedSession,
  input: { obligationId: string; sourceAccountId: string },
): Promise<{ result: PlanResult; outstandingMinor: bigint; rate: LiveRate | null; comparison: ProviderComparison | null }> {
  const obligation = await ownedObligation(db, session.id, input.obligationId);
  const account = await ownedAccount(db, session.id, input.sourceAccountId);

  if (obligation.reserveCurrency !== account.currency) {
    throw new AppError('UNSUPPORTED', 'the reserve must use the funding account currency');
  }

  if (!obligation.confirmedAt) {
    throw new AppError('VALIDATION_FAILED', 'confirm the obligation details before planning');
  }

  const settled = await settledCreditMinor(db, obligation.id);
  const outstanding = obligation.targetMinor - settled;
  if (outstanding <= 0n) {
    throw new AppError('OVERPAYS_OBLIGATION', 'this obligation is already fully paid');
  }

  // Real market data, fetched now. If both reference sources are unreachable we
  // fall back to the last-known table and label it, rather than presenting a
  // stale number as if it were today's market.
  const from = account.currency as Currency;
  const to = obligation.currency as Currency;
  const staticRoutes = routesForCorridor(from, to);

  let livePricing: {
    routes: readonly SimulatedRoute[];
    rate: LiveRate | null;
    comparison: ProviderComparison | null;
  } = { routes: staticRoutes, rate: null, comparison: null };

  // ponytail: ROUTES_SOURCE=fixtures pins the frozen route table. The test suite
  // uses it so consent and execution are tested against fixed terms without the
  // network; live-provider correctness has its own tests.
  if (process.env.ROUTES_SOURCE !== 'fixtures') try {
    // Real providers, priced for THIS bill. The reference rate is only used to
    // estimate the send amount so the quotes land in the right fee tier; every
    // figure the student sees comes from the provider's own quote.
    const rate = await liveMidRate(from, to);
    const real = await realRoutesForTarget(from, to, formatAmount(outstanding, to), rate.mid);
    if (real.routes.length > 0) {
      livePricing = { routes: real.routes, rate, comparison: real.comparison };
    }
  } catch {
    // Providers unreachable. We keep the last-known table and report rate: null
    // so the interface can say the figures are not live, rather than presenting
    // a stale number as if it were today's market.
  }

  const flows = await db
    .select()
    .from(cashFlowEvents)
    .where(eq(cashFlowEvents.sessionId, session.id));

  const request: PlanRequest = {
    now: sessionNow(session),
    targetMinor: outstanding,
    targetCurrency: obligation.currency as Currency,
    deadlineAt: obligation.deadlineAt,
    account: {
      currency: account.currency as Currency,
      balanceMinor: account.balanceMinor,
      reservedMinor: account.reservedMinor,
    },
    reserveMinor: obligation.reserveMinor,
    cashFlows: flows.map<CashFlow>((f) => ({
      label: f.label,
      currency: f.currency as Currency,
      direction: f.direction as 'inflow' | 'outflow',
      amountMinor: f.amountMinor,
      occursAt: f.occursAt,
      certain: f.certain,
      obligationId: f.obligationId,
    })),
    horizonDays: GOLDEN_SCENARIO.planningHorizonDays,
    routes: livePricing.routes,
    obligationId: obligation.id,
  };

  return {
    result: planTuitionPayment(request),
    outstandingMinor: outstanding,
    rate: livePricing.rate,
    comparison: livePricing.comparison,
  };
}

export interface CreatedPlan {
  readonly planId: string;
  readonly quoteId: string;
  readonly termsHash: string;
  readonly terms: CanonicalTerms;
  readonly expiresAt: Date;
}

/**
 * Freezes a chosen route into an immutable plan. The terms are built from SERVER
 * data only: the caller chooses a route id, never an amount, a fee or a rate.
 */
export async function createPlan(
  db: Db,
  session: ResolvedSession,
  input: { obligationId: string; sourceAccountId: string; routeId: string },
): Promise<CreatedPlan> {
  const { result, rate: liveRate } = await comparePlan(db, session, input);

  const chosen: Candidate | undefined = [
    ...(result.recommended ? [result.recommended] : []),
    ...result.alternatives,
  ].find((c) => c.pricing.routeId === input.routeId);

  if (!chosen) {
    // Either the route does not exist, or it is not feasible. Both are refused
    // here; an infeasible route never becomes an executable plan.
    const excluded = result.excluded.find((c) => c.pricing.routeId === input.routeId);
    throw new AppError(
      'VALIDATION_FAILED',
      excluded
        ? `route ${input.routeId} is not executable: ${excluded.exclusions.join(', ')}`
        : `route ${input.routeId} is not available`,
    );
  }

  const obligation = await ownedObligation(db, session.id, input.obligationId);
  const account = await ownedAccount(db, session.id, input.sourceAccountId);
  const beneficiaryRows = await db
    .select()
    .from(beneficiaries)
    .where(and(eq(beneficiaries.id, obligation.beneficiaryId), eq(beneficiaries.sessionId, session.id)))
    .limit(1);
  const beneficiary = beneficiaryRows[0];
  if (!beneficiary) throw new AppError('NOT_FOUND', 'beneficiary not found');

  const p = chosen.pricing;
  const quoteRows = await db
    .insert(quotes)
    .values({
      sessionId: session.id,
      routeId: p.routeId,
      providerLabel: p.providerLabel,
      sourceCurrency: p.from,
      targetCurrency: p.to,
      targetMinor: p.targetMinor,
      principalMinor: p.principalMinor,
      feeMinor: p.feeMinor,
      totalDebitMinor: p.totalDebitMinor,
      rate: p.rate,
      quotedAt: result.asOf,
      deliveredAt: p.deliveredAt,
      postedAt: p.postedAt,
      expiresAt: p.expiresAt,
      feeCompleteness: p.feeCompleteness,
      sourceKind: p.sourceKind,
    })
    .returning();
  const quote = quoteRows[0]!;

  const terms: CanonicalTerms = {
    schemaVersion: 1,
    sessionId: session.id,
    planKind: 'tuition_remittance',
    obligationId: obligation.id,
    obligationVersion: obligation.version,
    beneficiaryId: beneficiary.id,
    beneficiaryVersion: beneficiary.version,
    beneficiaryReference: beneficiary.reference,
    sourceAccountId: account.id,
    sourceCurrency: p.from,
    targetCurrency: p.to,
    targetAmount: formatAmount(p.targetMinor, p.to),
    principalAmount: formatAmount(p.principalMinor, p.from),
    feeAmount: formatAmount(p.feeMinor, p.from),
    totalDebitAmount: formatAmount(p.totalDebitMinor, p.from),
    rate: p.rate,
    routeId: p.routeId,
    providerLabel: p.providerLabel,
    quoteId: quote.id,
    quoteExpiresAt: p.expiresAt.toISOString(),
    expectedDeliveryAt: p.deliveredAt.toISOString(),
    expectedPostingAt: p.postedAt.toISOString(),
    deadlineAt: obligation.deadlineAt.toISOString(),
    reserveAmount: formatAmount(obligation.reserveMinor, obligation.reserveCurrency as Currency),
    projectedLowAmount: formatAmount(chosen.projectedLowMinor, p.from),
    executionMode: EXECUTION_MODE,
    policyVersion: POLICY_VERSION,
  };

  const termsHash = hashTerms(terms);
  const planRows = await db
    .insert(plans)
    .values({
      sessionId: session.id,
      obligationId: obligation.id,
      sourceAccountId: account.id,
      beneficiaryId: beneficiary.id,
      quoteId: quote.id,
      termsJson: terms,
      termsHash,
      state: 'AWAITING_APPROVAL',
      expiresAt: p.expiresAt,
    })
    .returning();

  return {
    planId: planRows[0]!.id,
    quoteId: quote.id,
    termsHash,
    terms,
    expiresAt: p.expiresAt,
  };
}

export async function ownedPlan(db: Db, sessionId: string, planId: string) {
    const rows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.sessionId, sessionId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'plan not found');
  return row;
}

/** Cancelling before dispatch. A plan with a transfer can never be cancelled. */
export async function cancelPlan(db: Db, session: ResolvedSession, planId: string): Promise<void> {
  return db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const plan = (await db.select().from(plans).where(and(eq(plans.id, planId), eq(plans.sessionId, session.id))).for('update'))[0];
    if (!plan) throw new AppError('NOT_FOUND', 'plan not found');
    const existing = await db.select().from(transfers).where(eq(transfers.planId, plan.id)).limit(1);
    if (existing[0]) throw new AppError('ALREADY_EXECUTED', 'this plan has already been executed');
    if (plan.state === 'CANCELLED') return;
    await db
      .update(plans)
      .set({ state: 'CANCELLED', cancelledAt: new Date() })
      .where(eq(plans.id, plan.id));
  });
}

export async function accountsFor(db: Db, sessionId: string) {
  return db.select().from(accounts).where(eq(accounts.sessionId, sessionId));
}

export async function obligationsFor(db: Db, sessionId: string) {
  return db.select().from(obligations).where(eq(obligations.sessionId, sessionId));
}
