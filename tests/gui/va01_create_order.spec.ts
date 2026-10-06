import { sapGuiTest as test } from './sapFakeTest';
import { loadEnv } from '@automation/referenced-automation-utils';

const env = loadEnv();

/**
 * Converted from examples/va01_create_order.vbs by sap-vbs-to-playwright.
 * Review before committing:
 *  - reads SAP_CLIENT, SAP_USER, SAP_PASSWORD, SAP_LANGUAGE from the environment (.env.<name> / CI variables); none of those values is stored here
 *  - no waits are needed: every step waits for SAP to be idle and for its element to exist
 *  - line 18: the recorded value for "wnd[0]/usr/pwdRSYST-BCODE" was replaced with env SAP_PASSWORD - it is not in the generated file
 */
test('recorded: va01_create_order @sapgui-sample', async ({ sap }) => {
  await sap.call('wnd[0]', 'maximize'); // vbs:15
  await sap.setText('wnd[0]/usr/txtRSYST-MANDT', env.get('SAP_CLIENT', '100')); // vbs:16
  await sap.setText('wnd[0]/usr/txtRSYST-BNAME', env.get('SAP_USER', 'TESTUSER')); // vbs:17
  await sap.setText('wnd[0]/usr/pwdRSYST-BCODE', env.get('SAP_PASSWORD')); // vbs:18
  await sap.setText('wnd[0]/usr/txtRSYST-LANGU', env.get('SAP_LANGUAGE', 'EN')); // vbs:19
  await sap.sendVKey(0); // vbs:20
  await sap.setText('wnd[0]/tbar[0]/okcd', '/nVA01'); // vbs:21
  await sap.sendVKey(0); // vbs:22
  await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR'); // vbs:23
  await sap.setText('wnd[0]/usr/ctxtVBAK-VKORG', '1000'); // vbs:24
  await sap.setText('wnd[0]/usr/ctxtVBAK-VTWEG', '10'); // vbs:25
  await sap.setText('wnd[0]/usr/ctxtVBAK-SPART', '00'); // vbs:26
  await sap.setFocus('wnd[0]/usr/ctxtVBAK-SPART'); // vbs:27
  await sap.set('wnd[0]/usr/ctxtVBAK-SPART', 'caretPosition', 2); // vbs:28
  await sap.sendVKey(0); // vbs:29
  // WScript.Sleep(500) dropped - waiting for SAP is automatic, a fixed sleep is either too short or too slow
  await sap.setText('wnd[0]/usr/ctxtKUAGV-KUNNR', '1000'); // vbs:31
  await sap.set('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG', 'columns.elementAt(1).width', 18); // vbs:33
  await sap.setText('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]', 'TG11'); // vbs:35
  await sap.setText('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtRV45A-KWMENG[3,0]', '5'); // vbs:36
  await sap.press('wnd[0]/tbar[0]/btn[11]'); // vbs:37
});
