import { expect, test } from '@playwright/test';
import { convertToPageObjects, convertVbs, parseVbs, redactSource } from '../../src';

/**
 * SEC-05: a recording contains whatever was typed - passwords, PINs, one-time codes, tokens - and a generated test is
 * committed. Every place a literal can end up (a variable that later flows into a field, a PIN field, a comment copied from an
 * unsupported line, a With block the converter did not understand) has to keep it out.
 */
const options = { testName: 'recorded: demo', sourceName: 'demo.vbs', inline: true };
const both = (vbs: string) => {
  const flat = convertVbs(vbs, options);
  const pages = convertToPageObjects(vbs, { testName: 'recorded: demo', baseName: 'demo', sourceName: 'demo.vbs' });
  return { flat, pages, all: [flat.code, pages.spec, pages.pages.code].join('\n\n') };
};

test.describe('a value that flows into a secret field', () => {
  const vbs = `pw = "Sup3r-Secret!"
session.findById("wnd[0]/usr/pwdRSYST-BCODE").text = pw
session.findById("wnd[0]").sendVKey 0`;

  test('the variable assigned the literal is read from the environment instead (flat and page-object output)', () => {
    const { flat, all } = both(vbs);
    expect(all).not.toContain('Sup3r-Secret!');
    expect(flat.body[0]).toBe("let pw = env.get('SAP_PASSWORD'); // vbs:1");
    expect(flat.envVars).toContain('SAP_PASSWORD');
    expect(flat.warnings.some((w) => w.message.includes('"pw"') && w.severity === 'info')).toBe(true);
  });

  test('through several variables and a concatenation', () => {
    const { all } = both(`base = "Sup3r"
mid = base & "-Secret"
final = mid
session.findById("wnd[0]/usr/pwdRSYST-BCODE").text = final & "!"`);
    expect(all).not.toMatch(/Sup3r|-Secret/);
  });

  test('a literal concatenated straight into a secret field is replaced as a whole', () => {
    const { all } = both(`session.findById("wnd[0]/usr/pwdRSYST-BCODE").text = "abc" & "123"`);
    expect(all).not.toMatch(/abc|123/);
    expect(all).toContain('SAP_PASSWORD');
  });

  test('negative control: a variable that only goes into an ordinary field keeps its value', () => {
    const { flat } = both(`customer = "1000"
session.findById("wnd[0]/usr/ctxtKUAGV-KUNNR").text = customer`);
    expect(flat.body[0]).toContain("let customer = '1000'");
    expect(flat.envVars).toEqual([]);
  });
});

test.describe('PIN, token and one-time-code fields', () => {
  for (const [field, env] of [
    ['wnd[0]/usr/txtZ_PIN', 'SAP_PIN'],
    ['wnd[0]/usr/txtZLOGIN-OTP', 'SAP_OTP'],
    ['wnd[0]/usr/txtZ_ACCESS_TOKEN', 'SAP_TOKEN'],
    ['wnd[0]/usr/txtZAUTH-SECRET', 'SAP_SECRET'],
  ] as const) {
    test(`${field.split('/').pop()} is read from ${env}, as a string or a number`, () => {
      const { all, flat } = both(`session.findById("${field}").text = "483921"
session.findById("${field}").text = 483921`);
      expect(all).not.toContain('483921');
      expect(flat.envVars).toEqual([env]);
    });
  }

  test('names are judged by their words: a spinner or a mapping is not a PIN', () => {
    const { flat } = both(`session.findById("wnd[0]/usr/txtSPINNER").text = "12"
mapping = "x"`);
    expect(flat.envVars).toEqual([]);
    expect(flat.body[0]).toContain("'12'");
  });

  test('a secret field reached through another property is replaced too', () => {
    const { all } = both(`session.findById("wnd[0]/usr/txtZ_PIN").value = "1234"`);
    expect(all).not.toContain('1234');
  });
});

