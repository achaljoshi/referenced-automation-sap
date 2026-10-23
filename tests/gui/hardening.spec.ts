import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect as pw, test } from '@playwright/test';
import {
  attachDiagnostics,
  BRIDGE_SCRIPT,
  bridgeInvocation,
  captureContract,
  dpapiSecrets,
  FakeSapGui,
  sapExpect as expect,
  SapConnection,
  SapGuiSession,
  storeDpapiSecret,
  type SapGuiTransport,
} from '../../src';
import { FAST, demoSession } from './support';

const root = path.resolve(__dirname, '../..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saphard-'));

/** Sets environment variables for one test and puts them back. */
async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    await run();
  } finally {
    apply(saved);
  }
}

test.describe('SAP-01: one SAP window, one worker', () => {
  // the config is TypeScript loaded through Playwright's transform; evaluate it afresh for each environment
  const loadConfig = (env: Record<string, string | undefined>) => {
    const file = require.resolve('../../playwright.config');
    let config: { workers?: unknown; fullyParallel?: unknown } = {};
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    return withEnv(env, () => {
      delete require.cache[file];
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      config = require(file).default;
    }).then(() => {
      console.warn = warn;
      return { config, warnings };
    });
  };
  // ENV=example: the committed .env.example says SAP_GUI_MODE=attach (the repo's .env.dev says open, where workers are honoured)
  // (the warning is printed by the main Playwright process only, which has no TEST_WORKER_INDEX)
  const clean = { ENV: 'example', SAP_GUI_SIMULATOR: undefined, SAP_GUI_MODE: undefined, WORKERS: undefined, TEST_WORKER_INDEX: undefined };

  test('the default (attach, real SAP) is one worker and no fully-parallel files', async () => {
    const { config, warnings } = await loadConfig(clean);
    pw(config.workers).toBe(1);
    pw(config.fullyParallel).toBe(false);
    pw(warnings).toEqual([]);
  });

  test('WORKERS=4 is ignored in attach mode - with a log line that says so', async () => {
    const { config, warnings } = await loadConfig({ ...clean, WORKERS: '4' });
    pw(config.workers).toBe(1);
    pw(warnings.join('\n')).toMatch(/WORKERS=4 ignored.*attach/);
  });

  test('WORKERS is honoured where every worker has its own SAP: the simulator, and mode=open', async () => {
    for (const own of [{ SAP_GUI_SIMULATOR: 'true' }, { SAP_GUI_MODE: 'open' }]) {
      const { config, warnings } = await loadConfig({ ...clean, ...own, WORKERS: '4' });
      pw(config.workers, JSON.stringify(own)).toBe('4');
      pw(warnings).toEqual([]);
    }
  });

  test('the sap fixture refuses attach mode with more than one worker, saying what to do', () => {
    const connection = new SapConnection({ sapGuiMode: 'attach', sapGuiTransport: undefined, sapGuiReuse: undefined });
    pw(() => connection.assertSessionNotShared(2)).toThrow(/SAP_GUI_MODE=attach with 2 workers.*same SAP GUI window.*--workers=1.*SAP_GUI_MODE=open/s);
    connection.assertSessionNotShared(1); // one worker is fine
  });

  test('... but not where each worker owns its SAP: a custom transport, the simulator, mode=open', async () => {
    const fake = () => new FakeSapGui({ start: 's', screens: [{ name: 's', elements: {} }] });
    new SapConnection({ sapGuiMode: 'attach', sapGuiTransport: fake, sapGuiReuse: undefined }).assertSessionNotShared(8);
    new SapConnection({ sapGuiMode: 'open', sapGuiTransport: undefined, sapGuiReuse: undefined }).assertSessionNotShared(8);
    await withEnv({ SAP_GUI_SIMULATOR: 'true' }, () => new SapConnection({ sapGuiMode: 'attach', sapGuiTransport: undefined, sapGuiReuse: undefined }).assertSessionNotShared(8));
    // and the mode comes from SAP_GUI_MODE when the option is not set
    await withEnv({ SAP_GUI_MODE: 'attach', SAP_GUI_SIMULATOR: undefined }, () =>
      pw(() => new SapConnection({ sapGuiMode: undefined, sapGuiTransport: undefined, sapGuiReuse: undefined }).assertSessionNotShared(3)).toThrow(/attach with 3 workers/),
    );
  });

  test('docs/ARCHITECTURE.md describes this (and no longer says one worker is merely "the default and the safe choice")', () => {
    const text = fs.readFileSync(path.join(root, 'docs/ARCHITECTURE.md'), 'utf8');
    pw(text).toContain('workers: 1');
    pw(text).toContain('refuses');
    pw(text).not.toContain('one worker is the default and the safe choice');
  });
});

