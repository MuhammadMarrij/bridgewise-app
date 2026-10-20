/**
 * Daily FX history from the European Central Bank, via Frankfurter.
 *
 * Facts about the past only: latest, change over the window, the last week, and
 * the high and low with their dates. Nothing here forecasts, and the assistant
 * is told never to present it as a reason to wait.
 */
import type { Currency } from '../domain/money';

export interface FxHistory {
  readonly pair: string;
  readonly points: ReadonlyArray<{ date: string; rate: number }>;
  readonly latest: number;
  readonly changePercent: string;
  readonly change7dPercent: string | null;
  readonly high: { date: string; rate: number };
  readonly low: { date: string; rate: number };
  readonly source: string;
}

const cache = new Map<string, { value: FxHistory; expires: number }>();

export async function fxHistory(base: Currency, quote: Currency, days = 30): Promise<FxHistory> {
  const key = `${base}/${quote}/${days}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const url = `https://api.frankfurter.dev/v1/${d(start)}..${d(end)}?base=${base}&symbols=${quote}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`ECB history unavailable for ${base}/${quote} (HTTP ${res.status})`);
  const body = (await res.json()) as { rates?: Record<string, Record<string, number>> };
  const points = Object.entries(body.rates ?? {})
    .map(([date, r]) => ({ date, rate: r[quote]! }))
    .filter((p) => Number.isFinite(p.rate))
    .sort((a, b) => a.date.localeCompare(b.date));
  // ponytail: the ECB publishes ~30 currencies; PKR and some others are absent.
  if (points.length < 2) throw new Error(`the ECB does not publish ${base}/${quote}`);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const weekAgo = points.find((p) => p.date >= d(new Date(end.getTime() - 7 * 86_400_000)));
  const high = points.reduce((a, b) => (b.rate > a.rate ? b : a));
  const low = points.reduce((a, b) => (b.rate < a.rate ? b : a));
  const pct = (a: number, b: number) => (((b - a) / a) * 100).toFixed(2);

  const value: FxHistory = {
    pair: `${base}/${quote}`,
    points,
    latest: last.rate,
    changePercent: pct(first.rate, last.rate),
    change7dPercent: weekAgo ? pct(weekAgo.rate, last.rate) : null,
    high,
    low,
    source: 'European Central Bank reference rates via Frankfurter',
  };
  cache.set(key, { value, expires: Date.now() + 60 * 60_000 });
  return value;
}
