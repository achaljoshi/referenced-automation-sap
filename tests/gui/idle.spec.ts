import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { FakeSapGui, ProcessTransport, SapGuiSession, SapGuiTransportError, type SapGuiCommand, type SapGuiTransport } from '../../src';

/**
 * "Idle" must not mean "Busy=false twice, 20 ms apart". On a slow link SAP reports Busy=false in the moment between the request
 * leaving and the GUI noticing it is waiting, so the next step used to run on the previous screen. The simulator's
 * `responseLagMs` models exactly that window: the old screen stays, Busy reads false, RoundTrips has not moved.
 */
const LAG_MS = 250;

const screens = (lag: number, reportRoundTrips = true) =>
  new FakeSapGui({
    start: 'a',
    transitionDelayMs: 0,
    responseLagMs: lag,
    reportRoundTrips,
    screens: [
      {
        name: 'a',
        context: { transaction: 'ZA', program: 'PA', screen: '0100' },
        elements: {
          'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Screen A' } },
          'wnd[0]/usr/btnNEXT': { type: 'GuiButton', props: { text: 'Next' } },
          'wnd[0]/usr/btnLOCAL': { type: 'GuiButton', props: { text: 'Client-side only' } },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onPress: { 'wnd[0]/usr/btnNEXT': () => 'b' }, // btnLOCAL never reaches the server
      },
      {
        name: 'b',
        context: { transaction: 'ZA', program: 'PB', screen: '0200' },
        elements: {
          'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Screen B' } },
          'wnd[0]/usr/txtB': { type: 'GuiTextField' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
      },
    ],
  });

const session = (fake: SapGuiTransport, options: { roundTripWaitMs?: number } = {}) => SapGuiSession.attach(fake, { timeoutMs: 3_000, pollMs: 10, ...options });

test.describe('SAP-02: the next step waits for the server round trip, not just for Busy=false', () => {
  test('negative control: with the old "Busy twice" logic (roundTripWaitMs: 0) the step after Enter sees the PREVIOUS screen', async () => {
    const sap = await session(screens(LAG_MS), { roundTripWaitMs: 0 });
    await sap.press('wnd[0]/usr/btnNEXT');
    expect(await sap.getText('wnd[0]')).toBe('Screen A'); // stale: SAP had not answered yet, and "idle" said it was done
  });

  test('by default the call returns only once the server has answered: the next step sees the new screen', async () => {
    const sap = await session(screens(LAG_MS));
    await sap.press('wnd[0]/usr/btnNEXT');
    expect(await sap.getText('wnd[0]')).toBe('Screen B');
    expect(sap.currentContext).toMatchObject({ program: 'PB', screen: '0200' });
    await sap.setText('wnd[0]/usr/txtB', 'typed on the right screen');
    expect(await sap.getText('wnd[0]/usr/txtB')).toBe('typed on the right screen');
  });

  test('an action that never reaches the server ends after the bounded quiet period, not at the step timeout', async () => {
    const sap = await session(screens(LAG_MS), { roundTripWaitMs: 120 });
    const startedAt = Date.now();
    await sap.press('wnd[0]/usr/btnLOCAL');
    const took = Date.now() - startedAt;
    expect(took).toBeGreaterThanOrEqual(100); // it did wait for a possible answer ...
    expect(took).toBeLessThan(1_500); // ... but only for the quiet period
    expect(await sap.getText('wnd[0]')).toBe('Screen A');
  });

  test('on a SAP GUI that reports no RoundTrips counter, a changed screen is evidence enough', async () => {
    const sap = await session(screens(LAG_MS, false));
    await sap.press('wnd[0]/usr/btnNEXT');
    expect(await sap.getText('wnd[0]')).toBe('Screen B');
  });

  test('a transport that does not know the `progress` op still works (Busy alone, as before)', async () => {
    const fake = screens(0);
    const requests: string[] = [];
    const legacy: SapGuiTransport = {
      close: () => fake.close(),
      request: async (command: SapGuiCommand) => {
        requests.push(command.op);
        if (command.op === 'progress') throw new SapGuiTransportError('Unknown op progress', 'ERROR');
        return fake.request(command);
      },
    };
    const sap = await session(legacy);
    await sap.press('wnd[0]/usr/btnNEXT');
    expect(await sap.getText('wnd[0]')).toBe('Screen B');
    await sap.press('wnd[0]/usr/btnNEXT').catch(() => undefined);
    expect(requests.filter((op) => op === 'progress')).toHaveLength(1); // asked once, then given up on
  });

  test('a dead connection while reading progress is an error, not "unsupported"', async () => {
    const fake = screens(0);
    const sap = await session(fake);
    fake.simulateSessionLoss();
    const startedAt = Date.now();
    const error = (await sap.press('wnd[0]/usr/btnNEXT').catch((e: unknown) => e)) as Error & { cause?: SapGuiTransportError };
    expect(error.cause).toBeInstanceOf(SapGuiTransportError);
    expect(error.cause?.code).toBe('SESSION_LOST');
    expect(Date.now() - startedAt).toBeLessThan(1_000); // fails at once instead of polling for a control until the 3 s timeout
  });
});

