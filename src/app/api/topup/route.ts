import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { topUp } from '@/lib/services/money-ops';
import { safeText } from '@/lib/security/sanitize';

const Body = z.object({
  currency: z.enum(SUPPORTED_CURRENCIES),
  amount: z.string().min(1).max(20),
  source: safeText(60),
  idempotencyKey: z.string().min(8).max(80),
}).strict();

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const b = await parseBody(req, Body);
    return json(await topUp(getDb(), session, { ...b, currency: b.currency as Currency }));
  } catch (error) {
    return fail(error);
  }
}
