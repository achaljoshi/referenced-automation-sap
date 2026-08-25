import { defineConfig, devices } from '@playwright/test';
import { loadEnv } from '@automation/referenced-automation-utils';

const env = loadEnv();
const headless = env.getBoolean('HEADLESS', true);
const requestedBrowser = env.get('BROWSER', 'chromium');

// Chromium-family "channels" launch a real, already-installed browser
// (system Chrome/Edge) instead of Playwright's own bundled binary - the
// way to run this framework on a machine where `playwright install` can
// never reach the internet to download browsers.
const SYSTEM_BROWSER_CHANNELS = ['msedge', 'msedge-beta', 'msedge-dev', 'chrome', 'chrome-beta', 'chrome-dev'];

const project = SYSTEM_BROWSER_CHANNELS.includes(requestedBrowser)
  ? { name: requestedBrowser, use: { ...devices['Desktop Chrome'], channel: requestedBrowser } }
  : { name: 'chromium', use: { ...devices['Desktop Chrome'] } };

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // fioriCart.spec.ts hits a live SAP-hosted demo - one retry absorbs
  // ordinary network jitter the same way it would for any external site.
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: env.getOptional('BASE_URL'),
    headless,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [project],
});
