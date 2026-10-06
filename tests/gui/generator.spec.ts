import { expect, test } from '@playwright/test';
import { convertVbs } from '../../src';

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => unknown;
const options = { testName: 'recorded: demo', sourceName: 'demo.vbs' };

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