test.describe('SEC-10: screenshots do not linger in the temp folder', () => {
  const attacher = () => {
    const attached: Array<{ name: string; path?: string; existedWhenAttached: boolean }> = [];
    return {
      attached,
      attach: async (name: string, options: { path?: string; body?: string }) => void attached.push({ name, path: options.path, existedWhenAttached: options.path ? fs.existsSync(options.path) : false }),
    };
  };

  test('evidence is written under the configured results folder (not os.tmpdir()) ...', async () => {
    const dir = path.join(tmp(), 'evidence');
    const { fake } = await demoSession();
    const sap = await SapGuiSession.attach(fake, { ...FAST, evidenceDir: dir });
    const file = await sap.evidence('after search');
    pw(file).toBeDefined();
    pw(path.dirname(file as string)).toBe(dir);
    pw(fs.existsSync(file as string)).toBe(true);
  });

  test('... and the default is test-results/sap-evidence under the working directory', async () => {
    const { sap } = await demoSession();
    pw(sap.screenshotDir()).toBe(path.resolve('test-results', 'sap-evidence'));
  });

  test('falls back to the temp folder only when the results folder cannot be created', async () => {
    const blocker = path.join(tmp(), 'blocker');
    fs.writeFileSync(blocker, 'a file where a folder is needed');
    const { fake } = await demoSession();
    const sap = await SapGuiSession.attach(fake, { ...FAST, evidenceDir: path.join(blocker, 'sub') });
    pw(sap.screenshotDir()).toBe(os.tmpdir());
  });

  test('requested evidence is attached and then DELETED', async () => {
    const dir = path.join(tmp(), 'evidence');
    const { fake } = await demoSession();
    const sap = await SapGuiSession.attach(fake, { ...FAST, evidenceDir: dir });
    const file = (await sap.evidence('one')) as string;
    const report = attacher();
    await attachDiagnostics(sap, report, 'failure', false);
    pw(report.attached).toEqual([{ name: 'sap-evidence: one', path: file, existedWhenAttached: true }]);
    pw(fs.existsSync(file)).toBe(false); // the report holds its own copy; the screenshot of a business screen is not left behind
  });

  test('the failure screenshot is attached and deleted too, and nothing is left in the folder', async () => {
    const dir = path.join(tmp(), 'evidence');
    const { fake } = await demoSession();
    const sap = await SapGuiSession.attach(fake, { ...FAST, evidenceDir: dir });
    const report = attacher();
    await attachDiagnostics(sap, report, 'failure', true);
    const shot = report.attached.find((a) => a.name === 'sap-screenshot');
    pw(shot?.existedWhenAttached).toBe(true);
    pw(fs.readdirSync(dir)).toEqual([]);
  });

  test('evidence that was never attached (the fixture failed first) is deleted when the next test resets the session', async () => {
    const dir = path.join(tmp(), 'evidence');
    const { fake } = await demoSession();
    const sap = await SapGuiSession.attach(fake, { ...FAST, evidenceDir: dir });
    const file = (await sap.evidence('orphan')) as string;
    sap.resetDiagnostics();
    pw(fs.existsSync(file)).toBe(false);
  });
});

