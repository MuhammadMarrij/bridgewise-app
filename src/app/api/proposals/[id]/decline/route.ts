import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, requireSession } from '@/lib/api/http';
import { declineProposal } from '@/lib/services/wallet';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    await declineProposal(getDb(), session, id);
    return json({ id, status: 'DECLINED' });
  } catch (error) {
    return fail(error);
  }
}
