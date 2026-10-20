import type { NextRequest } from 'next/server';
import { eq, asc, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { fail, json, requireSession } from '@/lib/api/http';
import { auditEvents, ledgerEntries, plans, transfers } from '@/lib/db/schema';
import { formatAmount, type Currency } from '@/lib/domain/money';
import { SCENARIO_VERSION } from '@/lib/domain/fixtures';

export const dynamic = 'force-dynamic';

/**
 * A judge-facing export, scoped to THIS session. There is no global dump: a
 * session cannot export another session's activity, and nothing here carries a
 * cookie value, a nonce, an API key or personal data.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const db = getDb();

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.sessionId, session.id))
      .orderBy(asc(auditEvents.seq));

    const sessionTransfers = await db
      .select()
      .from(transfers)
      .where(eq(transfers.sessionId, session.id));

    const entries = sessionTransfers.length
      ? await db
          .select()
          .from(ledgerEntries)
          .where(inArray(ledgerEntries.transferId, sessionTransfers.map((t) => t.id)))
      : [];

    const sessionPlans = await db.select().from(plans).where(eq(plans.sessionId, session.id));

    return json({
      manifest: {
        scenarioVersion: SCENARIO_VERSION,
        clockKind: session.clockKind,
        executionMode: process.env.EXECUTION_MODE ?? 'SIMULATED',
        // The real instant this export was produced, distinct from any scenario time.
        exportedAt: new Date().toISOString(),
        simulated: true,
        note: 'All providers, rates, accounts and recipients are synthetic. No real funds moved.',
      },
      events: events.map((e) => ({
        seq: e.seq,
        at: e.createdAt.toISOString(),
        type: e.type,
        actor: e.actor,
        outcome: e.outcome,
        reason: e.reason,
        correlationId: e.correlationId,
        payload: e.payload,
      })),
      plans: sessionPlans.map((p) => ({
        id: p.id,
        state: p.state,
        termsHash: p.termsHash,
        // The full terms are included: a judge can recompute the hash themselves.
        terms: p.termsJson,
      })),
      transfers: sessionTransfers.map((t) => ({
        id: t.id,
        status: t.status,
        debit: formatAmount(t.debitMinor, t.sourceCurrency as Currency),
        credit: formatAmount(t.creditMinor, t.targetCurrency as Currency),
        externalReference: t.externalReference,
        createdAt: t.createdAt.toISOString(),
        deliveredAt: t.deliveredAt?.toISOString() ?? null,
        postedAt: t.postedAt?.toISOString() ?? null,
      })),
      ledger: entries.map((e) => ({
        transferId: e.transferId,
        bucket: e.bucket,
        currency: e.currency,
        // Signed minor units as a string, so a reader can check that each
        // currency sums to zero independently.
        signedMinor: e.signedMinor.toString(),
      })),
    });
  } catch (error) {
    return fail(error);
  }
}