test.describe('SEC-10: the PowerShell bridge and -ExecutionPolicy Bypass', () => {
  test('by default the script is written to a temp file and run with Bypass (documented), and removed afterwards', () => {
    const dir = tmp();
    const { args, cleanup } = bridgeInvocation({}, dir);
    pw(args).toEqual(expect.arrayContaining(['-ExecutionPolicy', 'Bypass', '-File']));
    const script = args[args.length - 1] as string;
    pw(path.dirname(script)).toBe(dir);
    pw(fs.readFileSync(script, 'ascii')).toBe(BRIDGE_SCRIPT);
    cleanup();
    pw(fs.existsSync(script)).toBe(false);
  });

  test('SAP_GUI_POWERSHELL_SCRIPT_DIR: an approved copy is run as it is, and the machine policy is left alone (no Bypass)', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'sap-gui-bridge.ps1'), BRIDGE_SCRIPT.replace(/\n/g, '\r\n'), 'ascii'); // CRLF, as a Windows editor saves it
    const { args } = bridgeInvocation({ scriptDir: dir });
    pw(args).not.toContain('Bypass');
    pw(args).not.toContain('-ExecutionPolicy');
    pw(args.slice(-2)).toEqual(['-File', path.join(dir, 'sap-gui-bridge.ps1')]);
  });

  test('a code-signed copy (signature block appended) is accepted', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'sap-gui-bridge.ps1'), `${BRIDGE_SCRIPT}\n# SIG # Begin signature block\n# MIIFakeSignatureBytes==\n# SIG # End signature block\n`, 'ascii');
    pw(() => bridgeInvocation({ scriptDir: dir })).not.toThrow();
  });

  test('a stale or edited copy is refused (a signed script that no longer matches what the framework sends commands to)', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'sap-gui-bridge.ps1'), `${BRIDGE_SCRIPT}\nStart-Process calc.exe\n`, 'ascii');
    pw(() => bridgeInvocation({ scriptDir: dir })).toThrow(/not the bridge script this version of the framework ships.*--print-bridge/s);
  });

  test('code hidden after a fake signature marker is NOT ignored: the copy is refused', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'sap-gui-bridge.ps1'), `${BRIDGE_SCRIPT}\n# SIG # Begin signature block\n# MIIFakeSignatureBytes==\nStart-Process calc.exe\n# SIG # End signature block\n`, 'ascii');
    pw(() => bridgeInvocation({ scriptDir: dir })).toThrow(/not the bridge script this version of the framework ships/);
    fs.writeFileSync(path.join(dir, 'sap-gui-bridge.ps1'), `${BRIDGE_SCRIPT}\n# SIG # Begin signature block\nStart-Process calc.exe\n`, 'ascii');
    pw(() => bridgeInvocation({ scriptDir: dir })).toThrow(/not the bridge script this version of the framework ships/);
  });

  test('a missing copy says how to create it', () => {
    pw(() => bridgeInvocation({ scriptDir: tmp() })).toThrow(/does not exist.*--print-bridge \| Out-File -Encoding ascii/s);
  });
});

test.describe('SEC-10: the DPAPI helper speaks UTF-8 like the bridge', () => {
  test('both the protect and the unprotect script set the console encodings first (a mangled password counts as a failed logon)', async () => {
    const dir = tmp();
    const scripts: string[] = [];
    const run = (script: string) => {
      scripts.push(script);
      return { status: 0, stdout: 'QUJD', stderr: '' };
    };
    storeDpapiSecret('SAP_PASSWORD', 'Grüße-€', { dir, run, platform: 'win32' });
    await dpapiSecrets({ dir, run, platform: 'win32' }).get('SAP_PASSWORD');
    pw(scripts).toHaveLength(2);
    for (const script of scripts) {
      pw(script).toContain('[Console]::InputEncoding = $u');
      pw(script).toContain('[Console]::OutputEncoding = $u');
      pw(script).toContain('UTF8Encoding($false)');
      pw(script.indexOf('InputEncoding')).toBeLessThan(script.indexOf('ProtectedData')); // before any data moves
    }
    pw(BRIDGE_SCRIPT).toContain('[Console]::InputEncoding = $utf8'); // the bridge's own, which this mirrors
  });
});

