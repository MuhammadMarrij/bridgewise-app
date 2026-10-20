/**
 * Produces the execution evidence bundle by RUNNING the application.
 *
 * It drives the real HTTP API end to end and records what actually came back.
 * Nothing in the output is hand-authored: if the app misbehaves, the bundle
 * shows the misbehaviour rather than a tidy story about it.
 *
 * Usage: start the app, then `npm run evidence`.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';

const BASE = process.env.BW_BASE_URL ?? 'http://localhost:3000';
const OUT = path.resolve('evidence');
const steps = [];

let cookie = null;

async function call(method, route, body) {
  const started = Date.now();
  const headers = { 'content-type': 'application/json', origin: BASE };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  steps.push({
    step: steps.length + 1,
    method,
    route,
    requestBody: redact(body ?? null),
    status: res.status,
    responseBody: redact(parsed),
    latencyMs: Date.now() - started,
    realTime: new Date().toISOString(),
  });
  return parsed;
}

/** Nothing that could authorise anything goes into an artefact. */
function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = /nonce|token|secret|cookie|apikey|api_key|password/i.test(k) ? '[redacted]' : redact(v);
  }
  return out;
}

function assert(condition, what) {
  if (!condition) {
    console.error(`EVIDENCE RUN FAILED: ${what}`);
    writeOut({ failed: what });
    process.exit(1);
  }
  console.log(`  ok  ${what}`);
}

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) {
  console.error(`the application is not running at ${BASE}. Start it, then run this again.`);
  process.exit(1);
}

console.log('recording the golden journey against the live application');

const session = await call('POST', '/api/demo/sessions', {});
assert(session?.obligationId, 'a synthetic workspace was created');

const before = await call('GET', '/api/snapshot');
const gbpBefore = before.accounts.find((a) => a.currency === 'GBP');
assert(gbpBefore.balance === '10000.00', 'the funding account starts at 10,000.00 GBP');
assert(before.obligations[0].settled === '0.00', 'no tuition has been paid yet');

const comparison = await call('POST', '/api/quotes/compare', {
  obligationId: session.obligationId,
  sourceAccountId: session.sourceAccountId,
});
assert(comparison.recommended.routeId === 'route-b', 'the recommendation is Simulated B');
assert(comparison.recommended.totalDebit === '6435.00', 'B debits exactly 6,435.00 GBP');
assert(comparison.recommended.reserveMargin === '365.00', 'the reserve margin is 365.00 GBP');

const cheaperButLate = comparison.excluded.find((r) => r.routeId === 'route-a');
assert(
  cheaperButLate.totalDebit === '6410.00' && cheaperButLate.exclusions.includes('MISSES_DEADLINE'),
  'a cheaper route is excluded for missing the deadline, not merely ranked lower',
);
const cheapestOfAll = comparison.excluded.find((r) => r.routeId === 'route-d');
assert(
  cheapestOfAll.exclusions.includes('INCOMPLETE_FEES'),
  'the cheapest visible route is excluded because one of its fees is unknown',
);

const plan = await call('POST', '/api/plans', {
  obligationId: session.obligationId,
  sourceAccountId: session.sourceAccountId,
  routeId: 'route-b',
});
assert(plan.termsHash?.length === 64, 'the plan carries a SHA-256 terms fingerprint');

const afterPlanning = await call('GET', '/api/snapshot');
assert(
  afterPlanning.accounts.find((a) => a.currency === 'GBP').balance === '10000.00',
  'planning moved no money',
);

// An attempt to execute without approval, recorded as part of the evidence.
const unapproved = await call('POST', `/api/plans/${plan.planId}/confirm`, {
  expectedTermsHash: plan.termsHash,
  nonce: 'this-nonce-was-never-issued',
  idempotencyKey: `evidence-unapproved-${Date.now()}`,
});
assert(unapproved?.code !== undefined, 'a confirmation without a valid approval is refused');

const grant = await call('POST', `/api/plans/${plan.planId}/approve`, {
  expectedTermsHash: plan.termsHash,
});
assert(grant?.nonce, 'the user approval issued a one-use nonce');

