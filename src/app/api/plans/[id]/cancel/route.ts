import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, requireSession } from '@/lib/api/http';
import { cancelPlan } from '@/lib/services/planning';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    // A plan that already has a transfer can never be cancelled: cancelling a
    // payment that happened would be a lie, not a safeguard.
    await cancelPlan(getDb(), session, id);
    return json({ planId: id, state: 'CANCELLED' });
  } catch (error) {
    return fail(error);
  }
}
