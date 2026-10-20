import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, fail, json, parseBody, requireSession } from '@/lib/api/http';
import { extractInvoice } from '@/lib/services/bills';

const Body = z.object({ text: z.string().min(10).max(8000) }).strict();

/** Reads an invoice the student pasted. Stores nothing. */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    await requireSession(req);
    const body = await parseBody(req, Body);
    return json(extractInvoice(body.text));
  } catch (error) {
    return fail(error);
  }
}
