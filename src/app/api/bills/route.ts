import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { addBill } from '@/lib/services/bills';
import { profileOf } from '@/lib/agent/bank-tools';
import { safeText } from '@/lib/security/sanitize';

const Body = z
  .object({
    description: safeText(120),
    amount: z.string().min(1).max(20),
    currency: z.enum(SUPPORTED_CURRENCIES),
    payee: safeText(120, 2),
    reference: safeText(64, 3),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    timezone: z.string().min(3).max(64).optional(),
    reserve: z.string().min(1).max(20).optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const body = await parseBody(req, Body);
    const db = getDb();
    const { home } = profileOf({ db, session } as never);
    const made = await addBill(db, session, {
      ...body,
      currency: body.currency as Currency,
      reserve: body.reserve ?? '0',
      reserveCurrency: home,
    });
    return json({ billId: made.obligationId, dueAt: made.deadlineAt.toISOString() }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
