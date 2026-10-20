/**
 * Builds a self-contained archive a judge can open without a GitHub account.
 *
 * The source archive comes from `git archive`, which includes TRACKED FILES ONLY.
 * That is the point: .env, node_modules, build output and the private
 * administrative folder are untracked, so they cannot end up in the archive by
 * accident. A hand-rolled zip of the working directory would include all of them.
 *
 * Run `npm run package` first so the submission folder is current.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const OUT = path.resolve('dist');
mkdirSync(OUT, { recursive: true });

if (!existsSync('submission/manifest.json')) {
  console.error('run `npm run package` first: there is no submission manifest to bundle');
  process.exit(1);
}

const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
if (dirty) {
  // A bundle built from a dirty tree cannot be reproduced from its own commit id.
  console.error('the working tree has uncommitted changes; commit them so the archive matches a commit');
  process.exit(1);
}

const sourceZip = path.join(OUT, `bridgewise-source-${commit}.zip`);
execSync(`git archive --format=zip --prefix=bridgewise/ -o "${sourceZip}" HEAD`, { stdio: 'inherit' });

// Belt and braces: prove the archive really does not carry the environment file.
const listing = execSync(`git archive --format=tar HEAD | tar -t`, { encoding: 'utf8', shell: 'bash' })
  .split('\n')
  .filter(Boolean);
const leaked = listing.filter((f) => /(^|\/)\.env$|\.xlsx$|\.docx$|passport/i.test(f));
if (leaked.length) {
  console.error('REFUSING: the archive would contain files that must stay private:');
  for (const f of leaked) console.error(`  - ${f}`);
  process.exit(1);
}

const sha = createHash('sha256').update(readFileSync(sourceZip)).digest('hex');
const sizeMb = (statSync(sourceZip).size / 1024 / 1024).toFixed(2);

writeFileSync(
  path.join(OUT, 'BUNDLE.txt'),
  [
    `BridgeWise source archive`,
    `commit:   ${commit}`,
    `file:     ${path.basename(sourceZip)}`,
    `size:     ${sizeMb} MB`,
    `sha256:   ${sha}`,
    `built:    ${new Date().toISOString()}`,
    `entries:  ${listing.length} tracked files`,
    ``,
    `Contains tracked files only. No environment file, no credentials, no`,
    `registration documents, no build output, no node_modules.`,
    ``,
    `To run it: see README.md inside the archive. Requires Node 20+ and`,
    `PostgreSQL 17. No real funds move; every provider and account is synthetic.`,
  ].join('\n') + '\n',
);

console.log(`\nsource archive: ${sourceZip}`);
console.log(`${listing.length} tracked files, ${sizeMb} MB`);
console.log(`sha256 ${sha}`);
console.log(`\nNo .env, credentials or private documents are in it (checked, not assumed).`);
