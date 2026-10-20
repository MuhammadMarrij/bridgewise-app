import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { addRecipient, listRecipients } from '@/lib/services/money-ops';
import { safeText } from '@/lib/security/sanitize';

export const dynamic = 'force-dynamic';

const Body = z.object({
  name: safeText(80),
  relationship: z.enum(['family', 'friend', 'landlord', 'university', 'other']),
  country: z.string().length(2),
  currency: z.enum(SUPPORTED_CURRENCIES),
  accountLabel: safeText(60, 3).optional(),
  // Paid for real through Alipay: the account (mobile or email) and the real name Alipay checks.
  alipayAccount: z.string().trim().min(5).max(80).optional(),
  alipayName: safeText(60).optional(),
}).strict();

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    return json({ recipients: await listRecipients(getDb(), session.id) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const b = await parseBody(req, Body);
    const r = await addRecipient(getDb(), session, { ...b, currency: b.currency as Currency });
    return json({ recipient: r }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
