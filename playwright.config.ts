import { createPlaywrightConfig } from '@automation/referenced-automation-utils';
import { defineBddConfig } from 'playwright-bdd';

// Every repo in the family runs Playwright the same way, defined once in
// utils - see createPlaywrightConfig's doc comment for every env var it reads.
// Gherkin features: `bddgen` turns features/*.feature + features/steps/*.ts into runnable tests in .features-gen/
// (the npm scripts run it first). They are their own project, so `--project=bdd` runs only them.
const bddTestDir = defineBddConfig({
  features: 'features/*.feature',
  steps: 'features/steps/*.ts',
  outputDir: '.features-gen',
});

export default createPlaywrightConfig({
  dir: __dirname,
  name: '@automation/referenced-automation-sap',
  baseUrlKey: 'BASE_URL',
  // fioriCart.spec.ts hits a live SAP-hosted demo - a second CI retry absorbs
  // ordinary network jitter the way it would for any external site.
  retriesOnCi: 2,
  testTimeoutMs: 60_000,
  // attach: the SAP steps use the session the (simulated) SAP Logon already has open
  extraProjects: [{ name: 'bdd', testDir: bddTestDir, use: { sapGuiMode: 'attach' } as Record<string, unknown> }],
});
