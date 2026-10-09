import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { JavaTransport, ProcessTransport, runConformance, SapGuiSession, SapGuiTransportError, type SapGuiTransport } from '../../src';

/**
 * The Java/JACOB bridge helper, compiled against STAND-IN JACOB classes (a tiny in-memory SAP) and run as a real
 * process. This verifies the helper's own logic - the line protocol, chained access, find, error mapping, UTF-8 -
 * and that it passes the same conformance suite as every other transport. It cannot say anything about real COM
 * behaviour or the real JACOB library: that needs a Windows machine with SAP GUI (see bridge/jacob/README.md).
 */
const root = path.resolve(__dirname, '../..');
const hasJdk = spawnSync('javac', ['-version']).status === 0 && spawnSync('java', ['-version']).status === 0;
let classes = '';

test.skip(!hasJdk, 'needs a JDK (javac and java on PATH)');

test.beforeAll(() => {
  classes = fs.mkdtempSync(path.join(os.tmpdir(), 'sapbridge-java-'));
  const stubs = (function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.java') ? [path.join(dir, e.name)] : []));
  })(path.join(__dirname, 'bridges/jacob-stub'));
  const sources = fs.readdirSync(path.join(root, 'bridge/jacob/src')).map((f) => path.join(root, 'bridge/jacob/src', f));
  const compile = spawnSync('javac', ['--release', '8', '-encoding', 'UTF-8', '-d', classes, ...stubs, ...sources], { encoding: 'utf8' });
  if (compile.status !== 0) throw new Error(`the Java bridge does not compile:\n${compile.stderr}`);
});

const start = (extraArgs: string[] = []) => ProcessTransport.start({ command: 'java', args: ['-cp', classes, ...extraArgs, 'SapBridge'], label: 'Java', requestTimeoutMs: 5000, startupTimeoutMs: 15_000 });

async function attached(): Promise<SapGuiTransport> {
  const transport = await start();
  await transport.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
  return transport;
}

test.describe('the Java bridge speaks the protocol', () => {
  test('starts, says ready, answers ping, and quits cleanly', async () => {
    const transport = await start();
    expect(await transport.request({ op: 'ping' })).toBe('pong');
    await transport.close();
  });

  test('passes the conformance suite (the same one every transport must pass)', async () => {
    const transport = await attached();
    const report = await runConformance(transport, { write: true });
    await transport.close();
    expect(report.results.filter((r) => r.status === 'fail').map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
    expect(report.passed).toBeGreaterThanOrEqual(15);
  });

  test('a missing control is NOT_FOUND, any other failure is ERROR - the codes the retry logic relies on', async () => {
    const transport = await attached();
    const missing = (await transport.request({ op: 'get', id: 'wnd[0]/usr/nope', prop: 'text' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(missing.code).toBe('NOT_FOUND');
    const other = (await transport.request({ op: 'get', id: 'wnd[0]', prop: 'noSuchProperty' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(other.code).toBe('ERROR');
    const unknownOp = (await transport.request({ op: 'frobnicate' } as never).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(unknownOp.code).toBe('ERROR');
    expect(unknownOp.message).toContain('Unknown op');
    expect(await transport.request({ op: 'ping' })).toBe('pong'); // still alive
    await transport.close();
  });

  test('non-ASCII text survives the pipes in both directions (UTF-8 end to end)', async () => {
    const transport = await attached();
    const text = 'Grüße ✓ € é';
    await transport.request({ op: 'set', id: 'wnd[0]/usr/txtRSYST-BNAME', prop: 'text', value: text });
    expect(await transport.request({ op: 'get', id: 'wnd[0]/usr/txtRSYST-BNAME', prop: 'text' })).toBe(text);
    await transport.close();
  });

  test('chained access, find by label, and info work', async () => {
    const transport = await attached();
    expect(await transport.request({ op: 'get', id: 'wnd[0]', prop: 'count', via: [{ member: 'children' }] })).toBeGreaterThan(0);
    const ids = (await transport.request({ op: 'find', criteria: { root: 'wnd[0]', label: 'user' } })) as string[];
    expect(ids).toEqual(['/app/con[0]/ses[0]/wnd[0]/usr/txtRSYST-BNAME']);
    expect(await transport.request({ op: 'info', id: 'wnd[0]/usr/pwdRSYST-BCODE' })).toMatchObject({ type: 'GuiPasswordField', changeable: true });
    expect(await transport.request({ op: 'context' })).toMatchObject({ system: 'STUB', user: 'TESTUSER', program: 'SAPMSYST', responseMs: 12 });
    await transport.close();
  });

  test('whole numbers are sent to COM as 32-bit integers (SAP rejects 64-bit)', async () => {
    const transport = await attached();
    await transport.request({ op: 'set', id: 'wnd[0]/usr/txtRSYST-BNAME', prop: 'caretPosition', value: 5 });
    expect(await transport.request({ op: 'get', id: 'wnd[0]/usr/txtRSYST-BNAME', prop: 'caretPosition' })).toBe(5);
    await transport.close();
  });

  test('a malformed line does not kill the bridge', async () => {
    const transport = await attached();
    // not reachable through request(); write straight to the process through a fresh raw spawn instead
    const raw = spawnSync('java', ['-cp', classes, 'SapBridge'], { input: 'this is not json\n{"rid":1,"op":"ping"}\n{"rid":2,"op":"quit"}\n', encoding: 'utf8' });
    expect(raw.stdout).toContain('"value":"pong"');
    expect(raw.stdout).toContain('"ok":false'); // the malformed line got an error reply
    await transport.close();
  });

  test('stdout carries only protocol lines: a library printing to stdout cannot corrupt it', () => {
    const raw = spawnSync('java', ['-cp', classes, 'SapBridge'], { input: '{"rid":1,"op":"ping"}\n{"rid":2,"op":"quit"}\n', encoding: 'utf8' });
    for (const line of raw.stdout.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  });

  test('a bridge that cannot start (bad classpath) fails with Java\'s own message', async () => {
    const error = (await ProcessTransport.start({ command: 'java', args: ['-cp', os.tmpdir(), 'SapBridge'], label: 'Java', startupTimeoutMs: 8000 }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(error.code).toBe('BRIDGE_EXITED');
    expect(error.message).toMatch(/Java bridge exited.*(NoClassDefFound|ClassNotFound|Could not find or load main class)/s);
  });
});

test.describe('a whole session over the Java bridge', () => {
  test('SapGuiSession: locate by label, fill, read, health, context', async () => {
    const transport = await start();
    const sap = await SapGuiSession.attach(transport, { timeoutMs: 5000, pollMs: 20 });
    await sap.getByLabel('User').fill('TESTUSER');
    expect(await sap.getByLabel('User').text()).toBe('TESTUSER');
    expect(sap.currentContext).toMatchObject({ system: 'STUB', user: 'TESTUSER' });
    expect(await sap.healthCheck()).toBe(true);
    await sap.close();
  });
});

test.describe('JavaTransport configuration errors say what to do', () => {
  test('missing jar / DLL are named with the setting that controls them', async () => {
    const error = (await JavaTransport.start({ bridgeJar: '/nope/sap-bridge.jar', jacobJar: '/nope/jacob.jar', jacobDll: '/nope/jacob.dll' }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('bridge jar (SAP_GUI_BRIDGE_JAR) was not found: /nope/sap-bridge.jar');
    expect(error.message).toContain('bridge/jacob/README.md');
    const unconfigured = (await JavaTransport.start({ bridgeJar: '', jacobJar: '', jacobDll: '' }).catch((e: unknown) => e)) as Error;
    expect(unconfigured.message).toContain('is not configured');
  });
});
