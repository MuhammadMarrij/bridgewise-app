/**
 * Staged-payment planner (F2).
 *
 * Pure and deterministic. When one bill cannot be paid in full from money that
 * exists today, but expected inbound money (family support, a scholarship, a
 * refund) arrives before the deadline, this produces a feasible sequence of
 * DATED legs.
 *
 * Strategy: money is committed as LATE as it safely can be. We walk the funding
 * moments chronologically and, at each one, only send what could not be covered
 * later: if a later moment can fund the whole remainder (via a route that still
 * posts by the deadline), the current moment is skipped. This avoids dribbling
 * small payments early and matches how a student actually waits for family
 * money before sending the balance.
 *
 * Invariants (identical to the single-payment planner):
 *   - every leg keeps the balance at or above the reserve plus committed outflows;
 *   - every chosen route posts by the deadline and has complete fees;
 *   - every leg is executed through the existing plan → approve → confirm path
 *     with a fresh quote. This module never moves money itself.
 *
 * Multi-bill: earlier-due obligations are passed as `priorCommitments` (the
 * source-currency they will debit) so two plans can never spend the same money.
 */
import { settle } from './calendar';
import { parseAmount, parseRate, sourcePrincipalFor, targetDeliverableFor } from './money';
import type { AccountSnapshot, CashFlow } from './planner';
import type { InstallmentSpec, PaymentScheduleSpec, SimulatedRoute } from './types';

export interface UnlockEvent {
  /** Human label, e.g. "Family tuition support". */
  readonly label: string;
  /** Amount of the FUNDING currency that becomes available at this instant. */
  readonly amountMinor: bigint;
  readonly availableAt: Date;
}

/** Source-currency already committed to an EARLIER-due bill. */
export interface PriorCommitment {
  readonly amountMinor: bigint;
  /** When that money is debited. */
  readonly at: Date;
}

export interface StageRequest {
  readonly now: Date;
  readonly targetMinor: bigint;
  readonly targetCurrency: AccountSnapshot['currency'];
  readonly deadlineAt: Date;
  readonly account: AccountSnapshot;
  readonly reserveMinor: bigint;
  readonly cashFlows: readonly CashFlow[];
  /** Expected inbound money, in the funding currency. */
  readonly unlocks: readonly UnlockEvent[];
  /** Debits reserved for earlier-due bills, in the funding currency. */
  readonly priorCommitments?: readonly PriorCommitment[];
  readonly horizonDays: number;
  readonly routes: readonly SimulatedRoute[];
  readonly obligationId?: string | null;
}

interface Moment {
  readonly at: Date;
  readonly fundedByLabel: string | null;
  /** Cumulative funding-currency balance (initial + all unlocks up to here). */
  readonly cumulativeBalanceMinor: bigint;
}

/** The cheapest complete route that posts by the deadline when dispatched at `at`. */
function routeAtMoment(
  routes: readonly SimulatedRoute[],
  from: string,
  to: string,
  at: Date,
  deadlineAt: Date,
): { route: SimulatedRoute; postedAt: Date } | null {
  const eligible = routes
    .filter((r) => r.from === from && r.to === to && r.feeCompleteness === 'complete')
    .map((r) => {
      const postedAt = settle(
        at,
        r.settlement ?? {
          kind: 'fixed_hours',
          deliveryHours: r.deliveryHours,
          postingHours: r.postingHours,
        },
      ).postedAt;
      return { r, postedAt };
    })
    .filter((x) => x.postedAt.getTime() <= deadlineAt.getTime());
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    if (a.r.id === b.r.id) return 0;
    return a.r.id < b.r.id ? -1 : 1;
  });
  return { route: eligible[0]!.r, postedAt: eligible[0]!.postedAt };
}

