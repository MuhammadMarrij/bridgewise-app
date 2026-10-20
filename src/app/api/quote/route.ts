import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { clientKey, fail, json, parseBody, rateLimit } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, formatAmount, parseAmount, type Currency } from '@/lib/domain/money';
import { planTuitionPayment } from '@/lib/domain/planner';
import { liveMidRate } from '@/lib/rates/live';
import { realRoutesForTarget } from '@/lib/rates/real-routes';
import { transitFor, formatDuration } from '@/lib/domain/transit';
import { resolveDeadline } from '@/lib/services/intake';
import { AppError } from '@/lib/services/errors';
import type { Candidate } from '@/lib/domain/types';

/**
 * The product, in one request.
 *
 * No account, no stored workspace, no seeded demo: a student types what they
 * owe and what they have, and gets ranked real providers back. Nothing is
 * written to the database, because answering this question requires storing
 * nothing about them.
 */
const Body = z
  .object({
    /** What the university must receive. */
    targetAmount: z.string().min(1).max(20),
    targetCurrency: z.enum(SUPPORTED_CURRENCIES),
    /** Where the money comes from. */
    sourceCurrency: z.enum(SUPPORTED_CURRENCIES),
    balance: z.string().min(1).max(20),
    /** Living costs that must survive the payment. */
    reserve: z.string().min(1).max(20),
    deadlineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    deadlineTime: z.string().regex(/^\d{2}:\d{2}$/),
    deadlineTimezone: z.string().min(3).max(64),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    // No session required, so the limit is the only thing between this and a
    // free proxy to the upstream comparison endpoint.
    rateLimit(`quote:${clientKey(req)}`, 30, 60_000);
    const body = await parseBody(req, Body);

    const target = parseAmount(body.targetAmount, body.targetCurrency);
    const balance = parseAmount(body.balance, body.sourceCurrency);
    const reserve = parseAmount(body.reserve, body.sourceCurrency);
    if (target <= 0n) throw new AppError('VALIDATION_FAILED', 'the amount owed must be above zero');

    const now = new Date();
    const deadlineAt = resolveDeadline(body.deadlineDate, body.deadlineTime, body.deadlineTimezone);
    if (deadlineAt.getTime() <= now.getTime()) {
      throw new AppError('VALIDATION_FAILED', 'that deadline has already passed', {
        deadlineDate: 'the deadline must be in the future',
      });
    }

    if (body.sourceCurrency === body.targetCurrency) {
      throw new AppError('UNSUPPORTED', 'no conversion is needed when both currencies match');
    }

    const mid = await liveMidRate(body.sourceCurrency, body.targetCurrency);
    const set = await realRoutesForTarget(
      body.sourceCurrency,
      body.targetCurrency,
      formatAmount(target, body.targetCurrency),
      mid.mid,
    );

    const plan = planTuitionPayment({
      now,
      targetMinor: target,
      targetCurrency: body.targetCurrency,
      deadlineAt,
      account: { currency: body.sourceCurrency, balanceMinor: balance, reservedMinor: 0n },
      reserveMinor: reserve,
      cashFlows: [],
      horizonDays: 90,
      routes: set.routes,
    });

    const src = body.sourceCurrency as Currency;
    const quoteOf = (c: Candidate) => {
      const q = set.comparison.quotes.find((x) => x.id === c.pricing.routeId);
      const transit = transitFor(q?.deliveryHours ?? null, q?.providerType);
      return {
        provider: c.pricing.providerLabel,
        providerType: q?.providerType ?? 'unknown',
        youSend: formatAmount(c.pricing.totalDebitMinor, src),
        theyReceive: formatAmount(c.pricing.targetMinor, body.targetCurrency),
        fee: formatAmount(c.pricing.feeMinor, src),
        rate: c.pricing.rate,
        // How far this provider's rate sits below the ECB reference rate. This
        // is usually larger than the visible fee and is the thing students miss.
        hiddenMarginPercent: q
          ? (((Number(mid.mid) - Number(q.rate)) / Number(mid.mid)) * 100).toFixed(2)
          : null,
        arrival: transit.label,
        arrivalIsAssumed: transit.assumed,
        arrivalBasis: transit.basis,
        leftAfterwards: formatAmount(c.projectedLowMinor, src),
        aboveYourReserve: formatAmount(c.reserveMarginMinor, src),
        usable: c.feasible,
        problems: c.exclusions,
        warnings: c.warnings,
      };
    };

    const feasible = [
      ...(plan.recommended ? [plan.recommended] : []),
      ...plan.alternatives,
    ];
    const cheapest = feasible[0];
    const dearest = feasible[feasible.length - 1];

    return json({
      answer: plan.outcome === 'PLAN_READY' ? 'USE_THIS' : 'NOTHING_WORKS',
      best: plan.recommended ? quoteOf(plan.recommended) : null,
      // What choosing badly would cost: the case for using this at all.
      costOfChoosingWorst:
        cheapest && dearest && dearest !== cheapest
          ? formatAmount(
              dearest.pricing.totalDebitMinor - cheapest.pricing.totalDebitMinor,
              src,
            )
          : null,
      alternatives: plan.alternatives.map(quoteOf),
      rejected: plan.excluded.map(quoteOf),
      shortfall: plan.shortfallMinor === null ? null : formatAmount(plan.shortfallMinor, src),
      deadline: {
        at: deadlineAt.toISOString(),
        timezone: body.deadlineTimezone,
        hoursFromNow: Math.round((deadlineAt.getTime() - now.getTime()) / 3_600_000),
      },
      referenceRate: {
        mid: mid.mid,
        pair: mid.pair,
        source: mid.source,
        asOf: mid.asOf,
      },
      providerData: {
        count: set.routes.length,
        source: set.comparison.source,
        fetchedAt: set.comparison.fetchedAt,
        disclosure: set.comparison.disclosure,
        publishAnArrivalTime: set.withPublishedArrival,
        note:
          set.withPublishedArrival === 0
            ? 'No provider in this comparison publishes an arrival time, so arrival is our conservative assumption and should be confirmed with the provider.'
            : null,
      },
      assumptions: [
        `We allow ${formatDuration(Number(process.env.POSTING_ALLOWANCE_HOURS ?? 24))} for the university to post the credit after the funds arrive.`,
        'Provider fees can be tiered; quotes are fetched for your actual amount.',
        'We do not move money. You make the payment yourself with your own provider.',
      ],
    });
  } catch (error) {
    return fail(error);
  }
}
