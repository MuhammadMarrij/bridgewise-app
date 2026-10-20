import { describe, it, expect } from 'vitest';
import {
  MoneyError,
  formatAmount,
  displayAmount,
  parseAmount,
  parseRate,
  sourcePrincipalFor,
  targetDeliverableFor,
  ceilDiv,
  MAX_MINOR,
  exponentOf,
} from '@/lib/domain/money';

describe('U01 strict amount parsing', () => {
  it('parses plain decimals to minor units', () => {
    expect(parseAmount('8000.00', 'USD')).toBe(800000n);
    expect(parseAmount('6435', 'GBP')).toBe(643500n);
    expect(parseAmount('0.01', 'GBP')).toBe(1n);
    expect(parseAmount('  12.30  ', 'USD')).toBe(1230n);
  });

  it.each([
    ['-5.00', 'a negative'],
    ['1e3', 'an exponent'],
    ['1,200.00', 'a thousands separator'],
    ['12.', 'a bare trailing dot'],
    ['.5', 'a bare leading dot'],
    ['NaN', 'a NaN-like word'],
    ['Infinity', 'an infinity word'],
    ['1 200', 'an internal space'],
    ['', 'an empty string'],
    ['0x10', 'hex'],
  ])('rejects %s (%s)', (bad) => {
    expect(() => parseAmount(bad, 'GBP')).toThrow(MoneyError);
  });

  it('rejects a non-string', () => {
    expect(() => parseAmount(12.5 as unknown, 'GBP')).toThrow(/decimal string/);
  });

  it('rejects more decimals than the currency allows', () => {
    expect(() => parseAmount('1.234', 'GBP')).toThrow(/decimal places/);
  });

  it('rejects an amount beyond the supported range', () => {
    expect(() => parseAmount('9999999999999999', 'GBP')).toThrow(/range/);
  });

  it('accepts the maximum and nothing above it', () => {
    expect(parseAmount(formatAmount(MAX_MINOR, 'GBP'), 'GBP')).toBe(MAX_MINOR);
  });
});

describe('U02 unsupported currency', () => {
  it('is rejected rather than treated as two decimals', () => {
    // An unsupported currency is rejected at runtime, not silently treated as 2dp.
    expect(() => parseAmount('100.00', 'XYZ' as never)).toThrow();
  });
});

describe('U02b currencies with different exponents', () => {
  it('exposes the correct exponent per currency', () => {
    expect(exponentOf('PKR')).toBe(0);
    expect(exponentOf('JPY')).toBe(0);
    expect(exponentOf('KRW')).toBe(0);
    expect(exponentOf('USD')).toBe(2);
    expect(exponentOf('GBP')).toBe(2);
    expect(exponentOf('KWD')).toBe(3);
    expect(exponentOf('BHD')).toBe(3);
  });

  it('parses and formats zero-decimal currencies with no fraction', () => {
    expect(parseAmount('1500000', 'PKR')).toBe(1_500_000n);
    expect(formatAmount(1_500_000n, 'PKR')).toBe('1500000');
    expect(displayAmount(1_500_000n, 'JPY')).toBe('1,500,000 JPY');
    expect(() => parseAmount('100.5', 'JPY')).toThrow(/decimal places/);
  });

  it('parses and formats three-decimal dinars', () => {
    expect(parseAmount('12.345', 'KWD')).toBe(12_345n);
    expect(formatAmount(12_345n, 'KWD')).toBe('12.345');
    expect(formatAmount(7n, 'KWD')).toBe('0.007');
    expect(() => parseAmount('12.3456', 'BHD')).toThrow(/decimal places/);
  });

  it('converts PKR (0dp) to USD (2dp) and always rounds up', () => {
    // 0.005 USD per PKR = 200 PKR per USD. 5,000.00 USD = 500000 USD-minor.
    // principal = ceil(500000 * 1000 * 10^0 / (5 * 10^2)) = 1,000,000 PKR.
    const rate = parseRate('0.005', 'PKR', 'USD');
    const principal = sourcePrincipalFor(parseAmount('5000.00', 'USD'), rate);
    expect(principal).toBe(1_000_000n);
    expect(formatAmount(principal, 'PKR')).toBe('1000000');
  });

  it('converts JPY (0dp) to USD (2dp) and rounds up to a whole yen', () => {
    // 0.01 USD per JPY = 100 JPY per USD. 100.00 USD = 10000 cents.
    // principal = ceil(10000 * 100 * 1 / (1 * 100)) = 10,000 JPY.
    const rate = parseRate('0.01', 'JPY', 'USD');
    const principal = sourcePrincipalFor(parseAmount('100.00', 'USD'), rate);
    expect(formatAmount(principal, 'JPY')).toBe('10000');
  });

  it('converts USD (2dp) to KWD (3dp) and rounds up to a whole cent', () => {
    // 0.300 KWD per USD. Target 100.000 KWD = 100000 fils.
    // principal = ceil(100000 * 10 * 100 / (3 * 1000)) = 33,334 cents = 333.34 USD.
    const rate = parseRate('0.3', 'USD', 'KWD');
    const principal = sourcePrincipalFor(parseAmount('100.000', 'KWD'), rate);
    expect(formatAmount(principal, 'USD')).toBe('333.34');
  });

  it('inverse targetDeliverableFor never over-states the deliverable', () => {
    const rate = parseRate('0.005', 'PKR', 'USD');
    // 1,000,000 PKR, no fee -> 5,000.00 USD exactly.
    expect(targetDeliverableFor(1_000_000n, 0n, rate)).toBe(500_000n);
    // One PKR less cannot deliver the full 5,000.00 USD.
    expect(targetDeliverableFor(999_999n, 0n, rate)).toBeLessThan(500_000n);
    // A 2,000 PKR fee reduces the deliverable to 4,990.00 USD.
    expect(targetDeliverableFor(1_000_000n, 2000n, rate)).toBe(499_000n);
  });

  it('golden GBP->USD is unchanged by the exponent scaling', () => {
    const rate = parseRate('1.24', 'GBP', 'USD');
    expect(formatAmount(sourcePrincipalFor(800000n, rate), 'GBP')).toBe('6451.62');
  });
});

