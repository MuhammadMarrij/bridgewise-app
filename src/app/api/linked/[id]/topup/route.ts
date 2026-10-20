import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { topUpFromSource } from '@/lib/services/linked';

const Body = z.object({ amount: z.string().min(1).max(20), idempotencyKey: z.string().min(8).max(80) }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const b = await parseBody(req, Body);
    return json(await topUpFromSource(getDb(), session, { sourceId: id, ...b }));
  } catch (error) {
    return fail(error);
  }
}
