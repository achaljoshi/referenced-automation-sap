import { expect, test } from './support/sapTest';
import { EasyAccessPage } from './pages/EasyAccessPage';

/**
 * STEP 1 - prove the machine, the connection and the credentials work.
 * If this passes, everything else is just more of the same.
 *
 *   npm run test:sapgui -- 01_
 */
test('logs on and lands on SAP Easy Access @sapgui @smoke', async ({ loggedInSap: sap }) => {
  // The command field (the box where you type a transaction code) exists on every screen once you're in.
  const start = new EasyAccessPage(sap);
  await expect(start.commandField).toExist();

  // The main window has a title. (Its wording depends on the SAP language, so only check there is one.)
  expect(await start.title()).not.toBe('');
});
