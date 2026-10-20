import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { assertSameOrigin, fail, json, parseBody, requireSession, rateLimit } from '@/lib/api/http';
import { SUPPORTED_CURRENCIES } from '@/lib/domain/money';
import { BANKS, CONNECTOR_MODE } from '@/lib/connectors';
import { linkSource, listSources, type LinkInput } from '@/lib/services/linked';
import { safeText } from '@/lib/security/sanitize';

export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('card'),
    // Validated and tokenised in memory, then dropped. Never stored or logged.
    number: z.string().min(12).max(23),
    expiry: z.string().max(7),
    cvc: z.string().max(4),
    holder: safeText(60),
    currency: z.enum(SUPPORTED_CURRENCIES),
  }).strict(),
  z.object({ kind: z.literal('wallet'), provider: z.enum(['alipay', 'wechatpay']), account: z.string().min(5).max(80), holder: safeText(60) }).strict(),
  z.object({ kind: z.literal('bank'), bank: z.enum(Object.keys(BANKS) as [string, ...string[]]), account: z.string().min(6).max(40), holder: safeText(60) }).strict(),
]);

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    return json({ sources: await listSources(getDb(), session.id), mode: CONNECTOR_MODE, banks: BANKS });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireSession(req);
    // Card linking is a classic card-testing target; keep it slow.
    await rateLimit(`link:${session.id}`, 10, 60_000);
    const body = await parseBody(req, Body);
    return json({ source: await linkSource(getDb(), session, body as LinkInput) }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}
