import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect as pw, test } from '@playwright/test';
import { captureContract, contractPath, diffContracts, FakeSapGui, loadContract, sapExpect as expect, saveContract, SapGuiSession, type FakeElementSpec } from '../../src';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sapcontract-'));

type Elements = Record<string, FakeElementSpec>;
const base: Elements = {
  'wnd[0]': { type: 'GuiMainWindow' },
  'wnd[0]/usr': { type: 'GuiUserArea' },
  'wnd[0]/usr/ctxtKUAGV-KUNNR': { type: 'GuiCTextField', props: { text: 'C-1000', leftLabel: 'Sold-To Party' } },
  'wnd[0]/usr/lblKUNNR': { type: 'GuiLabel', props: { text: 'Sold-To Party' } },
  'wnd[0]/usr/btnSAVE': { type: 'GuiButton', props: { text: 'Save' } },
  'wnd[0]/usr/tblORD': { type: 'GuiTableControl' },
  'wnd[0]/usr/tblORD/txtQTY[3,0]': { type: 'GuiTextField', props: { text: '5' } },
  'wnd[0]/sbar': { type: 'GuiStatusbar' },
};

async function screen(elements: Elements) {
  const fake = new FakeSapGui({ start: 's', screens: [{ name: 's', context: { transaction: 'VA01', program: 'SAPMV45A', screen: '4001' }, elements }] });
  return SapGuiSession.attach(fake, { timeoutMs: 1000, pollMs: 10 });
}
const without = (...ids: string[]): Elements => Object.fromEntries(Object.entries(base).filter(([id]) => !ids.includes(id)));

test.describe('capturing a contract', () => {
  test('records ids and types, and the caption of fixed-text controls - never the value of an input field', async () => {
    const contract = await captureContract(await screen(base), 'va01-overview');
    expect(contract).toMatchObject({ name: 'va01-overview', context: { transaction: 'VA01', program: 'SAPMV45A', screen: '4001' } });
    const byId = Object.fromEntries(contract.controls.map((c) => [c.id, c]));
    expect(byId['wnd[0]/usr/btnSAVE']).toEqual({ id: 'wnd[0]/usr/btnSAVE', type: 'GuiButton', text: 'Save' });
    expect(byId['wnd[0]/usr/lblKUNNR']?.text).toBe('Sold-To Party');
    expect(byId['wnd[0]/usr/ctxtKUAGV-KUNNR']).toEqual({ id: 'wnd[0]/usr/ctxtKUAGV-KUNNR', type: 'GuiCTextField' }); // 'C-1000' is data, not structure
    expect(JSON.stringify(contract)).not.toContain('C-1000');
  });

  test('table and list cell positions are left out by default (they change with scrolling and data)', async () => {
    const contract = await captureContract(await screen(base), 'x');
    expect(contract.controls.some((c) => c.id.includes('[3,0]'))).toBe(false);
    expect(contract.controls.some((c) => c.id === 'wnd[0]/usr/tblORD')).toBe(true);
  });

  test('custom ignore patterns', async () => {
    const contract = await captureContract(await screen(base), 'x', { ignore: [/btn/] });
    expect(contract.controls.some((c) => c.id.includes('btnSAVE'))).toBe(false);
  });

  test('controls are sorted, so the saved file diffs cleanly in code review', async () => {
    const ids = (await captureContract(await screen(base), 'x')).controls.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });
});

test.describe('files', () => {
  test('save and load round-trip; the name cannot escape the folder', async () => {
    const dir = tmp();
    const contract = await captureContract(await screen(base), 'va01-overview');
    const file = saveContract(dir, contract);
    expect(path.basename(file)).toBe('va01-overview.contract.json');
    expect(loadContract(dir, 'va01-overview')).toEqual(contract);
    expect(loadContract(dir, 'other')).toBeUndefined();
    expect(() => contractPath(dir, '../evil')).toThrow(/may only contain/);
  });
});

