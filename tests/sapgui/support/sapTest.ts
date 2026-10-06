import { ensureLoggedIn, sapGuiTest, type SapGuiSession } from '../../../src';

/**
 * The `test` every SAP GUI spec in this folder imports. It adds one fixture
 * to the framework's `sapGuiTest`:
 *
 *   sap          a session, NOT logged in by us (it is wherever SAP Logon is)
 *   loggedInSap  the same session, logged on with SAP_USER / SAP_PASSWORD / SAP_CLIENT
 *                from .env.<name>(.local) - or left alone if you were already logged on
 *
 * Add your own fixtures here (a page object, test data ...) - see
 * https://playwright.dev/docs/test-fixtures
 */
export const test = sapGuiTest.extend<{ loggedInSap: SapGuiSession }>({
  loggedInSap: async ({ sap }, use) => {
    await ensureLoggedIn(sap);
    await use(sap);
  },
});

export { expect } from '@playwright/test';

// `npm run convert` points generated specs at this file (they import `sapGuiTest`), so recordings pick up your fixtures too.
export { test as sapGuiTest };
