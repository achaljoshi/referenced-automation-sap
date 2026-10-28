import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { FakeSapGui, SapGuiSession, attachDiagnostics, createSampleSapSystem } from '../../src';
import { demoSession, FAST } from './support';

/** A demo SAP where pressing Continue raises the "System Message" pop-up in front of the screen. */
async function withPopupOnContinue() {
  const { sap, fake } = await demoSession({ onPress: { 'wnd[0]/usr/btnCONT': () => 'popup' } });
  return { sap, fake };
}

test.describe('pop-up handlers', () => {
  test('a registered handler clears the pop-up before the next step, so the test never mentions it', async () => {
    const { sap, fake } = await withPopupOnContinue();
    sap.onPopup('system message', { title: /System Message/ }, (s) => s.press('wnd[1]/tbar[0]/btn[0]'));

    await sap.getByTooltip('Continue (Enter)').click(); // raises the pop-up
    await sap.getByLabel('City').fill('Leeds'); // would fail on the pop-up without the handler

    expect(fake.currentScreen).toBe('main');
    expect(fake.calls.at(-1)).toMatchObject({ op: 'set', name: 'text', args: ['Leeds'] });
  });

  test('negative control: without a handler the same test is stuck behind the pop-up', async () => {
    const { sap } = await withPopupOnContinue();
    await sap.getByTooltip('Continue (Enter)').click();
    await expect(sap.getByLabel('City').fill('Leeds')).rejects.toThrow(/no control matched label "City"/);
  });

  test('a handler only acts on the pop-up it was written for', async () => {
    const { sap, fake } = await withPopupOnContinue();
    sap.onPopup('license', { title: 'License' }, (s) => s.press('wnd[1]/tbar[0]/btn[0]'));
    await sap.getByTooltip('Continue (Enter)').click();
    await expect(sap.getByLabel('City').fill('x')).rejects.toThrow();
    expect(fake.currentScreen).toBe('popup');
  });

  test('a step aimed at the pop-up itself is never intercepted', async () => {
    const { sap, fake } = await withPopupOnContinue();
    let ran = 0;
    sap.onPopup('catch-all', { title: /./ }, async (s) => {
      ran++;
      await s.press('wnd[1]/tbar[0]/btn[0]');
    });
    await sap.getByTooltip('Continue (Enter)').click();
    expect(await sap.getByText('Maintenance').count()).toBe(0); // (text lives on wnd[1]/usr/lblMSG, outside the default root)
    await sap.press('wnd[1]/tbar[0]/btn[0]'); // the test deals with it on purpose
    expect(ran).toBe(0);
    expect(fake.currentScreen).toBe('main');
  });

  test('times: 1 handles it once, then leaves later pop-ups to the test', async () => {
    const { sap, fake } = await withPopupOnContinue();
    sap.onPopup('once', { title: /System/ }, (s) => s.press('wnd[1]/tbar[0]/btn[0]'), { times: 1 });
    await sap.getByTooltip('Continue (Enter)').click();
    await sap.getByLabel('City').fill('a'); // handled here
    await sap.getByTooltip('Continue (Enter)').click();
    await expect(sap.getByLabel('City').fill('b')).rejects.toThrow(); // second pop-up: not handled
    expect(fake.currentScreen).toBe('popup');
  });

  test('the returned function removes the handler', async () => {
    const { sap } = await withPopupOnContinue();
    const remove = sap.onPopup('x', { title: /System/ }, (s) => s.press('wnd[1]/tbar[0]/btn[0]'));
    remove();
    await sap.getByTooltip('Continue (Enter)').click();
    expect(await sap.dismissPopups()).toBe(0);
  });
});

