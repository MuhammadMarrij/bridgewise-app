import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { executeProposal } from '@/lib/services/wallet';

// The browser echoes the hash of the terms it displayed. If the stored terms
// differ, the student would be approving something they were not shown.
const Body = z.object({ expectedTermsHash: z.string().length(64) }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    const out = await executeProposal(getDb(), session, id, body.expectedTermsHash);
    return json({ id, status: out.proposal.status, result: out.proposal.resultJson, replay: out.replay });
  } catch (error) {
    return fail(error);
  }
}
