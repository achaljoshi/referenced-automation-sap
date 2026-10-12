import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { convertToPageObjects, convertVbs, createSampleSapSystem, ensureLoggedIn, logonStepLine, parseVbs, SapGuiSession } from '../../src';

/**
 * What a converted test asserts (--expect-text, --expect-title, --expect-status), that the SAP-aware `expect` is always imported, and
 * which session fixture it uses (--fixture sap | loggedInSap | auto): a recording made while already logged on must not start on the
 * logon screen, a recording of the logon must.
 */
const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'dist/cli/convertVbs.js');
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;
const IMPORT_EXPECT = "import { sapExpect as expect } from '@automation/referenced-automation-sap';";

const loggedOn = fs.readFileSync(path.join(root, 'examples/va01_logged_on.vbs'), 'utf8'); // recorded inside SAP: starts with /nVA01
const fromLogon = fs.readFileSync(path.join(root, 'examples/va01_create_order.vbs'), 'utf8'); // recorded from the logon screen
const options = { testName: 'recorded: demo', sourceName: 'demo.vbs' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sapassert-'));
const run = (...args: string[]) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

test.describe('the SAP-aware expect is always imported', () => {
  const simple = 'session.findById("wnd[0]/tbar[0]/okcd").text = "/nSU3"\nsession.findById("wnd[0]").sendVKey 0';

  test('flat, page-object and data-driven tests import it with no assertion option at all - so `await expect(sap.getByText(...)).toExist()` typed by hand works', () => {
    const flat = convertVbs(simple, options).code;
    const pages = convertToPageObjects(simple, { ...options, baseName: 'demo' }).spec;
    const data = convertToPageObjects(simple, { ...options, baseName: 'demo', dataDriven: true }).spec;
    for (const code of [flat, pages, data]) expect(code).toContain(IMPORT_EXPECT);
  });

  test('--expect-import moves it (to your own support module), also when nothing is asserted', () => {
    const code = convertVbs(simple, { ...options, expectImport: './support/sapTest' }).code;
    expect(code).toContain("import { sapExpect as expect } from './support/sapTest';");
    expect(code).not.toContain(IMPORT_EXPECT);
  });

  test('the generated file is valid TypeScript that uses what it imports (the placeholder keeps expect "used")', async () => {
    const { code } = convertVbs(simple, options);
    expect(code).toMatch(/void expect;/);
    // the line is real code: it needs `expect` in scope, which the import provides
    await new AsyncFunction('expect', 'void expect;')(expect);
  });
});

test.describe('--expect-text, --expect-title, --expect-status', () => {
  const asserted = (extra: Record<string, unknown>) => convertVbs(loggedOn, { ...options, ...extra });

  test('expectText writes `await expect(sap.getByText(...).first()).toExist();`, once per text, in the order given', () => {
    const { code } = asserted({ expectText: ['Address', 'Order saved'] });
    expect(code).toContain("await expect(sap.getByText('Address').first()).toExist();");
    expect(code).toContain("await expect(sap.getByText('Order saved').first()).toExist();");
    expect(code.indexOf("'Address'")).toBeLessThan(code.indexOf("'Order saved'"));
  });

  test('a text is quoted, so an apostrophe or backslash cannot break the generated code', () => {
    const { code } = asserted({ expectText: ["Customer's \\ name"] });
    expect(code).toContain("sap.getByText('Customer\\'s \\\\ name').first()");
  });

  test('expectTitle writes `await expect(sap).toHaveTitle(/.../i);` (a pattern containing a slash becomes a RegExp)', () => {
    expect(asserted({ expectTitle: 'Standard Order' }).code).toContain('await expect(sap).toHaveTitle(/Standard Order/i);');
    expect(asserted({ expectTitle: 'Sales/Orders' }).code).toContain("await expect(sap).toHaveTitle(new RegExp('Sales/Orders', 'i'));");
    expect(() => asserted({ expectTitle: '(' })).toThrow(SyntaxError); // a bad pattern fails at conversion time
  });

  test('all three together: text, then title, then status bar - and none of them leaves the TODO or the failing guard behind', () => {
    const { code } = asserted({ expectText: ['Address'], expectTitle: 'Standard Order', expectStatus: 'has been saved' });
    const text = code.indexOf('getByText');
    const title = code.indexOf('toHaveTitle');
    const status = code.indexOf('toHaveStatusMessage');
    expect(text).toBeGreaterThan(0);
    expect(title).toBeGreaterThan(text);
    expect(status).toBeGreaterThan(title);
    expect(code).not.toMatch(/TODO\(converter\)|NO ASSERTION|add an assertion|void expect/);
  });

  test('each one alone satisfies the "no assertion" guard (flat, page objects, data-driven)', () => {
    for (const given of [{ expectText: ['Address'] }, { expectTitle: 'Order' }, { expectStatus: 'saved' }]) {
      const flat = convertVbs(loggedOn, { ...options, ...given }).code;
      const pages = convertToPageObjects(loggedOn, { ...options, baseName: 'demo', ...given }).spec;
      const data = convertToPageObjects(loggedOn, { ...options, baseName: 'demo', dataDriven: true, ...given }).spec;
      for (const code of [flat, pages, data]) {
        expect(code, JSON.stringify(given)).not.toMatch(/TODO\(converter\)|NO ASSERTION|add an assertion|void expect/);
        expect(code, JSON.stringify(given)).toMatch(/await expect\(sap/);
      }
    }
  });

  test('an empty list of texts is no assertion: the guard stays', () => {
    expect(convertVbs(loggedOn, { ...options, expectText: [] }).code).toContain('add an assertion');
  });

  test('page-object and data-driven tests put the assertions inside the test (and inside the per-row loop)', () => {
    const data = convertToPageObjects(loggedOn, { ...options, baseName: 'demo', dataDriven: true, expectText: ['Address'], expectTitle: 'Order' }).spec;
    expect(data).toContain("    await expect(sap.getByText('Address').first()).toExist();");
    expect(data).toContain('    await expect(sap).toHaveTitle(/Order/i);');
  });
});

test.describe('the CLI', () => {
  test('--expect-text is repeatable, --expect-title and --expect-status combine, and with --strict the run still succeeds (they satisfy the guard)', () => {
    const dir = tmp();
    const result = run(path.join(root, 'examples/va01_logged_on.vbs'), '--out', dir, '--strict', '--expect-text', 'Address', '--expect-text', "Customer's name", '--expect-title', 'Standard Order', '--expect-status', 'has been saved');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('no assertion');
    const code = fs.readFileSync(path.join(dir, 'va01_logged_on.spec.ts'), 'utf8');
    expect(code).toContain("await expect(sap.getByText('Address').first()).toExist();");
    expect(code).toContain("await expect(sap.getByText('Customer\\'s name').first()).toExist();");
    expect(code).toContain('await expect(sap).toHaveTitle(/Standard Order/i);');
    expect(code).toContain('await expect(sap).toHaveStatusMessage(/has been saved/i);');
    expect(code).not.toContain('add an assertion');
  });

  for (const flag of [['--expect-text', 'Address'], ['--expect-title', 'Order']]) {
    test(`${flag[0]} alone is enough for --strict, and without any of the three the output says so`, () => {
      const dir = tmp();
      const asserted = run(path.join(root, 'examples/va01_logged_on.vbs'), '--out', dir, '--strict', ...flag);
      expect(asserted.status, asserted.stderr).toBe(0);
      expect(asserted.stdout).not.toContain('no assertion');
      const plain = run(path.join(root, 'examples/va01_logged_on.vbs'), '--out', dir);
      expect(plain.stdout).toContain('no assertion: the test fails until you add one');
    });
  }

  test('the page-object and data-driven modes take the same options', () => {
    const dir = tmp();
    const result = run(path.join(root, 'examples/va01_logged_on.vbs'), '--out', dir, '--data', '--expect-text', 'Address', '--expect-title', 'Order');
    expect(result.status, result.stderr).toBe(0);
    const spec = fs.readFileSync(path.join(dir, 'va01_logged_on.spec.ts'), 'utf8');
    expect(spec).toContain("getByText('Address')");
    expect(spec).toContain('toHaveTitle(/Order/i)');
    expect(spec).toContain('async ({ loggedInSap: sap })');
  });

  test('a missing value or an unknown --fixture is a usage error (exit 2)', () => {
    for (const args of [['--expect-text'], ['--expect-title'], ['--fixture', 'both'], ['--fixture']]) {
      const result = run(path.join(root, 'examples/va01_logged_on.vbs'), ...args);
      expect(result.status, args.join(' ')).toBe(2);
      expect(result.stderr).toContain('Usage:');
    }
  });

  test('--help documents the new options next to --expect-status', () => {
    const help = run('--help').stdout;
    for (const option of ['--expect-status', '--expect-text', '--expect-title', '--fixture']) expect(help).toContain(option);
    expect(help.indexOf('--expect-text')).toBeGreaterThan(help.indexOf('--expect-status'));
    expect(help).toMatch(/--fixture <sap\|loggedInSap\|auto>/);
  });

  test('the npm convert scripts import expect and the pages module from this repo (the package name does not resolve inside its own repo)', () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const name of ['convert', 'convert:pages', 'convert:data']) expect(scripts[name], name).toContain('--expect-import ./support/sapTest');
    for (const name of ['convert:pages', 'convert:data']) expect(scripts[name], name).toContain('--sap-import ../../../src');
    const support = fs.readFileSync(path.join(root, 'tests/sapgui/support/sapTest.ts'), 'utf8');
    expect(support).toMatch(/export \{[^}]*sapExpect[^}]*\}/); // `import { sapExpect as expect } from './support/sapTest'` has to work
  });
});

