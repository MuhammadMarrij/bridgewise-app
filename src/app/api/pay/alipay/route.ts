import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, rateLimit, requireSession } from '@/lib/api/http';
import { createAlipayTopUp } from '@/lib/connectors/live';

const Body = z.object({ amount: z.string().min(1).max(20) }).strict();

/** Creates an Alipay trade and returns the cashier URL to send the student to. */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    await rateLimit(`alipay:${session.id}`, 10, 60_000);
    const b = await parseBody(req, Body);
    const origin = req.headers.get('origin') ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`;
    return json(await createAlipayTopUp(getDb(), session, b.amount, origin), { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
