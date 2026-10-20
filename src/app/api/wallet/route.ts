import type { NextRequest } from 'next/server';
import { desc, eq, isNotNull, and } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { fail, json, requireSession } from '@/lib/api/http';
import { getWallet, listProposals } from '@/lib/services/wallet';
import { profileOf } from '@/lib/agent/bank-tools';
import { actionProposals, obligations, rateAlerts } from '@/lib/db/schema';
import { formatAmount, type Currency } from '@/lib/domain/money';
import { insightsFor } from '@/lib/services/insights';

export const dynamic = 'force-dynamic';

/** Everything the home screen needs in one read. */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const db = getDb();
    const { home, study } = profileOf({ db, session } as never);
    const [wallet, insights] = await Promise.all([
      getWallet(db, session.id, study),
      insightsFor(db, session, { home, study }),
    ]);
    const bills = await db.select().from(obligations).where(eq(obligations.sessionId, session.id));
    const alerts = await db.select().from(rateAlerts).where(eq(rateAlerts.sessionId, session.id));
    const proposals = await listProposals(db, session.id);
    const activity = await db
      .select()
      .from(actionProposals)
      .where(and(eq(actionProposals.sessionId, session.id), isNotNull(actionProposals.decidedAt)))
      .orderBy(desc(actionProposals.decidedAt))
      .limit(10);
    const now = Date.now();
    return json({
      profile: { home, study },
      wallet,
      insights,
      bills: bills.map((b) => ({
        id: b.id,
        description: b.description,
        amount: formatAmount(b.targetMinor, b.currency as Currency),
        currency: b.currency,
        dueAt: b.deadlineAt.toISOString(),
        daysLeft: Math.floor((b.deadlineAt.getTime() - now) / 86_400_000),
        confirmed: !!b.confirmedAt,
        paid: !!b.paidAt,
      })),
      alerts: alerts.map((a) => ({ id: a.id, pair: `${a.base}/${a.quote}`, direction: a.direction, threshold: a.threshold, firedAt: a.firedAt })),
      proposals: proposals.map((p) => ({
        id: p.id, kind: p.kind, title: p.title, summary: p.summary, status: p.status,
        terms: p.termsJson, termsHash: p.termsHash, proposedBy: p.proposedBy,
        expiresAt: p.expiresAt.toISOString(), result: p.resultJson,
      })),
      activity: activity.map((p) => ({ id: p.id, title: p.title, status: p.status, at: p.decidedAt, result: p.resultJson })),
    });
  } catch (error) {
    return fail(error);
  }
}
