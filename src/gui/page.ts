import { AdapterError } from '@automation/referenced-automation-utils';
import type { SapLocator } from './locator';
import type { SapGuiSession } from './session';

/**
 * Base class for a screen's page object. A page object is where a screen's
 * technical ids live - ONE place - so tests read as intent and a SAP screen
 * change is fixed in one file instead of in every test and recording.
 *
 *   export class SalesOrderPage extends SapPage {
 *     readonly marker = 'wnd[0]/usr/ctxtKUAGV-KUNNR';
 *     readonly customer = this.sap.locator('wnd[0]/usr/ctxtKUAGV-KUNNR');
 *     readonly save = this.sap.getByTooltip('Save');
 *     async fillItem(row: number, material: string, qty: string) { ... }
 *   }
 *
 *   const order = await new SalesOrderPage(sap).waitUntilDisplayed();
 *
 * Methods return `this` or data, tests make the assertions - a page object
 * that asserts hides what a test is checking.
 */
export abstract class SapPage {
  /** The id of a control that is on this screen and no other: how the page knows it is showing. */
  abstract readonly marker: string;

  constructor(protected readonly sap: SapGuiSession) {}

  protected locator(id: string): SapLocator {
    return this.sap.locator(id);
  }

  async isDisplayed(): Promise<boolean> {
    return this.sap.exists(this.marker);
  }

  /** Waits until this screen is showing; fails with what IS showing instead (title and status bar) if it never does. */
  async waitUntilDisplayed(timeoutMs = this.sap.timeoutMs): Promise<this> {
    try {
      await this.sap.locator(this.marker).waitFor({ state: 'attached', timeout: timeoutMs });
    } catch (error) {
      const title = String((await this.sap.peekProp('wnd[0]', 'text').catch(() => '')) ?? '');
      const status = await this.sap.statusBarText().catch(() => '');
      throw new AdapterError(
        'sap-gui',
        'waitUntilDisplayed',
        `${this.constructor.name} did not appear within ${timeoutMs}ms (looked for ${this.marker}). SAP is showing: "${title || '(no title)'}"` +
          (status ? `, status bar: "${status}"` : ''),
        { cause: error },
      );
    }
    return this;
  }
}