test.describe('diffing', () => {
  const capture = async (e: Elements) => captureContract(await screen(e), 'c');

  test('identical screens: no differences (negative control)', async () => {
    const diff = diffContracts(await capture(base), await capture(base));
    expect(diff).toMatchObject({ removed: [], added: [], typeChanged: [], textChanged: [], breaking: false });
  });

  test('a removed control is breaking', async () => {
    const diff = diffContracts(await capture(base), await capture(without('wnd[0]/usr/btnSAVE')));
    expect(diff.removed.map((c) => c.id)).toEqual(['wnd[0]/usr/btnSAVE']);
    expect(diff.breaking).toBe(true);
  });

  test('a retyped control is breaking', async () => {
    const diff = diffContracts(await capture(base), await capture({ ...base, 'wnd[0]/usr/btnSAVE': { type: 'GuiToolbarButton', props: { text: 'Save' } } }));
    expect(diff.typeChanged).toEqual([{ id: 'wnd[0]/usr/btnSAVE', was: 'GuiButton', now: 'GuiToolbarButton' }]);
    expect(diff.breaking).toBe(true);
  });

  test('an added control or a changed caption is not breaking, but is reported', async () => {
    const changed = { ...base, 'wnd[0]/usr/btnSAVE': { type: 'GuiButton', props: { text: 'Save order' } }, 'wnd[0]/usr/txtNEW': { type: 'GuiTextField' } };
    const diff = diffContracts(await capture(base), await capture(changed));
    expect(diff.breaking).toBe(false);
    expect(diff.added.map((c) => c.id)).toEqual(['wnd[0]/usr/txtNEW']);
    expect(diff.textChanged).toEqual([{ id: 'wnd[0]/usr/btnSAVE', was: 'Save', now: 'Save order' }]);
  });

  test('suggests where a removed control went: moved to another container, or renamed with the same caption', async () => {
    const moved = { ...without('wnd[0]/usr/btnSAVE'), 'wnd[0]/usr/subHEADER/btnSAVE': { type: 'GuiButton', props: { text: 'Save' } } };
    expect(diffContracts(await capture(base), await capture(moved)).suggestions).toEqual([{ was: 'wnd[0]/usr/btnSAVE', maybeNow: 'wnd[0]/usr/subHEADER/btnSAVE' }]);
    const renamed = { ...without('wnd[0]/usr/btnSAVE'), 'wnd[0]/usr/btnSAVE2': { type: 'GuiButton', props: { text: 'Save' } } };
    expect(diffContracts(await capture(base), await capture(renamed)).suggestions).toEqual([{ was: 'wnd[0]/usr/btnSAVE', maybeNow: 'wnd[0]/usr/btnSAVE2' }]);
  });
});

test.describe('toMatchScreenContract', () => {
  const opts = (dir: string) => ({ dir });

  test('without a baseline it fails and says how to create one - a missing contract is never a pass', async () => {
    const sap = await screen(base);
    const error = await expect(sap).toMatchScreenContract('va01', opts(tmp())).catch((e: unknown) => e as Error);
    pw((error as Error).message).toContain('There is no screen contract "va01"');
    pw((error as Error).message).toContain('SAP_GUI_UPDATE_CONTRACTS=true');
  });

  test('update mode writes the baseline; the next run matches it', async () => {
    const dir = tmp();
    await expect(await screen(base)).toMatchScreenContract('va01', { dir, update: true });
    pw(fs.existsSync(contractPath(dir, 'va01'))).toBe(true);
    await expect(await screen(base)).toMatchScreenContract('va01', opts(dir));
  });

  test('a control that disappeared fails the assertion with what is gone and where it probably went', async () => {
    const dir = tmp();
    await expect(await screen(base)).toMatchScreenContract('va01', { dir, update: true });
    const moved = { ...without('wnd[0]/usr/btnSAVE'), 'wnd[0]/usr/subHEADER/btnSAVE': { type: 'GuiButton', props: { text: 'Save' } } };
    const error = (await expect(await screen(moved)).toMatchScreenContract('va01', opts(dir)).catch((e: unknown) => e)) as Error;
    pw(error.message).toContain('GONE - tests using these will fail');
    pw(error.message).toContain('wnd[0]/usr/btnSAVE');
    pw(error.message).toContain('Probably moved');
    pw(error.message).toContain('wnd[0]/usr/subHEADER/btnSAVE');
    pw(error.message).toContain('SAP_GUI_UPDATE_CONTRACTS=true');
  });

  test('additions and changed captions pass by default and fail with strict: true', async () => {
    const dir = tmp();
    await expect(await screen(base)).toMatchScreenContract('va01', { dir, update: true });
    const changed = { ...base, 'wnd[0]/usr/txtNEW': { type: 'GuiTextField' } };
    await expect(await screen(changed)).toMatchScreenContract('va01', opts(dir));
    await expect(expect(await screen(changed)).toMatchScreenContract('va01', { dir, strict: true })).rejects.toThrow(/New on the screen/);
  });

  test('table cell noise does not fail the contract', async () => {
    const dir = tmp();
    await expect(await screen(base)).toMatchScreenContract('va01', { dir, update: true });
    const scrolled = { ...base, 'wnd[0]/usr/tblORD/txtQTY[3,5]': { type: 'GuiTextField' }, 'wnd[0]/usr/tblORD/txtQTY[3,6]': { type: 'GuiTextField' } };
    await expect(await screen(scrolled)).toMatchScreenContract('va01', opts(dir));
  });

  test('SAP_GUI_CONTRACTS_DIR / SAP_GUI_UPDATE_CONTRACTS are honoured', async () => {
    const dir = tmp();
    process.env.SAP_GUI_CONTRACTS_DIR = dir;
    process.env.SAP_GUI_UPDATE_CONTRACTS = 'true';
    try {
      await expect(await screen(base)).toMatchScreenContract('from-env');
    } finally {
      delete process.env.SAP_GUI_CONTRACTS_DIR;
      delete process.env.SAP_GUI_UPDATE_CONTRACTS;
    }
    pw(fs.existsSync(contractPath(dir, 'from-env'))).toBe(true);
  });

  test('the same two settings in a .env.<name> file count too (every setting comes through the shared config, not only the process environment)', async () => {
    const work = tmp();
    const dir = path.join(work, 'baselines');
    fs.writeFileSync(path.join(work, '.env.contractdocs'), `SAP_GUI_CONTRACTS_DIR=${dir.replace(/\\/g, '/')}\nSAP_GUI_UPDATE_CONTRACTS=true\n`);
    const savedEnv = process.env.ENV;
    const savedCwd = process.cwd();
    process.env.ENV = 'contractdocs';
    process.chdir(work);
    try {
      await expect(await screen(base)).toMatchScreenContract('from-env-file');
    } finally {
      process.chdir(savedCwd);
      if (savedEnv === undefined) delete process.env.ENV;
      else process.env.ENV = savedEnv;
    }
    pw(fs.existsSync(contractPath(dir, 'from-env-file'))).toBe(true);
  });
});

