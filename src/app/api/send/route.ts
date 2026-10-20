import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { proposeSend } from '@/lib/services/money-ops';
import { safeText } from '@/lib/security/sanitize';

const Body = z.object({
  recipientId: z.string().uuid(),
  receiveAmount: z.string().min(1).max(20),
  fromCurrency: z.enum(SUPPORTED_CURRENCIES).optional(),
  note: safeText(80).optional(),
}).strict();

/** Prepares a transfer card. Moves nothing until approved. */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const b = await parseBody(req, Body);
    const p = await proposeSend(getDb(), session, { ...b, fromCurrency: b.fromCurrency as Currency | undefined, proposedBy: 'user' });
    return json({ id: p.id, title: p.title }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
