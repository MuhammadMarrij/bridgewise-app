import type { NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { fail, json, requireSession } from '@/lib/api/http';
import { accountsFor, obligationsFor, settledCreditMinor } from '@/lib/services/planning';
import { sessionNow } from '@/lib/services/workspace';
import { displayAmount, formatAmount, type Currency } from '@/lib/domain/money';
import { asc, desc, eq } from 'drizzle-orm';
import { cashFlowEvents, transfers } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const db = getDb();
    const accounts = await accountsFor(db, session.id);
    const obligations = await obligationsFor(db, session.id);
    const flows = await db.select().from(cashFlowEvents).where(eq(cashFlowEvents.sessionId, session.id)).orderBy(asc(cashFlowEvents.occursAt));
    const activity = await db.select().from(transfers).where(eq(transfers.sessionId, session.id)).orderBy(desc(transfers.createdAt));

    return json({
      // Balances stay in their OWN currencies. There is deliberately no
      // consolidated total: a sum across currencies is not a spendable balance.
      accounts: accounts.map((a) => ({
        id: a.id,
        label: a.label,
        currency: a.currency,
        balance: formatAmount(a.balanceMinor, a.currency as Currency),
        reserved: formatAmount(a.reservedMinor, a.currency as Currency),
        available: formatAmount(a.balanceMinor - a.reservedMinor, a.currency as Currency),
        display: displayAmount(a.balanceMinor, a.currency as Currency),
      })),
      obligations: await Promise.all(
        obligations.map(async (o) => {
          const settled = await settledCreditMinor(db, o.id);
          return {
            id: o.id,
            confirmed: !!o.confirmedAt,
            description: o.description,
            currency: o.currency,
            target: formatAmount(o.targetMinor, o.currency as Currency),
            // Only POSTED credits count. A plan or an approval pays nothing.
            settled: formatAmount(settled, o.currency as Currency),
            outstanding: formatAmount(o.targetMinor - settled, o.currency as Currency),
            paid: settled >= o.targetMinor,
            deadlineAt: o.deadlineAt.toISOString(),
            deadlineTimezone: o.deadlineTimezone,
            reserve: formatAmount(o.reserveMinor, o.reserveCurrency as Currency),
            reserveCurrency: o.reserveCurrency,
          };
        }),
      ),
      cashFlows: flows.map((f) => ({
        id: f.id, label: f.label, currency: f.currency, direction: f.direction,
        amount: formatAmount(f.amountMinor, f.currency as Currency),
        occursAt: f.occursAt.toISOString(), certain: f.certain,
      })),
      activity: activity.map((t) => ({
        transferId: t.id, status: t.status,
        debit: formatAmount(t.debitMinor, t.sourceCurrency as Currency),
        credit: formatAmount(t.creditMinor, t.targetCurrency as Currency),
        sourceCurrency: t.sourceCurrency, targetCurrency: t.targetCurrency,
        createdAt: t.createdAt.toISOString(),
      })),
      clock: { kind: session.clockKind, now: sessionNow(session).toISOString() },
      executionMode: process.env.EXECUTION_MODE ?? 'SIMULATED',
      simulated: true,
    });
  } catch (error) {
    return fail(error);
  }
}
