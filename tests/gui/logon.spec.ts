import { expect, test } from '@playwright/test';
import { createSampleSapSystem, dumpScreen, formatScreenDump, logon, SapGuiSession } from '../../src';

const FAST = { timeoutMs: 3_000, pollMs: 10 };

const good = { client: '100', user: 'TESTUSER', password: 'correct-horse', language: 'EN' };

async function fresh() {
  const sap = await SapGuiSession.attach(createSampleSapSystem({ transitionDelayMs: 30 }), FAST);
  return sap;
}

// The logon helper itself (a valid logon, a wrong or missing password, ensureLoggedIn, the password kept out of the message)
// is described in features/sap-logon.feature; what stays here are the simulator's multiple-logon pop-up (asserted on the
// calls it receives) and the screen dump.

test.describe('multiple-logon pop-up (user already logged on elsewhere)', () => {
  const withPopup = () => createSampleSapSystem({ transitionDelayMs: 30, multipleLogon: true });

  test('by default picks "continue without ending the other sessions" and presses Continue - like the Java framework', async () => {
    const fake = withPopup();
    const sap = await SapGuiSession.attach(fake, FAST);
    await logon(sap, good);
    expect(fake.currentScreen).toBe('easyAccess');
    const calls = fake.calls.filter((c) => c.id.startsWith('wnd[1]')).map((c) => `${c.name}:${c.id}`);
    expect(calls).toEqual(['select:wnd[1]/usr/radMULTI_LOGON_OPT2', 'press:wnd[1]/tbar[0]/btn[0]']);
  });

  test("onMultipleLogon: 'fail' stops with an explanation instead", async () => {
    const sap = await SapGuiSession.attach(withPopup(), FAST);
    await expect(logon(sap, { ...good, onMultipleLogon: 'fail' })).rejects.toThrow(/pop-up after logon.*License Information.*SAP_MULTIPLE_LOGON=continue/);
  });

  test('no pop-up, no extra steps', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 30 });
    await logon(await SapGuiSession.attach(fake, FAST), good);
    expect(fake.calls.some((c) => c.id.startsWith('wnd[1]'))).toBe(false);
  });
});

test.describe('dumpScreen - "what ids are on this screen?"', () => {
  test('lists controls with their technical ids, types and nesting', async () => {
    const sap = await fresh();
    const nodes = await dumpScreen(sap);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('wnd[0]/usr/txtRSYST-BNAME');
    expect(ids).toContain('wnd[0]/usr/pwdRSYST-BCODE');
    expect(nodes.find((n) => n.id === 'wnd[0]/usr/pwdRSYST-BCODE')?.type).toBe('GuiPasswordField');

    const text = formatScreenDump(nodes);
    expect(text).toContain('GuiTextField');
    expect(text).toMatch(/wnd\[0\]\/usr\/txtRSYST-BNAME/);
  });

  test('a different screen shows different controls', async () => {
    const sap = await fresh();
    await logon(sap, good);
    const ids = (await dumpScreen(sap)).map((n) => n.id);
    expect(ids).toContain('wnd[0]/tbar[0]/okcd');
    expect(ids).not.toContain('wnd[0]/usr/pwdRSYST-BCODE');
  });

  test('is bounded: maxNodes stops a huge screen from flooding the console', async () => {
    const sap = await fresh();
    expect(await dumpScreen(sap, 'wnd[0]', 6, 2)).toHaveLength(2);
  });
});
