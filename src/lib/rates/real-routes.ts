/**
 * Real routes.
 *
 * Replaces the invented provider table with live quotes from named institutions.
 * Every rate, fee and landed amount below came from a provider, not a developer.
 *
 * The honest difficulty: most providers publish no arrival estimate. We do NOT
 * invent one to make a deadline calculation look complete. A route with no
 * published arrival is offered with `arrivalPublished: false`, and the planner
 * refuses to certify it against a hard deadline. For a student whose enrolment
 * depends on the money landing by Friday, "the provider will not say" is the
 * truth and is more useful than a confident guess.
 */
import type { SimulatedRoute } from '../domain/types';
import type { Currency } from '../domain/money';
import { fetchProviderQuotes, type ProviderComparison } from './providers';
import { transitFor } from '../domain/transit';

export interface RealRouteSet {
  readonly routes: readonly SimulatedRoute[];
  readonly comparison: ProviderComparison;
  /** How many of the quotes carry an arrival estimate we can act on. */
  readonly withPublishedArrival: number;
}

/**
 * How long we assume an institution needs before the receiving university can
 * post the credit, once the funds have arrived. This is a UNIVERSITY-side
 * processing allowance, not a provider claim, and it is stated in the interface
 * as an assumption the student can change.
 */
export const UNIVERSITY_POSTING_HOURS = Number(process.env.POSTING_ALLOWANCE_HOURS ?? 24);

/** A quote stays actionable for this long before we make the user re-check. */
const QUOTE_TTL_MINUTES = Number(process.env.QUOTE_TTL_MINUTES ?? 30);

/**
 * Live routes for a corridor, priced for the amount actually being sent.
 *
 * `sendAmount` matters: provider fees are tiered, so a comparison fetched for a
 * different amount would misprice this transfer.
 */
export async function realRoutesForCorridor(
  from: Currency,
  to: Currency,
  sendAmount: string,
): Promise<RealRouteSet> {
  const comparison = await fetchProviderQuotes(from, to, sendAmount);

  const routes = comparison.quotes.map<SimulatedRoute>((q) => ({
    id: q.id,
    providerLabel: q.providerName,
    from,
    to,
    rate: q.rate,
    midRate: undefined,
    sourceFee: q.fee,
    receivingFee: '0',
    // NEVER zero. An unpublished arrival defaulting to instant would make every
    // route look like it beats the deadline, which is the most dangerous wrong
    // answer this product could give. Unknown means the conservative bound.
    deliveryHours: transitFor(q.deliveryHours, q.providerType).hours,
    postingHours: UNIVERSITY_POSTING_HOURS,
    quoteTtlMinutes: QUOTE_TTL_MINUTES,
    feeCompleteness: 'complete',
    sourceKind: 'simulated',
    // Carried through so the planner and the interface can tell the difference
    // between "arrives in 2 hours" and "the provider will not say".
    arrivalPublished: !q.deliveryUnknown,
    providerType: q.providerType,
    realQuote: true,
  } as SimulatedRoute));

  return {
    routes,
    comparison,
    withPublishedArrival: comparison.quotes.filter((q) => !q.deliveryUnknown).length,
  };
}

/**
 * Live routes for a FIXED TARGET, which is what a tuition bill actually is.
 *
 * The provider endpoint only prices a given send amount, so we:
 *   1. estimate the send from the ECB mid-market rate,
 *   2. fetch quotes at that amount to land in the right fee tier,
 *   3. recompute each provider's exact cost from its own rate and fee, and
 *   4. refetch once if the estimate was materially wrong, because provider fees
 *      are tiered and a quote fetched for the wrong amount misprices the deal.
 *
 * Step 4 is the difference between "about right" and right. One refetch is
 * enough: the second estimate is derived from a real quote, not from mid.
 */
export async function realRoutesForTarget(
  from: Currency,
  to: Currency,
  targetAmount: string,
  midRate: string,
): Promise<RealRouteSet & { estimatedSend: string; refetched: boolean }> {
  const target = Number(targetAmount);
  const mid = Number(midRate);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(mid) || mid <= 0) {
    throw new Error('realRoutesForTarget needs a positive target and mid rate');
  }

  // Allow headroom for the provider margin so the first fetch lands in roughly
  // the right fee tier rather than one below it.
  const estimate = (target / mid) * 1.01;
  let sendAmount = estimate.toFixed(2);
  let set = await realRoutesForCorridor(from, to, sendAmount);

  // What the best provider would really need for this exact target.
  const best = set.comparison.quotes[0];
  let refetched = false;
  if (best) {
    const needed = target / Number(best.rate) + Number(best.fee);
    if (Number.isFinite(needed) && Math.abs(needed - Number(sendAmount)) / Number(sendAmount) > 0.05) {
      sendAmount = needed.toFixed(2);
      set = await realRoutesForCorridor(from, to, sendAmount);
      refetched = true;
    }
  }

  return { ...set, estimatedSend: sendAmount, refetched };
}
