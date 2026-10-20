import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// P0 has no domain logic yet. This asserts the one thing P0 actually promises:
// the command contract from MASTER_PLAYBOOK 15.3 exists as real scripts.
const REQUIRED = [
  'doctor', 'setup', 'dev', 'seed-demo', 'lint', 'typecheck',
  'test:unit', 'test:integration', 'test:security', 'test:e2e',
  'eval:stub', 'eval:live', 'evidence', 'package',
];

describe('P0 command contract', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const name of REQUIRED) {
    it(`defines npm script "${name}"`, () => {
      expect(pkg.scripts?.[name], `${name} is missing`).toBeTruthy();
    });
  }
});
