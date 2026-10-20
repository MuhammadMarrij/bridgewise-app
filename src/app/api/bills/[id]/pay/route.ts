import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { proposeBillPayment } from '@/lib/services/bills';

const Body = z.object({ fromCurrency: z.enum(SUPPORTED_CURRENCIES).optional() }).strict();

/** Prepares an approval card for paying a bill. Pays nothing. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    const p = await proposeBillPayment(getDb(), session, {
      obligationId: id, fromCurrency: body.fromCurrency as Currency | undefined, proposedBy: 'user',
    });
    return json({ id: p.id, title: p.title }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
