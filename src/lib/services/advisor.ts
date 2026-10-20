/**
 * The agent's id-free advisory reads.
 *
 * These aggregate the deterministic planner, the settlement calendar, inbound
 * remittances and the stage planner into account-scoped views that take no
 * object ids, so the guided agent (and the live model) can reason about the
 * signed-in workspace without guessing UUIDs. Everything here is read-only.
 *
 * Bills are processed in deadline order and earlier-due bills are recorded as
 * prior commitments, so two plans can never be shown spending the same money.
 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accountsFor,
  comparePlan,
  createPlan,
  obligationsFor,
  settledCreditMinor,
} from './planning';
import { listRemittances } from './remittance';
import { sessionNow, type ResolvedSession } from './workspace';
import { cashFlowEvents, inboundRemittances } from '../db/schema';
import { formatAmount, type Currency } from '../domain/money';
import { routesForCorridor } from '../domain/corridors';
import {
  planStagedPayment,
  type PriorCommitment,
  type UnlockEvent,
} from '../domain/stage-planner';
import type { Candidate, PaymentScheduleSpec, PlanResult } from '../domain/types';
import { AppError } from './errors';

type Db = NodePgDatabase<Record<string, never>>;

function candidateView(c: Candidate) {
  const p = c.pricing;
  return {
    routeId: p.routeId,
    provider: p.providerLabel,
    from: p.from,
    to: p.to,
    rate: p.rate,
    midRate: p.midRate,
    recipientAmount: formatAmount(p.targetMinor, p.to as Currency),
    sourcePrincipal: formatAmount(p.principalMinor, p.from as Currency),
    fee: formatAmount(p.feeMinor, p.from as Currency),
    totalDebit: formatAmount(p.totalDebitMinor, p.from as Currency),
    // FX cost decomposition (informational; never an added charge).
    fxMargin: p.fxMarginCostMinor === null ? null : formatAmount(p.fxMarginCostMinor, p.from as Currency),
    fxMarginBasisPoints: p.fxMarginBasisPoints,
    costBeyondMid: p.allInCostBeyondMidMinor === null ? null : formatAmount(p.allInCostBeyondMidMinor, p.from as Currency),
    settlementKind: p.settlementKind,
    expectedDeliveryAt: p.deliveredAt.toISOString(),
    expectedPostingAt: p.postedAt.toISOString(),
    feasible: c.feasible,
    exclusions: c.exclusions,
    projectedLow: formatAmount(c.projectedLowMinor, p.from as Currency),
    reserveMargin: formatAmount(c.reserveMarginMinor, p.from as Currency),
  };
}

function resultView(result: PlanResult, currency: string) {
  return {
    outcome: result.outcome,
    recommended: result.recommended ? candidateView(result.recommended) : null,
    alternatives: result.alternatives.map(candidateView),
    excluded: result.excluded.map(candidateView),
    shortfall:
      result.shortfallMinor === null || result.shortfallMinor === undefined
        ? null
        : formatAmount(result.shortfallMinor, currency as Currency),
  };
}

function formatStaged(spec: PaymentScheduleSpec, targetCurrency: string, fundingCurrency: string) {
  return {
    feasible: spec.feasible,
    reservePreserved: spec.reservePreserved,
    totalTarget: formatAmount(spec.totalTargetMinor, targetCurrency as Currency),
    residualShortfall: formatAmount(spec.residualShortfallMinor, targetCurrency as Currency),
    installments: spec.installments.map((i) => ({
      sequence: i.sequence,
      routeId: i.routeId,
      amount: formatAmount(i.targetMinor, targetCurrency as Currency),
      expectedDebit: formatAmount(i.expectedTotalDebitMinor, fundingCurrency as Currency),
      dispatchOnOrAfter: i.dispatchOnOrAfter.toISOString(),
      expectedPostingAt: i.expectedPostingAt.toISOString(),
      fundedBy: i.fundedByLabel,
    })),
  };
}

interface AccountRow {
  id: string;
  currency: string;
  balanceMinor: bigint;
  reservedMinor: bigint;
}

interface BillAdvice {
  obligationId: string;
  description: string;
  currency: string;
  target: string;
  settled: string;
  outstanding: string;
  paid: boolean;
  deadlineAt: string;
  fundingCurrency: string | null;
  comparison: ReturnType<typeof resultView> | { error: string };
  staged: unknown;
}

/** Builds the ordered, non-double-counting advice for every bill. */
async function buildAllAdvice(db: Db, session: ResolvedSession): Promise<BillAdvice[]> {
  const obligations = [...(await obligationsFor(db, session.id))].sort(
    (a, b) => a.deadlineAt.getTime() - b.deadlineAt.getTime(),
  );
  const accounts = await accountsFor(db, session.id);
  const flowRows = await db.select().from(cashFlowEvents).where(eq(cashFlowEvents.sessionId, session.id));
  const remRows = await db
    .select()
    .from(inboundRemittances)
    .where(eq(inboundRemittances.sessionId, session.id));
  const now = sessionNow(session);

  const commitments: PriorCommitment[] = [];
  const out: BillAdvice[] = [];

  for (const o of obligations) {
    const settled = await settledCreditMinor(db, o.id);
    const outstanding = o.targetMinor - settled;
    const base = {
      obligationId: o.id,
      description: o.description,
      currency: o.currency,
      target: formatAmount(o.targetMinor, o.currency as Currency),
      settled: formatAmount(settled, o.currency as Currency),
      outstanding: formatAmount(outstanding, o.currency as Currency),
      paid: settled >= o.targetMinor,
      deadlineAt: o.deadlineAt.toISOString(),
    };

    const funding = accounts.find((a) => a.currency === o.reserveCurrency) as AccountRow | undefined;
    if (settled >= o.targetMinor) {
      out.push({ ...base, fundingCurrency: null, comparison: { error: 'already paid' }, staged: null });
      continue;
    }
    if (!funding) {
      out.push({
        ...base,
        fundingCurrency: null,
        comparison: { error: 'no funding account in the reserve currency' },
        staged: null,
      });
      continue;
    }

    let comparison: ReturnType<typeof resultView> | { error: string };
    let result: PlanResult | null = null;
    try {
      const compared = await comparePlan(db, session, { obligationId: o.id, sourceAccountId: funding.id });
      result = compared.result;
      // Shortfall is measured in the funding (reserve) currency.
      comparison = resultView(result, funding.currency);
    } catch (error) {
      comparison = { error: error instanceof Error ? error.message : 'comparison failed' };
    }

    // Expected inbound money for the funding currency, not yet released.
    const unlocks: UnlockEvent[] = remRows
      .filter((r) => r.status !== 'AVAILABLE' && r.currency === funding.currency)
      .map((r) => ({ label: r.label, amountMinor: r.amountMinor, availableAt: r.expectedAvailableAt }));

    const spec = planStagedPayment({
      now,
      targetMinor: outstanding,
      targetCurrency: o.currency as Currency,
      deadlineAt: o.deadlineAt,
      account: {
        currency: funding.currency as Currency,
        balanceMinor: funding.balanceMinor,
        reservedMinor: funding.reservedMinor,
      },
      reserveMinor: o.reserveMinor,
      cashFlows: flowRows.map((f) => ({
        label: f.label,
        currency: f.currency as Currency,
        direction: f.direction as 'inflow' | 'outflow',
        amountMinor: f.amountMinor,
        occursAt: f.occursAt,
        certain: f.certain,
        obligationId: f.obligationId,
      })),
      unlocks,
      priorCommitments: commitments,
      horizonDays: 30,
      routes: routesForCorridor(funding.currency, o.currency),
      obligationId: o.id,
    });

    out.push({
      ...base,
      fundingCurrency: funding.currency,
      comparison,
      staged: formatStaged(spec, o.currency, funding.currency),
    });

    // Record what this bill will consume so later bills cannot reuse it.
    if (result?.recommended) {
      commitments.push({ amountMinor: result.recommended.pricing.totalDebitMinor, at: now });
    } else if (spec.feasible) {
      for (const i of spec.installments) {
        commitments.push({ amountMinor: i.expectedTotalDebitMinor, at: i.dispatchOnOrAfter });
      }
    }
  }

  return out;
}

