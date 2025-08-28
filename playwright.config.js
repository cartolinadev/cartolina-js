// @ts-check
const { devices } = require('@playwright/test');

const config = {
  testDir: './test/perf',
  timeout: 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1, // SERIAL runs for stable metrics
  reporter: [['list'], ['json', { outputFile: 'test/perf/results/last-run.playwright.json' }]],
  use: {
    browserName: 'chromium',
    headless: !!process.env.CI && !process.env.PWDEBUG,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
};
module.exports = config;
