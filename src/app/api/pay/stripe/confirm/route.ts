import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { confirmStripe } from '@/lib/connectors/live';

const Body = z.object({ outTradeNo: z.string().min(8).max(64) }).strict();

/** Retrieves the PaymentIntent from Stripe; credits only on succeeded. */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const b = await parseBody(req, Body);
    return json(await confirmStripe(getDb(), session, b.outTradeNo));
  } catch (error) {
    return fail(error);
  }
}
