import { loadEnv } from '@automation/referenced-automation-utils';
import { SapPage } from '../../../../src';

const env = loadEnv();

/** What the recording typed. Change a value here and every step that uses it follows. Secrets and settings are read from the environment. */
export const CONSTANTS = {
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
  },
};

/** Every control the recording touched, by its SAP GUI Scripting id. When a screen changes, fix the id here and every step follows. */
export const LOCATORS = {
  commandField: 'wnd[0]/tbar[0]/okcd',
  statusBar: 'wnd[0]/sbar',
  logonClient: 'wnd[0]/usr/txtRSYST-MANDT',
  logonUser: 'wnd[0]/usr/txtRSYST-BNAME',
  logonPassword: 'wnd[0]/usr/pwdRSYST-BCODE',
  logonLanguage: 'wnd[0]/usr/txtRSYST-LANGU',
  vbakAuart: 'wnd[0]/usr/ctxtVBAK-AUART',
  vbakVkorg: 'wnd[0]/usr/ctxtVBAK-VKORG',
  vbakVtweg: 'wnd[0]/usr/ctxtVBAK-VTWEG',
  vbakSpart: 'wnd[0]/usr/ctxtVBAK-SPART',
  kuagvKunnr: 'wnd[0]/usr/ctxtKUAGV-KUNNR',
  sapmv45atctrlUErfAuftrag: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG',
  mainWindow: 'wnd[0]',
};

/**
 * Page objects generated from examples/va01_create_order.vbs by sap-vbs-to-playwright.
 * CONSTANTS and LOCATORS above hold every typed value and every id: change them there. The class and property names are mechanical (Screen1, vbakAuart): rename them to business terms.
 */
abstract class Va01CreateOrderScreen extends SapPage {
  /** The command field: where a user types a transaction code. */
  readonly commandField = this.sap.locator(LOCATORS.commandField);

  /** The message line at the bottom of the screen. */
  readonly statusBar = this.sap.locator(LOCATORS.statusBar);

  /** A button in the standard toolbar (btn[0] Enter, btn[3] Back, btn[11] Save, btn[12] Cancel, ...). */
  toolbarButton(n: number) {
    return this.sap.locator(`wnd[0]/tbar[0]/btn[${n}]`);
  }
}

/** The standard frame every screen has (command field, toolbar, status bar) - for steps that happen on a screen of their own. */
export class Va01CreateOrderFrame extends Va01CreateOrderScreen {
  readonly marker = LOCATORS.commandField;
}

export class Va01CreateOrderScreen1Page extends Va01CreateOrderScreen {
  readonly marker = LOCATORS.logonClient;

  readonly logonClient = this.sap.locator(LOCATORS.logonClient);
  readonly logonUser = this.sap.locator(LOCATORS.logonUser);
  readonly logonPassword = this.sap.locator(LOCATORS.logonPassword);
  readonly logonLanguage = this.sap.locator(LOCATORS.logonLanguage);
}

export class Va01CreateOrderScreen2Page extends Va01CreateOrderScreen {
  readonly marker = LOCATORS.vbakAuart;

  readonly vbakAuart = this.sap.locator(LOCATORS.vbakAuart);
  readonly vbakVkorg = this.sap.locator(LOCATORS.vbakVkorg);
  readonly vbakVtweg = this.sap.locator(LOCATORS.vbakVtweg);
  readonly vbakSpart = this.sap.locator(LOCATORS.vbakSpart);
}

export class Va01CreateOrderScreen3Page extends Va01CreateOrderScreen {
  readonly marker = LOCATORS.kuagvKunnr;

  readonly kuagvKunnr = this.sap.locator(LOCATORS.kuagvKunnr);
  readonly sapmv45atctrlUErfAuftragTable = this.sap.table(LOCATORS.sapmv45atctrlUErfAuftrag);
}
