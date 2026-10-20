/**
 * Simulated corridor catalog. Routes are synthetic and deterministic; nothing
 * here is a market quote or a live provider.
 *
 * The golden GBPâ†’USD routes live in fixtures.ts (they are frozen). This module
 * adds a second, genuinely different corridor â€” PKRâ†’USD â€” so the product is not
 * a single hardcoded pair. It also exposes a same-currency settlement leg, which
 * carries no FX at all.
 */
import type { SimulatedRoute } from './types';
import { SIMULATED_ROUTES } from './fixtures';

/**
 * PKRâ†’USD corridors for the global student persona. A Pakistani student funds
 * a US dollar tuition from a PKR account. Rates are TO per FROM (USD per PKR).
 *
 * The cheap route is a multi-day correspondent path that lands after the
 * deadline; the fast e-wallet is dearer; the bank transfer is the balanced
 * recommendation.
 */
export const GLOBAL_ROUTES: readonly SimulatedRoute[] = [
  {
    id: 'pkr-bank',
    providerLabel: 'Simulated Bank Transfer (fictional)',
    from: 'PKR',
    to: 'USD',
    rate: '0.00355',
    midRate: '0.00357',
    sourceFee: '2000',
    deliveryHours: 0,
    postingHours: 0,
    settlement: {
      kind: 'business_days',
      deliveryBusinessDays: 3,
      postingBusinessDays: 1,
      jurisdiction: 'US',
    },
    quoteTtlMinutes: 30,
    feeCompleteness: 'complete',
    sourceKind: 'simulated',
  },
  {
    id: 'pkr-fast',
    providerLabel: 'Simulated Fast E-Wallet (fictional)',
    from: 'PKR',
    to: 'USD',
    rate: '0.00350',
    midRate: '0.00357',
    sourceFee: '3000',
    deliveryHours: 0,
    postingHours: 0,
    settlement: {
      kind: 'business_days',
      deliveryBusinessDays: 1,
      postingBusinessDays: 1,
      jurisdiction: 'US',
    },
    quoteTtlMinutes: 30,
    feeCompleteness: 'complete',
    sourceKind: 'simulated',
  },
  {
    id: 'pkr-cheap',
    providerLabel: 'Simulated Correspondent (fictional)',
    from: 'PKR',
    to: 'USD',
    rate: '0.00358',
    midRate: '0.00357',
    sourceFee: '800',
    deliveryHours: 0,
    postingHours: 0,
    settlement: {
      kind: 'business_days',
      deliveryBusinessDays: 7,
      postingBusinessDays: 2,
      jurisdiction: 'US',
    },
    quoteTtlMinutes: 30,
    feeCompleteness: 'complete',
    sourceKind: 'simulated',
  },
  {
    id: 'pkr-promo',
    providerLabel: 'Simulated Promo App (fictional)',
    from: 'PKR',
    to: 'USD',
    rate: '0.00359',
    midRate: '0.00357',
    sourceFee: '500',
    deliveryHours: 0,
    postingHours: 0,
    settlement: {
      kind: 'business_days',
      deliveryBusinessDays: 1,
      postingBusinessDays: 1,
      jurisdiction: 'US',
    },
    quoteTtlMinutes: 30,
    feeCompleteness: 'unknown_recipient_fee',
    incompleteFeeNote: 'The promotional quote omits the receiving-bank fee.',
    sourceKind: 'simulated',
  },
];

/**
 * A same-currency leg: money already in the bill's currency moves to the
 * beneficiary with no conversion. There is no FX margin. Used to consume a
 * pre-existing USD balance before any foreign exchange is bought.
 */
export const LOCAL_USD_ROUTE: SimulatedRoute = {
  id: 'local-usd',
  providerLabel: 'Simulated Local Account (fictional)',
  from: 'USD',
  to: 'USD',
  rate: '1',
  midRate: '1',
  sourceFee: '0.00',
  deliveryHours: 24,
  postingHours: 24,
  quoteTtlMinutes: 30,
  feeCompleteness: 'complete',
  sourceKind: 'simulated',
};

/** Every simulated route the catalog knows. */
export const ALL_ROUTES: readonly SimulatedRoute[] = [
  ...SIMULATED_ROUTES,
  ...GLOBAL_ROUTES,
  LOCAL_USD_ROUTE,
];

/** Routes whose pair exactly matches the requested corridor. */
export function routesForCorridor(from: string, to: string): readonly SimulatedRoute[] {
  return ALL_ROUTES.filter((r) => r.from === from && r.to === to);
}

export function routeById(id: string): SimulatedRoute | undefined {
  return ALL_ROUTES.find((r) => r.id === id);
}
