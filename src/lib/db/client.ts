import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

// A single pool per process. Integration tests open their own overlapping
// connections deliberately (MASTER_PLAYBOOK 16.1) and must not share this one.
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured');
  pool ??= new pg.Pool({ connectionString: url, max: 10 });
  return pool;
}

export function getDb() {
  return drizzle(getPool());
}
