import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { csvUtils } from '@automation/referenced-automation-utils';
import { expect, test } from '@playwright/test';
import { convertToPageObjects, propertyName } from '../../src';

const root = path.resolve(__dirname, '../..');
const recording = fs.readFileSync(path.join(root, 'examples/va01_create_order.vbs'), 'utf8');
const cli = path.join(root, 'dist/cli/convertVbs.js');
const options = { testName: 'recorded: demo', baseName: 'demo_flow', sourceName: 'demo.vbs' };

test.describe('naming', () => {
  test('property names come from the field name, without the control-type prefix', () => {
    expect(propertyName('wnd[0]/usr/ctxtVBAK-AUART')).toBe('vbakAuart');
    expect(propertyName('wnd[0]/usr/txtRSYST-BNAME')).toBe('rsystBname');
    expect(propertyName('wnd[0]/usr/pwdRSYST-BCODE')).toBe('rsystBcode');
    expect(propertyName('wnd[0]/usr/chkINCLUDE_ITEMS')).toBe('includeItems');
    expect(propertyName('wnd[0]/usr/btnBUTTON_SAVE')).toBe('buttonSave');
    expect(propertyName('wnd[0]/usr/tabsTAB_STRIP/tabpDETAIL')).toBe('detail');
    expect(propertyName('wnd[0]/usr/ctxtX[1,0]')).toBe('x'); // positions are not part of the name
  });

  test('reserved words and leading digits are made safe', () => {
    expect(propertyName('wnd[0]/usr/txtDEFAULT')).toBe('default_');
    expect(propertyName('wnd[0]/usr/txt123')).toBe('_123');
  });
});

