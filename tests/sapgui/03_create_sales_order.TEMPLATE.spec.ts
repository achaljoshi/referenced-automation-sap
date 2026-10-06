import { loadEnv } from '@automation/referenced-automation-utils';
import { expect, test } from './support/sapTest';
import { createSalesOrder } from './support/salesOrder';

/**
 * STEP 3 - a TEMPLATE for your own business flow.
 *
 * The ids below are the ones SAP's standard VA01 screens use, but your system's
 * screens, mandatory fields and customising will differ - so this is switched
 * off against a real SAP until you have made it yours:
 *   1. record your own flow (see README), or `npm run doctor -- --dump` on each screen
 *   2. fix the ids/values in support/salesOrder.ts
 *   3. set SAP_RUN_TEMPLATES=true
 * It always runs against the built-in simulator (SAP_GUI_SIMULATOR=true).
 */
const env = loadEnv();
test.skip(
  !env.getBoolean('SAP_GUI_SIMULATOR', false) && !env.getBoolean('SAP_RUN_TEMPLATES', false),
  'template - adapt support/salesOrder.ts to your system, then set SAP_RUN_TEMPLATES=true',
);

test('creates a standard sales order @sapgui @template', async ({ loggedInSap: sap }) => {
  const status = await createSalesOrder(sap, {
    type: 'OR',
    salesOrg: '1000',
    channel: '10',
    division: '00',
    customer: '1000',
    material: 'TG11',
    quantity: '5',
  });

  expect(status).toMatch(/has been saved/i);
});
