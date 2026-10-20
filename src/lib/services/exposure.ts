/**
 * How much of an obligation is already spoken for.
 *
 * Settled credit alone is NOT enough to decide whether another payment is safe.
 * A transfer that has been submitted but not yet posted has not credited the
 * obligation, yet it is on its way: counting only settled credit lets two
 * separate plans for the same tuition both execute and overpay it.
 *
 * `committedCreditMinor` counts every transfer against this obligation that has
 * not reached a terminal failure, so a second payment is refused while a first
 * one is still in flight.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type Db = NodePgDatabase<Record<string, never>>;

/** Statuses that no longer hold any claim on the obligation. */
export const RELEASED_STATUSES = ['REJECTED', 'FAILED'] as const;

/**
 * Credit in flight or already landed, in the obligation's currency.
 *
 * UNKNOWN_OUTCOME counts. An unknown outcome might have succeeded, and the safe
 * reading of "we do not know" is that the money may well be on its way.
 */
export async function committedCreditMinor(db: Db, obligationId: string): Promise<bigint> {
  const result = await db.execute<{ total: string | null }>(sql`
    SELECT COALESCE(SUM(t.credit_minor), 0)::text AS total
    FROM transfers t
    JOIN plans p ON p.id = t.plan_id
    WHERE p.obligation_id = ${obligationId}::uuid
      AND t.status NOT IN ('REJECTED', 'FAILED')
  `);
  const rows = (result as unknown as { rows?: Array<{ total: string | null }> }).rows
    ?? (result as unknown as Array<{ total: string | null }>);
  const total = rows?.[0]?.total;
  return total ? BigInt(total) : 0n;
}
