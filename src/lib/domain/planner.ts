/**
 * The planner. Pure, deterministic, and the single authority on which route is
 * recommended and why every other one was not.
 *
 * Nothing here touches the database, the clock, the network or the model. The
 * same inputs always produce the same output, which is what makes the golden
 * scenario reproducible on any machine on any date.
 *
 * The model NEVER re-derives these numbers. It reads this output and explains it.
 */
import { HOUR_MS, DAY_MS, isExpired } from './clock';
import {
  type Currency,
  parseAmount,
  parseRate,
  sourcePrincipalFor,
} from './money';
import { settle, type SettlementSpec } from './calendar';
import type {
  Candidate,
  ExclusionReason,
  PlanResult,
  RoutePricing,
  SimulatedRoute,
} from './types';

export interface AccountSnapshot {
  readonly currency: Currency;
  readonly balanceMinor: bigint;
  /** Already committed to an in-flight transfer, so not spendable. */
  readonly reservedMinor: bigint;
}

export interface CashFlow {
  readonly label: string;
  readonly currency: Currency;
  readonly direction: 'inflow' | 'outflow';
  readonly amountMinor: bigint;
  readonly occursAt: Date;
  /** An uncertain inflow is shown but never counted as available funds. */
  readonly certain: boolean;
  /** Set when the row IS the obligation being planned, so it is not counted twice. */
  readonly obligationId?: string | null;
}

export interface PlanRequest {
  readonly now: Date;
  readonly targetMinor: bigint;
  readonly targetCurrency: Currency;
  readonly deadlineAt: Date;
  readonly account: AccountSnapshot;
  /** Untouchable living funds, in the account's currency. */
  readonly reserveMinor: bigint;
  readonly cashFlows: readonly CashFlow[];
  readonly horizonDays: number;
  readonly routes: readonly SimulatedRoute[];
  /** Excluded from the liquidity walk so the tuition is never counted twice. */
  readonly obligationId?: string | null;
}

/** A route's settlement spec: explicit business-days, otherwise the fixed-hours model. */
function settlementOf(route: SimulatedRoute): SettlementSpec {
  if (route.settlement) return route.settlement;
  return {
    kind: 'fixed_hours',
    deliveryHours: route.deliveryHours,
    postingHours: route.postingHours,
  };
}

/**
 * Price a route for a fixed target. The debit is the source principal (exact,
 * rounded up) plus the explicit source fee. The mid-market reference, when
 * present, is used only to DECOMPOSE the cost into explicit fee and embedded FX
 * margin: it never changes the debit, so the golden figures are unchanged.
 */
function price(route: SimulatedRoute, req: PlanRequest): RoutePricing {
  const rate = parseRate(route.rate, route.from, route.to);
  const principalMinor = sourcePrincipalFor(req.targetMinor, rate);
  const feeMinor = parseAmount(route.sourceFee, route.from);
  const receivingFeeMinor = parseAmount(route.receivingFee ?? '0', route.to);

  const spec = settlementOf(route);
  const { deliveredAt, postedAt } = settle(req.now, spec);

  // FX margin decomposition (informational). Quoted rate is no better than mid
  // for the student in these fixtures; guard anyway so a bad fixture can't show
  // a negative "cost".
  let principalAtMidMinor: bigint | null = null;
  let fxMarginCostMinor: bigint | null = null;
  let allInCostBeyondMidMinor: bigint | null = null;
  let fxMarginBasisPoints: number | null = null;
  if (route.midRate) {
    const mid = parseRate(route.midRate, route.from, route.to);
    principalAtMidMinor = sourcePrincipalFor(req.targetMinor, mid);
    const margin = principalMinor - principalAtMidMinor;
    fxMarginCostMinor = margin < 0n ? 0n : margin;
    allInCostBeyondMidMinor = fxMarginCostMinor + feeMinor;
    fxMarginBasisPoints =
      principalAtMidMinor > 0n
        ? Number((fxMarginCostMinor * 10_000n) / principalAtMidMinor)
        : 0;
  }

  return {
    routeId: route.id,
    providerLabel: route.providerLabel,
    from: route.from,
    to: route.to,
    rate: route.rate,
    midRate: route.midRate ?? null,
    targetMinor: req.targetMinor,
    principalMinor,
    feeMinor,
    totalDebitMinor: principalMinor + feeMinor,
    principalAtMidMinor,
    fxMarginCostMinor,
    allInCostBeyondMidMinor,
    fxMarginBasisPoints,
    receivingFeeMinor,
    deliveredAt,
    postedAt,
    expiresAt: new Date(req.now.getTime() + route.quoteTtlMinutes * 60_000),
    settlementKind: spec.kind,
    feeCompleteness: route.feeCompleteness,
    sourceKind: route.sourceKind,
  };
}

/**
 * The lowest point the account reaches across the planning horizon, if this debit
 * is taken now. Uncertain inflows are excluded: a scholarship that might land is
 * not money you can spend. The obligation's own row is excluded so a tuition that
 * also appears as a scheduled outflow is not subtracted twice.
 */
