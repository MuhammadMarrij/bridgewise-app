/**
 * Money. Integer minor units in bigint, never a float, never a Number.
 *
 * Every amount that crosses a boundary (JSON, database, UI) is a decimal STRING.
 * Every amount in arithmetic is a bigint of minor units plus its currency.
 * The hand-verified golden scenario is the oracle these functions must reproduce exactly.
 */

/**
 * Currencies differ in how many decimal places they use. Most students use
 * two-decimal currencies, but real corridors include zero-decimal home
 * currencies (PKR, JPY, KRW) and three-decimal dinars (KWD, BHD). Conversion
 * scales by the exponent of EACH currency; adding a currency is a deliberate
 * act that must also widen the database CHECK (migration 0003) in one change.
 */
export interface CurrencyMeta {
  /** ISO 4217 code. */
  code: string;
  /** Number of decimal places in the smallest cash unit. */
  exponent: number;
  /** Human label, e.g. "Pakistani rupee". */
  label: string;
  /** Jurisdiction the settlement calendar tags default to. */
  jurisdiction: string;
}

/**
 * The supported currencies. GBP and USD stay first so the seeded golden
 * workspace and its UI ordering are unchanged.
 */
const CURRENCY_META: CurrencyMeta[] = [
  // Two-decimal corridors.
  { code: 'GBP', exponent: 2, label: 'British pound', jurisdiction: 'GB' },
  { code: 'USD', exponent: 2, label: 'US dollar', jurisdiction: 'US' },
  { code: 'EUR', exponent: 2, label: 'Euro', jurisdiction: 'EU' },
  { code: 'AUD', exponent: 2, label: 'Australian dollar', jurisdiction: 'AU' },
  { code: 'CAD', exponent: 2, label: 'Canadian dollar', jurisdiction: 'CA' },
  { code: 'CNY', exponent: 2, label: 'Chinese yuan', jurisdiction: 'CN' },
  { code: 'AED', exponent: 2, label: 'UAE dirham', jurisdiction: 'AE' },
  { code: 'INR', exponent: 2, label: 'Indian rupee', jurisdiction: 'IN' },
  // Zero-decimal corridors.
  { code: 'PKR', exponent: 0, label: 'Pakistani rupee', jurisdiction: 'PK' },
  { code: 'JPY', exponent: 0, label: 'Japanese yen', jurisdiction: 'JP' },
  { code: 'KRW', exponent: 0, label: 'South Korean won', jurisdiction: 'KR' },
  // Three-decimal corridors (the dinar is priced to the fils, 1/1000).
  { code: 'KWD', exponent: 3, label: 'Kuwaiti dinar', jurisdiction: 'KW' },
  { code: 'BHD', exponent: 3, label: 'Bahraini dinar', jurisdiction: 'BH' },
];

export const CURRENCY_REGISTRY: Record<string, CurrencyMeta> = Object.fromEntries(
  CURRENCY_META.map((m) => [m.code, m]),
);

export const SUPPORTED_CURRENCIES = CURRENCY_META.map((m) => m.code) as [string, ...string[]];
export type Currency = string;

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CURRENCY_REGISTRY, value);
}

export function assertCurrency(value: unknown): Currency {
  if (!isCurrency(value)) {
    throw new MoneyError('UNSUPPORTED_CURRENCY', `currency ${String(value)} is not supported`);
  }
  return value;
}

export function currencyMeta(currency: Currency): CurrencyMeta {
  const meta = CURRENCY_REGISTRY[currency];
  if (!meta) throw new MoneyError('UNSUPPORTED_CURRENCY', `currency ${currency} is not supported`);
  return meta;
}

export function exponentOf(currency: Currency): number {
  return currencyMeta(currency).exponent;
}

export type MoneyErrorCode =
  | 'UNSUPPORTED_CURRENCY'
  | 'MALFORMED_AMOUNT'
  | 'NEGATIVE_AMOUNT'
  | 'TOO_MANY_DECIMALS'
  | 'AMOUNT_TOO_LARGE'
  | 'MALFORMED_RATE'
  | 'CURRENCY_MISMATCH'
  | 'EXPONENT_MISMATCH';

