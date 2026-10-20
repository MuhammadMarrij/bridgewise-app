/**
 * Inbound remittances (F3): money the student is EXPECTING from family, a
 * scholarship or a refund.
 *
 * The displayed amount is never spendable until the simulated provider says it
 * is here and the student releases it. On release it is credited through the
 * same double-entry ledger as an outbound payment, and the demo clock advances
 * to the moment the funds clear (a scenario control, gated like the others).
 *
 * This is a simulation: there is no real inbound provider and no network.
 */
import { and, eq, asc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accounts,
  inboundRemittances,
  ledgerEntries,
  sessions,
} from '../db/schema';
import { formatAmount, type Currency } from '../domain/money';
import { AppError } from './errors';
import { appendAudit } from './audit';
import { type ResolvedSession, sessionNow } from './workspace';

type Db = NodePgDatabase<Record<string, never>>;

export interface RemittanceView {
  readonly id: string;
  readonly label: string;
  readonly senderLabel: string;
  readonly currency: string;
  readonly amount: string;
  readonly status: string;
  readonly expectedAvailableAt: string;
  readonly creditedAt: string | null;
  /** True only when the student may release it in the current demo clock. */
  readonly releasable: boolean;
  readonly simulated: true;
}

function view(
  row: typeof inboundRemittances.$inferSelect,
  now: Date,
): RemittanceView {
  return {
    id: row.id,
    label: row.label,
    senderLabel: row.senderLabel,
    currency: row.currency,
    amount: formatAmount(row.amountMinor, row.currency as Currency),
    status: row.status,
    expectedAvailableAt: row.expectedAvailableAt.toISOString(),
    creditedAt: row.creditedAt ? row.creditedAt.toISOString() : null,
    releasable:
      (row.status === 'SENT' || row.status === 'RECEIVED') &&
      now.getTime() >= row.expectedAvailableAt.getTime(),
    simulated: true,
  };
}

export async function listRemittances(
  db: Db,
  session: ResolvedSession,
): Promise<RemittanceView[]> {
  const now = sessionNow(session);
  const rows = await db
    .select()
    .from(inboundRemittances)
    .where(eq(inboundRemittances.sessionId, session.id))
    .orderBy(asc(inboundRemittances.expectedAvailableAt));
  return rows.map((r) => view(r, now));
}

/**
 * The first (chronological) remittance that is on its way but not yet available,
 * so the agent can answer "when does my family money arrive?" without naming an id.
 */
export async function nextPendingRemittance(
  db: Db,
  session: ResolvedSession,
): Promise<RemittanceView | null> {
  const all = await listRemittances(db, session);
  return all.find((r) => r.status === 'SENT' || r.status === 'RECEIVED' || r.status === 'EXPECTED') ?? null;
}

export interface ReleasedRemittance {
  readonly view: RemittanceView;
  /** The demo clock was advanced to this instant when the funds cleared. */
  readonly clockAdvancedTo: string;
}

/**
 * Credit an inbound remittance into the funding account.
 *
 * Scenario-only: this is a demo control. It advances the pinned demo clock to
 * the clearance instant (a future-dated leg cannot be dispatched before the
 * money exists), credits the account, writes balanced ledger entries, and
 * audits the release.
 */
export async function releaseRemittance(
  db: Db,
  session: ResolvedSession,
  id: string,
): Promise<ReleasedRemittance> {
  if (session.clockKind !== 'scenario') {
    throw new AppError('UNSUPPORTED', 'inbound remittance simulation is only available in the demo scenario');
  }

  const result = await db.transaction(async (tx) => {
    const remRows = await tx
      .select()
      .from(inboundRemittances)
      .where(and(eq(inboundRemittances.id, id), eq(inboundRemittances.sessionId, session.id)))
      .for('update');
    const rem = remRows[0];
    if (!rem) throw new AppError('NOT_FOUND', 'remittance not found');
    if (rem.status === 'AVAILABLE') {
      // Idempotent: releasing twice does not credit twice.
      return { rem, account: null as null };
    }
    if (rem.status !== 'SENT' && rem.status !== 'RECEIVED') {
      throw new AppError('VALIDATION_FAILED', `this remittance is ${rem.status} and cannot be released`);
    }

    const acctRows = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, rem.accountId), eq(accounts.sessionId, session.id)))
      .for('update');
    const account = acctRows[0];
    if (!account) throw new AppError('NOT_FOUND', 'funding account not found');
    if (account.currency !== rem.currency) {
      throw new AppError('VALIDATION_FAILED', 'the remittance currency does not match the account');
    }

    // Advance the demo clock to the clearance instant. The family money cannot
    // be spent before it exists.
    const clearedAt = rem.expectedAvailableAt;
    await tx
      .update(sessions)
      .set({ scenarioNow: clearedAt })
      .where(eq(sessions.id, session.id));

    // Balanced double entry per currency: +X to the student, -X from the external
    // inbound source. No FX happens here; it is the home currency.
    await tx.insert(ledgerEntries).values([
      {
        inboundRemittanceId: rem.id,
        bucket: 'student_account',
        accountId: account.id,
        currency: rem.currency,
        signedMinor: rem.amountMinor,
      },
      {
        inboundRemittanceId: rem.id,
        bucket: 'inbound_remittance',
        currency: rem.currency,
        signedMinor: -rem.amountMinor,
      },
    ]);

    await tx
      .update(accounts)
      .set({ balanceMinor: account.balanceMinor + rem.amountMinor, version: account.version + 1 })
      .where(eq(accounts.id, account.id));

    await tx
      .update(inboundRemittances)
      .set({ status: 'AVAILABLE', creditedAt: clearedAt })
      .where(eq(inboundRemittances.id, rem.id));

    await appendAudit(tx as unknown as Db, {
      sessionId: session.id,
      correlationId: rem.id,
      type: 'remittance.released',
      actor: 'user',
      outcome: 'allowed',
      payload: {
        remittanceId: rem.id,
        currency: rem.currency,
        amountMinor: rem.amountMinor,
        creditedAt: clearedAt.toISOString(),
      },
    });

    return { rem, account };
  });

  // Re-read after commit (the session clock moved to the clearance instant).
  const advancedSession: ResolvedSession = { ...session, scenarioNow: result.rem.expectedAvailableAt };
  const refreshed = await listRemittances(db, advancedSession);
  const v = refreshed.find((r) => r.id === id) ?? view(result.rem, result.rem.expectedAvailableAt);
  return { view: v, clockAdvancedTo: result.rem.expectedAvailableAt.toISOString() };
}
