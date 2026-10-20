import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { fail, json, requireSession } from '@/lib/api/http';
import { listTransactions } from '@/lib/services/money-ops';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const q = req.nextUrl.searchParams;
    return json({
      transactions: await listTransactions(getDb(), session.id, {
        currency: q.get('currency') ?? undefined,
        category: q.get('category') ?? undefined,
        limit: Number(q.get('limit') ?? 100),
      }),
    });
  } catch (error) {
    return fail(error);
  }
}
