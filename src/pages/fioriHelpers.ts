import type { Locator, Page } from '@playwright/test';

/**
 * SAP Fiori/UI5 helpers on top of referenced-automation-ui's `actions`
 * (same Playwright Page, same logged actions). These are the two things
 * generic web automation doesn't need for a UI5 app:
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
export function byControlId(page: Page, logicalId: string): Locator {
  return page.locator(`[id$="${logicalId}"]`);
}

/**
 * Waits until the UI5 app has finished what it is doing, without a fixed
 * sleep and without 'networkidle' (which never settles on an app that
 * polls, and returns too early on one that hasn't started its requests yet).
 *
 * Ready means both: no busy indicator is showing, and UI5's own renderer
 * reports nothing left to render (`sap.ui.getCore().getUIDirty()` is false).
 * On a page that isn't a UI5 app at all there is nothing to wait for, so it
 * returns immediately.
 *
 * You rarely need this directly: Playwright actions and assertions already
 * wait for the element they act on. It's for "the whole screen has settled"
 * moments - after opening the app, or after a step that re-renders widely.
 */
export async function waitForUI5Ready(page: Page, timeoutMs = 30_000): Promise<void> {
  await page
    .locator('.sapUiLocalBusyIndicator, .sapMBusyIndicator, .sapUiBlockLayer')
    .first()
    .waitFor({ state: 'hidden', timeout: timeoutMs })
    .catch(() => undefined); // fine if none ever appeared

  await page.waitForFunction(
    () => {
      const core = (globalThis as unknown as { sap?: { ui?: { getCore?: () => { getUIDirty?: () => boolean } } } }).sap?.ui?.getCore?.();
      return !core?.getUIDirty?.();
    },
    undefined,
    { timeout: timeoutMs },
  );
}
