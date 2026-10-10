import { registerDataSteps } from '@automation/referenced-automation-ui';
import { createBdd } from 'playwright-bdd';
import { registerSapSteps } from '../../src/gui/steps';
import { deleteSalesOrder } from './orders';
import { test } from './fixtures';

// The business-readable SAP vocabulary ("I open transaction ...", "the status bar shows ...") lives in the package and is
// shared by every project; so are the data steps ("I generate a random email called ...", "the date 7 days from today ...").
// Add this project's own steps below, using the same Given/When/Then.
const { Given, When, Then } = createBdd(test);
registerDataSteps({ Given, Then });
registerSapSteps({ Given, When, Then });

// Steps that create data in SAP go through `sapData`: values that cannot collide, and a cleanup that runs after the
// scenario whether it passed or failed.
Given('I make up a unique value starting with {string} as {string}', async ({ sapData, vars }, prefix: string, name: string) => {
  vars.set(name, sapData.unique(prefix));
});

Then('the saved sales order is registered for cleanup as {string}', async ({ sapData, sapScenario, vars }, name: string) => {
  const order = await sapData.captureFromStatusBar('SalesOrder', /Order (\d+)/, {
    cleanup: (sap) => deleteSalesOrder(sap, order),
  });
  sapScenario.set(name, order);
  vars.set(name, order);
});
