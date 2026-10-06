import type { SapGuiSession } from '../../../src';

/**
 * A "page object" for classic SAP GUI is just a few functions that wrap the
 * ids you copied from a recording (or from `npm run doctor -- --dump`), so a
 * test reads as intent and the ids live in ONE place. When SAP changes a
 * screen you fix it here, not in every test.
 */
export async function createSalesOrder(
  sap: SapGuiSession,
  order: { type: string; salesOrg: string; channel: string; division: string; customer: string; material: string; quantity: string },
): Promise<string> {
  await sap.startTransaction('VA01');

  await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', order.type);
  await sap.setText('wnd[0]/usr/ctxtVBAK-VKORG', order.salesOrg);
  await sap.setText('wnd[0]/usr/ctxtVBAK-VTWEG', order.channel);
  await sap.setText('wnd[0]/usr/ctxtVBAK-SPART', order.division);
  await sap.sendVKey(0); // Enter

  await sap.setText('wnd[0]/usr/ctxtKUAGV-KUNNR', order.customer);
  // A table-control cell: [column,row]. It appears a moment after the screen - the session waits for it.
  await sap.setText('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]', order.material);
  await sap.setText('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtRV45A-KWMENG[3,0]', order.quantity);

  await sap.press('wnd[0]/tbar[0]/btn[11]'); // Save

  return sap.statusBarText(); // e.g. "Standard Order 4711 has been saved"
}
