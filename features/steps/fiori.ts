import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from './fixtures';

// Steps for the SAPUI5 shopping cart demo. They drive `fioriCart`, the page object in tests/support/FioriCartPage.ts (every
// selector in it was confirmed against a live render of the demo); this file only says what the scenario reads like.
const { Given, When, Then } = createBdd(test);

// SAP's own hosted demo kit, not a random third-party site.
const CART_APP_URL = 'https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html';

Given('I open the SAPUI5 shopping cart demo', async ({ fioriCart }) => {
  await fioriCart.open(CART_APP_URL);
});

Then('the shopping cart app has loaded', async ({ fioriCart }) => {
  expect(await fioriCart.isLoaded()).toBe(true);
});

When('I add the first promoted item to the cart', async ({ fioriCart }) => {
  await fioriCart.expandPromotedItems();
  await fioriCart.addFirstPromotedItemToCart();
});

When('I open the cart', async ({ fioriCart }) => {
  await fioriCart.openCart();
});

// The "Promoted Items" panel rotates its contents between loads, so the amount (and whether it needs thousands-grouping,
// e.g. "1.459,00" vs "2,30") varies - the check is the shape of the total, not one specific value or format.
Then('the cart total is shown as an amount in EUR', async ({ fioriCart }) => {
  expect(await fioriCart.cartTotalText()).toMatch(/^Total: [\d.,]+ EUR$/);
});
