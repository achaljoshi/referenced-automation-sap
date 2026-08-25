import type { Page } from '@playwright/test';
import { FioriPage } from '../../src/pages/FioriPage';

/**
 * Page object for SAP's own public "Shopping Cart" SAPUI5 demo kit app
 * (https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html)
 * - a credential-free, officially SAP-hosted demo, used here purely as a
 * real UI5 app to prove FioriPage against (not a random third-party site).
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
export class FioriCartPage extends FioriPage {
  private readonly promotedItemsHeader = this.page.getByText('Promoted Items', { exact: true });
  private readonly addToCartButtons = this.page.locator('[aria-label="Add to Shopping Cart"]');
  private readonly showCartButton = this.page.locator('[aria-label="Show Shopping Cart"]');
  private readonly cartPanelTitle = this.page.locator('.sapMTitle', { hasText: /^Shopping Cart$/ });
  private readonly cartTotal = this.page.getByText(/^Total:/);

  constructor(page: Page) {
    super(page);
  }

  async open(url: string): Promise<void> {
    await this.goto(url);
    await this.waitForUI5Ready();
  }

  async isLoaded(): Promise<boolean> {
    return (await this.title()) === 'Shopping Cart';
  }

  async expandPromotedItems(): Promise<void> {
    await this.click(this.promotedItemsHeader);
    await this.waitForVisible(this.addToCartButtons.first());
  }

  async addFirstPromotedItemToCart(): Promise<void> {
    await this.click(this.addToCartButtons.first());
    await this.waitForUI5Ready();
  }

  async openCart(): Promise<void> {
    await this.click(this.showCartButton);
    await this.waitForVisible(this.cartPanelTitle);
  }

  async cartTotalText(): Promise<string> {
    return this.getText(this.cartTotal);
  }
}
