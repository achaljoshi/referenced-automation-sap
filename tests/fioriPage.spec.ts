import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '@automation/referenced-automation-ui';
import { FioriPage } from '../src/pages/FioriPage';

const fixtureUrl = `file://${path.join(__dirname, 'support', 'fioriStyleFixture.html')}`;

class FixturePage extends FioriPage {
  constructor(page: Page) {
    super(page);
  }
}

test.describe('FioriPage helpers @smoke', () => {
  test('byControlId matches on the logical id suffix, ignoring the UI5-generated prefix', async ({
    page,
  }) => {
    const fixture = new FixturePage(page);
    await fixture.goto(fixtureUrl);

    const button = fixture.byControlId('addToCartBtn');
    await expect(button).toBeVisible();
    expect(await button.getAttribute('id')).toBe('__component0---mainView--addToCartBtn');
  });

  test('waitForUI5Ready waits out a transient busy indicator', async ({ page }) => {
    const fixture = new FixturePage(page);
    await fixture.goto(fixtureUrl);

    await fixture.click(fixture.byControlId('addToCartBtn'));
    await fixture.waitForUI5Ready();

    await expect(page.locator('#busy-overlay')).toBeHidden();
  });
});