export function projectedLow(req: Pick<PlanRequest, 'now' | 'horizonDays' | 'cashFlows' | 'account' | 'obligationId'>, debitMinor: bigint): bigint {
  const horizonEnd = req.now.getTime() + req.horizonDays * DAY_MS;
  const relevant = req.cashFlows
    .filter((f) => f.currency === req.account.currency)
    .filter((f) => f.certain)
    .filter((f) => !req.obligationId || f.obligationId !== req.obligationId)
    .filter((f) => f.occursAt.getTime() >= req.now.getTime() && f.occursAt.getTime() <= horizonEnd)
    .slice()
    .sort((a, b) => a.occursAt.getTime() - b.occursAt.getTime());

  let running = req.account.balanceMinor - req.account.reservedMinor - debitMinor;
  let low = running;
  for (const flow of relevant) {
    running += flow.direction === 'inflow' ? flow.amountMinor : -flow.amountMinor;
    if (running < low) low = running;
  }
  return low;
}

function evaluate(route: SimulatedRoute, req: PlanRequest): Candidate {
  const exclusions: ExclusionReason[] = [];
  const warnings: ExclusionReason[] = [];

  // Corridor first: an unsupported pair is not priced at all, because pricing it
  // would imply the route is available when it is not.
  if (route.from !== req.account.currency || route.to !== req.targetCurrency) {
    const pricing = price(route, req);
    return {
      pricing,
      feasible: false,
      exclusions: ['UNSUPPORTED_CORRIDOR'],
      warnings: [],
      projectedLowMinor: 0n,
      reserveMarginMinor: 0n,
    };
  }

  const pricing = price(route, req);

  // An unknown fee makes the all-in cost unknown. A route whose total we cannot
  // state is never offered as the cheapest, whatever its visible numbers say.
  if (route.feeCompleteness !== 'complete') exclusions.push('INCOMPLETE_FEES');

  if (isExpired(pricing.expiresAt, req.now)) exclusions.push('QUOTE_EXPIRED');

  // Feasibility is decided on INSTITUTION POSTING, not provider delivery.
  // Money that arrives at the university after the deadline is late money.
  //
  // A real provider often publishes no arrival estimate at all. We refuse to
  // certify such a route against a hard deadline rather than inventing hours to
  // make the calculation look complete: for a student whose enrolment depends on
  // the money landing, "the provider will not say" is the honest answer, and it
  // is a different fact from "it arrives too late".
  // A provider that publishes no arrival time is not disqualified: almost none
  // publishes one. It is planned against a conservative assumption, flagged so
  // the student knows which figure to verify, and excluded only if it misses
  // the deadline even then.
  if (route.arrivalPublished === false) warnings.push('ARRIVAL_NOT_PUBLISHED');
  if (pricing.postedAt.getTime() > req.deadlineAt.getTime()) exclusions.push('MISSES_DEADLINE');

  const spendable = req.account.balanceMinor - req.account.reservedMinor;
  if (pricing.totalDebitMinor > spendable) exclusions.push('INSUFFICIENT_BALANCE');

  const low = projectedLow(req, pricing.totalDebitMinor);
  const margin = low - req.reserveMinor;
  if (margin < 0n) exclusions.push('BREACHES_RESERVE');

  return {
    pricing,
    feasible: exclusions.length === 0,
    exclusions,
    warnings,
    projectedLowMinor: low,
    reserveMarginMinor: margin,
  };
}

/**
 * Deterministic ordering: cheapest total debit first; ties broken by the earlier
 * institution posting; remaining ties by route id, so the result never depends on
 * input order or on the engine's sort stability.
 */
function rank(a: Candidate, b: Candidate): number {
  if (a.pricing.totalDebitMinor !== b.pricing.totalDebitMinor) {
    return a.pricing.totalDebitMinor < b.pricing.totalDebitMinor ? -1 : 1;
  }
  const byPosting = a.pricing.postedAt.getTime() - b.pricing.postedAt.getTime();
  if (byPosting !== 0) return byPosting;
  return a.pricing.routeId < b.pricing.routeId ? -1 : a.pricing.routeId > b.pricing.routeId ? 1 : 0;
}

export function planTuitionPayment(req: PlanRequest): PlanResult {
  if (req.horizonDays <= 0) throw new Error('horizonDays must be positive');
  if (req.targetMinor <= 0n) throw new Error('target must be positive');
  if (req.reserveMinor < 0n) throw new Error('reserve must not be negative');

  const evaluated = req.routes.map((r) => evaluate(r, req));
  const feasible = evaluated.filter((c) => c.feasible).sort(rank);
  const excluded = evaluated.filter((c) => !c.feasible).sort(rank);

  if (feasible.length > 0) {
    return {
      outcome: 'PLAN_READY',
      recommended: feasible[0]!,
      alternatives: feasible.slice(1),
      excluded,
      shortfallMinor: null,
      asOf: req.now,
    };
  }

  // No feasible route. Report the SMALLEST shortfall among routes that failed only
  // on money, so the student learns how far short they are. A route that missed the
  // deadline has no shortfall: more money would not have saved it.
  const moneyOnly = excluded.filter(
    (c) =>
      c.exclusions.length > 0 &&
      c.exclusions.every((e) => e === 'BREACHES_RESERVE' || e === 'INSUFFICIENT_BALANCE'),
  );
  let shortfall: bigint | null = null;
  for (const c of moneyOnly) {
    const need = req.reserveMinor - c.projectedLowMinor;
    if (need > 0n && (shortfall === null || need < shortfall)) shortfall = need;
  }

  return {
    outcome: 'NO_FEASIBLE_PLAN',
    recommended: null,
    alternatives: [],
    excluded,
    shortfallMinor: shortfall,
    asOf: req.now,
  };
}
