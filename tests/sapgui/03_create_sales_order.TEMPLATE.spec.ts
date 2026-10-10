import { loadEnv } from '@automation/referenced-automation-utils';
import { expect, test } from './support/sapTest';
import { EasyAccessPage } from './pages/EasyAccessPage';
import { SystemMessagePopup } from './pages/Popups';
import { CreateOrderInitialPage } from './pages/SalesOrderPages';

/**
 * STEP 3 - a TEMPLATE for your own business flow, written the way every flow should be:
 * the ids live in page objects (pages/), the test reads as intent, assertions retry.
 *
 * The ids in pages/SalesOrderPages.ts are the ones SAP's standard VA01 screens use, but your
 * system's screens, mandatory fields and customising will differ - so this is switched off
 * against a real SAP until you have made it yours:
 *   1. record your own flow (see README), or `npm run doctor -- --dump` on each screen
 *   2. fix the ids/values in pages/
 *   3. set SAP_RUN_TEMPLATES=true
 * It always runs against the built-in simulator (SAP_GUI_SIMULATOR=true).
 */
const env = loadEnv();

/** What this flow types and expects: change a value here and every step that uses it follows (the converters write the same shape). */
const CONSTANTS = {
  order: { type: 'OR', salesOrg: '1000', channel: '10', division: '00', customer: '1000', item: { material: 'TG11', quantity: '5' } },
  expected: { saved: /has been saved/i },
};

test.skip(
  !env.getBoolean('SAP_GUI_SIMULATOR', false) && !env.getBoolean('SAP_RUN_TEMPLATES', false),
  'template - adapt pages/SalesOrderPages.ts to your system, then set SAP_RUN_TEMPLATES=true',
);

test('creates a standard sales order @sapgui @template', async ({ loggedInSap: sap }) => {
  // Anything SAP may put in front of a step is dealt with once, here, not inside the flow.
  sap.onPopup('system message', { title: /System Message/i }, (s) => new SystemMessagePopup(s).dismiss());

  await new EasyAccessPage(sap).open('VA01');

  const initial = await new CreateOrderInitialPage(sap).waitUntilDisplayed();
  const { type, salesOrg, channel, division, customer, item } = CONSTANTS.order;
  const order = await initial.enter({ type, salesOrg, channel, division });

  await order.customer.fill(customer);
  await order.addItem(0, item);
  await sap.evidence('order filled in'); // a screenshot that goes into the test report
  await order.save.click();

  await expect(sap).toHaveStatusMessage(CONSTANTS.expected.saved, { type: 'S' });
  await sap.evidence('order saved');
});
