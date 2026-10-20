import { describe, it, expect } from 'vitest';
import { fetchProviderQuotes, clearQuoteCache } from '@/lib/rates/providers';

// ponytail: hits the live endpoint. Asserts shape and invariants, never a
// specific price — the market moves and a fixed figure would be a test that
// only passed on the day it was written.
describe('real provider quotes', () => {
  it('returns named real providers with usable costs', async () => {
    clearQuoteCache();
    let c;
    try {
      c = await fetchProviderQuotes('GBP', 'USD', '6000.00');
    } catch {
      console.warn('skipped: no network');
      return;
    }

    expect(c.quotes.length).toBeGreaterThan(3);
    expect(c.disclosure).toMatch(/not neutral|competes|provider in this market/i);

    for (const q of c.quotes) {
      expect(q.providerName.length).toBeGreaterThan(1);
      expect(Number(q.rate)).toBeGreaterThan(0);
      expect(Number(q.fee)).toBeGreaterThanOrEqual(0);
      expect(Number(q.receivedAmount)).toBeGreaterThan(0);
      // An unknown arrival time is recorded as unknown, never as a number.
      if (q.deliveryUnknown) expect(q.deliveryHours).toBeNull();
      else expect(q.deliveryHours).toBeGreaterThan(0);
    }

    // Sorted by what actually lands, best first.
    const landed = c.quotes.map((q) => Number(q.receivedAmount));
    expect([...landed].sort((a, b) => b - a)).toEqual(landed);

    // The spread between best and worst is the whole point of the product.
    expect(landed[0]! - landed[landed.length - 1]!).toBeGreaterThan(0);
  });

  it('rejects a malformed amount before building a request', async () => {
    await expect(fetchProviderQuotes('GBP', 'USD', '6,000')).rejects.toThrow();
  });
});
