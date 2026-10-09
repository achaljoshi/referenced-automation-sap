import { SapPage } from '../../../../src';

/**
 * Page objects generated from examples/va01_create_order.vbs by sap-vbs-to-playwright.
 * The class and property names are mechanical (Screen1, vbakAuart): rename them to business terms.
 * The technical ids live here, once - when a screen changes, fix it here.
 */
abstract class Va01CreateOrderScreen extends SapPage {
  /** The command field: where a user types a transaction code. */
  readonly commandField = this.sap.locator('wnd[0]/tbar[0]/okcd');

  /** The message line at the bottom of the screen. */
  readonly statusBar = this.sap.locator('wnd[0]/sbar');

  /** A button in the standard toolbar (btn[0] Enter, btn[3] Back, btn[11] Save, btn[12] Cancel, ...). */
  toolbarButton(n: number) {
    return this.sap.locator(`wnd[0]/tbar[0]/btn[${n}]`);
  }
}

/** The standard frame every screen has (command field, toolbar, status bar) - for steps that happen on a screen of their own. */
export class Va01CreateOrderFrame extends Va01CreateOrderScreen {
  readonly marker = 'wnd[0]/tbar[0]/okcd';
}

export class Va01CreateOrderScreen1Page extends Va01CreateOrderScreen {
  readonly marker = 'wnd[0]/usr/txtRSYST-MANDT';

  readonly rsystMandt = this.sap.locator('wnd[0]/usr/txtRSYST-MANDT');
  readonly rsystBname = this.sap.locator('wnd[0]/usr/txtRSYST-BNAME');
  readonly rsystBcode = this.sap.locator('wnd[0]/usr/pwdRSYST-BCODE');
  readonly rsystLangu = this.sap.locator('wnd[0]/usr/txtRSYST-LANGU');
}

export class Va01CreateOrderScreen2Page extends Va01CreateOrderScreen {
  readonly marker = 'wnd[0]/usr/ctxtVBAK-AUART';

  readonly vbakAuart = this.sap.locator('wnd[0]/usr/ctxtVBAK-AUART');
  readonly vbakVkorg = this.sap.locator('wnd[0]/usr/ctxtVBAK-VKORG');
  readonly vbakVtweg = this.sap.locator('wnd[0]/usr/ctxtVBAK-VTWEG');
  readonly vbakSpart = this.sap.locator('wnd[0]/usr/ctxtVBAK-SPART');
}

export class Va01CreateOrderScreen3Page extends Va01CreateOrderScreen {
  readonly marker = 'wnd[0]/usr/ctxtKUAGV-KUNNR';

  readonly kuagvKunnr = this.sap.locator('wnd[0]/usr/ctxtKUAGV-KUNNR');
  readonly sapmv45atctrlUErfAuftragTable = this.sap.table('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG');
}
