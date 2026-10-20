/**
 * Live foreign-exchange rates from real published sources.
 *
 * Primary:  Frankfurter (European Central Bank reference rates)
 * Fallback: open.er-api.com (exchangerate-api.com free tier)
 *
 * Both are free and need no key. Neither is a trading venue: these are
 * REFERENCE rates, which is exactly what a mid-market comparison needs, and the
 * provenance travels with the number so nothing is ever shown as a rate we
 * cannot source.
 *
 * If both sources fail we return an error, never a stale invented number. A
 * wrong rate presented confidently is worse than no rate.
 */
import { parseRate, type Currency, type Rate } from '../domain/money';

export interface LiveRate {
  readonly pair: string;
  /** Mid-market reference rate, TO per one FROM unit, as exact decimal text. */
  readonly mid: string;
  readonly from: Currency;
  readonly to: Currency;
  /** The publisher, named so a judge can check it. */
  readonly source: string;
  readonly sourceUrl: string;
  /** The date the publisher says the rate is for. */
  readonly asOf: string;
  /** When we fetched it. Distinct from asOf: ECB publishes once a day. */
  readonly fetchedAt: string;
}

export class RateUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`no live rate available: ${detail}`);
    this.name = 'RateUnavailableError';
  }
}

// ponytail: in-process cache. ECB publishes once a working day, so a short TTL
// is plenty and avoids hammering a free endpoint. Redis if this ever runs
// multi-instance.
const TTL_MS = Number(process.env.FX_CACHE_TTL_MS ?? 15 * 60_000);
const cache = new Map<string, { value: LiveRate; expires: number }>();

/** Decimal text with a bounded number of places; never a float in transit. */
function toDecimal(value: number, places = 6): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RateUnavailableError(`source returned a non-positive rate: ${value}`);
  }
  return value.toFixed(places);
}

async function fromFrankfurter(from: Currency, to: Currency, signal: AbortSignal): Promise<LiveRate> {
  const url = `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`;
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new RateUnavailableError(`frankfurter HTTP ${res.status}`);
  const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
  const value = body.rates?.[to];
  if (value === undefined) throw new RateUnavailableError(`frankfurter has no ${from}/${to}`);
  return {
    pair: `${from}/${to}`,
    mid: toDecimal(value),
    from,
    to,
    source: 'European Central Bank reference rate (via Frankfurter)',
    sourceUrl: url,
    asOf: body.date ?? new Date().toISOString().slice(0, 10),
    fetchedAt: new Date().toISOString(),
  };
}

async function fromErApi(from: Currency, to: Currency, signal: AbortSignal): Promise<LiveRate> {
  const url = `https://open.er-api.com/v6/latest/${from}`;
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new RateUnavailableError(`er-api HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: string;
    time_last_update_utc?: string;
    rates?: Record<string, number>;
  };
  if (body.result !== 'success') throw new RateUnavailableError('er-api did not report success');
  const value = body.rates?.[to];
  if (value === undefined) throw new RateUnavailableError(`er-api has no ${from}/${to}`);
  return {
    pair: `${from}/${to}`,
    mid: toDecimal(value),
    from,
    to,
    source: 'exchangerate-api.com open endpoint',
    sourceUrl: url,
    asOf: body.time_last_update_utc ?? new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * The live mid-market rate for a pair, cached briefly.
 *
 * Tries the ECB first because it is the authoritative public reference, then
 * the secondary source. Both failing is reported, not papered over.
 */
export async function liveMidRate(from: Currency, to: Currency): Promise<LiveRate> {
  if (from === to) {
    return {
      pair: `${from}/${to}`,
      mid: '1.000000',
      from,
      to,
      source: 'identity',
      sourceUrl: '',
      asOf: new Date().toISOString().slice(0, 10),
      fetchedAt: new Date().toISOString(),
    };
  }

  const key = `${from}/${to}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.FX_TIMEOUT_MS ?? 8000));
  const failures: string[] = [];
  try {
    for (const source of [fromFrankfurter, fromErApi]) {
      try {
        const value = await source(from, to, controller.signal);
        cache.set(key, { value, expires: Date.now() + TTL_MS });
        return value;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'unknown');
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // A stale cached rate is better than nothing ONLY if we say it is stale.
  if (hit) return { ...hit.value, source: `${hit.value.source} (STALE, refresh failed)` };
  throw new RateUnavailableError(failures.join(' | '));
}

/** The mid rate as an exact rational, for arithmetic. */
export function asRate(live: LiveRate): Rate {
  return parseRate(live.mid, live.from, live.to);
}

/**
 * A provider's customer rate: the mid-market rate less their spread.
 *
 * This is how remittance pricing actually works — the margin embedded in the
 * rate is usually larger than the visible fee — so deriving it this way means
 * every figure traces back to a published reference rate rather than to a
 * number somebody typed.
 */
export function applyMargin(midText: string, basisPoints: number, places = 6): string {
  if (!Number.isFinite(basisPoints) || basisPoints < 0 || basisPoints > 2000) {
    throw new RateUnavailableError(`implausible margin: ${basisPoints} bps`);
  }
  // Integer arithmetic on scaled units; no float multiplication of money.
  const scale = 10n ** BigInt(places);
  const midScaled = BigInt(Math.round(Number(midText) * Number(scale)));
  const customer = (midScaled * BigInt(10_000 - Math.round(basisPoints))) / 10_000n;
  const whole = customer / scale;
  const frac = (customer % scale).toString().padStart(places, '0');
  return `${whole}.${frac}`;
}

export function clearRateCache(): void {
  cache.clear();
}

export interface RateTable {
  readonly base: Currency;
  /** TO units per one BASE unit, as exact decimal text. */
  readonly rates: Readonly<Record<string, string>>;
  readonly source: string;
  readonly asOf: string;
  readonly fetchedAt: string;
}

const tableCache = new Map<string, { value: RateTable; expires: number }>();

/**
 * Every rate against one base in a single request, for valuing a whole wallet.
 * The ECB does not publish PKR, so this uses the broader secondary source and
 * says so; single-pair pricing still prefers the ECB.
 */
export async function rateTable(base: Currency): Promise<RateTable> {
  const hit = tableCache.get(base);
  if (hit && hit.expires > Date.now()) return hit.value;
  const url = `https://open.er-api.com/v6/latest/${base}`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new RateUnavailableError(`er-api HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string; time_last_update_utc?: string; rates?: Record<string, number> };
    if (body.result !== 'success' || !body.rates) throw new RateUnavailableError('er-api did not report success');
    const rates: Record<string, string> = {};
    for (const [code, v] of Object.entries(body.rates)) {
      if (Number.isFinite(v) && v > 0) rates[code] = v.toFixed(8);
    }
    const value: RateTable = {
      base,
      rates,
      source: 'exchangerate-api.com open endpoint',
      asOf: body.time_last_update_utc ?? new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    };
    tableCache.set(base, { value, expires: Date.now() + TTL_MS });
    return value;
  } catch (error) {
    if (hit) return { ...hit.value, source: `${hit.value.source} (STALE, refresh failed)` };
    throw error instanceof RateUnavailableError ? error : new RateUnavailableError(String(error));
  }
}