export class MoneyError extends Error {
  constructor(readonly code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * The largest amount we accept, in minor units: 1e15 minor = 10 trillion major.
 * Bounded so a hostile input cannot produce an unbounded bigint and so every
 * product below stays far inside what PostgreSQL's bigint column can hold.
 */
export const MAX_MINOR = 1_000_000_000_000_000n;

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export function money(minor: bigint, currency: Currency): Money {
  if (minor > MAX_MINOR || minor < -MAX_MINOR) {
    throw new MoneyError('AMOUNT_TOO_LARGE', `amount ${minor} exceeds the supported range`);
  }
  return { minor, currency };
}

/**
 * Strict decimal text to minor units. Rejects anything a careless parser would
 * accept: signs, exponents, thousands separators, whitespace inside, bare dots,
 * excess decimals, and NaN-like words.
 */
export function parseAmount(text: unknown, currency: Currency): bigint {
  if (typeof text !== 'string') {
    throw new MoneyError('MALFORMED_AMOUNT', 'amount must be a decimal string');
  }
  const trimmed = text.trim();
  const match = /^(\d{1,16})(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new MoneyError('MALFORMED_AMOUNT', `amount ${JSON.stringify(text)} is not a plain decimal`);
  }
  const whole = match[1]!;
  const frac = match[2] ?? '';
  const exponent = exponentOf(currency);
  if (frac.length > exponent) {
    throw new MoneyError(
      'TOO_MANY_DECIMALS',
      `${currency} allows ${exponent} decimal places, received ${frac.length}`,
    );
  }
  const padded = frac.padEnd(exponent, '0');
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(padded === '' ? '0' : padded);
  if (minor > MAX_MINOR) {
    throw new MoneyError('AMOUNT_TOO_LARGE', `amount ${trimmed} exceeds the supported range`);
  }
  return minor;
}

/** Minor units to a plain decimal string. No grouping: that is presentation. */
export function formatAmount(minor: bigint, currency: Currency): string {
  const exponent = exponentOf(currency);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const scale = 10n ** BigInt(exponent);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(exponent, '0');
  const body = exponent === 0 ? `${whole}` : `${whole}.${frac}`;
  return negative ? `-${body}` : body;
}

/** Presentation only: grouped, with the ISO code. Never fed back into arithmetic. */
export function displayAmount(minor: bigint, currency: Currency): string {
  const plain = formatAmount(minor, currency);
  const negative = plain.startsWith('-');
  const [whole = '0', frac] = (negative ? plain.slice(1) : plain).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac === undefined ? grouped : `${grouped}.${frac}`;
  return `${negative ? '-' : ''}${body} ${currency}`;
}

/**
 * An exchange rate held exactly, as a rational. "1.25" becomes 125/100 and stays
 * that way: it is never converted to a float at any point in the pipeline.
 */
export interface Rate {
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly text: string;
  readonly from: Currency;
  readonly to: Currency;
}

/** `text` is TO units per one FROM unit, e.g. parseRate('1.25', 'GBP', 'USD'). */
export function parseRate(text: unknown, from: Currency, to: Currency): Rate {
  if (typeof text !== 'string') {
    throw new MoneyError('MALFORMED_RATE', 'rate must be a decimal string');
  }
  const trimmed = text.trim();
  const match = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(trimmed);
  if (!match) {
    throw new MoneyError('MALFORMED_RATE', `rate ${JSON.stringify(text)} is not a plain decimal`);
  }
  const whole = match[1]!;
  const frac = match[2] ?? '';
  const numerator = BigInt(whole + frac);
  if (numerator === 0n) {
    throw new MoneyError('MALFORMED_RATE', 'rate must be greater than zero');
  }
  return {
    numerator,
    denominator: 10n ** BigInt(frac.length),
    text: trimmed,
    from,
    to,
  };
}

/** Ceiling division for positive bigints. The student never under-funds a bill. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError('MALFORMED_RATE', 'denominator must be positive');
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The source principal needed to deliver exactly `targetMinor` of the target
 * currency at `rate`, rounded UP to a whole source minor unit.
 *
 * The rate is "TO units per one FROM unit", expressed as a decimal text, so
 * `rate.numerator / rate.denominator` already absorbs the decimal scaling of
 * the rate text itself. Converting a minor-unit count to a minor-unit count
 * across currencies that may have different exponents adds one factor per side:
 *
 *   targetWhole  = targetMinor / 10^eTo
 *   sourceWhole  = targetWhole / rate
 *   principal    = ceil(sourceWhole * 10^eFrom)
 *                = ceil(targetMinor * rateDen * 10^eFrom / (rateNum * 10^eTo))
 *
 * When both exponents are two (the golden corridor), the 10^2 factors cancel
 * and this reduces to the previous ceil(target*rateDen/rateNum), so the golden
 * figures are unchanged. Rounding is always UP: a student may over-pay a
 * fraction of a source minor unit, never under-fund the tuition.
 */
export function sourcePrincipalFor(targetMinor: bigint, rate: Rate): bigint {
  if (targetMinor < 0n) throw new MoneyError('NEGATIVE_AMOUNT', 'target must not be negative');
  const fromScale = 10n ** BigInt(exponentOf(rate.from));
  const toScale = 10n ** BigInt(exponentOf(rate.to));
  return ceilDiv(targetMinor * rate.denominator * fromScale, rate.numerator * toScale);
}

/**
 * The inverse of {@link sourcePrincipalFor}: the largest TARGET minor amount
 * (rounded DOWN) that can be delivered by `sourceMinor` of the source currency
 * at `rate`, accounting for a flat source fee. Used to size staged payments.
 *
 *   spendable      = sourceMinor - feeMinor
 *   targetMinor    = floor(spendable * rateNum * 10^eTo / (rateDen * 10^eFrom))
 */
export function targetDeliverableFor(
  sourceMinor: bigint,
  feeMinor: bigint,
  rate: Rate,
): bigint {
  const spendable = sourceMinor - feeMinor;
  if (spendable <= 0n) return 0n;
  const fromScale = 10n ** BigInt(exponentOf(rate.from));
  const toScale = 10n ** BigInt(exponentOf(rate.to));
  return (spendable * rate.numerator * toScale) / (rate.denominator * fromScale);
}

export function addSame(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new MoneyError('CURRENCY_MISMATCH', `cannot add ${a.currency} to ${b.currency}`);
  }
  return money(a.minor + b.minor, a.currency);
}

export function subtractSame(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new MoneyError('CURRENCY_MISMATCH', `cannot subtract ${b.currency} from ${a.currency}`);
  }
  return money(a.minor - b.minor, a.currency);
}
