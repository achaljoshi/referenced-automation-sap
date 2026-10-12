import { loadEnv } from '@automation/referenced-automation-utils';
import { expect, test } from './support/sapTest';

/**
 * STEP 4 - a worked example that uses every feature once. Read it top to bottom, then copy the parts you need.
 *
 * It runs against the built-in simulator, which models the logon, VA01 (create sales order) and VA02 (delete):
 *
 *     npm run try:simulator -- 04_
 *
 * Against a REAL SAP it is skipped unless SAP_RUN_TEMPLATES=true: it creates a sales order with ids and values that are right for
 * the simulator (order type OR, sales organisation 1000, material TG11 ...) and that will not match every system. Adapt the CONSTANTS
 * and the ids first, the same way as for 03_create_sales_order.TEMPLATE.spec.ts.
 *
 * The settings it relies on - every one is explained in .env.example (what it is for, valid values, default, where to find it):
 *   SAP_GUI_SIMULATOR               true = run on the built-in fake SAP (what `npm run try:simulator` sets); this example only runs then...
 *   SAP_RUN_TEMPLATES               ...or with this set to true, against a real SAP you have adapted it to
 *   SAP_GUI_MODE                    open (start at the logon screen) or attach (use the window you have open)
 *   SAP_GUI_CONNECTION_NAME         mode=open: the SAP Logon entry
 *   SAP_CLIENT, SAP_USER, SAP_LANGUAGE   typed on the logon screen by `loggedInSap`
 *   SAP_PASSWORD                    secret: .env.<ENV>.local - typed by `loggedInSap`, never written to a log
 *   SAP_LOGON_FAILURE_COOLDOWN_MIN  after a rejected logon the same credentials are not tried again for this long (protects the user)
 *   SAP_GUI_TIMEOUT_MS              how long any one step below waits for its control (30 s by default)
 *   SAP_GUI_EVIDENCE                what the report gets automatically (screenshots on failure by default)
 *   SAP_GUI_CLEANUP, SAP_GUI_CLEANUP_FAILURE   whether the order registered below is deleted again, and what a failed cleanup does
 */
const env = loadEnv();

test.skip(
  !env.getBoolean('SAP_GUI_SIMULATOR', false) && !env.getBoolean('SAP_RUN_TEMPLATES', false),
  'example - it creates a sales order with the simulator\'s ids and values: run it with `npm run try:simulator -- 04_`, or adapt it and set SAP_RUN_TEMPLATES=true',
);

/** What this flow types and expects: change a value here and every step that uses it follows. */
const CONSTANTS = {
  order: { type: 'OR', salesOrg: '1000', channel: '10', division: '00', customer: '1000', material: 'TG11', quantity: '5' },
  expected: { saved: /Order (\d+) has been saved/i },
};

/* eslint-disable no-restricted-syntax -- an example shows the raw ids so they can be seen; in your own tests they live in a page object (pages/) */
const IDS = {
  commandField: 'wnd[0]/tbar[0]/okcd', // the box where you type a transaction code
  orderType: 'wnd[0]/usr/ctxtVBAK-AUART', // what the SAP GUI Scripting recorder writes: found with `npm run doctor -- --dump`, or by recording
  salesOrg: 'wnd[0]/usr/ctxtVBAK-VKORG',
  channel: 'wnd[0]/usr/ctxtVBAK-VTWEG',
  division: 'wnd[0]/usr/ctxtVBAK-SPART',
  material: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]', // a cell of a table control: [column,row]
  quantity: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtRV45A-KWMENG[3,0]',
  deleteConfirmYes: 'wnd[1]/usr/btnSPOP-OPTION1', // "Yes" in the confirmation pop-up (window 1 = a pop-up in front of the main window 0)
};
/* eslint-enable no-restricted-syntax */

