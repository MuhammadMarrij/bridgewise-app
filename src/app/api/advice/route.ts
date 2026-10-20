import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { fail, json, requireSession } from '@/lib/api/http';
import { reviewPaymentOptions, reviewStagedPlans } from '@/lib/services/advisor';

export const dynamic = 'force-dynamic';

/**
 * Read-only advisory view used by the dashboard: every bill's route comparison
 * (fee vs embedded FX margin, business-day posting, reserve margin), staged
 * plans, and expected inbound remittances. All figures are computed by the
 * deterministic services and are quoted verbatim by the agent and the UI.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const db = getDb();
    const [options, staged] = await Promise.all([
      reviewPaymentOptions(db, session),
      reviewStagedPlans(db, session),
    ]);
    return json({
      obligations: options.obligations,
      stagedPlans: staged.plans,
      remittances: staged.remittances,
      simulated: true,
    });
  } catch (error) {
    return fail(error);
  }
}
