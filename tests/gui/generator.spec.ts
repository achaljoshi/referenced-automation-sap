import { expect, test } from '@playwright/test';
import { convertVbs } from '../../src';

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => unknown;
// The mapping tests below read the generated statements, so they use `inline` (ids and values where they are used).
// The CONSTANTS / LOCATORS objects - the default - have their own tests at the end of this file.
const options = { testName: 'recorded: demo', sourceName: 'demo.vbs', inline: true };

test.describe('convertVbs - the generated Playwright test', () => {
  test('a recorded password is never written to the output', () => {
    const { code, body, envVars } = convertVbs(
      `session.findById("wnd[0]/usr/pwdRSYST-BCODE").text = "sup3r-secret!"
session.findById("wnd[0]/usr/txtRSYST-BNAME").text = "JDOE"`,
      options,
    );
    expect(code).not.toContain('sup3r-secret!');
    expect(body.join('\n')).toContain("env.get('SAP_PASSWORD')");
    expect(envVars).toContain('SAP_PASSWORD');
  });

  test('a non-secret parameter keeps the recorded value only as a default', () => {
    const { body } = convertVbs('session.findById("wnd[0]/usr/txtRSYST-BNAME").text = "JDOE"', options);
    expect(body[0]).toContain("env.get('SAP_USER', 'JDOE')");
  });

  test('--param rules take precedence and can mark more fields as secrets or settings', () => {
    const { body } = convertVbs('session.findById("wnd[0]/usr/ctxtVBAK-VKORG").text = "1000"', {
      ...options,
      params: [{ idPattern: /VKORG/i, envVar: 'SALES_ORG' }],
    });
    expect(body[0]).toContain("env.get('SALES_ORG', '1000')");
  });

  test('strips the recorder session prefix by default and keeps it on request', () => {
    const src = 'session.findById("/app/con[0]/ses[0]/wnd[0]/usr/txtA").text = "x"';
    expect(convertVbs(src, options).body[0]).toContain("'wnd[0]/usr/txtA'");
    expect(convertVbs(src, { ...options, stripSessionPrefix: false }).body[0]).toContain("'/app/con[0]/ses[0]/wnd[0]/usr/txtA'");
  });

  test('sleeps are dropped with the reason, never turned into a wait', () => {
    const { code } = convertVbs('WScript.Sleep 2000', options);
    expect(code).toContain('dropped');
    expect(code).not.toMatch(/waitForTimeout|setTimeout|sleep\(/);
  });

  test('unsupported logic is carried as a TODO comment and listed in the header', () => {
    const { code, warnings } = convertVbs(
      `If x = 1 Then
    session.findById("wnd[0]").sendVKey 3
End If`,
      options,
    );
    expect(code).toContain('TODO(manual');
    expect(warnings.length).toBeGreaterThan(0);
    expect(code).not.toMatch(/await sap\.sendVKey\(3\)/);
  });

  test('strings are escaped so a recorded quote or backslash cannot break the generated code', () => {
    const { body } = convertVbs(`session.findById("wnd[0]/usr/txtA").text = "C:\\temp\\it's ""x"""`, options);
    expect(body[0]).toContain(`'C:\\\\temp\\\\it\\'s "x"'`);
    expect(() => new AsyncFunction('sap', 'env', body.join('\n'))).not.toThrow();
  });

  test('variables become real variables, declared once', () => {
    const { body } = convertVbs(
      `orderNo = session.findById("wnd[0]/usr/txtORDER").text
orderNo = session.findById("wnd[0]/usr/txtORDER2").text
session.findById("wnd[0]/usr/txtB").text = orderNo`,
      options,
    );
    expect(body.filter((l) => l.startsWith('let orderNo'))).toHaveLength(1);
    expect(body[2]).toContain('orderNo');
  });

  test('every generated body is syntactically valid JavaScript', () => {
    const { body } = convertVbs(
      `session.findById("wnd[0]/usr/txtRSYST-BNAME").text = "A"
session.findById("wnd[0]/usr/tblX").columns.elementAt(1).width = 18
session.findById("wnd[0]/tbar[0]/btn[11]").press
session.findById("wnd[0]").sendVKey 0`,
      options,
    );
    expect(() => new AsyncFunction('sap', 'env', body.join('\n'))).not.toThrow();
  });

  test('lineComments: false omits the vbs trace comments', () => {
    const { body } = convertVbs('session.findById("wnd[0]").sendVKey 0', { ...options, lineComments: false });
    expect(body[0]).not.toContain('vbs:');
  });

  test('--test-import and tag are honoured', () => {
    const { code } = convertVbs('session.findById("wnd[0]").sendVKey 0', { ...options, testImport: '../base', tag: '@regression' });
    expect(code).toContain("from '../base'");
    expect(code).toContain('@regression');
  });
});

test.describe('CONSTANTS and LOCATORS (the default)', () => {
  const recording = `session.findById("wnd[0]/usr/txtRSYST-BNAME").text = "JDOE"
session.findById("wnd[0]/usr/pwdRSYST-BCODE").text = "sup3r-secret!"
session.findById("wnd[0]").sendVKey 0
session.findById("wnd[0]").sendVKey 0
session.StartTransaction "VA01"
session.findById("wnd[0]/usr/ctxtVBAK-AUART").text = "OR"
session.findById("wnd[0]/usr/ctxtVBAK-AUART").text = "OR"
session.findById("wnd[0]/usr/ctxtVBAK-AUART").text = "ZOR"
session.findById("wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]").text = "TG11"
session.findById("wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,1]").text = "TG12"
session.findById("wnd[0]/usr/txtNAME").text = ""
session.findById("wnd[1]/usr/btnOK").press
session.findById("wnd[0]/tbar[0]/btn[11]").press`;
  const generated = convertVbs(recording, { testName: 'recorded: demo', sourceName: 'demo.vbs' });
  const { code } = generated;

  test('the file starts with CONSTANTS, then LOCATORS, then the test - and the steps only refer to them', () => {
    const constants = code.indexOf('const CONSTANTS = {');
    const locators = code.indexOf('const LOCATORS = {');
    const start = code.indexOf("test('recorded: demo");
    expect(constants).toBeGreaterThan(0);
    expect(locators).toBeGreaterThan(constants);
    expect(start).toBeGreaterThan(locators);
    const steps = generated.body.join('\n');
    expect(steps).not.toMatch(/'wnd\[|'JDOE'|'OR'|'VA01'|'TG11'/); // no id and no typed value is left in a step
    expect(steps).toContain('CONSTANTS.inputs.');
    expect(steps).toContain('LOCATORS.');
  });

  test('CONSTANTS.inputs: typed values named after their control; secrets and settings are environment getters, never values', () => {
    expect(code).toContain("vbakAuart: 'OR',");
    expect(code).toContain("vbakAuart2: 'ZOR',");
    expect(code).toContain("transaction: 'VA01',");
    expect(code).toContain("get logonPassword() {\n      return env.get('SAP_PASSWORD');\n    },");
    expect(code).toContain("get logonUser() {\n      return env.get('SAP_USER', 'JDOE');\n    },");
    expect(code).not.toContain('sup3r-secret!');
    expect(code).toContain("sap.startTransaction(CONSTANTS.inputs.transaction)");
    // the same value typed into the same control twice is one entry; a different value is another
    expect(code.match(/vbakAuart: 'OR'/g)).toHaveLength(1);
    expect(generated.body.filter((l) => l.includes('CONSTANTS.inputs.vbakAuart)'))).toHaveLength(2);
    // an empty string is not a value worth a constant
    expect(code).toContain("sap.setText(LOCATORS.name, '')");
  });

  test('LOCATORS: one key per id, readable keys for the standard controls, cells carry their coordinates', () => {
    expect(code).toContain("logonUser: 'wnd[0]/usr/txtRSYST-BNAME',");
    expect(code).toContain("toolbarButton11: 'wnd[0]/tbar[0]/btn[11]',");
    expect(code).toContain("rv45aMabnrC1R0: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]',");
    expect(code).toContain("rv45aMabnrC1R1: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,1]',");
    expect(code).toContain("ok: 'wnd[1]/usr/btnOK',");
    expect(code.match(/vbakAuart: 'wnd/g)).toHaveLength(1);
    expect(generated.body.join('\n')).toContain('sap.press(LOCATORS.toolbarButton11)');
  });

  test('the generated objects and steps run exactly as written (what the preamble defines, the body uses)', async () => {
    const calls: string[] = [];
    const sap = new Proxy({}, { get: (_t, name) => async (...args: unknown[]) => void calls.push(`${String(name)}(${args.map((a) => JSON.stringify(a)).join(',')})`) });
    const env = { get: (key: string, fallback?: string) => ({ SAP_PASSWORD: 'pw' })[key as 'SAP_PASSWORD'] ?? fallback };
    await (new AsyncFunction('sap', 'env', [...generated.preamble, ...generated.body].join('\n')) as (sap: unknown, env: unknown) => Promise<void>)(sap, env);
    expect(calls).toContain('setText("wnd[0]/usr/txtRSYST-BNAME","JDOE")');
    expect(calls).toContain('setText("wnd[0]/usr/pwdRSYST-BCODE","pw")');
    expect(calls).toContain('startTransaction("VA01")');
    expect(calls).toContain('press("wnd[0]/tbar[0]/btn[11]")');
  });

  test('--inline writes neither object and keeps ids and values in the steps', () => {
    const inline = convertVbs(recording, { testName: 'recorded: demo', inline: true });
    expect(inline.code).not.toMatch(/CONSTANTS|LOCATORS/);
    expect(inline.preamble).toEqual([]);
    expect(inline.body.join('\n')).toContain("sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR')");
  });
});
