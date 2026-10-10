import * as path from 'node:path';
import { actions, test, expect } from '@automation/referenced-automation-ui';
import { byControlId, waitForUI5Ready } from '../src/pages/fioriHelpers';

const fixtureUrl = `file://${path.join(__dirname, 'support', 'fioriStyleFixture.html')}`;

test.describe('FioriPage helpers @smoke', () => {
  test('byControlId matches on the logical id suffix, ignoring the UI5-generated prefix', async ({
    page,
  }) => {
    await actions.goto(page, fixtureUrl);

    const button = byControlId(page, 'addToCartBtn');
    await expect(button).toBeVisible();
    expect(await button.getAttribute('id')).toBe('__component0---mainView--addToCartBtn');
  });

  test('byControlId is anchored on the "--" separator: "Btn" finds the control called Btn, not SaveBtn', async ({ page }) => {
    await actions.goto(page, fixtureUrl);

    const matches = byControlId(page, 'Btn');
    await expect(matches).toHaveCount(1);
    expect(await matches.getAttribute('id')).toBe('__component0---mainView--Btn');
    expect(await byControlId(page, 'SaveBtn').getAttribute('id')).toBe('__component0---mainView--SaveBtn');
  });

  test('byControlId finds a control whose whole id is the logical id, and survives quotes in the id', async ({ page }) => {
    await actions.goto(page, fixtureUrl);

    expect(await byControlId(page, 'standaloneBtn').getAttribute('id')).toBe('standaloneBtn');
    expect(await byControlId(page, 'odd"id').getAttribute('id')).toBe('__component0---mainView--odd"id');
    await expect(byControlId(page, 'tandaloneBtn')).toHaveCount(0); // a suffix of the id is not the id
  });

  test('waitForUI5Ready FAILS when a busy indicator never clears (it used to swallow that and report ready)', async ({ page }) => {
    await page.setContent('<div class="sapUiLocalBusyIndicator" style="width:50px;height:50px">Loading...</div>');

    await expect(waitForUI5Ready(page, 600)).rejects.toThrow(/busy indicator.*still showing after 600ms/);
  });

  test('waitForUI5Ready is ready at once on a page with no indicator at all, and ignores hidden ones', async ({ page }) => {
    await page.setContent('<div class="sapUiBlockLayer" style="display:none">hidden</div><p>nothing busy</p>');

    await waitForUI5Ready(page, 600);
  });

  test('waitForUI5Ready waits out a transient busy indicator', async ({ page }) => {
    await actions.goto(page, fixtureUrl);

    await actions.click(byControlId(page, 'addToCartBtn'));
    await waitForUI5Ready(page);

    await expect(page.locator('#busy-overlay')).toBeHidden();
  });
});
