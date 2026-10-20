// P0 doctor: verifies the environment without printing a single secret value.
// Exit 0 only when every REQUIRED check passes.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import net from 'node:net';

const REQUIRED_ENV = ['APP_ENV', 'EXECUTION_MODE', 'DATABASE_URL', 'SESSION_SECRET'];
const OPTIONAL_ENV = ['MODEL_PROVIDER', 'MODEL_NAME', 'MODEL_API_KEY', 'TEST_DATABASE_URL'];

const results = [];
const add = (name, ok, detail, required = true) =>
  results.push({ name, ok, detail, required });

// --- load .env without a dependency, values never echoed
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    // Strip a trailing `# comment`, which .env.example uses to document each value.
    // A value that is ONLY a comment is empty, not set: that distinction is what keeps
    // an absent MODEL_API_KEY reported as a blocker instead of as configured.
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/(^|\s)#.*$/, '').trim();
  }
} catch { /* .env is optional when the environment is already populated */ }

// --- runtime
const major = Number(process.versions.node.split('.')[0]);
add('node >= 20', major >= 20, `found ${process.versions.node}`);

// --- environment variables, presence only
for (const k of REQUIRED_ENV) add(`env ${k}`, Boolean(process.env[k]), process.env[k] ? 'set' : 'MISSING');
// Optional variables WARN when absent rather than PASS: a reader scanning the report
// must not see PASS next to "not set".
for (const k of OPTIONAL_ENV) add(`env ${k}`, Boolean(process.env[k]), process.env[k] ? 'set' : 'not set', false);

// --- mode safety
add('EXECUTION_MODE is SIMULATED', process.env.EXECUTION_MODE === 'SIMULATED',
    `found ${process.env.EXECUTION_MODE ?? 'unset'}`);
add('no LIVE payment mode', process.env.EXECUTION_MODE !== 'LIVE', 'LIVE is not implemented');

// --- database reachability, TCP only (no credentials used here)
const dbOk = await (async () => {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: false, detail: 'DATABASE_URL missing' };
  let host, port;
  try { const u = new URL(url); host = u.hostname; port = Number(u.port || 5432); }
  catch { return { ok: false, detail: 'DATABASE_URL unparseable' }; }
  return await new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok, detail) => { s.destroy(); resolve({ ok, detail }); };
    s.setTimeout(3000);
    s.on('connect', () => done(true, `${host}:${port} accepting connections`));
    s.on('timeout', () => done(false, `${host}:${port} timed out`));
    s.on('error', (e) => done(false, `${host}:${port} ${e.code}`));
  });
})();
add('postgres reachable', dbOk.ok, dbOk.detail);

// --- report
let failed = 0;
for (const r of results) {
  const tag = r.ok ? 'PASS' : (r.required ? 'FAIL' : 'WARN');
  if (!r.ok && r.required) failed++;
  console.log(`${tag.padEnd(5)} ${r.name.padEnd(28)} ${r.detail}`);
}
console.log(`\n${results.length - failed} ok, ${failed} required failure(s)`);
process.exit(failed ? 1 : 0);
