import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { proposeWithdrawal } from '@/lib/services/linked';

const Body = z.object({ receiveAmount: z.string().min(1).max(20), fromCurrency: z.enum(SUPPORTED_CURRENCIES).optional() }).strict();

/** Prepares an approval card for moving money out. Moves nothing. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const b = await parseBody(req, Body);
    const p = await proposeWithdrawal(getDb(), session, { sourceId: id, receiveAmount: b.receiveAmount, fromCurrency: b.fromCurrency as Currency | undefined, proposedBy: 'user' });
    return json({ id: p.id, title: p.title }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
