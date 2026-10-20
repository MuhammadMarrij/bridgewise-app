// Applies every .sql file in drizzle/ in filename order, once, inside a transaction.
// Deliberately tiny: drizzle-kit generates the SQL, this applies it reproducibly.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not configured'); process.exit(1); }

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

const dir = path.resolve('drizzle');
let files = [];
try { files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort(); }
catch { console.log('no drizzle/ directory yet'); }

const { rows } = await client.query('SELECT name FROM _migrations');
const done = new Set(rows.map((r) => r.name));
let applied = 0;

for (const f of files) {
  if (done.has(f)) continue;
  const sql = readFileSync(path.join(dir, f), 'utf8');
  try {
    await client.query('BEGIN');
    // drizzle-kit separates statements with --> statement-breakpoint
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.query(stmt);
    }
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [f]);
    await client.query('COMMIT');
    console.log(`applied ${f}`);
    applied++;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FAILED ${f}: ${e.message}`);
    await client.end();
    process.exit(1);
  }
}
console.log(`${applied} migration(s) applied, ${files.length} total, database up to date`);
await client.end();