test('creates a sales order and cleans it up - every feature once @sapgui @example', async ({ loggedInSap: sap, sapData }) => {
  // ---- 1. loggedInSap: logged on already. With SAP_GUI_MODE=open the fixture logged on with SAP_USER / SAP_PASSWORD / SAP_CLIENT /
  //         SAP_LANGUAGE; with attach mode on an open session it did nothing. (A test that records the logon itself asks for `sap` instead.)
  await expect(sap.locator(IDS.commandField)).toExist(); // the command field exists on every screen once you are in

  // ---- 2. startTransaction: like typing /nVA01 + Enter. Every call below waits for SAP by itself - there is not a single sleep here.
  await sap.startTransaction('VA01');
  await expect(sap).toHaveTitle(/Create Sales Order/i); // an assertion that retries until it holds (5 s by default; { timeout } changes it)

  // ---- 3. Finding controls three ways: by technical id, by the label the user sees, by tooltip / text.
  const { order } = CONSTANTS;
  await sap.setText(IDS.orderType, order.type); // by id + setText: the recorder's vocabulary (setText, press, sendVKey ...) works as is
  await sap.locator(IDS.salesOrg).fill(order.salesOrg); // the same by locator: fill() knows what to do for a text field, a drop-down, a checkbox
  await sap.setText(IDS.channel, order.channel);
  await sap.setText(IDS.division, order.division);

  // ---- 4. sendVKey: a function key to the main window (0 Enter, 3 Back, 8 Execute, 11 Save, 12 Cancel).
  await sap.sendVKey(0);

  await sap.getByLabel('Sold-To Party').fill(order.customer); // by label: the field next to the text "Sold-To Party" (the label follows SAP_LANGUAGE)
  await sap.setText(IDS.material, order.material);
  await sap.setText(IDS.quantity, order.quantity);

  // ---- 5. Diagnostics: when a control is NOT on the screen, the assertion says what IS - title, status bar, texts with their ids and the
  //         closest matches - so the test can be repaired without opening SAP. The text below does not exist on this screen, on purpose.
  const failure = await expect(sap.getByText('Delivery address').first()).toExist({ timeout: 300 }).then(
    () => undefined,
    (error: Error) => error,
  );
  expect(failure, 'the missing text must fail the assertion').toBeDefined();
  expect(failure?.message).toContain('On the screen now (wnd[0]): title'); // + status bar, "texts (N): ..." and "Closest to ..."
  // The same happens for toHaveText, toContainText, toBeEditable and toBeChecked, and for the pop-up (wnd[1]) when one is in front.

  // ---- 6. Evidence: a screenshot that goes into the test report (`npx playwright show-report`). SAP_GUI_EVIDENCE decides what is taken on its own.
  await sap.evidence('order filled in');

  // ---- 7. press / getByTooltip: toolbar buttons have no text, they are found by tooltip. click() presses a button, selects a tab,
  //         ticks a checkbox - it chooses by the control's type.
  await sap.getByTooltip('Save').click();

  // ---- 8. The status bar: S success, E error, W warning, I information, A abort. The assertion waits for SAP's answer.
  await expect(sap).toHaveStatusMessage(CONSTANTS.expected.saved, { type: 'S' });

  // ---- 9. Cleanup registration: read the order number SAP reported and say how to undo it. The cleanup runs after the test - passed or
  //         failed, and after every retry - so test orders do not pile up (SAP_GUI_CLEANUP=off keeps them; SAP_GUI_CLEANUP_FAILURE=warn
  //         stops a failed cleanup from failing the test).
  const orderNo = await sapData.captureFromStatusBar('SalesOrder', CONSTANTS.expected.saved, {
    cleanup: async (s) => {
      await s.startTransaction('VA02');
      await s.getByLabel('Order').fill(orderNo);
      await s.sendVKey(0);
      await s.getByTooltip('Delete').click();
      await s.locator(IDS.deleteConfirmYes).press(); // the confirmation pop-up
      await expect(s).toHaveStatusMessage(/has been deleted/i, { type: 'S' });
    },
  });
  expect(orderNo).toMatch(/^\d+$/);
  await sap.evidence(`order ${orderNo} saved`);
});
