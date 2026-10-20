import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against a REAL build talking to a REAL database. There is no
 * mocked API: the point is to prove the journey works end to end, and a mocked
 * backend would prove only that the mock works.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Each test creates its own synthetic workspace, so they are independent — but
  // they share one database, and the money assertions are about exact balances.
  // One worker keeps the failure messages honest.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      // The responsive spec is a phone test; running it at 1440 proves nothing.
      testIgnore: /responsive.spec.ts/,
    },
    { name: 'mobile', use: { ...devices['Pixel 5'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: {
    command: 'npm start',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