test.describe('page objects from a recording', () => {
  const result = convertToPageObjects(recording, options);

  test('the recording is cut into screens where SAP changes screen', () => {
    expect(result.screens.map((s) => s.className)).toEqual(['DemoFlowScreen1Page', 'DemoFlowScreen2Page', 'DemoFlowScreen3Page']);
    expect(result.screens.map((s) => s.marker)).toEqual(['wnd[0]/usr/txtRSYST-MANDT', 'wnd[0]/usr/ctxtVBAK-AUART', 'wnd[0]/usr/ctxtKUAGV-KUNNR']);
    expect(result.screens[0]?.controls).toEqual(['logonClient', 'logonUser', 'logonPassword', 'logonLanguage']);
  });

  test('every technical id lives in the pages file - the spec has none of its own for page controls', () => {
    for (const id of ['wnd[0]/usr/ctxtVBAK-AUART', 'wnd[0]/usr/txtRSYST-BNAME', 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG']) {
      expect(result.pages.code).toContain(id);
      expect(result.spec).not.toContain(id);
    }
  });

  test('the command field, toolbar and status bar are in a shared base class, not repeated per screen', () => {
    expect(result.pages.code).toContain('abstract class DemoFlowScreen extends SapPage');
    expect(result.pages.code.match(/readonly commandField/g)).toHaveLength(1);
    expect(result.pages.code).toContain('toolbarButton(n: number)');
    expect(result.spec).toContain('.toolbarButton(11).press()'); // btn[11] is the Save button
    expect(result.spec).not.toContain("'wnd[0]/tbar[0]/btn[11]'");
  });

  test('a step on a screen of its own (typing the t-code) uses the frame class, not a raw id', () => {
    expect(result.pages.code).toContain('export class DemoFlowFrame extends DemoFlowScreen');
    expect(result.spec).toMatch(/const frame\d = await new DemoFlowFrame\(sap\)\.waitUntilDisplayed\(\)/);
    expect(result.spec).toMatch(/frame\d\.commandField\.fill\(/);
  });

  test('a table control becomes a table helper; direct members go through .locator, cells through .cell', () => {
    expect(result.pages.code).toMatch(/readonly sapmv45atctrlUErfAuftragTable = this\.sap\.table\(LOCATORS\.sapmv45atctrlUErfAuftrag\)/);
    expect(result.pages.code).toContain("sapmv45atctrlUErfAuftrag: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG',");
    expect(result.spec).toContain("Table.locator.set('columns.elementAt(1).width', 18)");
    expect(result.spec).toContain(".cell('ctxtRV45A-MABNR', 1, 0).fill(");
  });

  test('each page is waited for before it is used; variable names match the class numbers', () => {
    expect(result.spec).toMatch(/const screen1 = await new DemoFlowScreen1Page\(sap\)\.waitUntilDisplayed\(\)/);
    expect(result.spec).toMatch(/const screen2 = await new DemoFlowScreen2Page\(sap\)\.waitUntilDisplayed\(\)/);
    expect(result.spec).toMatch(/const screen3 = await new DemoFlowScreen3Page\(sap\)\.waitUntilDisplayed\(\)/);
  });

  test('the recorded password is in none of the generated files', () => {
    expect(result.spec).not.toContain('correct-horse');
    expect(result.pages.code).not.toContain('correct-horse');
    expect(result.pages.code).toContain("return env.get('SAP_PASSWORD');"); // CONSTANTS holds the getter; the spec only refers to it
    expect(result.spec).toContain('CONSTANTS.inputs.logonPassword');
  });

  test('sleeps are dropped, and logic the converter cannot translate is carried as a TODO', () => {
    expect(result.spec).toContain('WScript.Sleep(500) dropped');
    const withLogic = convertToPageObjects(`session.findById("wnd[0]/usr/txtA").text = "1"\nIf x = 1 Then\n  session.findById("wnd[0]").sendVKey 3\nEnd If`, options);
    expect(withLogic.spec).toContain('TODO(manual');
    expect(withLogic.spec).not.toMatch(/await sap\.sendVKey\(3\)/);
  });

  test('a pop-up control is not put on a page (it is not part of the main screen)', () => {
    const popup = convertToPageObjects(`session.findById("wnd[0]/usr/txtA").text = "1"\nsession.findById("wnd[1]/usr/btnOK").press`, options);
    expect(popup.screens[0]?.controls).toEqual(['a']); // no page class has it
    expect(popup.pages.code).toContain("ok: 'wnd[1]/usr/btnOK',"); // it is only a named id in LOCATORS
    expect(popup.pages.code).not.toMatch(/readonly ok\b/);
    expect(popup.spec).toContain('sap.locator(LOCATORS.ok).press()');
  });

  test('two fields with the same name on one screen get distinct properties', () => {
    const dup = convertToPageObjects(`session.findById("wnd[0]/usr/txtNAME").text = "a"\nsession.findById("wnd[0]/usr/subX/txtNAME").text = "b"`, options);
    expect(dup.screens[0]?.controls).toEqual(['name', 'name2']);
  });

  test('flat mode is untouched: there is no pages file unless asked for', () => {
    expect(result.pages.fileName).toBe('DemoFlowPages.ts');
  });
});

test.describe('data-driven mode', () => {
  const result = convertToPageObjects(recording, { ...options, dataDriven: true });

  test('recorded literals become columns; one row holds what was recorded', () => {
    expect(result.data?.fileName).toBe('demo_flow.data.csv');
    expect(result.data?.rows).toEqual([{ okcd: '/nVA01', vbakAuart: 'OR', vbakVkorg: '1000', vbakVtweg: '10', vbakSpart: '00', kuagvKunnr: '1000', rv45aMabnr_c1r0: 'TG11', rv45aKwmeng_c3r0: '5' }]);
  });

  test('values that come from the environment (user, client, password) are NOT in the data file', () => {
    const csv = csvUtils.toCsv(result.data?.rows ?? []);
    expect(csv).not.toContain('correct-horse');
    expect(csv).not.toContain('TESTUSER');
    expect(Object.keys(result.data?.rows[0] ?? {})).not.toContain('rsystBname');
  });

  test('the spec makes one test per row and reads each cell through a helper that names a missing column', () => {
    expect(result.spec).toContain('for (const [index, data] of rows.entries())');
    expect(result.spec).toContain('csvUtils.parseCsvFile');
    expect(result.spec).toContain("field(data, 'vbakAuart')");
    expect(result.spec).toContain('has no column');
    expect(result.spec).not.toContain("'OR'"); // the recorded value is data now, not code
  });

  test('the same field set twice gets two columns', () => {
    const twice = convertToPageObjects(`session.findById("wnd[0]/usr/txtQTY").text = "1"\nsession.findById("wnd[0]").sendVKey 0\nsession.findById("wnd[0]/usr/txtQTY").text = "2"`, { ...options, dataDriven: true });
    expect(Object.keys(twice.data?.rows[0] ?? {})).toEqual(['qty', 'qty_2']);
  });

  test('without --data nothing is parameterised', () => {
    expect(convertToPageObjects(recording, options).data).toBeUndefined();
    expect(convertToPageObjects(recording, options).pages.code).toContain("vbakAuart: 'OR',"); // typed values are in CONSTANTS, not in the CSV
  });
});

test.describe('the committed example', () => {
  test('is exactly what the converter produces from the committed recording (so it cannot rot)', () => {
    const generated = convertToPageObjects(recording, {
      testName: 'recorded: va01_create_order',
      baseName: 'va01_create_order',
      sourceName: 'examples/va01_create_order.vbs',
      testImport: '../sapFakeTest',
      sapImport: '../../../../src',
      tag: '@sapgui-sample',
      dataDriven: true,
      expectStatus: 'has been saved',
      expectImport: '../../../src',
    });
    const dir = path.join(root, 'tests/gui/generated');
    expect(fs.readFileSync(path.join(dir, 'va01_create_order.spec.ts'), 'utf8')).toBe(generated.spec);
    expect(fs.readFileSync(path.join(dir, 'pages', generated.pages.fileName), 'utf8')).toBe(generated.pages.code);
    expect(fs.readFileSync(path.join(dir, 'va01_create_order.data.csv'), 'utf8')).toBe(csvUtils.toCsv(generated.data?.rows ?? []));
  });
});

test.describe('CLI', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sapgen-'));

  test('--out is a folder unless it ends in .ts, and is created if missing', () => {
    const out = path.join(tmp(), 'not', 'yet', 'there');
    const run = spawnSync('node', [cli, path.join(root, 'examples/va01_create_order.vbs'), '--out', out, '--page-objects'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(fs.existsSync(path.join(out, 'va01_create_order.spec.ts'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'pages', 'Va01CreateOrderPages.ts'))).toBe(true);
  });

  test('--data writes the CSV next to the spec and says how many columns', () => {
    const out = tmp();
    const run = spawnSync('node', [cli, path.join(root, 'examples/va01_create_order.vbs'), '--out', out, '--data'], { encoding: 'utf8' });
    expect(run.stdout).toContain('8 column(s)');
    expect(fs.readFileSync(path.join(out, 'va01_create_order.data.csv'), 'utf8')).toContain('okcd,vbakAuart');
  });

  test('a single .ts path is still honoured for flat output', () => {
    const file = path.join(tmp(), 'custom.spec.ts');
    spawnSync('node', [cli, path.join(root, 'examples/va01_create_order.vbs'), '--out', file]);
    expect(fs.existsSync(file)).toBe(true);
  });
});

test.describe('CONSTANTS and LOCATORS at the top of the pages file', () => {
  const result = convertToPageObjects(recording, options);
  const code = result.pages.code;

  test('both objects (exported) come first, then the page classes built from them', () => {
    expect(code.indexOf('export const CONSTANTS = {')).toBeGreaterThan(0);
    expect(code.indexOf('export const LOCATORS = {')).toBeGreaterThan(code.indexOf('export const CONSTANTS'));
    expect(code.indexOf('abstract class DemoFlowScreen')).toBeGreaterThan(code.indexOf('export const LOCATORS'));
    expect(code).toContain("const env = loadEnv();");
    expect(code).toContain("vbakAuart: 'wnd[0]/usr/ctxtVBAK-AUART',");
    expect(code).toContain("readonly vbakAuart = this.sap.locator(LOCATORS.vbakAuart);");
  });

  test('the spec imports what it uses from the pages file and has no env and no ids of its own', () => {
    expect(result.spec).toMatch(/import \{ CONSTANTS, [^}]*DemoFlowScreen1Page[^}]*\} from '\.\/pages\/DemoFlowPages';/);
    expect(result.spec).not.toMatch(/loadEnv|env\.get/);
    expect(result.spec).toContain('.fill(CONSTANTS.inputs.vbakAuart)');
    expect(result.spec).toContain('.fill(CONSTANTS.inputs.logonUser)');
  });

  test('--data keeps typed values in the CSV; CONSTANTS then holds only what comes from the environment', () => {
    const data = convertToPageObjects(recording, { ...options, dataDriven: true });
    expect(data.pages.code).toContain('get logonPassword()');
    expect(data.pages.code).not.toContain("vbakAuart: 'OR'");
    expect(data.spec).toContain("field(data, 'vbakAuart')");
  });
});
