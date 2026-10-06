import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { convertVbs, createSampleSapSystem, SapGuiSession } from '../../src';

const root = path.resolve(__dirname, '../..');
const recording = path.join(root, 'examples/va01_create_order.vbs');
const cli = path.join(root, 'dist/cli/convertVbs.js');
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (sap: SapGuiSession, env: unknown) => Promise<void>;

const sampleEnv = (values: Record<string, string>) => ({ get: (key: string, fallback?: string) => values[key] ?? fallback });

test.describe('a recording, converted, runs to completion', () => {
  test('the generated statements execute against the simulated SAP and create the order', async () => {
    const { body } = convertVbs(fs.readFileSync(recording, 'utf8'), { testName: 'e2e' });
    const fake = createSampleSapSystem({ transitionDelayMs: 100 });
    const sap = await SapGuiSession.attach(fake, { timeoutMs: 5_000, pollMs: 10 });

    // executing exactly the generated lines - the same code the spec file contains
    await new AsyncFunction('sap', 'env', body.join('\n'))(sap, sampleEnv({ SAP_PASSWORD: 'correct-horse' }));

    expect(fake.currentScreen).toBe('saved');
    expect(await sap.statusBarText()).toBe('Standard Order 4711 has been saved');
    expect(fake.calls).toContainEqual({
      op: 'set',
      id: 'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]',
      name: 'text',
      args: ['TG11'],
    });
  });

  test('a run with the wrong password stops at the logon screen and says why', async () => {
    const { body } = convertVbs(fs.readFileSync(recording, 'utf8'), { testName: 'e2e' });
    const fake = createSampleSapSystem({ transitionDelayMs: 20 });
    const sap = await SapGuiSession.attach(fake, { timeoutMs: 500, pollMs: 10 });

    const failure = await new AsyncFunction('sap', 'env', body.join('\n'))(sap, sampleEnv({ SAP_PASSWORD: 'wrong' })).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('not found');
    // the failure names the logon error rather than leaving someone to guess
    expect((failure as Error).message).toContain('Name or password is incorrect');
  });

  test('the committed spec is exactly what the converter produces from the committed recording', () => {
    const regenerated = convertVbs(fs.readFileSync(recording, 'utf8'), {
      testName: 'recorded: va01_create_order',
      sourceName: 'examples/va01_create_order.vbs',
      testImport: './sapFakeTest',
      tag: '@sapgui-sample',
    }).code;
    expect(fs.readFileSync(path.join(root, 'tests/gui/va01_create_order.spec.ts'), 'utf8')).toBe(regenerated);
  });
});

test.describe('sap-vbs-to-playwright CLI', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sapvbs-'));

  test('converts a file, writes <name>.spec.ts, and never prints or writes the password', () => {
    const dir = tmp();
    const out = execFileSync('node', [cli, recording, '--out', dir], { encoding: 'utf8' });
    const written = fs.readFileSync(path.join(dir, 'va01_create_order.spec.ts'), 'utf8');
    expect(out).toContain('va01_create_order.spec.ts');
    expect(written).not.toContain('correct-horse');
    expect(out).not.toContain('correct-horse');
  });

  test('converts a whole folder', () => {
    const input = tmp();
    const output = tmp();
    fs.copyFileSync(recording, path.join(input, 'a.vbs'));
    fs.copyFileSync(recording, path.join(input, 'b.vbs'));
    execFileSync('node', [cli, input, '--out', output]);
    expect(fs.readdirSync(output).sort()).toEqual(['a.spec.ts', 'b.spec.ts']);
  });

  test('--param reads a field from the environment instead of embedding it', () => {
    const dir = tmp();
    execFileSync('node', [cli, recording, '--out', dir, '--param', 'VKORG=SALES_ORG']);
    expect(fs.readFileSync(path.join(dir, 'va01_create_order.spec.ts'), 'utf8')).toContain("env.get('SALES_ORG', '1000')");
  });

  test('--strict exits non-zero when something needs manual attention, and still writes the file', () => {
    const dir = tmp();
    const src = path.join(dir, 'logic.vbs');
    fs.writeFileSync(src, 'If x = 1 Then\n  session.findById("wnd[0]").sendVKey 3\nEnd If\n');
    const result = spawnSync('node', [cli, src, '--strict'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(dir, 'logic.spec.ts'))).toBe(true);
  });

  test('without --strict the same input succeeds but reports the TODO', () => {
    const dir = tmp();
    const src = path.join(dir, 'logic.vbs');
    fs.writeFileSync(src, 'If x = 1 Then\n  session.findById("wnd[0]").sendVKey 3\nEnd If\n');
    const result = spawnSync('node', [cli, src], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('was not converted');
  });

  test('usage errors exit 2 with the usage text', () => {
    const result = spawnSync('node', [cli, '--nope'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });
});
