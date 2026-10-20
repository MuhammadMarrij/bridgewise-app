import { describe, it, expect } from 'vitest';
import { applyMargin, liveMidRate, asRate, clearRateCache } from '@/lib/rates/live';
import { withLiveRates } from '@/lib/rates/apply';
import { SIMULATED_ROUTES } from '@/lib/domain/fixtures';
import { sourcePrincipalFor, formatAmount } from '@/lib/domain/money';

describe('provider margin over mid-market', () => {
  it('reduces the customer rate by exactly the spread', () => {
    // 40 bps off 1.333100 is 1.327768...
    expect(applyMargin('1.331400', 40)).toBe('1.326074');
    expect(applyMargin('1.000000', 0)).toBe('1.000000');
  });

  it('a wider spread always gives the customer a worse rate', () => {
    const tight = Number(applyMargin('1.331400', 40));
    const wide = Number(applyMargin('1.331400', 80));
    expect(wide).toBeLessThan(tight);
  });

  it('rejects an implausible spread rather than pricing it', () => {
    expect(() => applyMargin('1.33', -1)).toThrow();
    expect(() => applyMargin('1.33', 5000)).toThrow();
  });
});

// hits the real network. Skipped when offline so the suite stays
// runnable on a train; the assertion is about provenance, not a fixed number.
describe('live reference rate', () => {
  it('fetches a real GBP/USD rate with a named source', async () => {
    clearRateCache();
    let rate;
    try {
      rate = await liveMidRate('GBP', 'USD');
    } catch {
      console.warn('skipped: no network');
      return;
    }
    expect(Number(rate.mid)).toBeGreaterThan(0.5);
    expect(Number(rate.mid)).toBeLessThan(5);
    expect(rate.source).toMatch(/Central Bank|exchangerate/i);
    expect(rate.asOf).toBeTruthy();
    // It must be usable as exact arithmetic, not a float.
    expect(asRate(rate).numerator).toBeGreaterThan(0n);
  });

  it('prices every route in the corridor off that one rate', async () => {
    let priced;
    try {
      priced = await withLiveRates(SIMULATED_ROUTES, 'GBP', 'USD');
    } catch {
      console.warn('skipped: no network');
      return;
    }
    const corridor = priced.routes.filter((r) => r.from === 'GBP' && r.to === 'USD');
    expect(corridor.length).toBeGreaterThan(0);
    for (const route of corridor) {
      expect(route.midRate).toBe(priced.rate.mid);
      // Every customer rate is worse than mid: that IS the provider's margin.
      expect(Number(route.rate)).toBeLessThan(Number(priced.rate.mid));
    }

    // The principal moves with the market instead of being a literal.
    const target = 800000n; // USD 8,000.00
    const principal = sourcePrincipalFor(target, asRate(priced.rate));
    expect(formatAmount(principal, 'GBP')).not.toBe('6400.00');
  });
});