test.describe('assignments whose NAME is secret-like', () => {
  test('x = "literal" becomes an environment read, with Const and numbers too', () => {
    const { all, flat } = both(`password = "abc123XYZ"
Const API_TOKEN = "tok-9f8e7d"
pin = 4711
userName = "JDOE"`);
    expect(all).not.toMatch(/abc123XYZ|tok-9f8e7d|4711/);
    expect(flat.body.join('\n')).toContain("let password = env.get('SAP_PASSWORD')");
    expect(flat.body.join('\n')).toContain("let API_TOKEN = env.get('SAP_TOKEN')");
    expect(flat.body.join('\n')).toContain("let pin = env.get('SAP_PIN')");
    expect(flat.body.join('\n')).toContain("let userName = 'JDOE'"); // not secret
  });
});

test.describe('literals of unsupported lines copied into comments', () => {
  test('are redacted when the line handles a secret, and the id stays so the line can be repaired', () => {
    const { all } = both(`If retry Then session.findById("wnd[0]/usr/pwdRSYST-BCODE").text = "Sup3r-Secret!"
session.findById("wnd[0]/usr/txtZ_OTP").text = "12" & x(1)
Dim s: s = Left("A-very-long-secret-value", 3)`);
    expect(all).not.toContain('Sup3r-Secret!');
    expect(all).not.toContain('A-very-long-secret-value');
    expect(all).toContain('wnd[0]/usr/pwdRSYST-BCODE'); // the control id is not a secret
    expect(all).toContain('[REDACTED]');
  });

  test('also in the conversion warnings that end up in the file header and on the console', () => {
    const { warnings } = parseVbs(`session.findById("wnd[0]/usr/txtZ_TOKEN").text = Mid("tok-secret-1", 1, 3)`);
    expect(JSON.stringify(warnings)).not.toContain('tok-secret-1');
  });

  test('a literal shaped like a JWT is redacted wherever it appears', () => {
    expect(redactSource('foo "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc" bar')).toBe('foo "[REDACTED]" bar');
  });

  test('negative control: an unsupported line about an ordinary field keeps its literals (that is what the human needs)', () => {
    const { flat } = both(`If x = 1 Then session.findById("wnd[0]/usr/txtZ_CITY").text = "Berlin"`);
    expect(flat.code).toContain('"Berlin"');
  });
});

test.describe('a With block on a target the converter cannot resolve', () => {
  const vbs = `With someObject
  .text = "Sup3r-Secret!"
  .press
End With
session.findById("wnd[0]/usr/txtA").text = "after"`;

  test('every statement inside is unsupported - nothing is resolved against the session', () => {
    const { steps } = parseVbs(vbs);
    expect(steps.filter((s) => s.kind === 'unsupported')).toHaveLength(4); // With, .text, .press, End With
    expect(steps.filter((s) => s.kind === 'set' || s.kind === 'call')).toEqual([expect.objectContaining({ kind: 'set', id: 'wnd[0]/usr/txtA' })]);
  });

  test('the typed value in there is redacted (the target could be a password field) and nothing is emitted against ""', () => {
    const { all, flat } = both(vbs);
    expect(all).not.toContain('Sup3r-Secret!');
    expect(flat.body.join('\n')).not.toMatch(/sap\.setText\(''|sap\.call\(''/);
    expect(flat.warnings.some((w) => w.message.includes('With block was not converted'))).toBe(true);
  });

  test('nested With blocks inside it stay unsupported until the matching End With', () => {
    const { steps } = parseVbs(`With someObject
  With session.findById("wnd[0]")
    .sendVKey 0
  End With
  .press
End With
session.findById("wnd[0]").sendVKey 3`);
    expect(steps.filter((s) => s.kind === 'call')).toEqual([expect.objectContaining({ method: 'sendVKey', args: [{ kind: 'number', value: 3 }] })]);
  });

  test('negative control: a With on a known target still converts, including With session and With <element variable>', () => {
    const { steps } = parseVbs(`With session
  .findById("wnd[0]").maximize
End With
Set btn = session.findById("wnd[0]/tbar[0]/btn[11]")
With btn
  .press
End With
With session.findById("wnd[0]/usr")
  .findById("txtA").text = "x"
End With`);
    expect(steps.filter((s) => s.kind === 'unsupported')).toEqual([]);
    expect(steps.map((s) => (s.kind === 'call' || s.kind === 'set' ? `${s.id}:${'method' in s ? s.method : s.prop}` : s.kind))).toEqual(['wnd[0]:maximize', 'wnd[0]/tbar[0]/btn[11]:press', 'wnd[0]/usr/txtA:text']);
  });
});
