import { sapGuiTest as test } from './sapFakeTest';
import { sapExpect as expect } from '../../src';
import { loadEnv } from '@automation/referenced-automation-utils';

const env = loadEnv();

/** What the recording typed. Change a value here and every step that uses it follows. Secrets and settings are read from the environment. */
const CONSTANTS = {
  inputs: {
    get logonClient() {
      return env.get('SAP_CLIENT', '100');
    },
    get logonUser() {
      return env.get('SAP_USER', 'TESTUSER');
    },
    get logonPassword() {
      return env.get('SAP_PASSWORD');
    },
    get logonLanguage() {
      return env.get('SAP_LANGUAGE', 'EN');
    },
    commandField: '/nVA01',
    vbakAuart: 'OR',
    vbakVkorg: '1000',
    vbakVtweg: '10',
    vbakSpart: '00',
    kuagvKunnr: '1000',
    rv45aMabnrC1R0: 'TG11',
    rv45aKwmengC3R0: '5',
  },
};

/** Every control the recording touched, by its SAP GUI Scripting id. When a screen changes, fix the id here and every step follows. */
const LOCATORS = {
  mainWindow: 'wnd[0]',
  logonClient: 'wnd[0]/usr/txtRSYST-MANDT',
  logonUser: 'wnd[0]/usr/txtRSYST-BNAME',
  logonPassword: 'wnd[0]/usr/pwdRSYST-BCODE',
  logonLanguage: 'wnd[0]/usr/txtRSYST-LANGU',
  commandField: 'wnd[0]/tbar[0]/okcd',
  vbakAuart: 'wnd[0]/usr/ctxtVBAK-AUART',
  vbakVkorg: 'wnd[0]/usr/ctxtVBAK-VKORG',
  vbakVtweg: 'wnd[0]/usr/ctxtVBAK-VTWEG',
  vbakSpart: 'wnd[0]/usr/ctxtVBAK-SPART',
  kuagvKunnr: 'wnd[0]/usr/ctxtKUAGV-KUNNR',
  sapmv45atctrlUErfAuftrag: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG',
  rv45aMabnrC1R0: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]',
  rv45aKwmengC3R0: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtRV45A-KWMENG[3,0]',
  toolbarButton11: 'wnd[0]/tbar[0]/btn[11]',
};

/**
 * Converted from examples/va01_create_order.vbs by sap-vbs-to-playwright.
 * Review before committing:
 *  - reads SAP_CLIENT, SAP_USER, SAP_PASSWORD, SAP_LANGUAGE from the environment (.env.<name> / CI variables); none of those values is stored here
 *  - session: sap (the recording contains the logon): the test starts on whatever the connection shows - the logon screen with SAP_GUI_MODE=open; in attach mode be on the logon screen too
 *  - no waits are needed: every step waits for SAP to be idle and for its element to exist
 *  - line 18: the recorded value for "wnd[0]/usr/pwdRSYST-BCODE" was replaced with env SAP_PASSWORD - it is not in the generated file
 */
test('recorded: va01_create_order @sapgui-sample', async ({ sap }) => {
  await sap.call(LOCATORS.mainWindow, 'maximize'); // vbs:15
  await sap.setText(LOCATORS.logonClient, CONSTANTS.inputs.logonClient); // vbs:16
  await sap.setText(LOCATORS.logonUser, CONSTANTS.inputs.logonUser); // vbs:17
  await sap.setText(LOCATORS.logonPassword, CONSTANTS.inputs.logonPassword); // vbs:18
  await sap.setText(LOCATORS.logonLanguage, CONSTANTS.inputs.logonLanguage); // vbs:19
  await sap.sendVKey(0); // vbs:20
  await sap.setText(LOCATORS.commandField, CONSTANTS.inputs.commandField); // vbs:21
  await sap.sendVKey(0); // vbs:22
  await sap.setText(LOCATORS.vbakAuart, CONSTANTS.inputs.vbakAuart); // vbs:23
  await sap.setText(LOCATORS.vbakVkorg, CONSTANTS.inputs.vbakVkorg); // vbs:24
  await sap.setText(LOCATORS.vbakVtweg, CONSTANTS.inputs.vbakVtweg); // vbs:25
  await sap.setText(LOCATORS.vbakSpart, CONSTANTS.inputs.vbakSpart); // vbs:26
  await sap.setFocus(LOCATORS.vbakSpart); // vbs:27
  await sap.set(LOCATORS.vbakSpart, 'caretPosition', 2); // vbs:28
  await sap.sendVKey(0); // vbs:29
  // WScript.Sleep(500) dropped - waiting for SAP is automatic, a fixed sleep is either too short or too slow
  await sap.setText(LOCATORS.kuagvKunnr, CONSTANTS.inputs.kuagvKunnr); // vbs:31
  await sap.set(LOCATORS.sapmv45atctrlUErfAuftrag, 'columns.elementAt(1).width', 18); // vbs:33
  await sap.setText(LOCATORS.rv45aMabnrC1R0, CONSTANTS.inputs.rv45aMabnrC1R0); // vbs:35
  await sap.setText(LOCATORS.rv45aKwmengC3R0, CONSTANTS.inputs.rv45aKwmengC3R0); // vbs:36
  await sap.press(LOCATORS.toolbarButton11); // vbs:37
  await expect(sap).toHaveStatusMessage(/has been saved/i);
});