test.describe('S15: small SAP defects', () => {
  const screenWith = async (elements: Record<string, { type: string; props?: Record<string, string | number | boolean> }>) => {
    const fake = new FakeSapGui({ start: 's', screens: [{ name: 's', context: { transaction: 'VA01', program: 'P', screen: '1' }, elements }] });
    return SapGuiSession.attach(fake, FAST);
  };
  const elements = { 'wnd[0]': { type: 'GuiMainWindow' }, 'wnd[0]/sbar': { type: 'GuiStatusbar' }, 'wnd[0]/usr/txtA': { type: 'GuiTextField' } };

  test('toMatchScreenContract refuses to UPDATE a baseline when CI is set (env and option)', async () => {
    const dir = tmp();
    const sap = await screenWith(elements);
    for (const via of ['env', 'option'] as const) {
      await withEnv({ CI: 'true', SAP_GUI_UPDATE_CONTRACTS: via === 'env' ? 'true' : undefined }, async () => {
        const error = await (expect(sap) as unknown as { toMatchScreenContract(n: string, o: object): Promise<void> })
          .toMatchScreenContract('va01', { dir, ...(via === 'option' ? { update: true } : {}) })
          .catch((e: unknown) => e as Error);
        pw((error as Error).message, via).toMatch(/Refusing to update the screen contract "va01" in CI/);
        pw(fs.existsSync(path.join(dir, 'va01.contract.json')), via).toBe(false);
      });
    }
  });

  test('negative control: outside CI the same update writes the baseline; CI=false counts as not CI', async () => {
    const dir = tmp();
    const sap = await screenWith(elements);
    for (const ci of [undefined, 'false', '0']) {
      await withEnv({ CI: ci, SAP_GUI_UPDATE_CONTRACTS: 'true' }, async () => {
        await expect(sap).toMatchScreenContract('va01', { dir });
      });
      pw(fs.existsSync(path.join(dir, 'va01.contract.json')), String(ci)).toBe(true);
      fs.rmSync(path.join(dir, 'va01.contract.json'));
    }
    pw(await captureContract(sap, 'x')).toBeTruthy();
  });

  /** A transport whose text field keeps only the first `keep` characters, as SAP does with an over-long entry (no error). */
  const truncating = (fake: FakeSapGui, keep: number): SapGuiTransport => ({
    close: () => fake.close(),
    request: (command) => fake.request(command.op === 'set' && command.prop === 'text' && command.id.endsWith('txtNAME') ? { ...command, value: String(command.value).slice(0, keep) } : command),
  });

  test('fill: with checkMaxLength on, a value SAP silently cut short or discarded is an error naming what the field holds', async () => {
    const { fake } = await demoSession();
    const sap = await SapGuiSession.attach(truncating(fake, 3), FAST);
    await pw(sap.getByLabel('Name').fill('Abcde', { checkMaxLength: true })).rejects.toThrow(/SAP did not accept "Abcde".*now holds "Abc"/);
    const none = await SapGuiSession.attach(truncating(fake, 0), FAST);
    await pw(none.getByLabel('Name').fill('Ab', { checkMaxLength: true })).rejects.toThrow(/now holds ""/);
  });

  test('negative control: without checkMaxLength nothing is read back (the documented trade-off), and an accepted value passes', async () => {
    const { fake } = await demoSession();
    const sap = await SapGuiSession.attach(truncating(fake, 3), FAST);
    await sap.getByLabel('Name').fill('Abcde'); // silently truncated, as before
    const ok = await demoSession();
    await ok.sap.getByLabel('Name').fill('Okay', { checkMaxLength: true });
    pw(await ok.sap.getText('wnd[0]/usr/txtNAME')).toBe('Okay');
  });

  test('fill: reformatting by SAP (case, leading zeros) is not a failure, and a password is never read back', async () => {
    const { fake } = await demoSession();
    const upcasing: SapGuiTransport = { close: () => fake.close(), request: (c) => fake.request(c.op === 'set' && c.prop === 'text' && c.id.endsWith('txtNAME') ? { ...c, value: String(c.value).toUpperCase() } : c) };
    const sap = await SapGuiSession.attach(upcasing, FAST);
    await sap.getByLabel('Name').fill('abc', { checkMaxLength: true });
    const reads: string[] = [];
    const spy: SapGuiTransport = { close: () => fake.close(), request: (c) => (c.op === 'get' && c.id.endsWith('pwdPASS') && c.prop === 'text' && reads.push(c.prop), fake.request(c)) };
    await (await SapGuiSession.attach(spy, FAST)).getByLabel('Password').fill('secret', { checkMaxLength: true });
    pw(reads).toEqual([]);
  });

  const leaving = (popup: boolean) =>
    new FakeSapGui({
      start: 'tx',
      screens: [
        { name: 'tx', elements: { 'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Create Order' } }, 'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' }, 'wnd[0]/sbar': { type: 'GuiStatusbar' } } },
        // what /n lands on: the start screen - with a "data will be lost" confirmation in front when the transaction had unsaved data
        {
          name: 'easyAccess',
          elements: {
            'wnd[0]': { type: 'GuiMainWindow', props: { text: 'SAP Easy Access' } },
            'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' },
            ...(popup ? { 'wnd[1]': { type: 'GuiModalWindow', props: { text: 'Exit Create Order' } }, 'wnd[1]/usr/btnSPOP-OPTION1': { type: 'GuiButton', props: { text: 'Yes' } } } : {}),
            'wnd[0]/sbar': { type: 'GuiStatusbar' },
          },
          onPress: { 'wnd[1]/usr/btnSPOP-OPTION1': () => 'clean' },
        },
        { name: 'clean', elements: { 'wnd[0]': { type: 'GuiMainWindow', props: { text: 'SAP Easy Access' } }, 'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' }, 'wnd[0]/sbar': { type: 'GuiStatusbar' } } },
      ],
    });

  test('home() re-checks for a pop-up after /n: one still in front means the session is NOT home, and it says what to do', async () => {
    const sap = await SapGuiSession.attach(leaving(true), FAST);
    await pw(sap.home()).rejects.toThrow(/pop-up "Exit Create Order" is still in front after \/n.*sap\.onPopup/s);
  });

  test('... a registered pop-up handler answers it, and home() then completes', async () => {
    const fake = leaving(true);
    const sap = await SapGuiSession.attach(fake, FAST);
    sap.onPopup('leave transaction', { title: /Exit/ }, (s) => s.press('wnd[1]/usr/btnSPOP-OPTION1'));
    await sap.home();
    pw(fake.currentScreen).toBe('clean');
  });

  test('negative control: nothing in front after /n, home() is fine', async () => {
    const sap = await SapGuiSession.attach(leaving(false), FAST);
    await sap.home();
  });
});

