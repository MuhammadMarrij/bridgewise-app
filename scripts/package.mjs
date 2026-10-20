/**
 * Assembles the submission bundle, and FAILS when something required is absent.
 *
 * A packaging step that succeeds regardless is worse than none: it turns a
 * missing artefact into a surprise at the deadline. This one refuses, names what
 * is missing, and exits non-zero.
 *
 * It copies, hashes and inventories. It does not write any claim of its own.
 */
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
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
  ['docs/GO_LIVE.md', 'go-live.md'],
  ['docs/VIDEO_SCRIPT.md', 'video-script.md'],
  ['docs/DEPLOY.md', 'deploy.md'],
  ['docs/AI-DISCLOSURE.md', 'ai-disclosure.md'],
  ['evidence/verification.md', 'evidence/verification.md'],
];

/** Made by a human; listed as MISSING rather than quietly omitted. Kept across runs. */
const EXPECTED_HUMAN = [
  ['demo.mp4', 'a screen recording under five minutes'],
  ['presentation.pptx', 'the deck, under ten minutes of narration'],
];

// Start clean so no file from an earlier version of the product survives,
// except the human-made ones.
const keep = new Set(EXPECTED_HUMAN.map(([f]) => f));
if (existsSync(OUT)) {
  for (const f of readdirSync(OUT)) if (!keep.has(f)) rmSync(path.join(OUT, f), { recursive: true, force: true });
}
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

let commit = 'unknown';
let dirty = false;
try {
  commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
} catch { /* not a git checkout */ }

const humanTodo = EXPECTED_HUMAN
  .filter(([file]) => !existsSync(path.join(OUT, file)))
  .map(([file, what]) => ({ file: `submission/${file}`, what, status: 'MISSING' }));

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
      live: 'https://bridgewise-azure.vercel.app',
      // Repeated here so the bundle carries its own disclaimer.
      provenance: {
        realFundsMoved: false,
        paymentRails: 'Alipay open-platform sandbox; Stripe test mode',
        rates: 'Live: ECB via Frankfurter, exchangerate-api, Wise public comparison',
        balances: 'Test funds in BridgeWise\'s own double-entry ledger',
        note: 'See evidence/verification.md for what was verified and how.',
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
for (const t of humanTodo) console.log(`STILL NEEDED: ${t.file} (${t.what})`);
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}

function walk(dir, fn) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, fn);
    else fn(p);
  }
}
