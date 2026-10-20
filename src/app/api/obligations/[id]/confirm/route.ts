import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { confirmObligation } from '@/lib/services/intake';

// The student echoes back what the SERVER understood. If it differs from what is
// stored, one of the two is wrong and we cannot tell which, so we refuse rather
// than accept the stored version.
const Body = z
  .object({
    amount: z.string().min(1).max(20),
    reference: z.string().min(3).max(64),
    deadlineAt: z.string().min(10).max(40),
  })
  .strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    await confirmObligation(getDb(), session, id, body);
    return json({ obligationId: id, confirmed: true });
  } catch (error) {
    return fail(error);
  }
}
