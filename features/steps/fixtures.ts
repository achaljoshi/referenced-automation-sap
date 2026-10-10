import { mergeTests } from '@playwright/test';
import { test as bddTest } from 'playwright-bdd';
import { createSampleSapSystem } from '../../src/gui/fakeSapGui';
import { sapGuiTest } from '../../src/gui/fixtures';

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
export const test = mergeTests(bddTest, sapGuiTest).extend({
  sapGuiTransport: [
    async ({}, use) => {
      await use(() => createSampleSapSystem({ transitionDelayMs: 20 }));
    },
    { scope: 'worker' },
  ],
});