/** Full payment comparison for every bill, with margin and settlement detail. */
export async function reviewPaymentOptions(db: Db, session: ResolvedSession) {
  return { obligations: await buildAllAdvice(db, session) };
}

/** Id-free staged proposals for the unpaid bills, plus expected inbound money. */
export async function reviewStagedPlans(db: Db, session: ResolvedSession) {
  const bills = (await buildAllAdvice(db, session)).filter((b) => !b.paid);
  return {
    plans: bills.map((b) => ({
      obligationId: b.obligationId,
      description: b.description,
      ...(b.staged as object),
    })),
    remittances: await listRemittances(db, session),
  };
}

/**
 * Prepares a payment proposal without the caller having to know object ids.
 * Defaults: the earliest-deadline unpaid bill and its recommended route. This
 * only PREPARES a proposal; the user must approve it on the review screen.
 */
export async function preparePayment(
  db: Db,
  session: ResolvedSession,
  opts: { obligationId?: string; routeId?: string } = {},
): Promise<unknown> {
  const obligations = [...(await obligationsFor(db, session.id))].sort(
    (a, b) => a.deadlineAt.getTime() - b.deadlineAt.getTime(),
  );
  const unpaid = (
    await Promise.all(
      obligations.map(async (o) => ({ o, settled: await settledCreditMinor(db, o.id) })),
    )
  )
    .filter((x) => x.settled < x.o.targetMinor)
    .sort((a, b) => a.o.deadlineAt.getTime() - b.o.deadlineAt.getTime());

  const chosen = opts.obligationId ? unpaid.find((x) => x.o.id === opts.obligationId) : unpaid[0];
  if (!chosen) throw new AppError('VALIDATION_FAILED', 'there is no unpaid bill to prepare');
  const o = chosen.o;

  const accounts = await accountsFor(db, session.id);
  const account = accounts.find((a) => a.currency === o.reserveCurrency);
  if (!account) throw new AppError('VALIDATION_FAILED', 'no funding account for that bill');

  const { result } = await comparePlan(db, session, { obligationId: o.id, sourceAccountId: account.id });
  if (result.outcome === 'NO_FEASIBLE_PLAN' && !opts.routeId) {
    throw new AppError(
      'VALIDATION_FAILED',
      'no single route can pay this bill in full today; review the staged plan or expected inbound money',
    );
  }

  const routeId = opts.routeId ?? result.recommended?.pricing.routeId;
  if (!routeId) throw new AppError('VALIDATION_FAILED', 'there is no recommended route');

  const plan = await createPlan(db, session, {
    obligationId: o.id,
    sourceAccountId: account.id,
    routeId,
  });

  return {
    planId: plan.planId,
    obligationId: o.id,
    description: o.description,
    routeId,
    termsHash: plan.termsHash,
    totalDebit: plan.terms.totalDebitAmount,
    sourceCurrency: plan.terms.sourceCurrency,
    recipientAmount: plan.terms.targetAmount,
    expectedPostingAt: plan.terms.expectedPostingAt,
    state: 'AWAITING_USER_APPROVAL',
    nextStep: 'The user must open the review screen and approve these exact terms.',
    simulated: true,
  };
}
