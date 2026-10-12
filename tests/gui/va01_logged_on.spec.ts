import { sapGuiTest as test } from './sapFakeTest';
import { sapExpect as expect } from '../../src';

/** What the recording typed. Change a value here and every step that uses it follows. Secrets and settings are read from the environment. */
const CONSTANTS = {
  inputs: {
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
  commandField: 'wnd[0]/tbar[0]/okcd',
  vbakAuart: 'wnd[0]/usr/ctxtVBAK-AUART',
  vbakVkorg: 'wnd[0]/usr/ctxtVBAK-VKORG',
  vbakVtweg: 'wnd[0]/usr/ctxtVBAK-VTWEG',
  vbakSpart: 'wnd[0]/usr/ctxtVBAK-SPART',
  kuagvKunnr: 'wnd[0]/usr/ctxtKUAGV-KUNNR',
  rv45aMabnrC1R0: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]',
  rv45aKwmengC3R0: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtRV45A-KWMENG[3,0]',
  toolbarButton11: 'wnd[0]/tbar[0]/btn[11]',
};

/**
 * Converted from examples/va01_logged_on.vbs by sap-vbs-to-playwright.
 * Review before committing:
 *  - session: loggedInSap (the recording has no logon steps): the fixture logs on with SAP_USER / SAP_PASSWORD / SAP_CLIENT / SAP_LANGUAGE when SAP shows the logon screen and leaves an already logged-on session alone
 *  - no waits are needed: every step waits for SAP to be idle and for its element to exist
 */
test('recorded: va01_logged_on @sapgui-sample', async ({ loggedInSap: sap }) => {
  await sap.call(LOCATORS.mainWindow, 'maximize'); // vbs:15
  await sap.setText(LOCATORS.commandField, CONSTANTS.inputs.commandField); // vbs:16
  await sap.sendVKey(0); // vbs:17
  await sap.setText(LOCATORS.vbakAuart, CONSTANTS.inputs.vbakAuart); // vbs:18
  await sap.setText(LOCATORS.vbakVkorg, CONSTANTS.inputs.vbakVkorg); // vbs:19
  await sap.setText(LOCATORS.vbakVtweg, CONSTANTS.inputs.vbakVtweg); // vbs:20
  await sap.setText(LOCATORS.vbakSpart, CONSTANTS.inputs.vbakSpart); // vbs:21
  await sap.sendVKey(0); // vbs:22
  await sap.setText(LOCATORS.kuagvKunnr, CONSTANTS.inputs.kuagvKunnr); // vbs:23
  await sap.setText(LOCATORS.rv45aMabnrC1R0, CONSTANTS.inputs.rv45aMabnrC1R0); // vbs:24
  await sap.setText(LOCATORS.rv45aKwmengC3R0, CONSTANTS.inputs.rv45aKwmengC3R0); // vbs:25
  await sap.press(LOCATORS.toolbarButton11); // vbs:26
  await expect(sap).toHaveTitle(/Standard Order: Overview/i);
  await expect(sap).toHaveStatusMessage(/has been saved/i);
});
