import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES, type Currency } from '@/lib/domain/money';
import { proposeConversion } from '@/lib/services/wallet';

/** A conversion the student starts themselves, from the wallet screen. */
const Body = z
  .object({ from: z.enum(SUPPORTED_CURRENCIES), to: z.enum(SUPPORTED_CURRENCIES), sellAmount: z.string().min(1).max(20) })
  .strict();

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    const body = await parseBody(req, Body);
    const p = await proposeConversion(getDb(), session, {
      from: body.from as Currency, to: body.to as Currency, sellAmount: body.sellAmount, proposedBy: 'user',
    });
    return json({ id: p.id, title: p.title, summary: p.summary, terms: p.termsJson, termsHash: p.termsHash, expiresAt: p.expiresAt.toISOString() }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
