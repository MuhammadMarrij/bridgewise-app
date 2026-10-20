import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  assertSameOrigin,
  demoControlsEnabled,
  fail,
  json,
  parseBody,
  requireSession, assertLegacyDemoEnabled } from '@/lib/api/http';
import { transfers } from '@/lib/db/schema';
import { AppError } from '@/lib/services/errors';
import { transferStatus } from '@/lib/services/execution';
import * as simulator from '@/lib/simulation/simulator';

/**
 * Scenario control for the demo and for tests: it advances the SIMULATOR, exactly
 * as a provider webhook would. It is not a way to edit the application's own
 * records, and it is unavailable on a hosted deployment.
 *
 * Note what it cannot do: it cannot credit an obligation, change a balance, or
 * mark a tuition paid. Those remain consequences of reconciliation.
 */
const Body = z.object({ event: z.enum(['deliver', 'post', 'reject']) }).strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    assertLegacyDemoEnabled();
    if (!demoControlsEnabled()) {
      throw new AppError('UNSUPPORTED', 'scenario controls are disabled in this environment');
    }
    assertSameOrigin(req);
    const session = await requireSession(req);
    const { id } = await ctx.params;
    const body = await parseBody(req, Body);
    const db = getDb();

    // Scoped to the caller's own transfer: a session cannot advance another
    // session's payment, even with the controls enabled.
    const owned = await db
      .select()
      .from(transfers)
      .where(and(eq(transfers.id, id), eq(transfers.sessionId, session.id)))
      .limit(1);
    if (!owned[0]) throw new AppError('NOT_FOUND', 'transfer not found');

    await simulator.advance(db, id, body.event, new Date(), 'simulated scenario control');
    const updated = await transferStatus(db, session, id);
    return json({ transferId: updated.id, status: updated.status, simulated: true });
  } catch (error) {
    if (error instanceof simulator.SimulatorError) {
      return fail(new AppError('VALIDATION_FAILED', error.message));
    }
    return fail(error);
  }
}