test.describe('which session fixture the test uses', () => {
  test('a recording made inside SAP (no logon steps) uses loggedInSap: flat, page objects, data-driven', () => {
    expect(convertVbs(loggedOn, options).code).toContain("async ({ loggedInSap: sap }) => {");
    expect(convertToPageObjects(loggedOn, { ...options, baseName: 'demo' }).spec).toContain("async ({ loggedInSap: sap }) => {");
    expect(convertToPageObjects(loggedOn, { ...options, baseName: 'demo', dataDriven: true }).spec).toContain("async ({ loggedInSap: sap }) => {");
    expect(convertVbs(loggedOn, options).fixture).toBe('loggedInSap');
  });

  test('a recording of the logon uses sap: flat, page objects, data-driven', () => {
    expect(convertVbs(fromLogon, options).code).toContain('async ({ sap }) => {');
    expect(convertToPageObjects(fromLogon, { ...options, baseName: 'demo' }).spec).toContain('async ({ sap }) => {');
    expect(convertToPageObjects(fromLogon, { ...options, baseName: 'demo', dataDriven: true }).spec).toContain('async ({ sap }) => {');
    expect(convertVbs(fromLogon, options).fixture).toBe('sap');
  });

  test('the logon is recognised by the logon screen\'s fields, or a password field before anything is typed in SAP - not by a password changed later', () => {
    const line = (vbs: string) => logonStepLine(parseVbs(vbs).steps);
    for (const field of ['txtRSYST-MANDT', 'txtRSYST-BNAME', 'pwdRSYST-BCODE', 'txtRSYST-LANGU'])
      expect(line(`session.findById("wnd[0]/usr/${field}").text = "x"`), field).toBe(1);
    expect(line('session.findById("wnd[0]/usr/pwdSOMETHING").text = "x"')).toBe(1); // a password field and nothing typed in SAP yet
    expect(line('session.findById("/app/con[0]/ses[0]/wnd[0]/usr/txtRSYST-BNAME").text = "x"')).toBe(1); // with the recorder's prefix
    const changePassword = 'session.StartTransaction "SU3"\nsession.findById("wnd[0]/usr/pwdUSR02-BCODE").text = "new"';
    expect(line(changePassword)).toBeUndefined();
    expect(convertVbs(changePassword, options).fixture).toBe('loggedInSap');
    expect(line('session.findById("wnd[0]/tbar[0]/okcd").text = "/nSU3"\nsession.findById("wnd[0]/usr/pwdUSR02-BCODE").text = "new"')).toBeUndefined();
    expect(line('session.findById("wnd[0]").sendVKey 0')).toBeUndefined();
  });

  test('--fixture decides when you know better: sap for a recording without logon, loggedInSap for one with', () => {
    expect(convertVbs(loggedOn, { ...options, fixture: 'sap' }).code).toContain('async ({ sap }) => {');
    expect(convertVbs(loggedOn, { ...options, fixture: 'auto' }).code).toContain('async ({ loggedInSap: sap }) => {');
    expect(convertToPageObjects(loggedOn, { ...options, baseName: 'demo', fixture: 'sap' }).spec).toContain('async ({ sap }) => {');
    const forced = convertVbs(fromLogon, { ...options, fixture: 'loggedInSap' });
    expect(forced.code).toContain('async ({ loggedInSap: sap }) => {');
    // ... but it says that the logon steps will not work there, as a TODO that fails --strict
    const warning = forced.warnings.find((w) => w.message.includes('--fixture loggedInSap'));
    expect(warning?.severity).not.toBe('info');
    expect(forced.code).toContain('--fixture loggedInSap, but the recording logs on itself');
    expect(convertVbs(fromLogon, options).warnings.some((w) => w.message.includes('--fixture'))).toBe(false);
  });

  test('the header says where the logon comes from', () => {
    expect(convertVbs(loggedOn, options).code).toContain('session: loggedInSap (the recording has no logon steps)');
    expect(convertVbs(fromLogon, options).code).toContain('session: sap (the recording contains the logon)');
    expect(convertVbs(loggedOn, { ...options, fixture: 'sap' }).code).toContain('session: sap (--fixture sap)');
  });

  test('CLI: --fixture, and the output names the fixture chosen', () => {
    const dir = tmp();
    const auto = run(path.join(root, 'examples/va01_logged_on.vbs'), '--out', dir);
    expect(auto.stdout).toContain('session fixture: loggedInSap');
    const forced = run(path.join(root, 'examples/va01_logged_on.vbs'), '--out', dir, '--fixture', 'sap');
    expect(forced.stdout).toContain('session fixture: sap');
    expect(fs.readFileSync(path.join(dir, 'va01_logged_on.spec.ts'), 'utf8')).toContain('async ({ sap }) => {');
    expect(run(path.join(root, 'examples/va01_create_order.vbs'), '--out', dir, '--fixture', 'loggedInSap', '--strict').status).toBe(1);
  });
});