/** Maximum target-currency deliverable at a single moment, respecting the reserve. */
function momentCapacity(
  req: StageRequest,
  moment: Moment,
  ownDebits: bigint,
): { route: SimulatedRoute; postedAt: Date; maxDebit: bigint; deliverable: bigint } | null {
  const from = req.account.currency;
  const choice = routeAtMoment(req.routes, from, req.targetCurrency, moment.at, req.deadlineAt);
  if (!choice) return null;

  const committed = (req.priorCommitments ?? [])
    .filter((c) => c.at.getTime() <= moment.at.getTime())
    .reduce((s, c) => s + c.amountMinor, 0n);

  const horizonEnd = moment.at.getTime() + req.horizonDays * 86_400_000;
  const futureOutflows = req.cashFlows
    .filter((f) => f.currency === from)
    .filter((f) => f.certain && f.direction === 'outflow')
    .filter((f) => !req.obligationId || f.obligationId !== req.obligationId)
    .filter((f) => f.occursAt.getTime() >= moment.at.getTime() && f.occursAt.getTime() <= horizonEnd)
    .reduce((sum, f) => sum + f.amountMinor, 0n);

  const maxDebit =
    moment.cumulativeBalanceMinor - ownDebits - committed - req.account.reservedMinor - req.reserveMinor - futureOutflows;
  if (maxDebit <= 0n) return null;

  const rate = parseRate(choice.route.rate, choice.route.from, choice.route.to);
  const fee = parseAmount(choice.route.sourceFee, choice.route.from);
  const deliverable = targetDeliverableFor(maxDebit, fee, rate);
  if (deliverable <= 0n) return null;

  return { route: choice.route, postedAt: choice.postedAt, maxDebit, deliverable };
}

export function planStagedPayment(req: StageRequest): PaymentScheduleSpec {
  const unlocks = [...req.unlocks]
    .filter((u) => u.amountMinor > 0n && u.availableAt.getTime() <= req.deadlineAt.getTime())
    .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());

  const moments: Moment[] = [
    { at: req.now, fundedByLabel: null, cumulativeBalanceMinor: req.account.balanceMinor },
  ];
  let cumulative = req.account.balanceMinor;
  for (const u of unlocks) {
    cumulative += u.amountMinor;
    moments.push({ at: u.availableAt, fundedByLabel: u.label, cumulativeBalanceMinor: cumulative });
  }

  // Capacity (deliverable) available at each moment before any leg is placed.
  const capacities = moments.map((m) => momentCapacity(req, m, 0n));

  const installments: InstallmentSpec[] = [];
  let remaining = req.targetMinor;
  let ownDebits = 0n;
  let reservePreserved = true;

  moments.forEach((moment, i) => {
    if (remaining <= 0n) return;

    // Total deliverable from every moment AFTER this one.
    const laterCapacity = capacities
      .slice(i + 1)
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .reduce((s, c) => s + c.deliverable, 0n);

    // Recompute this moment's capacity net of legs already placed.
    const cap = momentCapacity(req, moment, ownDebits);
    if (!cap) {
      if (laterCapacity < remaining) reservePreserved = false;
      return;
    }

    // If later moments can cover the full remainder, defer and send nothing now.
    if (laterCapacity >= remaining) return;

    const neededNow = remaining - laterCapacity;
    const legTarget = cap.deliverable < neededNow ? cap.deliverable : neededNow < remaining ? neededNow : remaining;
    const rate = parseRate(cap.route.rate, cap.route.from, cap.route.to);
    const fee = parseAmount(cap.route.sourceFee, cap.route.from);
    const principal = sourcePrincipalFor(legTarget, rate);
    const debit = principal + fee;

    if (debit > cap.maxDebit || legTarget <= 0n) {
      reservePreserved = false;
      return;
    }

    installments.push({
      sequence: installments.length + 1,
      routeId: cap.route.id,
      targetMinor: legTarget,
      dispatchOnOrAfter: moment.at,
      expectedPostingAt: cap.postedAt,
      expectedTotalDebitMinor: debit,
      fundedByLabel: moment.fundedByLabel,
    });
    ownDebits += debit;
    remaining -= legTarget;
  });

  const totalTarget = req.targetMinor - remaining;
  return {
    feasible: remaining === 0n && reservePreserved,
    installments,
    totalTargetMinor: totalTarget,
    residualShortfallMinor: remaining > 0n ? remaining : 0n,
    reservePreserved,
  };
}
