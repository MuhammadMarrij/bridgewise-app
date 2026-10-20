import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
  test: {
    environment: 'node',
    // Integration suites share one PostgreSQL database and truncate it between
    // tests, so two files must never run at the same time against it.
    fileParallelism: false,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Integration and security suites hit a real PostgreSQL instance
    // (TEST_DATABASE_URL) and must never run against the demo database.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
