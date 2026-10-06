import { expect, test } from './support/sapTest';

/**
 * STEP 1 - prove the machine, the connection and the credentials work.
 * If this passes, everything else is just more of the same.
 *
 *   npm run test:sapgui -- 01_
 */
test('logs on and lands on SAP Easy Access @sapgui @smoke', async ({ loggedInSap: sap }) => {
  // The command field (the box where you type a transaction code) exists on every screen once you're in.
  expect(await sap.exists('wnd[0]/tbar[0]/okcd')).toBe(true);

  // Reading a property: the main window's title.
  const title = await sap.getText('wnd[0]');
  expect(title).not.toBe('');
});