test.describe('home(): a known starting point between tests', () => {
  test('cancels a modal window and returns to the start screen', async () => {
    const { sap, fake } = await withPopupOnContinue();
    await sap.getByTooltip('Continue (Enter)').click();
    expect(fake.currentScreen).toBe('popup');
    await sap.home();
    expect(fake.currentScreen).toBe('main');
  });

  test('is a no-op on the logon screen (no command field to type in)', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 0 });
    const sap = await SapGuiSession.attach(fake, FAST);
    await sap.home();
    expect(fake.currentScreen).toBe('logon');
    expect(fake.calls).toHaveLength(0);
  });

  test('healthCheck is false once SAP is gone', async () => {
    const { sap, fake } = await demoSession();
    expect(await sap.healthCheck()).toBe(true);
    await fake.close();
    expect(await sap.healthCheck()).toBe(false);
  });
});

test.describe('journal and evidence', () => {
  test('the journal lists each step with its duration, and marks the one that failed with why', async () => {
    const { sap } = await demoSession();
    await sap.getByLabel('City').fill('Leeds');
    await sap.getByTooltip('Save').click();
    await sap.getByLabel('Nonexistent').click().catch(() => undefined);

    const text = sap.journalText();
    expect(text).toMatch(/ok\s+set text\s+wnd\[0\]\/usr\/txtCITY/);
    expect(text).toMatch(/ok\s+press\s+wnd\[0\]\/usr\/btnSAVE/);
    expect(sap.steps.some((s) => s.ok)).toBe(true);
  });

  test('a failed step is journaled FAIL with the reason', async () => {
    const { sap } = await demoSession();
    await sap.setText('wnd[0]/usr/txtNOPE', 'x').catch(() => undefined);
    expect(sap.journalText()).toMatch(/FAIL\s+set text\s+wnd\[0\]\/usr\/txtNOPE.*not found/);
  });

  test('the journal never contains a password', async () => {
    const { sap } = await demoSession();
    await sap.getByLabel('Password').fill('hunter2-secret');
    expect(sap.journalText()).not.toContain('hunter2-secret');
  });

  test('evidence is a screenshot kept for the report; resetDiagnostics clears per-test state', async () => {
    const { sap } = await demoSession();
    const file = await sap.evidence('after search');
    expect(file && fs.existsSync(file)).toBe(true);
    expect(sap.evidenceItems.map((e) => e.label)).toEqual(['after search']);
    sap.resetDiagnostics();
    expect(sap.evidenceItems).toHaveLength(0);
    expect(sap.steps).toHaveLength(0);
  });

  test("evidence: 'steps' mode takes a screenshot after every step that changes the screen", async () => {
    const { fake } = await demoSession();
    const sap = await SapGuiSession.attach(fake, { ...FAST, evidence: 'steps' });
    await sap.getByLabel('City').fill('x'); // not a round trip: no screenshot
    await sap.getByTooltip('Save').click(); // a round trip: screenshot
    expect(sap.evidenceItems).toHaveLength(1);
  });

  test('on failure the report gets the journal, status bar text and a screenshot - and nothing on a pass', async () => {
    const { sap } = await demoSession();
    await sap.getByLabel('City').fill('x');
    const attached: string[] = [];
    const testInfo = { attach: async (name: string) => void attached.push(name) };

    await attachDiagnostics(sap, testInfo, 'failure', false);
    expect(attached).toEqual([]);

    await attachDiagnostics(sap, testInfo, 'failure', true);
    expect(attached).toEqual(['sap-context', 'sap-steps', 'sap-status-bar', 'sap-screenshot']);
  });

  test("SAP_GUI_EVIDENCE=off attaches nothing even on failure", async () => {
    const { sap } = await demoSession();
    const attached: string[] = [];
    await attachDiagnostics(sap, { attach: async (name) => void attached.push(name) }, 'off', true);
    expect(attached).toEqual([]);
  });

  test('diagnostics never throw, even if SAP is gone (it must not mask the real failure)', async () => {
    const { sap, fake } = await demoSession();
    await fake.close();
    await expect(attachDiagnostics(sap, { attach: async () => undefined }, 'failure', true)).resolves.toBeUndefined();
  });
});