describe('formatting', () => {
  it('round-trips', () => {
    expect(formatAmount(643500n, 'GBP')).toBe('6435.00');
    expect(formatAmount(1n, 'USD')).toBe('0.01');
    expect(formatAmount(0n, 'USD')).toBe('0.00');
    expect(formatAmount(-250n, 'GBP')).toBe('-2.50');
  });

  it('groups only for display', () => {
    expect(displayAmount(643500n, 'GBP')).toBe('6,435.00 GBP');
    expect(displayAmount(800000n, 'USD')).toBe('8,000.00 USD');
    expect(displayAmount(-120000n, 'GBP')).toBe('-1,200.00 GBP');
  });
});

describe('U03 the golden arithmetic', () => {
  // These expectations come from docs/COMMAND_BRAIN.md section 1 R-2, not from
  // running the implementation. Target: USD 8,000.00 net.
  const target = 800000n;

  it('route A: rate 1.25, fee 10.00 -> principal 6400.00, debit 6410.00', () => {
    const principal = sourcePrincipalFor(target, parseRate('1.25', 'GBP', 'USD'));
    expect(formatAmount(principal, 'GBP')).toBe('6400.00');
    expect(formatAmount(principal + parseAmount('10.00', 'GBP'), 'GBP')).toBe('6410.00');
  });

  it('route B: rate 1.25, fee 35.00 -> debit 6435.00', () => {
    const principal = sourcePrincipalFor(target, parseRate('1.25', 'GBP', 'USD'));
    expect(formatAmount(principal + parseAmount('35.00', 'GBP'), 'GBP')).toBe('6435.00');
  });

  it('route C: rate 1.24, fee 8.00 -> principal 6451.62, debit 6459.62', () => {
    const principal = sourcePrincipalFor(target, parseRate('1.24', 'GBP', 'USD'));
    expect(formatAmount(principal, 'GBP')).toBe('6451.62');
    expect(formatAmount(principal + parseAmount('8.00', 'GBP'), 'GBP')).toBe('6459.62');
  });

  it('B is 24.62 cheaper than C and A is 25.00 cheaper than B', () => {
    const at125 = sourcePrincipalFor(target, parseRate('1.25', 'GBP', 'USD'));
    const at124 = sourcePrincipalFor(target, parseRate('1.24', 'GBP', 'USD'));
    const a = at125 + parseAmount('10.00', 'GBP');
    const b = at125 + parseAmount('35.00', 'GBP');
    const c = at124 + parseAmount('8.00', 'GBP');
    expect(formatAmount(c - b, 'GBP')).toBe('24.62');
    expect(formatAmount(b - a, 'GBP')).toBe('25.00');
  });

  it('rounds the principal UP, never down', () => {
    // 6451.61 would deliver less than USD 8,000.00 and must not be accepted.
    const principal = sourcePrincipalFor(target, parseRate('1.24', 'GBP', 'USD'));
    const oneLess = principal - 1n;
    // At 1.24, 645161 minor GBP yields 800000 - remainder, i.e. short of target.
    expect(oneLess * 124n < target * 100n).toBe(true);
    expect(principal * 124n >= target * 100n).toBe(true);
  });

  it('leaves the reserve margin at 365.00 after B and rent', () => {
    const balance = parseAmount('10000.00', 'GBP');
    const debit = sourcePrincipalFor(target, parseRate('1.25', 'GBP', 'USD')) + parseAmount('35.00', 'GBP');
    const rent = parseAmount('1200.00', 'GBP');
    const reserve = parseAmount('2000.00', 'GBP');
    const low = balance - debit - rent;
    expect(formatAmount(low, 'GBP')).toBe('2365.00');
    expect(formatAmount(low - reserve, 'GBP')).toBe('365.00');
  });

  it('breaches the reserve by 135.00 on the tight fixture', () => {
    const balance = parseAmount('9500.00', 'GBP');
    const debit = sourcePrincipalFor(target, parseRate('1.25', 'GBP', 'USD')) + parseAmount('35.00', 'GBP');
    const rent = parseAmount('1200.00', 'GBP');
    const reserve = parseAmount('2000.00', 'GBP');
    const low = balance - debit - rent;
    expect(formatAmount(low, 'GBP')).toBe('1865.00');
    expect(formatAmount(reserve - low, 'GBP')).toBe('135.00');
  });
});

describe('rate parsing', () => {
  it('keeps the rate exact as a rational', () => {
    const r = parseRate('1.24', 'GBP', 'USD');
    expect(r.numerator).toBe(124n);
    expect(r.denominator).toBe(100n);
    expect(r.text).toBe('1.24');
  });

  it.each(['0', '0.00', '-1.25', '1e2', 'abc', ''])('rejects %s', (bad) => {
    expect(() => parseRate(bad, 'GBP', 'USD')).toThrow(MoneyError);
  });
});

describe('ceilDiv', () => {
  it('rounds up on any remainder and is exact otherwise', () => {
    expect(ceilDiv(10n, 5n)).toBe(2n);
    expect(ceilDiv(11n, 5n)).toBe(3n);
    expect(ceilDiv(0n, 5n)).toBe(0n);
  });

  it('rejects a non-positive denominator', () => {
    expect(() => ceilDiv(10n, 0n)).toThrow(MoneyError);
  });
});
