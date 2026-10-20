/**
 * Deletes expired synthetic sessions and everything that cascades from them.
 *
 * This exists so the retention claim in the security report is TRUE. Expired
 * sessions are already refused at resolve time, but refusing a session is not
 * the same as deleting its data, and we will not claim automatic cleanup for a
 * scheduled job that does not exist. This is a documented manual command.
 *
 * It refuses to run unless the connection string names a demo or test database.
 */
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not configured');
  process.exit(1);
}

const dbName = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

if (!/^bridgewise(_test)?$/.test(dbName)) {
  console.error(`refusing to purge database ${JSON.stringify(dbName)}: not a known demo database`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

const before = await client.query('SELECT count(*)::int AS n FROM sessions');
const deleted = await client.query('DELETE FROM sessions WHERE expires_at < now() RETURNING id');
const after = await client.query('SELECT count(*)::int AS n FROM sessions');

// Everything student-owned cascades from the session row, so nothing is orphaned.
const orphans = await client.query(`
  SELECT
    (SELECT count(*)::int FROM accounts a LEFT JOIN sessions s ON s.id = a.session_id WHERE s.id IS NULL) AS accounts,
    (SELECT count(*)::int FROM transfers t LEFT JOIN sessions s ON s.id = t.session_id WHERE s.id IS NULL) AS transfers,
    (SELECT count(*)::int FROM audit_events e LEFT JOIN sessions s ON s.id = e.session_id WHERE s.id IS NULL) AS audit
`);

console.log(`sessions before: ${before.rows[0].n}`);
console.log(`expired sessions deleted: ${deleted.rowCount}`);
console.log(`sessions after: ${after.rows[0].n}`);
console.log(`orphaned rows remaining: ${JSON.stringify(orphans.rows[0])}`);

const leftover = Object.values(orphans.rows[0]).reduce((a, b) => a + b, 0);
await client.end();

if (leftover > 0) {
  console.error('FAIL: rows survived their session. The cascade is incomplete.');
  process.exit(1);
}
console.log('OK: no row outlived its session');
