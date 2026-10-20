import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, requireSession, uuid } from '@/lib/api/http';
import { markBillPaid } from '@/lib/services/bills';

/** The student paid a set-aside bill elsewhere: release the reservation, record it paid. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    return json(await markBillPaid(getDb(), session, uuid.parse(id)));
  } catch (error) {
    return fail(error);
  }
}