test.describe('grid, tree and table controls', () => {
  async function gridSession() {
    const rows = [
      { MATNR: 'TG11', MAKTX: 'Trading good 11' },
      { MATNR: 'TG12', MAKTX: 'Trading good 12' },
      { MATNR: 'TG13', MAKTX: 'Trading good 13' },
    ];
    const fake = new FakeSapGui({
      start: 'list',
      screens: [
        {
          name: 'list',
          elements: {
            'wnd[0]': { type: 'GuiMainWindow' },
            'wnd[0]/usr/cntlGRID/shellcont/shell': {
              type: 'GuiShell',
              props: { rowCount: rows.length },
              methods: { getCellValue: (args) => rows[Number(args[0])]?.[String(args[1]) as 'MATNR' | 'MAKTX'] ?? '' },
            },
            'wnd[0]/usr/cntlTREE/shellcont/shell': { type: 'GuiShell', methods: { getNodeTextByKey: (args) => `node ${String(args[0])}` }, props: { selectedNode: '000002' } },
            'wnd[0]/usr/tblORD': { type: 'GuiTableControl', props: { visibleRowCount: 8, rowCount: 20 } },
            'wnd[0]/usr/tblORD/txtQTY[3,0]': { type: 'GuiTextField' },
            'wnd[0]/sbar': { type: 'GuiStatusbar' },
          },
        },
      ],
    });
    return { sap: await SapGuiSession.attach(fake, FAST), fake };
  }

  test('grid: read cells and rows, find a row, select, double-click', async () => {
    const { sap, fake } = await gridSession();
    const grid = sap.grid('wnd[0]/usr/cntlGRID/shellcont/shell');
    expect(await grid.rowCount()).toBe(3);
    expect(await grid.cell(1, 'MAKTX')).toBe('Trading good 12');
    expect(await grid.rows(['MATNR'])).toEqual([{ MATNR: 'TG11' }, { MATNR: 'TG12' }, { MATNR: 'TG13' }]);
    expect(await grid.findRow('MATNR', 'TG13')).toBe(2);
    expect(await grid.findRow('MATNR', 'NOPE')).toBe(-1);

    await grid.selectRows(0, 2);
    await grid.doubleClickCell(1, 'MATNR');
    const names = fake.calls.map((c) => `${c.name}=${c.args.join(',')}`);
    expect(names).toContain('selectedRows=0,2');
    expect(names).toContain('currentCellRow=1');
    expect(names).toContain('currentCellColumn=MATNR');
    expect(names).toContain('doubleClickCurrentCell=');
  });

  test('tree: expand, select, open a node and read its text', async () => {
    const { sap, fake } = await gridSession();
    const tree = sap.tree('wnd[0]/usr/cntlTREE/shellcont/shell');
    await tree.expandNode('000001');
    await tree.doubleClickNode('000002');
    expect(await tree.nodeText('000002')).toBe('node 000002');
    expect(await tree.selectedNode()).toBe('000002');
    expect(fake.calls.map((c) => c.name)).toEqual(['expandNode', 'doubleClickNode', 'getNodeTextByKey']);
  });

  test('table: a cell is addressed by field, column and row; scroll and selection use the recorder members', async () => {
    const { sap, fake } = await gridSession();
    const table = sap.table('wnd[0]/usr/tblORD');
    await table.cell('txtQTY', 3, 0).fill('5');
    expect(fake.calls[0]).toMatchObject({ id: 'wnd[0]/usr/tblORD/txtQTY[3,0]', name: 'text', args: ['5'] });
    expect(await table.visibleRowCount()).toBe(8);
    await table.scrollTo(12);
    await table.selectRow(3);
    expect(fake.calls.slice(-2).map((c) => c.name)).toEqual(['verticalScrollbar.position', 'getAbsoluteRow(3).selected']);
  });
});
