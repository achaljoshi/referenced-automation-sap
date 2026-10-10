import { registerDataSteps } from '@automation/referenced-automation-ui';
import { createBdd } from 'playwright-bdd';
import { registerSapSteps } from '../../src/gui/steps';
import { test } from './fixtures';

// The business-readable SAP vocabulary ("I open transaction ...", "the status bar shows ...") lives in the package and is
// shared by every project; so are the data steps ("I generate a random email called ...", "the date 7 days from today ...").
// Add this project's own steps below, using the same Given/When/Then.
const { Given, When, Then } = createBdd(test);
registerDataSteps({ Given, Then });
registerSapSteps({ Given, When, Then });
