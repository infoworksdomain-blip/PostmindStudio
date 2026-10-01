import { defineConfig, devices } from '@playwright/test';

// Phase 18 Track E — end-to-end happy path (e2e/*.spec.ts): landing → pricing → sign-up →
// onboarding → first project, against the real Next.js app in standalone mode.
//   E2E_BASE_URL  the app under test (default http://127.0.0.1:3102)
//   E2E_START=1   let Playwright start `npm run start -- -p <port>` itself (CI builds first)
// Locally without a browser (npx playwright install chromium) or a database, the spec skips.

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3102';
const port = new URL(baseURL).port || '3102';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    // The spec asserts en-GB copy; the app picks the language from Accept-Language (Phase 16).
    locale: 'en-GB',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_START
    ? [
        {
          command: 'node e2e/qa/s3-stub.mjs',
          url: 'http://127.0.0.1:3199',
          reuseExistingServer: true,
          timeout: 30_000,
        },
        {
          command: `npm run start -- -p ${port}`,
          url: `${baseURL}/api/health`,
          timeout: 120_000,
          reuseExistingServer: false,
        },
      ]
    : undefined,
});
