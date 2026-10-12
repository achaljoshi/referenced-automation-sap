import { sapExpect, sapGuiTest } from '../../../src';

/**
 * The `test` every SAP GUI spec in this folder imports. It is the framework's own `sapGuiTest`, which provides:
 *
 *   sap          a session - one SAP connection per worker, reused and reset to the start
 *                screen between tests (SAP_GUI_REUSE=test for a fresh one each time)
 *   loggedInSap  the same session, logged on with SAP_USER / SAP_PASSWORD / SAP_CLIENT
 *                (from the environment, .env.<name>.local, or `npx sap-gui-secret`) - or left
 *                alone if you were already logged on
 *
 * Add your own fixtures and cross-cutting behaviour here with `sapGuiTest.extend({ ... })`: a page object, test data, or a
 * pop-up handler that every test should have, for example:
 *
 *   sap.onPopup('system message', { title: /System Message/ }, (s) => s.press('wnd[1]/tbar[0]/btn[0]'));
 *
 * https://playwright.dev/docs/test-fixtures
 */
export const test = sapGuiTest;

/** Playwright's `expect` plus the SAP assertions (toHaveText on a locator, toHaveStatusMessage / toHaveTitle on the session, ...), all of which wait and retry. */
export const expect = sapExpect;

// `npm run convert` points generated specs at this file (`--test-import` / `--expect-import`): they import `sapGuiTest` and
// `sapExpect` from here, so recordings pick up your fixtures too.
export { test as sapGuiTest, sapExpect };