const idempotencyKey = `evidence-${plan.planId}`;
const transfer = await call('POST', `/api/plans/${plan.planId}/confirm`, {
  expectedTermsHash: plan.termsHash,
  nonce: grant.nonce,
  idempotencyKey,
});
assert(transfer.status === 'SUBMITTED', 'the approved payment was submitted');
assert(transfer.tuitionPosted === false, 'submitted does not mean the tuition is paid');

// The same request again: a retry must return the original, not pay twice.
const retry = await call('POST', `/api/plans/${plan.planId}/confirm`, {
  expectedTermsHash: plan.termsHash,
  nonce: grant.nonce,
  idempotencyKey,
});
assert(retry.transferId === transfer.transferId, 'a retried confirmation returns the original transfer');

const afterSubmit = await call('GET', '/api/snapshot');
assert(
  afterSubmit.accounts.find((a) => a.currency === 'GBP').balance === '3565.00',
  'the balance fell by exactly the approved debit',
);
assert(afterSubmit.obligations[0].settled === '0.00', 'the tuition is still unpaid at SUBMITTED');

await call('POST', `/api/demo/simulate/${transfer.transferId}`, { event: 'deliver' });
const afterDelivery = await call('GET', '/api/snapshot');
assert(
  afterDelivery.obligations[0].settled === '0.00',
  'the tuition is STILL unpaid at DELIVERED, which is the point',
);

await call('POST', `/api/demo/simulate/${transfer.transferId}`, { event: 'post' });
const afterPosting = await call('GET', '/api/snapshot');
assert(afterPosting.obligations[0].settled === '8000.00', 'the tuition is credited only at POSTED');
assert(afterPosting.obligations[0].paid === true, 'the obligation reports itself paid');

const receipt = await call('GET', `/api/transfers/${transfer.transferId}`);
assert(receipt.status === 'POSTED', 'the receipt comes from stored state');

const evidence = await call('GET', '/api/evidence');
const gbpJournal = evidence.ledger
  .filter((l) => l.currency === 'GBP')
  .reduce((a, l) => a + BigInt(l.signedMinor), 0n);
const usdJournal = evidence.ledger
  .filter((l) => l.currency === 'USD')
  .reduce((a, l) => a + BigInt(l.signedMinor), 0n);
assert(gbpJournal === 0n, 'the GBP journal sums to zero on its own');
assert(usdJournal === 0n, 'the USD journal sums to zero on its own');

writeOut(null, evidence);
console.log(`\nevidence written to ${OUT}`);

function writeOut(failed, auditExport) {
  mkdirSync(OUT, { recursive: true });

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch { /* not a git checkout */ }

  const manifest = {
    release: {
      commit,
      scenarioVersion: 'golden-1',
      executionMode: process.env.EXECUTION_MODE ?? 'SIMULATED',
      // The instant the capture actually happened, distinct from the demo clock
      // the scenario runs on. Both appear, and they are never conflated.
      capturedAtRealTime: new Date().toISOString(),
      demoClock: '2026-10-19T10:00:00.000Z',
      node: process.version,
      baseUrl: BASE,
    },
    provenance: {
      simulated: true,
      liveProviderUsed: false,
      liveModelUsed: false,
      note:
        'Every provider, rate, account and recipient is synthetic. No real funds moved. ' +
        'No live model call is included in this bundle: see docs/PROGRESS.md for the blocker.',
    },
    outcome: failed ? { status: 'FAILED', at: failed } : { status: 'COMPLETED' },
    assertions: steps.length,
  };

  writeFileSync(path.join(OUT, 'run-manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    path.join(OUT, 'http-trace.jsonl'),
    steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
  );
  if (auditExport) {
    writeFileSync(path.join(OUT, 'audit-export.json'), JSON.stringify(auditExport, null, 2));
  }

  // Checksums over what was just written, so a reader can tell whether the
  // bundle they hold is the bundle that was produced.
  const files = readdirSync(OUT).filter((f) => f !== 'checksums.txt');
  const lines = files.map((f) => {
    const hash = createHash('sha256').update(readFileSync(path.join(OUT, f))).digest('hex');
    return `${hash}  ${f}`;
  });
  writeFileSync(path.join(OUT, 'checksums.txt'), lines.join('\n') + '\n');
}
