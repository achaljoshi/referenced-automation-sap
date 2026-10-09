import { expect } from '@playwright/test';
import { createSampleSapSystem, sapGuiTest, SapConnection } from '../../src';

sapGuiTest.describe('SapConnection', () => {
  sapGuiTest('knows whether this machine can run real SAP GUI tests', () => {
    const connection = new SapConnection({ sapGuiMode: 'attach', sapGuiTransport: undefined, sapGuiReuse: undefined });
    const simulated = process.env.SAP_GUI_SIMULATOR === 'true';
    expect(connection.canRun).toBe(process.platform === 'win32' || simulated);
    expect(new SapConnection({ sapGuiMode: undefined, sapGuiTransport: () => createSampleSapSystem(), sapGuiReuse: undefined }).canRun).toBe(true);
  });

  sapGuiTest('reconnects when the previous session has died', async () => {
    let made = 0;
    const connection = new SapConnection({
      sapGuiMode: 'attach',
      sapGuiReuse: undefined,
      sapGuiTransport: () => {
        made++;
        return createSampleSapSystem({ transitionDelayMs: 0 });
      },
    });
    const first = await connection.acquire();
    expect(await connection.acquire()).toBe(first);
    expect(made).toBe(1);
    await first.close(); // the bridge dies
    const second = await connection.acquire();
    expect(second).not.toBe(first);
    expect(made).toBe(2);
    await connection.dispose();
  });
});
