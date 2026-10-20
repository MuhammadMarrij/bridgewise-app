// Loads .env for the test run and refuses to let a suite point at the demo database.
import { readFileSync } from 'node:fs';

try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]!]) {
      const value = m[2]!.replace(/(^|\s)#.*$/, '').trim();
      if (value) process.env[m[1]!] = value;
    }
  }
} catch { /* a CI environment may supply these directly */ }

const test = process.env.TEST_DATABASE_URL;
if (test && process.env.DATABASE_URL === test) {
  throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL: tests truncate their database');
}
if (test && !/_test(\?|$)/.test(test)) {
  throw new Error('TEST_DATABASE_URL must name a database ending in _test');
}

// Consent/execution suites run on the frozen fixture routes, offline and exact.
process.env.ROUTES_SOURCE ??= 'fixtures';
