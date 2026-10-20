import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { fail, json, requireSession } from '@/lib/api/http';
import { spendingSummary } from '@/lib/services/money-ops';
import { profileOf } from '@/lib/agent/bank-tools';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const db = getDb();
    const { study } = profileOf({ db, session } as never);
    const days = Math.min(90, Math.max(7, Number(req.nextUrl.searchParams.get('days') ?? 30)));
    return json(await spendingSummary(db, session.id, study, days));
  } catch (error) {
    return fail(error);
  }
}
