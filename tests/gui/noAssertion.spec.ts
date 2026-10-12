import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { assertionLines, convertToPageObjects, convertVbs } from '../../src';

/**
 * ORC-03: a converted recording only performs actions, so it passes whenever SAP does not throw - it proves nothing about the
 * business result. The converter says so in the file, and the test fails until a human replaces the placeholder with a check.
 */
const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'dist/cli/convertVbs.js');
const recording = path.join(root, 'examples/va01_create_order.vbs');
const vbs = 'session.findById("wnd[0]/usr/txtA").text = "x"\nsession.findById("wnd[0]").sendVKey 0';
const options = { testName: 'recorded: demo', sourceName: 'demo.vbs' };
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;

test.describe('a converted test without an assertion', () => {
  test('says so in the header and at the end, and ends with a guard that fails', () => {
    const { code } = convertVbs(vbs, options);
    expect(code).toContain(' *  - NO ASSERTION: this test only performs the recorded actions');
    expect(code).toContain('// TODO(converter): no assertion');
    expect(code).toMatch(/throw new Error\('add an assertion: TODO\(converter\): no assertion/);
    expect(code.indexOf('sendVKey(0)')).toBeLessThan(code.indexOf('throw new Error'));
  });

  test('the guard really fails when the generated lines run (negative control for the converted example passing silently)', async () => {
    await expect(new AsyncFunction('expect', assertionLines({}).join('\n'))(expect)).rejects.toThrow(/add an assertion/);
  });

  test('page-object mode does the same', () => {
    const { spec } = convertToPageObjects(vbs, { ...options, baseName: 'demo' });
    expect(spec).toContain(' *  - NO ASSERTION');
    expect(spec).toContain('// TODO(converter): no assertion');
    expect(spec).toContain("throw new Error('add an assertion");
  });

  test('noAssertion: "todo" keeps the TODO and the header note but leaves the guard out', () => {
    const { code } = convertVbs(vbs, { ...options, noAssertion: 'todo' });
    expect(code).toContain('// TODO(converter): no assertion');
    expect(code).toContain('NO ASSERTION');
    expect(code).not.toContain('throw new Error');
  });

  test('the SAP-aware expect is imported even without an assertion, and kept "used" so the import is never reported as unused', async () => {
    for (const noAssertion of ['fail', 'todo'] as const) {
      const flat = convertVbs(vbs, { ...options, noAssertion }).code;
      const pages = convertToPageObjects(vbs, { ...options, baseName: 'demo', noAssertion }).spec;
      for (const code of [flat, pages]) {
        expect(code).toContain("import { sapExpect as expect } from '@automation/referenced-automation-sap';");
        expect(code).toContain('void expect;');
      }
    }
    // the placeholder line really references expect: without the import it would be a ReferenceError, with it nothing happens
    await new AsyncFunction('expect', assertionLines({ noAssertion: 'todo' }).join('\n'))(expect);
    await expect(new AsyncFunction(assertionLines({ noAssertion: 'todo' }).join('\n'))()).rejects.toThrow(/expect is not defined/);
  });

  test('expectStatus writes the assertion instead: no TODO, no guard, the matcher imported', () => {
    const { code } = convertVbs(vbs, { ...options, expectStatus: 'has been saved' });
    expect(code).toContain('await expect(sap).toHaveStatusMessage(/has been saved/i);');
    expect(code).toContain("import { sapExpect as expect } from '@automation/referenced-automation-sap';");
    expect(code).not.toMatch(/TODO\(converter\)|NO ASSERTION|throw new Error|void expect/);
    expect(() => convertVbs(vbs, { ...options, expectStatus: '(' })).toThrow(SyntaxError); // a bad pattern fails at conversion time
  });

  test('the generated body (the statements) is unchanged: only the file gets the assertion lines', () => {
    expect(convertVbs(vbs, options).body.join('\n')).not.toContain('assertion');
  });
});

test.describe('the converter CLI: --strict by default in the npm scripts', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;

  test('convert, convert:pages and convert:data all pass --strict', () => {
    for (const name of ['convert', 'convert:pages', 'convert:data']) expect(scripts[name], name).toContain('--strict');
  });

  test('--strict is not tripped by the note that a secret was replaced (the converter doing its job), but is by real TODOs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapstrict-'));
    const ok = spawnSync('node', [cli, recording, '--out', dir, '--strict'], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('was replaced with env SAP_PASSWORD'); // still reported
    const src = path.join(dir, 'logic.vbs');
    fs.writeFileSync(src, 'If x = 1 Then\n  session.findById("wnd[0]").sendVKey 3\nEnd If\n');
    expect(spawnSync('node', [cli, src, '--strict'], { encoding: 'utf8' }).status).toBe(1);
  });

  test('without --expect-status the output says that the test has no assertion and will fail; --allow-no-assertion and --expect-status change that', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapassert-'));
    const plain = execFileSync('node', [cli, recording, '--out', dir], { encoding: 'utf8' });
    expect(plain).toContain('no assertion: the test fails until you add one');
    expect(plain).toContain('--expect-text, --expect-title or --expect-status');
    expect(fs.readFileSync(path.join(dir, 'va01_create_order.spec.ts'), 'utf8')).toContain('throw new Error');

    execFileSync('node', [cli, recording, '--out', dir, '--allow-no-assertion']);
    expect(fs.readFileSync(path.join(dir, 'va01_create_order.spec.ts'), 'utf8')).not.toContain('throw new Error');

    const asserted = execFileSync('node', [cli, recording, '--out', dir, '--expect-status', 'has been saved'], { encoding: 'utf8' });
    expect(asserted).not.toContain('no assertion');
    expect(fs.readFileSync(path.join(dir, 'va01_create_order.spec.ts'), 'utf8')).toContain('toHaveStatusMessage(/has been saved/i)');
  });

  test('the committed generated examples carry a real assertion (they run in the suite and must be able to fail)', () => {
    for (const file of ['tests/gui/va01_create_order.spec.ts', 'tests/gui/generated/va01_create_order.spec.ts', 'tests/gui/va01_logged_on.spec.ts']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      expect(text, file).toContain('toHaveStatusMessage(/has been saved/i)');
      expect(text, file).not.toContain('TODO(converter)');
    }
  });
});
