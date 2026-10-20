/**
 * Assembles the submission bundle, and FAILS when something required is absent.
 *
 * A packaging step that succeeds regardless is worse than none: it turns a
 * missing artefact into a surprise at the deadline. This one refuses, names what
 * is missing, and exits non-zero.
 *
 * It copies, hashes and inventories. It does not write any claim of its own.
 */
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';

const OUT = path.resolve('submission');
const problems = [];

/** Required: absence blocks the package. */
const REQUIRED = [
  ['README.md', 'README.md'],
  ['docs/TECHNICAL-REPORT.md', 'technical-report.md'],
  ['docs/SECURITY_REPORT.md', 'security-assessment.md'],
  ['docs/DEMO-SCRIPT.md', 'demo-script.md'],
  ['docs/REVIEW_FINDINGS.md', 'review-findings.md'],
  ['docs/PROGRESS.md', 'progress.md'],
  ['docs/TEAM_BRIEF.md', 'team-brief.md'],
  ['evidence/run-manifest.json', 'evidence/run-manifest.json'],
  ['evidence/http-trace.jsonl', 'evidence/http-trace.jsonl'],
  ['evidence/audit-export.json', 'evidence/audit-export.json'],
  ['evidence/checksums.txt', 'evidence/checksums.txt'],
];

/** Expected but not yet produced: listed as MISSING rather than quietly omitted. */
const EXPECTED_HUMAN = [
  ['submission/demo.mp4', 'a screen recording under five minutes'],
  ['submission/presentation.pdf', 'the deck, under ten minutes of narration'],
];

mkdirSync(path.join(OUT, 'evidence'), { recursive: true });

for (const [from, to] of REQUIRED) {
  if (!existsSync(from)) {
    problems.push(`MISSING required artefact: ${from}`);
    continue;
  }
  const target = path.join(OUT, to);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(from, target);
}

// The evidence must describe a run that actually completed.
let manifest = null;
if (existsSync('evidence/run-manifest.json')) {
  manifest = JSON.parse(readFileSync('evidence/run-manifest.json', 'utf8'));
  if (manifest.outcome?.status !== 'COMPLETED') {
    problems.push(`evidence run did not complete: ${JSON.stringify(manifest.outcome)}`);
  }
} else {
  problems.push('MISSING evidence: run `npm run evidence` with the app running');
}

let commit = 'unknown';
let dirty = false;
try {
  commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
} catch { /* not a git checkout */ }

if (manifest && manifest.release?.commit !== commit) {
  // Equality is the wrong test. Committing the evidence itself necessarily moves
  // HEAD past the commit the evidence names, so a strict check can never be
  // satisfied. What matters is whether the CODE changed since capture: evidence
  // captured from code that is no longer the release is the real danger, while a
  // commit that merely adds the evidence files is not.
  const captured = manifest.release?.commit ?? '';
  try {
    execSync(`git merge-base --is-ancestor ${captured} HEAD`, { stdio: 'ignore' });
    const changed = execSync(`git diff --name-only ${captured} HEAD`, { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter((f) => /^(src|drizzle|scripts)\//.test(f));
    if (changed.length > 0) {
      problems.push(
        `evidence was captured at ${captured.slice(0, 7)} and code has changed since ` +
          `(${changed.slice(0, 5).join(', ')}). Re-run the evidence step.`,
      );
    } else {
      console.log(`note: evidence captured at ${captured.slice(0, 7)}; no code has changed since.`);
    }
  } catch {
    problems.push(
      `evidence was captured at ${captured.slice(0, 7)}, which is not an ancestor of ` +
        `HEAD (${commit.slice(0, 7)}). Re-run the evidence step.`,
    );
  }
}

const humanTodo = EXPECTED_HUMAN
  .filter(([file]) => !existsSync(file))
  .map(([file, what]) => ({ file, what, status: 'MISSING' }));

const inventory = [];
walk(OUT, (file) => {
  const rel = path.relative(OUT, file).split(path.sep).join('/');
  if (rel === 'manifest.json' || rel === 'checksums.txt') return;
  inventory.push({
    path: rel,
    bytes: statSync(file).size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  });
});

writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify(
    {
      release: { commit, workingTreeDirty: dirty },
      builtAt: new Date().toISOString(),
      // Repeated here so the bundle carries its own disclaimer.
      provenance: {
        simulated: true,
        liveProviderUsed: false,
        liveModelUsed: manifest?.provenance?.liveModelUsed ?? false,
        note: 'No real funds moved. All providers, rates, accounts and recipients are synthetic.',
      },
      files: inventory,
      stillRequiredFromAHuman: humanTodo,
    },
    null,
    2,
  ),
);

writeFileSync(
  path.join(OUT, 'checksums.txt'),
  inventory.map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n',
);

console.log(`packaged ${inventory.length} file(s) into ${OUT}`);
if (dirty) console.log('NOTE: the working tree has uncommitted changes.');
for (const t of humanTodo) console.log(`TODO (human): ${t.file} — ${t.what}`);

if (problems.length) {
  console.error('\nPACKAGE INCOMPLETE:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nAll required artefacts present.');

function walk(dir, fn) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, fn);
    else fn(full);
  }
}