test.describe('SAP-02 through a real child process: the stand-in bridge reports RoundTrips and delays its answer', () => {
  const bridge = path.resolve(__dirname, 'bridges/standInBridge.js');
  const start = (env: NodeJS.ProcessEnv) =>
    ProcessTransport.start({ command: process.execPath, args: [bridge], label: 'Stand-in', env: { ...process.env, ...env }, requestTimeoutMs: 5_000, startupTimeoutMs: 5_000 });

  async function logonThenEnter(roundTripWaitMs: number) {
    const transport = await start({ BRIDGE_RESPONSE_LAG_MS: String(LAG_MS) });
    const sap = await SapGuiSession.attach(transport, { timeoutMs: 5_000, pollMs: 10, roundTripWaitMs });
    await sap.getByLabel('User').fill('TESTUSER');
    await sap.getByLabel('Password').fill('correct-horse');
    await sap.getByLabel('Client').fill('100');
    await sap.sendVKey(0);
    const title = String(await sap.peekProp('wnd[0]', 'text'));
    await sap.close();
    return title;
  }

  test('the bridge reports a RoundTrips counter that moves when the delayed answer arrives', async () => {
    const transport = await start({ BRIDGE_RESPONSE_LAG_MS: '150' });
    await transport.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
    const before = (await transport.request({ op: 'progress' })) as { roundTrips: number; title: string };
    await transport.request({ op: 'set', id: 'wnd[0]/usr/txtRSYST-BNAME', prop: 'text', value: 'TESTUSER' });
    await transport.request({ op: 'set', id: 'wnd[0]/usr/pwdRSYST-BCODE', prop: 'text', value: 'correct-horse' });
    await transport.request({ op: 'set', id: 'wnd[0]/usr/txtRSYST-MANDT', prop: 'text', value: '100' });
    await transport.request({ op: 'call', id: 'wnd[0]', method: 'sendVKey', args: [0] });
    const during = (await transport.request({ op: 'progress' })) as { roundTrips: number; title: string };
    expect(during).toEqual(before); // sent, not answered: nothing has moved and Busy would read false
    expect(await transport.request({ op: 'busy' })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = (await transport.request({ op: 'progress' })) as { roundTrips: number; title: string };
    expect(after.roundTrips).toBe(before.roundTrips + 1);
    expect(after.title).toBe('SAP Easy Access');
    await transport.close();
  });

  test('negative control: without the round-trip wait, the step after Enter sees the logon screen', async () => {
    expect(await logonThenEnter(0)).not.toBe('SAP Easy Access');
  });

  test('with it, the step after Enter sees SAP Easy Access', async () => {
    expect(await logonThenEnter(250)).toBe('SAP Easy Access');
  });
});
