import { expect, test } from '@playwright/test';
import { attachDiagnostics, createSampleSapSystem, SapGuiSession } from '../../src';
import { FAST } from './support';

async function loggedOn(options: { trackContext?: boolean; delay?: number } = {}) {
  const fake = createSampleSapSystem({ transitionDelayMs: options.delay ?? 40 });
  const sap = await SapGuiSession.attach(fake, { ...FAST, trackContext: options.trackContext });
  await sap.setText('wnd[0]/usr/txtRSYST-MANDT', '100');
  await sap.setText('wnd[0]/usr/txtRSYST-BNAME', 'TESTUSER');
  await sap.setText('wnd[0]/usr/pwdRSYST-BCODE', 'correct-horse');
  await sap.sendVKey(0);
  return { sap, fake };
}

test.describe('SAP-aware context: which transaction, program and screen', () => {
  test('is read from the session and follows each screen change', async () => {
    const { sap } = await loggedOn();
    expect(sap.currentContext).toMatchObject({ system: 'FAKE', client: '100', user: 'TESTUSER', transaction: 'SESSION_MANAGER' });

    await sap.startTransaction('VA01');
    expect(sap.currentContext).toMatchObject({ transaction: 'VA01', program: 'SAPMV45A', screen: '0101' });

    await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR');
    await sap.sendVKey(0);
    expect(sap.currentContext).toMatchObject({ transaction: 'VA01', screen: '4001' });
  });

  test('a transaction without a known screen reports the code that was entered', async () => {
    const { sap } = await loggedOn();
    await sap.startTransaction('su3');
    expect(sap.currentContext?.transaction).toBe('SU3');
  });

  test("SAP's own response time and round trips are carried through", async () => {
    const { sap } = await loggedOn({ delay: 120 });
    await sap.startTransaction('VA01');
    expect(sap.currentContext?.responseMs).toBe(120);
    expect(sap.currentContext?.roundTrips).toBeGreaterThanOrEqual(2);
  });

  test('every journal step says which transaction it ran in', async () => {
    const { sap } = await loggedOn();
    await sap.startTransaction('VA01');
    await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR');
    const entry = sap.steps.find((s) => s.label === 'set text' && s.id.endsWith('VBAK-AUART'));
    expect(entry).toMatchObject({ tx: 'VA01', program: 'SAPMV45A', screen: '0101' });
    expect(sap.journalText()).toMatch(/VA01\s+set text\s+wnd\[0\]\/usr\/ctxtVBAK-AUART/);
  });

  test('a failure says where SAP was, not just what was missing', async () => {
    const { sap } = await loggedOn();
    await sap.startTransaction('VA01');
    const error = (await sap.setText('wnd[0]/usr/txtNOPE', 'x').catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('SAP is on transaction VA01, screen 0101, program SAPMV45A');
  });

  test('on failure the report gets a sap-context attachment', async () => {
    const { sap } = await loggedOn();
    await sap.startTransaction('VA01');
    const attached: Array<{ name: string; body?: string }> = [];
    await attachDiagnostics(sap, { attach: async (name, o) => void attached.push({ name, body: o.body }) }, 'failure', true);
    const context = attached.find((a) => a.name === 'sap-context');
    expect(context?.body).toContain('transaction VA01, screen 0101, program SAPMV45A');
    expect(context?.body).toContain('system FAKE, client 100, user TESTUSER');
  });

  test('trackContext: false turns it off (no extra calls, no attribution)', async () => {
    const { sap } = await loggedOn({ trackContext: false });
    await sap.startTransaction('VA01');
    expect(sap.currentContext).toBeUndefined();
    expect(sap.steps.every((s) => s.tx === undefined)).toBe(true);
  });

  test('a transport that cannot report context does not break anything', async () => {
    const { sap, fake } = await loggedOn();
    const original = fake.request.bind(fake);
    fake.request = async (command) => {
      if (command.op === 'context') throw new Error('Info object not available on this SAP GUI');
      return original(command);
    };
    await sap.startTransaction('VA01'); // must still work
    expect(sap.currentContext?.transaction).toBe('SESSION_MANAGER'); // stale but intact
  });
});
