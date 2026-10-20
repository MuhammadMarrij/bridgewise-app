import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { creditPlan, markCreditStep } from '@/lib/services/credit';
import { profileOf } from '@/lib/agent/bank-tools';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const db = getDb();
    return json(await creditPlan(db, session, profileOf({ db, session } as never).study));
  } catch (error) {
    return fail(error);
  }
}

const Body = z.object({ stepId: z.string().min(2).max(40), done: z.boolean() }).strict();

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const db = getDb();
    const b = await parseBody(req, Body);
    await markCreditStep(db, session, b.stepId, b.done);
    return json(await creditPlan(db, session, profileOf({ db, session } as never).study));
  } catch (error) {
    return fail(error);
  }
}
