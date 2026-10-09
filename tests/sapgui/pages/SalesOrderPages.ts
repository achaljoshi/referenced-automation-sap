import { SapPage } from '../../../src';

/**
 * VA01 as page objects: one class per screen, the technical ids in ONE place.
 * These ids are the ones SAP's standard screens use; yours may differ - fix
 * them here (record the flow, or `npm run doctor -- --dump`) and every test
 * that uses the page is fixed with them.
 */
export class CreateOrderInitialPage extends SapPage {
  readonly marker = 'wnd[0]/usr/ctxtVBAK-AUART';

  readonly orderType = this.sap.locator('wnd[0]/usr/ctxtVBAK-AUART');
  readonly salesOrg = this.sap.locator('wnd[0]/usr/ctxtVBAK-VKORG');
  readonly channel = this.sap.locator('wnd[0]/usr/ctxtVBAK-VTWEG');
  readonly division = this.sap.locator('wnd[0]/usr/ctxtVBAK-SPART');

  async enter(order: { type: string; salesOrg: string; channel: string; division: string }): Promise<OrderOverviewPage> {
    await this.orderType.fill(order.type);
    await this.salesOrg.fill(order.salesOrg);
    await this.channel.fill(order.channel);
    await this.division.fill(order.division);
    await this.sap.sendVKey(0); // Enter
    return new OrderOverviewPage(this.sap).waitUntilDisplayed();
  }
}

export class OrderOverviewPage extends SapPage {
  readonly marker = 'wnd[0]/usr/ctxtKUAGV-KUNNR';

  /** Found by the label the user sees - survives an id change. */
  readonly customer = this.sap.getByLabel('Sold-To Party');
  readonly items = this.sap.table('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG');
  /** Found by tooltip: the same on every screen that has a Save button. */
  readonly save = this.sap.getByTooltip('Save');

  /** Fills one order line. A table cell appears a moment after the screen - the locator waits for it. */
  async addItem(row: number, item: { material: string; quantity: string }): Promise<void> {
    await this.items.cell('ctxtRV45A-MABNR', 1, row).fill(item.material);
    await this.items.cell('txtRV45A-KWMENG', 3, row).fill(item.quantity);
  }
}
