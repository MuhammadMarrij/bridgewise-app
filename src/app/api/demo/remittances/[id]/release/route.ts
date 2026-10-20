import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import {
  assertSameOrigin,
  demoControlsEnabled,
  fail,
  json,
  requireSession, assertLegacyDemoEnabled } from '@/lib/api/http';
import { AppError } from '@/lib/services/errors';
import { releaseRemittance } from '@/lib/services/remittance';
import { inboundRemittances } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * Scenario control: "receive" an inbound remittance. It is demo-gated exactly
 * like the transfer simulator, and is scoped to the caller's own workspace.
 * Releasing credits the student's own account through a balanced ledger and
 * advances the pinned demo clock; it is idempotent.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertLegacyDemoEnabled();
    if (!demoControlsEnabled()) {
      throw new AppError('UNSUPPORTED', 'scenario controls are disabled in this environment');
    }
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const db = getDb();

    const owned = await db
      .select()
      .from(inboundRemittances)
      .where(and(eq(inboundRemittances.id, id), eq(inboundRemittances.sessionId, session.id)))
      .limit(1);
    if (!owned[0]) throw new AppError('NOT_FOUND', 'remittance not found');

    const result = await releaseRemittance(db, session, id);
    return json({
      remittance: result.view,
      clockAdvancedTo: result.clockAdvancedTo,
      simulated: true,
    });
  } catch (error) {
    return fail(error);
  }
}
