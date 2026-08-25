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

  test('waitForUI5Ready waits out a transient busy indicator', async ({ page }) => {
    await actions.goto(page, fixtureUrl);

    await actions.click(byControlId(page, 'addToCartBtn'));
    await waitForUI5Ready(page);

    await expect(page.locator('#busy-overlay')).toBeHidden();
  });
});