test.describe('S13 / S14 / SAP-03: the pipeline definition', () => {
  const ci = fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8');
  const job = (name: string) => ci.slice(ci.search(new RegExp(`^${name}:`, 'm'))).split(/\n(?=[a-z][\w-]*:|# ----)/)[0] as string;
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<string, string>;

  test('test:smoke and test:framework generate the features first and fail when too few tests executed', () => {
    for (const name of ['test:smoke', 'test:framework']) {
      pw(scripts[name], name).toMatch(/^bddgen && playwright test /);
      pw(scripts[name], name).toMatch(/node scripts\/min-executed\.js --min \d+$/);
    }
    pw(scripts['test:bdd']).toMatch(/^bddgen && playwright test --project=bdd .*min-executed/);
  });

  test('the build job type-checks (tests and steps, not just src)', () => {
    pw(job('build')).toContain('npm run typecheck');
    pw(scripts.typecheck).toContain('tsc --noEmit');
  });

  test('the Allure pages job needs Java: it checks for it and for results, and publishes only when both exist', () => {
    const pages = job('pages');
    pw(pages).toContain('command -v java');
    pw(pages).toContain('ls -A allure-results');
    pw(pages).toContain('allure generate allure-results --clean -o public');
    pw(pages.indexOf('command -v java')).toBeLessThan(pages.indexOf('allure generate'));
  });

  test('a conformance job exists as a manual/scheduled template, allowed to fail, and marked NOT VERIFIED - and the CLI it runs exists', () => {
    const conformance = job('sapgui-conformance');
    pw(conformance).toContain('allow_failure: true');
    pw(conformance).toContain('npm run conformance');
    pw(conformance).toMatch(/when: manual/);
    pw(conformance).toContain('$CI_PIPELINE_SOURCE == "schedule"');
    pw(ci).toMatch(/NOT VERIFIED: nobody has run this job/);
    pw(scripts.conformance).toBe('node dist/cli/doctor.js --conformance');
    pw(fs.readFileSync(path.join(root, 'src/cli/doctor.ts'), 'utf8')).toContain("'--conformance'");
  });

  test('the main test job says where the JDK skip count shows up', () => {
    pw(ci).toMatch(/skipped \dx: needs a JDK/);
    pw(fs.readFileSync(path.join(__dirname, 'javaBridge.spec.ts'), 'utf8')).toContain('min-executed');
  });
});

test.describe('scripts/min-executed.js', () => {
  const script = path.join(root, 'scripts/min-executed.js');
  const report = (tests: Array<{ status: string; skip?: string }>) => {
    const file = path.join(tmp(), 'results.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        suites: [{ specs: [], suites: [{ specs: tests.map((t) => ({ tests: [{ status: t.status, annotations: t.skip ? [{ type: 'skip', description: t.skip }] : [], results: [{ status: t.status === 'skipped' ? 'skipped' : 'passed' }] }] })) }] }],
      }),
    );
    return file;
  };
  const run = (file: string, min: number) => spawnSync('node', [script, '--input', file, '--min', String(min)], { encoding: 'utf8' });

  test('passes with enough executed tests and prints the skip reasons with their counts', () => {
    const result = run(report([{ status: 'expected' }, { status: 'expected' }, { status: 'skipped', skip: 'needs a JDK' }, { status: 'skipped', skip: 'needs a JDK' }, { status: 'flaky' }]), 3);
    pw(result.status).toBe(0);
    pw(result.stdout).toContain('3 executed, 2 skipped, 0 failed');
    pw(result.stdout).toContain('skipped 2x: needs a JDK');
  });

  test('fails an all-skipped run (Playwright itself exits 0 for it)', () => {
    const result = run(report([{ status: 'skipped', skip: 'needs a JDK' }, { status: 'skipped', skip: 'needs a JDK' }]), 1);
    pw(result.status).toBe(1);
    pw(result.stderr).toContain('only 0 test(s) executed, expected at least 1');
  });

  test('fails when a test failed, and exits 2 without a report', () => {
    pw(run(report([{ status: 'expected' }, { status: 'unexpected' }]), 1).status).toBe(1);
    pw(run(path.join(tmp(), 'missing.json'), 1).status).toBe(2);
  });
});
