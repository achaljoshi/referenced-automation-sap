import { test, expect } from '@automation/referenced-automation-ui';
import { createFioriCartPage } from './support/FioriCartPage';

const CART_APP_URL = 'https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html';

// SAP's own hosted demo kit, not a random third-party site - see
// FioriCartPage's javadoc-style comment for how each selector below was
// confirmed against a live render before being written.
test.describe('SAPUI5 Shopping Cart demo @regression', () => {
  test('adding a promoted item updates the cart total', async ({ page }) => {
    const cart = createFioriCartPage(page);
    await cart.open(CART_APP_URL);
    expect(await cart.isLoaded()).toBe(true);

    await cart.expandPromotedItems();
    await cart.addFirstPromotedItemToCart();

    await cart.openCart();
    const total = await cart.cartTotalText();
    // The "Promoted Items" panel rotates its contents between loads, so the
    // amount (and whether it needs thousands-grouping, e.g. "1.459,00" vs
    // "2,30") varies - assert the shape, not one specific value or format.
    expect(total).toMatch(/^Total: [\d.,]+ EUR$/);
  });
});
