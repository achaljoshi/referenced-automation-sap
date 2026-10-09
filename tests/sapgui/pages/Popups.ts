import type { SapGuiSession } from '../../../src';

/** The "System Message" box SAP can raise in front of any screen. Written once, used by a pop-up handler. */
export class SystemMessagePopup {
  constructor(private readonly sap: SapGuiSession) {}

  async dismiss(): Promise<void> {
    await this.sap.press('wnd[1]/tbar[0]/btn[0]'); // Continue
  }
}