test.describe('sap-gui-contracts CLI (against the built-in simulator)', () => {
  const cli = path.resolve(__dirname, '../../dist/cli/contracts.js');
  const run = (args: string[], dir: string) => spawnSync('node', [cli, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, SAP_GUI_SIMULATOR: 'true', LOG_LEVEL: 'error' } });

  test('capture then check: matches; after editing the saved baseline to expect a control that is not there, check fails with exit 1', () => {
    const dir = tmp();
    const captured = run(['capture', 'logon'], dir);
    pw(captured.status).toBe(0);
    pw(captured.stdout).toContain('saved');

    pw(run(['check', 'logon'], dir).status).toBe(0);

    const file = contractPath(dir, 'logon');
    const contract = JSON.parse(fs.readFileSync(file, 'utf8')) as { controls: Array<{ id: string; type: string }> };
    contract.controls.push({ id: 'wnd[0]/usr/txtGONE', type: 'GuiTextField' });
    fs.writeFileSync(file, JSON.stringify(contract));
    const failed = run(['check', 'logon'], dir);
    pw(failed.status).toBe(1);
    pw(failed.stdout).toContain('wnd[0]/usr/txtGONE');
  });

  test('check without a baseline says how to create one', () => {
    const result = run(['check', 'nothing'], tmp());
    pw(result.status).toBe(2);
    pw(result.stderr).toContain('sap-gui-contracts capture nothing');
  });

  test('diff compares two files with no SAP at all', async () => {
    const dir = tmp();
    const a = saveContract(dir, await captureContract(await screen(base), 'a'));
    const b = saveContract(dir, await captureContract(await screen(without('wnd[0]/usr/btnSAVE')), 'b'));
    const result = spawnSync('node', [cli, 'diff', a, b], { encoding: 'utf8' });
    pw(result.status).toBe(1);
    pw(result.stdout).toContain('wnd[0]/usr/btnSAVE');
  });

  test('without SAP_GUI_SIMULATOR on a non-Windows machine it refuses with an explanation instead of crashing', () => {
    if (process.platform === 'win32') test.skip();
    const result = spawnSync('node', [cli, 'capture', 'x', '--dir', tmp()], { encoding: 'utf8', env: { ...process.env, SAP_GUI_SIMULATOR: 'false' } });
    pw(result.status).toBe(2);
    pw(result.stderr).toContain('Windows COM API');
  });
});
