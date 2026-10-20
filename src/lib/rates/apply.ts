/**
 * Turns the static route table into live-priced routes.
 *
 * A route no longer carries an invented exchange rate. It carries the thing a
 * provider actually controls — its fee and the spread it charges over the
 * mid-market rate — and the rate itself is derived from a published reference
 * rate fetched at request time.
 *
 * Consequence: change nothing in the code and tomorrow's comparison uses
 * tomorrow's market. The figures trace to the ECB, not to a developer.
 */
import type { SimulatedRoute } from '../domain/types';
import type { Currency } from '../domain/money';
import { applyMargin, liveMidRate, type LiveRate } from './live';

/** Spread each provider charges over mid-market, in basis points. */
export const ROUTE_MARGIN_BPS: Record<string, number> = {
  'route-a': 40,
  'route-b': 40,
  'route-c': 48,
  'route-d': 47,
};

export const DEFAULT_MARGIN_BPS = 45;

export interface LivePricedRoutes {
  readonly routes: readonly SimulatedRoute[];
  readonly rate: LiveRate;
}

/**
 * Re-prices every route in a corridor against the live mid-market rate.
 *
 * Routes for other corridors are returned untouched, so a mixed table does not
 * silently acquire the wrong pair's rate.
 */
export async function withLiveRates(
  routes: readonly SimulatedRoute[],
  from: Currency,
  to: Currency,
): Promise<LivePricedRoutes> {
  const rate = await liveMidRate(from, to);
  return {
    rate,
    routes: routes.map((route) => {
      if (route.from !== from || route.to !== to) return route;
      const bps = ROUTE_MARGIN_BPS[route.id] ?? DEFAULT_MARGIN_BPS;
      return {
        ...route,
        rate: applyMargin(rate.mid, bps),
        midRate: rate.mid,
      };
    }),
  };
}
