import type { Locator } from '@playwright/test';
import { BasePage } from '@automation/referenced-automation-ui';

/**
 * Base class for SAP Fiori/UI5 page objects. Extends referenced-automation-ui's
 * BasePage directly (same Playwright Page, same logged actions) and adds the
 * two things generic web automation doesn't need for a UI5 app:
 *
 * 1. `byControlId` - UI5 renders a control's DOM id as the auto-generated
 *    view/component id path PLUS the developer-assigned logical id you gave
 *    the control in the view (e.g. a button with id="addToCartBtn" inside a
 *    view UI5 auto-names "container-cart---welcomeView" renders as
 *    id="container-cart---welcomeView--addToCartBtn"). Matching on the
 *    logical id as a suffix survives that auto-generated prefix changing
 *    between app reloads/versions - a full/exact id never does.
 *
 * 2. `waitForUI5Ready` - UI5 shows a full-screen or local busy indicator
 *    while it's fetching data/re-rendering; interacting before it clears is
 *    a common source of flaky UI5 test automation. This waits for every
 *    busy-indicator element to disappear.
 *
 * Where a control has a proper ARIA role/label (most standard sap.m
 * controls do), prefer Playwright's own page.getByRole()/getByLabel() -
 * they're more resilient than either technique here. byControlId exists for
 * the custom/compound controls that don't expose one.
 */
export abstract class FioriPage extends BasePage {
  /** Locates an element whose id ends with the UI5 control's logical id. */
  byControlId(logicalId: string): Locator {
    return this.page.locator(`[id$="${logicalId}"]`);
  }

  async waitForUI5Ready(timeoutMs = 30_000): Promise<void> {
    await this.page
      .locator('.sapUiLocalBusyIndicator, .sapMBusyIndicator, .sapUiBlockLayer')
      .first()
      .waitFor({ state: 'hidden', timeout: timeoutMs })
      .catch(() => undefined); // fine if none ever appeared
    await this.page.waitForLoadState('networkidle');
  }
}
