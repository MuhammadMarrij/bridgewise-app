import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { approvePlan } from '@/lib/services/execution';

// The browser echoes back the hash of the terms it DISPLAYED. If the stored terms
// differ, the user would be approving something they were not shown, and this fails.
const Body = z.object({ expectedTermsHash: z.string().length(64) }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    const grant = await approvePlan(getDb(), session, {
      planId: id,
      expectedTermsHash: body.expectedTermsHash,
    });
    // The nonce is returned ONCE and is single use.
    return json({ nonce: grant.nonce, expiresAt: grant.expiresAt.toISOString() });
  } catch (error) {
    return fail(error);
  }
}
