import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

/**
 * Every integration test runs against a real PostgreSQL instance, never SQLite:
 * row locking and transaction isolation are the things under test, and a
 * substitute engine would make the concurrency results meaningless.
 */
const TABLES = [
  'obligation_allocations', 'ledger_entries', 'outbox', 'transfers', 'approvals',
  'plans', 'quotes', 'cash_flow_events', 'obligations', 'beneficiaries',
  'accounts', 'audit_events', 'agent_runs', 'sessions', 'simulator_transfers',
];

export function testUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not configured');
  return url;
}

/** A pool for the suite. Separate pools give genuinely overlapping connections. */
export function testPool(max = 10): pg.Pool {
  return new pg.Pool({ connectionString: testUrl(), max });
}

export function dbFor(pool: pg.Pool): NodePgDatabase<Record<string, never>> {
  return drizzle(pool);
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}
