import { loadEnv } from '@automation/referenced-automation-utils';
import { expect, test } from './support/sapTest';

/**
 * STEP 2 - open a transaction and check SAP did not complain.
 * Change SAP_SAMPLE_TCODE in .env.<name> to any transaction your user may open.
 */
test('opens a transaction without an error message @sapgui', async ({ loggedInSap: sap }) => {
  const tcode = loadEnv().get('SAP_SAMPLE_TCODE', 'SU3');
  const titleBefore = await sap.getText('wnd[0]');

  await sap.startTransaction(tcode); // waits for the new screen by itself - no sleeps anywhere

  expect(await sap.getText('wnd[0]')).not.toBe(titleBefore);

  // The status bar at the bottom: type E = error, W = warning, S = success, I = info.
  const messageType = String((await sap.get('wnd[0]/sbar', 'messageType')) ?? '');
  expect(messageType, `status bar said: "${await sap.statusBarText()}"`).not.toBe('E');
});
