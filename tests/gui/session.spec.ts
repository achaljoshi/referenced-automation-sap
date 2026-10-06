import { expect, test } from '@playwright/test';
import { createSampleSapSystem, SapGuiElementNotFoundError, SapGuiSession, SapGuiTransportError } from '../../src';

const FAST = { timeoutMs: 5_000, pollMs: 10 };

async function attached(delay = 150) {
  const fake = createSampleSapSystem({ transitionDelayMs: delay });
  const sap = await SapGuiSession.attach(fake, FAST);
  return { fake, sap };
}

async function logOn(sap: SapGuiSession): Promise<void> {
  await sap.setText('wnd[0]/usr/txtRSYST-MANDT', '100');
  await sap.setText('wnd[0]/usr/txtRSYST-BNAME', 'TESTUSER');
  await sap.setText('wnd[0]/usr/pwdRSYST-BCODE', 'correct-horse');
  await sap.sendVKey(0);
}

test.describe('SapGuiSession waits for SAP so a recording needs no sleeps', () => {
  test('the negative control: the same steps WITHOUT the session race the screen change and fail', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 150 });
    await fake.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
    await fake.request({ op: 'set', id: 'wnd[0]/usr/txtRSYST-MANDT', prop: 'text', value: '100' });
    await fake.request({ op: 'set', id: 'wnd[0]/usr/txtRSYST-BNAME', prop: 'text', value: 'TESTUSER' });
    await fake.request({ op: 'set', id: 'wnd[0]/usr/pwdRSYST-BCODE', prop: 'text', value: 'correct-horse' });
    await fake.request({ op: 'call', id: 'wnd[0]', method: 'sendVKey', args: [0] });

    // This is exactly what a recorded script does next - and what fails when it runs faster than it was recorded.
    await expect(fake.request({ op: 'set', id: 'wnd[0]/tbar[0]/okcd', prop: 'text', value: '/nVA01' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('with the session, the identical sequence just works', async () => {
    const { fake, sap } = await attached(150);
    await logOn(sap);
    await sap.setText('wnd[0]/tbar[0]/okcd', '/nVA01');
    await sap.sendVKey(0);
    expect(fake.currentScreen).toBe('va01Initial');
  });

  test('it waits for a control that SAP renders late (table cells appear after the screen)', async () => {
    const { fake, sap } = await attached(50);
    await logOn(sap);
    await sap.startTransaction('VA01');
    await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR');
    await sap.sendVKey(0);
    // the cell does not exist yet at this instant:
    expect(await sap.exists('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]')).toBe(false);
    await sap.setText('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]', 'TG11');
    expect(fake.calls.at(-1)).toMatchObject({ op: 'set', name: 'text', args: ['TG11'] });
  });

  test('it does not return from a screen-changing step until SAP has settled', async () => {
    const { fake, sap } = await attached(200);
    await logOn(sap);
    // sendVKey has returned, so the new screen must already be usable with no further waiting
    expect(await fake.request({ op: 'busy' })).toBe(false);
    expect(await fake.request({ op: 'exists', id: 'wnd[0]/tbar[0]/okcd' })).toBe(true);
  });

  test('chained access (column width, scrollbar, row selection) is passed through and recorded', async () => {
    const { fake, sap } = await attached(10);
    await logOn(sap);
    await sap.startTransaction('VA01');
    await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR');
    await sap.sendVKey(0);
    await sap.set('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG', 'columns.elementAt(1).width', 18);
    await sap.set('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG', 'getAbsoluteRow(3).selected', true);
    expect(fake.calls.slice(-2)).toEqual([
      { op: 'set', id: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG', name: 'columns.elementAt(1).width', args: [18] },
      { op: 'set', id: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG', name: 'getAbsoluteRow(3).selected', args: [true] },
    ]);
  });

  test('NOT_FOUND diagnostics: nearest existing id, its children, and the status bar', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 0 });
    const sap = await SapGuiSession.attach(fake, { timeoutMs: 300, pollMs: 10 });
    const error = (await sap.setText('wnd[0]/usr/txtNO-SUCH-FIELD', 'x').catch((e: unknown) => e)) as SapGuiElementNotFoundError;
    expect(error).toBeInstanceOf(SapGuiElementNotFoundError);
    expect(error.nearestExistingId).toBe('wnd[0]/usr');
    expect(error.message).toContain('txtRSYST-BNAME');
    expect(error.message).toContain('"wnd[0]/usr/txtNO-SUCH-FIELD" not found');
  });

  test('a wrong password is a visible outcome, not a hang: the status bar says why', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 20 });
    const sap = await SapGuiSession.attach(fake, FAST);
    await sap.setText('wnd[0]/usr/txtRSYST-MANDT', '100');
    await sap.setText('wnd[0]/usr/txtRSYST-BNAME', 'TESTUSER');
    await sap.setText('wnd[0]/usr/pwdRSYST-BCODE', 'wrong');
    await sap.sendVKey(0);
    expect(await sap.statusBarText()).toContain('incorrect');
  });

  test('the password never reaches the logs', async () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const { sap } = await attached(10);
      await sap.setText('wnd[0]/usr/pwdRSYST-BCODE', 'hunter2-secret');
    } finally {
      process.stdout.write = original;
    }
    const output = lines.join('');
    // prove the log was actually captured (otherwise "not contained" proves nothing) ...
    expect(output).toContain('[sap-gui] set text');
    // ... and that the secret was masked rather than printed
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('hunter2-secret');
  });

  test('a transport failure that is not "not found" is not retried into a timeout', async () => {
    const { fake, sap } = await attached(0);
    await fake.close();
    await expect(sap.setText('wnd[0]/usr/txtRSYST-BNAME', 'x')).rejects.toThrow(/bridge is closed|sap-gui/);
    expect(new SapGuiTransportError('x', 'BRIDGE_EXITED').code).toBe('BRIDGE_EXITED');
  });

  test('healthCheck reflects the bridge', async () => {
    const { fake, sap } = await attached(0);
    expect(await sap.healthCheck()).toBe(true);
    await fake.close();
    expect(await sap.healthCheck()).toBe(false);
  });
});
