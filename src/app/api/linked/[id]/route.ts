import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, requireSession } from '@/lib/api/http';
import { removeSource } from '@/lib/services/linked';

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    await removeSource(getDb(), session, id);
    return json({ id, removed: true });
  } catch (error) {
    return fail(error);
  }
}
