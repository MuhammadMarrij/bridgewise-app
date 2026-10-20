import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession, uuid } from '@/lib/api/http';
import { createPlan } from '@/lib/services/planning';

// The caller chooses a ROUTE, never an amount, a fee or a rate. Every figure in
// the resulting plan is resolved server-side by the deterministic planner.
const Body = z
  .object({
    obligationId: uuid,
    sourceAccountId: uuid,
    routeId: z.string().min(1).max(64),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const body = await parseBody(req, Body);
    const plan = await createPlan(getDb(), session, body);
    return json(
      {
        planId: plan.planId,
        termsHash: plan.termsHash,
        terms: plan.terms,
        expiresAt: plan.expiresAt.toISOString(),
        simulated: true,
      },
      { status: 201 },
    );
  } catch (error) {
    return fail(error);
  }
}
