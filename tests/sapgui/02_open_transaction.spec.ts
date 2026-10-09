import { loadEnv } from '@automation/referenced-automation-utils';
import { expect, test } from './support/sapTest';
import { EasyAccessPage } from './pages/EasyAccessPage';

/**
 * STEP 2 - open a transaction and check SAP did not complain.
 * Change SAP_SAMPLE_TCODE in .env.<name> to any transaction your user may open.
 */
test('opens a transaction without an error message @sapgui', async ({ loggedInSap: sap }) => {
  const tcode = loadEnv().get('SAP_SAMPLE_TCODE', 'SU3');
  const start = new EasyAccessPage(sap);
  const titleBefore = await start.title();

  await start.open(tcode); // waits for the new screen by itself - no sleeps anywhere

  // These assertions retry until they hold (or time out), like Playwright's own - no race with the screen change.
  await expect(sap).not.toHaveTitle(titleBefore);
  // Status bar message types: S success, W warning, E error. Fail if SAP shows an error.
  await expect(sap).not.toHaveStatusMessage(/./, { type: 'E' });
});