test.describe('a recording made while logged on, run the way the generated test runs it', () => {
  const FAST = { timeoutMs: 600, pollMs: 10 };
  const env = { get: (key: string, fallback?: string) => fallback };
  const generated = convertVbs(loggedOn, options);

  test('with sap on a fresh connection (the logon screen) it fails to find the command field - the problem loggedInSap solves', async () => {
    const sap = await SapGuiSession.attach(createSampleSapSystem({ transitionDelayMs: 10 }), FAST);
    const failure = (await new AsyncFunction('sap', 'env', [...generated.preamble, ...generated.body].join('\n'))(sap, env).catch((e: unknown) => e)) as Error;
    expect(failure.message).toContain('wnd[0]/tbar[0]/okcd');
    expect(failure.message).toContain('not found');
  });

  test('after loggedInSap\'s logon it creates the order', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 10 });
    const sap = await SapGuiSession.attach(fake, { timeoutMs: 5_000, pollMs: 10 });
    await ensureLoggedIn(sap, { client: '100', user: 'TESTUSER', password: 'correct-horse', language: 'EN' });
    await new AsyncFunction('sap', 'env', [...generated.preamble, ...generated.body].join('\n'))(sap, env);
    expect(fake.currentScreen).toBe('saved');
    expect(fake.sample.created).toHaveLength(1);
  });

  test('the committed generated example (it runs in this suite through sapFakeTest) is exactly what the converter writes', () => {
    const regenerated = convertVbs(loggedOn, {
      testName: 'recorded: va01_logged_on',
      sourceName: 'examples/va01_logged_on.vbs',
      testImport: './sapFakeTest',
      tag: '@sapgui-sample',
      expectStatus: 'has been saved',
      expectTitle: 'Standard Order: Overview',
      expectImport: '../../src',
    }).code;
    expect(fs.readFileSync(path.join(root, 'tests/gui/va01_logged_on.spec.ts'), 'utf8')).toBe(regenerated);
  });
});

test.describe('docs', () => {
  test('the README and the guide document the new converter options next to --expect-status', () => {
    for (const file of ['README.md', 'docs/SAP_GUI_GUIDE.md']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      for (const option of ['--expect-text', '--expect-title', '--expect-status', '--fixture']) expect(text, `${file} ${option}`).toContain(option);
      expect(text, file).toContain('loggedInSap');
    }
  });
});
