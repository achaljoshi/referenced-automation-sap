import * as path from 'node:path';
import { sapGuiTest as test } from '../sapFakeTest';
import { csvUtils } from '@automation/referenced-automation-utils';
import { CONSTANTS, LOCATORS, Va01CreateOrderFrame, Va01CreateOrderScreen1Page, Va01CreateOrderScreen2Page, Va01CreateOrderScreen3Page } from './pages/Va01CreateOrderPages';

const rows = csvUtils.parseCsvFile(path.join(__dirname, 'va01_create_order.data.csv'));

/** One cell of the current row. A missing column is an error that names it, not a silent `undefined` typed into SAP. */
function field(row: Record<string, string>, column: string): string {
  const value = row[column];
  if (value === undefined) throw new Error(`va01_create_order.data.csv has no column "${column}" - add it (the recording typed a value there)`);
  return value;
}

/**
 * Converted from examples/va01_create_order.vbs by sap-vbs-to-playwright (page-object mode).
 * Review before committing:
 *  - reads SAP_CLIENT, SAP_USER, SAP_PASSWORD, SAP_LANGUAGE from the environment (.env.<name> / CI variables); none of those values is stored here
 *  - every typed value (CONSTANTS) and every id (LOCATORS) is at the top of ./pages/Va01CreateOrderPages.ts: change them there; the page and property names are mechanical - rename them
 *  - no waits are needed: every step waits for SAP to be idle and for its control to exist
 *  - one test runs per row of va01_create_order.data.csv; the first row holds the values that were recorded
 *  - line 18: the recorded value for "wnd[0]/usr/pwdRSYST-BCODE" was replaced with env SAP_PASSWORD - it is not in the generated files
 */
for (const [index, data] of rows.entries()) {
  test(`recorded: va01_create_order @sapgui-sample [row ${index + 1}]`, async ({ sap }) => {
    const screen1 = await new Va01CreateOrderScreen1Page(sap).waitUntilDisplayed();
    await sap.locator(LOCATORS.mainWindow).call('maximize'); // vbs:15
    await screen1.logonClient.fill(CONSTANTS.inputs.logonClient); // vbs:16
    await screen1.logonUser.fill(CONSTANTS.inputs.logonUser); // vbs:17
    await screen1.logonPassword.fill(CONSTANTS.inputs.logonPassword); // vbs:18
    await screen1.logonLanguage.fill(CONSTANTS.inputs.logonLanguage); // vbs:19
    await sap.sendVKey(0); // vbs:20
    const frame2 = await new Va01CreateOrderFrame(sap).waitUntilDisplayed();
    await frame2.commandField.fill(field(data, 'okcd')); // vbs:21
    await sap.sendVKey(0); // vbs:22
    const screen2 = await new Va01CreateOrderScreen2Page(sap).waitUntilDisplayed();
    await screen2.vbakAuart.fill(field(data, 'vbakAuart')); // vbs:23
    await screen2.vbakVkorg.fill(field(data, 'vbakVkorg')); // vbs:24
    await screen2.vbakVtweg.fill(field(data, 'vbakVtweg')); // vbs:25
    await screen2.vbakSpart.fill(field(data, 'vbakSpart')); // vbs:26
    await screen2.vbakSpart.focus(); // vbs:27
    await screen2.vbakSpart.set('caretPosition', 2); // vbs:28
    await sap.sendVKey(0); // vbs:29
    const screen3 = await new Va01CreateOrderScreen3Page(sap).waitUntilDisplayed();
    // WScript.Sleep(500) dropped - waiting for SAP is automatic
    await screen3.kuagvKunnr.fill(field(data, 'kuagvKunnr')); // vbs:31
    await screen3.sapmv45atctrlUErfAuftragTable.locator.set('columns.elementAt(1).width', 18); // vbs:33
    await screen3.sapmv45atctrlUErfAuftragTable.cell('ctxtRV45A-MABNR', 1, 0).fill(field(data, 'rv45aMabnr_c1r0')); // vbs:35
    await screen3.sapmv45atctrlUErfAuftragTable.cell('txtRV45A-KWMENG', 3, 0).fill(field(data, 'rv45aKwmeng_c3r0')); // vbs:36
    await screen3.toolbarButton(11).press(); // vbs:37
  });
}
