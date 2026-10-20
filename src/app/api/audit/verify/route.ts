import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { fail, json, requireSession } from '@/lib/api/http';
import { verifyAuditChain } from '@/lib/services/audit';

export const dynamic = 'force-dynamic';

/**
 * Read-only integrity proof for the caller's own session: recomputes the
 * tamper-evident audit hash chain and reports the first break, if any. It
 * cannot change data; it demonstrates that silent edits are detectable.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const db = getDb();
    const verdict = await verifyAuditChain(db, session.id);
    return json({ ...verdict, simulated: true });
  } catch (error) {
    return fail(error);
  }
}
