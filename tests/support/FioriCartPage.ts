import type { Page } from '@playwright/test';
import { actions } from '@automation/referenced-automation-ui';
import { waitForUI5Ready } from '../../src/pages/fioriHelpers';

/**
 * Page object for SAP's own public "Shopping Cart" SAPUI5 demo kit app
 * (https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html)
 * - a credential-free, officially SAP-hosted demo, used here purely as a
 * real UI5 app to prove the fiori helpers against (not a random third-party
 * site).
 *
 * Every selector below was confirmed against a live render of this exact
 * app before being written, not guessed from SAPUI5 documentation:
 * - `[aria-label="Add to Shopping Cart"]` / `[aria-label="Show Shopping Cart"]`
 *   are the real accessible names SAPUI5 renders for those buttons.
 * - The "Promoted Items" panel is not expanded by default - it must be
 *   clicked open before its "Add to Shopping Cart" buttons exist in the DOM.
 * - The cart panel's total is rendered as "Total: 2,30 EUR" (comma decimal
 *   separator), while the product card price uses a period ("2.30 EUR") -
 *   a real, observed inconsistency in the app, not a copy-paste mismatch
 *   here.
 */
export interface FioriCartPage {
  open(url: string): Promise<void>;
  isLoaded(): Promise<boolean>;
  expandPromotedItems(): Promise<void>;
  addFirstPromotedItemToCart(): Promise<void>;
  openCart(): Promise<void>;
  cartTotalText(): Promise<string>;
}

export function createFioriCartPage(page: Page): FioriCartPage {
  const promotedItemsHeader = page.getByText('Promoted Items', { exact: true });
  const addToCartButtons = page.locator('[aria-label="Add to Shopping Cart"]');
  const showCartButton = page.locator('[aria-label="Show Shopping Cart"]');
  const cartPanelTitle = page.locator('.sapMTitle', { hasText: /^Shopping Cart$/ });
  const cartTotal = page.getByText(/^Total:/);

  return {
    async open(url) {
      await actions.goto(page, url);
      await waitForUI5Ready(page);
    },

    async isLoaded() {
      return (await actions.title(page)) === 'Shopping Cart';
    },

    async expandPromotedItems() {
      await actions.click(promotedItemsHeader);
      await actions.waitForVisible(addToCartButtons.first());
    },

    async addFirstPromotedItemToCart() {
      await actions.click(addToCartButtons.first());
      await waitForUI5Ready(page);
    },

    async openCart() {
      await actions.click(showCartButton);
      await actions.waitForVisible(cartPanelTitle);
    },

    async cartTotalText() {
      return actions.getText(cartTotal);
    },
  };
}
