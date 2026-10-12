import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { createSampleSapSystem, dumpScreen, ensureLoggedIn, formatScreenDump, logon, SapGuiSession } from '../../src';

const FAST = { timeoutMs: 3_000, pollMs: 10 };

// A wrong password arms the logon cooldown (see logonGuard.ts): keep each test's marker in a folder of its own so that
// neither another test nor the next run of this suite is refused because of a failure this file provoked on purpose.
const savedMarkerDir = process.env.SAP_GUI_LOGON_MARKER_DIR;
test.beforeEach(() => {
  process.env.SAP_GUI_LOGON_MARKER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-logon-marker-'));
});
test.afterEach(() => {
  fs.rmSync(process.env.SAP_GUI_LOGON_MARKER_DIR ?? '', { recursive: true, force: true });
  if (savedMarkerDir === undefined) delete process.env.SAP_GUI_LOGON_MARKER_DIR;
  else process.env.SAP_GUI_LOGON_MARKER_DIR = savedMarkerDir;
});
const good = { client: '100', user: 'TESTUSER', password: 'correct-horse', language: 'EN' };

async function fresh() {
  const sap = await SapGuiSession.attach(createSampleSapSystem({ transitionDelayMs: 30 }), FAST);
  return sap;
}

test.describe('logon helper', () => {
  test('logs on and leaves the logon screen', async () => {
    const sap = await fresh();
    await logon(sap, good);
    expect(await sap.exists('wnd[0]/tbar[0]/okcd')).toBe(true);
    expect(await sap.getText('wnd[0]')).toBe('SAP Easy Access');
  });

  test('a wrong password fails right there, with the status bar text', async () => {
    const sap = await fresh();
    await expect(logon(sap, { ...good, password: 'nope' })).rejects.toThrow(/still on the logon screen.*Name or password is incorrect/);
  });

  test('missing credentials fail with where to put them, before touching SAP', async () => {
    const sap = await fresh();
    await expect(logon(sap, { user: '', password: '' })).rejects.toThrow(/SAP_USER and SAP_PASSWORD must both be set.*\.env\.\w+\.local/);
    expect(await sap.exists('wnd[0]/usr/pwdRSYST-BCODE')).toBe(true); // still untouched on the logon screen
  });

  test('ensureLoggedIn logs on from the logon screen and does nothing when already logged on', async () => {
    const sap = await fresh();
    await ensureLoggedIn(sap, good);
    expect(await sap.getText('wnd[0]')).toBe('SAP Easy Access');
    await ensureLoggedIn(sap, { user: 'ignored', password: 'ignored' }); // would throw if it tried to log on again
  });

  test('the password is not in the failure message', async () => {
    const sap = await fresh();
    const error = (await logon(sap, { ...good, password: 'hunter2-secret' }).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain('hunter2-secret');
  });
});

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
