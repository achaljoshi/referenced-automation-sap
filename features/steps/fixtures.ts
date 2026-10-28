import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergeTests } from '@playwright/test';
import { test as bddTest } from 'playwright-bdd';
import { createSampleSapSystem } from '../../src/gui/fakeSapGui';
import { sapGuiTest } from '../../src/gui/fixtures';
import { createFioriCartPage, type FioriCartPage } from '../../tests/support/FioriCartPage';

// The simulator's own made-up credentials (not real; never commit real ones - use .env.<name>.local or CI variables).
process.env.SAP_USER ??= 'TESTUSER';
process.env.SAP_PASSWORD ??= 'correct-horse';
process.env.SAP_CLIENT ??= '100';

/**
 * The test the Gherkin steps run in: `sapGuiTest` (session, correlation id, evidence, data cleanup, `vars` ...) pointed at
 * the built-in simulator so the sample features run on any machine. Against a real SAP, delete the `sapGuiTransport`
 * override and set SAP_GUI_MODE / the .env files as for any other SAP test.
 */
// playwright-bdd needs its own `test` underneath; mergeTests combines it with the SAP one.
export const test = mergeTests(bddTest, sapGuiTest).extend<{ logonMarkerDir: string; fioriCart: FioriCartPage }>({
  sapGuiTransport: [
    async ({}, use) => {
      await use(() => createSampleSapSystem({ transitionDelayMs: 20 }));
    },
    { scope: 'worker' },
  ],
  // A rejected logon arms the logon cooldown (see src/gui/logonGuard.ts): the logon steps keep their marker in a folder of
  // this scenario's own, so neither another scenario nor the next run is refused because of a failure provoked on purpose.
  logonMarkerDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-logon-marker-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  // The page object of SAP's public SAPUI5 shopping cart demo (the fiori-cart feature), on this scenario's browser page.
  fioriCart: async ({ page }, use) => {
    await use(createFioriCartPage(page));
  },
});
