import { createPlaywrightConfig } from '@automation/referenced-automation-utils';

// Every repo in the family runs Playwright the same way, defined once in
// utils - see createPlaywrightConfig's doc comment for every env var it reads.
export default createPlaywrightConfig({
  dir: __dirname,
  name: '@automation/referenced-automation-sap',
  baseUrlKey: 'BASE_URL',
  // fioriCart.spec.ts hits a live SAP-hosted demo - a second CI retry absorbs
  // ordinary network jitter the way it would for any external site.
  retriesOnCi: 2,
  testTimeoutMs: 60_000,
});
