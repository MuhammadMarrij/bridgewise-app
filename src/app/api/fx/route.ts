import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/api/http';
import { assertCurrency } from '@/lib/domain/money';
import { fxHistory } from '@/lib/rates/history';
import { liveMidRate } from '@/lib/rates/live';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const base = assertCurrency(p.get('base') ?? 'GBP');
    const quote = assertCurrency(p.get('quote') ?? 'USD');
    const days = Math.min(90, Math.max(7, Number(p.get('days') ?? 30)));
    const live = await liveMidRate(base, quote);
    const history = await fxHistory(base, quote, days).catch(() => null);
    return json({ pair: `${base}/${quote}`, live, history });
  } catch (error) {
    return fail(error);
  }
}
