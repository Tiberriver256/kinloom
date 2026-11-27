import os from 'node:os';
import { defineConfig, devices } from '@playwright/test';

const DEFAULT_E2E_WORKERS = Math.min(4, Math.max(2, os.availableParallelism()));

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env.KINLOOM_CWV_BUDGET === '1' ? [] : ['**/cwv-budget.spec.ts'],
  fullyParallel: false,
  workers: DEFAULT_E2E_WORKERS,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    ignoreHTTPSErrors: true,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm run preview --workspace=@kinloom/demo',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
