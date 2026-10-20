import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, rateLimit, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { createStripeTopUp } from '@/lib/connectors/live';

const Body = z.object({ amount: z.string().min(1).max(20), currency: z.enum(SUPPORTED_CURRENCIES) }).strict();

/** Creates a Stripe PaymentIntent; the card is entered in Stripe's own field, never ours. */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    rateLimit(`stripe:${session.id}`, 10, 60_000);
    const b = await parseBody(req, Body);
    return json(await createStripeTopUp(getDb(), session, b.amount, b.currency as Currency), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
