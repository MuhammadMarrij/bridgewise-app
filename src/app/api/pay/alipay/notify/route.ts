import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { alipayNotify } from '@/lib/connectors/live';
import type { ResolvedSession } from '@/lib/services/workspace';

/**
 * Alipay's server-to-server notification. No cookie and no origin check — it
 * comes from Alipay — so the RSA2 signature is the only authority, verified
 * before any field is used. Alipay retries until it receives "success".
 */
export async function POST(req: NextRequest) {
  const db = getDb();
  try {
    const form = Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>;
    await alipayNotify(db, form, async (sessionId) => {
      const s = (await db.select().from(sessions).where(eq(sessions.id, sessionId)))[0]!;
      return { id: s.id, clockKind: 'real', scenarioNow: null, scenarioVersion: s.scenarioVersion } as ResolvedSession;
    });
    return new Response('success');
  } catch {
    return new Response('failure', { status: 400 });
  }
}
