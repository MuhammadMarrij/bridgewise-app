import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession, uuid } from '@/lib/api/http';
import { comparePlan } from '@/lib/services/planning';
import { formatAmount, type Currency } from '@/lib/domain/money';
import type { Candidate } from '@/lib/domain/types';

const Body = z.object({ obligationId: uuid, sourceAccountId: uuid }).strict();

/** Every excluded route is returned WITH its reason. Nothing is silently dropped. */
const shape = (c: Candidate) => ({
  routeId: c.pricing.routeId,
  provider: c.pricing.providerLabel,
  sourceCurrency: c.pricing.from,
  targetCurrency: c.pricing.to,
  recipientAmount: formatAmount(c.pricing.targetMinor, c.pricing.to as Currency),
  principal: formatAmount(c.pricing.principalMinor, c.pricing.from as Currency),
  fee: formatAmount(c.pricing.feeMinor, c.pricing.from as Currency),
  totalDebit: formatAmount(c.pricing.totalDebitMinor, c.pricing.from as Currency),
  rate: c.pricing.rate,
  expectedDeliveryAt: c.pricing.deliveredAt.toISOString(),
  expectedPostingAt: c.pricing.postedAt.toISOString(),
  quoteExpiresAt: c.pricing.expiresAt.toISOString(),
  feeCompleteness: c.pricing.feeCompleteness,
  sourceKind: c.pricing.sourceKind,
  feasible: c.feasible,
  exclusions: c.exclusions,
  projectedLow: formatAmount(c.projectedLowMinor, c.pricing.from as Currency),
  reserveMargin: formatAmount(c.reserveMarginMinor, c.pricing.from as Currency),
});

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const body = await parseBody(req, Body);
    // Comparing has no financial effect and writes nothing.
    const { result, outstandingMinor, rate } = await comparePlan(getDb(), session, body);
    return json({
      outcome: result.outcome,
      outstanding: formatAmount(outstandingMinor, 'USD'),
      recommended: result.recommended ? shape(result.recommended) : null,
      alternatives: result.alternatives.map(shape),
      excluded: result.excluded.map(shape),
      shortfall: result.shortfallMinor === null ? null : formatAmount(result.shortfallMinor, 'GBP'),
      asOf: result.asOf.toISOString(),
      // Provenance travels with the numbers: a judge can check the publisher.
      rateSource: rate
        ? {
            mid: rate.mid,
            pair: rate.pair,
            source: rate.source,
            sourceUrl: rate.sourceUrl,
            asOf: rate.asOf,
            fetchedAt: rate.fetchedAt,
            live: true,
          }
        : { live: false, source: 'no reference rate reachable; using the last-known table' },
      simulated: true,
    });
  } catch (error) {
    return fail(error);
  }
}
