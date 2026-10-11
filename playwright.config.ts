import { createPlaywrightConfig, loadEnv } from '@automation/referenced-automation-utils';
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

// ---- Parallelism: SAP GUI is ONE desktop ----
// In attach mode every worker would attach to the same SAP Logon session and interleave keystrokes in the same window, so
// a run that can reach a real SAP in attach mode gets exactly one worker and no fully-parallel files, whatever WORKERS says.
// Parallel workers are fine - and honoured - when each owns its SAP: the simulator (SAP_GUI_SIMULATOR=true) or
// SAP_GUI_MODE=open (a connection per worker, users from SAP_USER_POOL). The `sap` fixture independently refuses attach mode
// with more than one worker, so `--workers=4` on the command line fails loudly instead of corrupting a run.
// (The npm scripts that only use the simulator, test:framework and test:bdd, pass --workers themselves.)
const env = loadEnv({ dir: __dirname });
// SAP_GUI_TRANSPORT=remote is always one worker: one interactive RDP desktop, one agent answering one request at a time.
const remoteDesktop = env.get('SAP_GUI_TRANSPORT', 'powershell').toLowerCase() === 'remote';
const ownSessionPerWorker = env.getBoolean('SAP_GUI_SIMULATOR', false) || (env.get('SAP_GUI_MODE', 'attach') === 'open' && !remoteDesktop);
const requestedWorkers = env.getOptional('WORKERS');
if (!ownSessionPerWorker && requestedWorkers && requestedWorkers !== '1' && process.env.TEST_WORKER_INDEX === undefined) {
  console.warn(
    `[sap] WORKERS=${requestedWorkers} ignored: SAP_GUI_MODE=attach (or SAP_GUI_TRANSPORT=remote) would put every worker in the same SAP window. ` +
      'Using 1 worker. (SAP_GUI_SIMULATOR=true or SAP_GUI_MODE=open with SAP_USER_POOL allow parallel workers.)',
  );
}

export default createPlaywrightConfig({
  dir: __dirname,
  name: '@automation/referenced-automation-sap',
  baseUrlKey: 'BASE_URL',
  // fioriCart.spec.ts hits a live SAP-hosted demo - a second CI retry absorbs
  // ordinary network jitter the way it would for any external site.
  retriesOnCi: 2,
  testTimeoutMs: 60_000,
  // attach: the SAP steps use the session the (simulated) SAP Logon already has open
  overrides: ownSessionPerWorker ? {} : { workers: 1, fullyParallel: false },
  extraProjects: [{ name: 'bdd', testDir: bddTestDir, use: { sapGuiMode: 'attach' } as Record<string, unknown> }],
});
