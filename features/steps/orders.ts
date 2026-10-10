import { sapExpect as expect, type SapGuiSession } from '../../src';

/**
 * Deletes a sales order through VA02 - what a test's cleanup does for an order it created (the sample system models this
 * flow; against your own SAP, adapt the ids / the confirmation to your system). Registered through `sapData`, it runs after
 * the scenario - passed or failed - so orders do not pile up in a shared system.
 */
export async function deleteSalesOrder(sap: SapGuiSession, order: string): Promise<void> {
  await sap.startTransaction('VA02');
  await sap.getByLabel('Order').fill(order);
  await sap.sendVKey(0);
  await sap.getByTooltip('Delete').click();
  await sap.locator('wnd[1]/usr/btnSPOP-OPTION1').press(); // "Yes" in the confirmation pop-up
  await expect(sap).toHaveStatusMessage(/has been deleted/i, { type: 'S' });
}
