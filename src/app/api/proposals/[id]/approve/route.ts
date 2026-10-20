import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { actionProposals } from '@/lib/db/schema';
import { assertSameOrigin, fail, json, parseBody, rateLimit, requireSession } from '@/lib/api/http';
import { confirmPassword } from '@/lib/services/auth';
import { executeProposal } from '@/lib/services/wallet';

// The browser echoes the hash of the terms it displayed. If the stored terms
// differ, the student would be approving something they were not shown.
const Body = z.object({ expectedTermsHash: z.string().length(64), password: z.string().max(200).optional() }).strict();

/** Kinds that send money out through a real provider: these need the password again. */
const PAYOUT_KINDS = new Set(['send', 'withdraw']);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    const db = getDb();
    const p = (await db.select({ kind: actionProposals.kind, terms: actionProposals.termsJson }).from(actionProposals)
      .where(and(eq(actionProposals.id, id), eq(actionProposals.sessionId, session.id))))[0];
    if (p && (PAYOUT_KINDS.has(p.kind) || (p.kind === 'pay_bill' && (p.terms as { rail?: string })?.rail === 'alipay'))) {
      await rateLimit(`stepup:${session.id}`, 5, 60_000);
      await confirmPassword(db, session.id, body.password);
    }
    const out = await executeProposal(db, session, id, body.expectedTermsHash);
    return json({ id, status: out.proposal.status, result: out.proposal.resultJson, replay: out.replay });
  } catch (error) {
    return fail(error);
  }
}
