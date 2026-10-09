import { SapPage } from '../../../src';

/** The SAP Easy Access start screen: where every flow begins and ends. */
export class EasyAccessPage extends SapPage {
  readonly marker = 'wnd[0]/tbar[0]/okcd';

  /** The command field - where a user types a transaction code. It exists on every screen once logged on. */
  readonly commandField = this.sap.locator(this.marker);

  /** Opens a transaction the way a user does (command field + Enter). Waits for the next screen by itself. */
  async open(tcode: string): Promise<void> {
    await this.sap.startTransaction(tcode);
  }

  /** The main window's title (its wording depends on the SAP language). */
  async title(): Promise<string> {
    return this.sap.getText('wnd[0]');
  }
}
