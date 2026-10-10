import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { ProcessTransport, SapGuiSession, SapGuiTransportError } from '../../src';

const processOf = (transport: ProcessTransport) => (transport as unknown as { child: import('node:child_process').ChildProcess }).child;
const exited = (transport: ProcessTransport) => new Promise<void>((resolve) => (processOf(transport).exitCode !== null || processOf(transport).signalCode !== null ? resolve() : processOf(transport).once('exit', () => resolve())));

const bridge = path.resolve(__dirname, 'bridges/standInBridge.js');
const start = (env: NodeJS.ProcessEnv = {}, extra: { requestTimeoutMs?: number; startupTimeoutMs?: number; quitTimeoutMs?: number; cleanup?: () => void } = {}) =>
  ProcessTransport.start({ command: process.execPath, args: [bridge], label: 'Stand-in', env: { ...process.env, ...env }, requestTimeoutMs: 2000, startupTimeoutMs: 3000, ...extra });

test.describe('ProcessTransport speaks the bridge protocol', () => {
  test('starts when the bridge says ready, answers requests, and closes cleanly (cleanup runs once)', async () => {
    let cleanups = 0;
    const transport = await start({}, { cleanup: () => void cleanups++ });
    expect(await transport.request({ op: 'ping' })).toBe('pong');
    expect(await transport.request({ op: 'busy' })).toBe(false);
    await transport.close();
    expect(cleanups).toBe(1);
  });

  test('a null result comes back as null, a structured one intact', async () => {
    const transport = await start();
    expect(await transport.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 })).toBeNull();
    expect(await transport.request({ op: 'context' })).toMatchObject({ system: 'FAKE', transaction: '' });
    await transport.close();
  });

  test('a failure carries the bridge\'s message, and NOT_FOUND keeps its code (the retry logic depends on it)', async () => {
    const transport = await start();
    await transport.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
    const missing = (await transport.request({ op: 'get', id: 'wnd[0]/usr/nope', prop: 'text' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(missing).toBeInstanceOf(SapGuiTransportError);
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.message).toContain('could not be found');
    await transport.close();
  });

  test('a dead COM connection comes back as SESSION_LOST (not ERROR, not a retryable NOT_FOUND)', async () => {
    const transport = await start({ BRIDGE_SESSION_LOST_OP: 'busy' });
    const error = (await transport.request({ op: 'busy' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(error.code).toBe('SESSION_LOST');
    expect(await transport.request({ op: 'ping' })).toBe('pong');
    await transport.close();
  });

  test('NOT_FOUND is decided by the bridge\'s code, not by the (localised) wording of the message', async () => {
    const transport = await start({ BRIDGE_NOT_FOUND_TEXT: 'Das Steuerelement konnte nicht gefunden werden' });
    await transport.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
    const missing = (await transport.request({ op: 'get', id: 'wnd[0]/usr/nope', prop: 'text' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.message).toBe('Das Steuerelement konnte nicht gefunden werden');
    await transport.close();
  });

  test('replies are matched to their requests even when they arrive out of order', async () => {
    const transport = await start({ BRIDGE_DELAY_OPS: 'ping:300' });
    const [slow, fast] = await Promise.all([transport.request({ op: 'ping' }), transport.request({ op: 'busy' })]);
    expect(slow).toBe('pong');
    expect(fast).toBe(false);
    await transport.close();
  });

  test('a non-JSON line is ignored, not fatal', async () => {
    const transport = await start({ BRIDGE_JUNK: '1' });
    expect(await transport.request({ op: 'ping' })).toBe('pong');
    await transport.close();
  });

  test('a bridge that never says ready fails to start with a TIMEOUT and is cleaned up exactly once', async () => {
    let cleanups = 0;
    const error = (await start({ BRIDGE_NO_READY: '1' }, { startupTimeoutMs: 300, cleanup: () => void cleanups++ }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toContain('did not become ready within 300ms');
    expect(cleanups).toBe(1);
  });

  test('a startup failure costs the startup timeout, not the startup timeout plus a 60 s `quit` wait', async () => {
    test.setTimeout(15_000);
    // the bridge neither says ready nor answers `quit`: asking it to quit politely used to cost one more request timeout (+3 s kill delay)
    const startedAt = Date.now();
    const error = (await start({ BRIDGE_NO_READY: '1', BRIDGE_HANG_OPS: 'quit' }, { startupTimeoutMs: 300, requestTimeoutMs: 60_000 }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(error.code).toBe('TIMEOUT');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test('a request the bridge never answers times out and says SAP may be blocked by a dialog', async () => {
    const transport = await start({ BRIDGE_HANG_OPS: 'busy' }, { requestTimeoutMs: 300 });
    const error = (await transport.request({ op: 'busy' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toMatch(/no reply to "busy" within 300ms.*dialog/);
    await transport.close();
  });

  test('after a timeout the bridge is killed, pending requests fail at once and later ones do not wait again', async () => {
    const transport = await start({ BRIDGE_HANG_OPS: 'busy' }, { requestTimeoutMs: 400 });
    const first = transport.request({ op: 'busy' }).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = transport.request({ op: 'busy' }).catch((e: unknown) => e); // would time out at ~600 ms on its own
    expect(((await first) as SapGuiTransportError).code).toBe('TIMEOUT');
    const stopped = (await second) as SapGuiTransportError;
    expect(stopped.code).toBe('BRIDGE_EXITED');
    expect(stopped.message).toContain('was stopped');
    const startedAt = Date.now();
    const later = (await transport.request({ op: 'ping' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(later.code).toBe('BRIDGE_EXITED');
    expect(Date.now() - startedAt).toBeLessThan(200); // failed immediately, no second request timeout
    await exited(transport); // the hung process is gone, not left holding the SAP session
    await transport.close();
  });

  test('a bridge that closed its input does not crash the test run with an uncaught EPIPE: the request fails with a clear error', async () => {
    const transport = await start({ BRIDGE_CLOSE_STDIN: '1' }, { requestTimeoutMs: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the bridge close its end
    const error = (await transport.request({ op: 'ping' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(error).toBeInstanceOf(SapGuiTransportError);
    expect(error.code).toBe('BRIDGE_EXITED');
    expect(error.message).toMatch(/closed its input|could not send/);
    await exited(transport); // killed
    await transport.close();
  });

  test('close() asks the bridge to quit for 2 s at most, then kills it - not a 60 s request timeout', async () => {
    test.setTimeout(15_000);
    const transport = await start({ BRIDGE_HANG_OPS: 'quit' }, { requestTimeoutMs: 60_000, quitTimeoutMs: 300 });
    const startedAt = Date.now();
    await transport.close();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await exited(transport);
  });

  test('the default quit timeout is short (2 s), whatever the request timeout is', async () => {
    test.setTimeout(15_000);
    const transport = await start({ BRIDGE_HANG_OPS: 'quit' }, { requestTimeoutMs: 60_000 });
    const startedAt = Date.now();
    await transport.close();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test('a bridge that dies mid-request fails that request with its stderr, and every later one fast', async () => {
    const transport = await start({ BRIDGE_CRASH_OP: 'exists' });
    const died = (await transport.request({ op: 'exists', id: 'wnd[0]' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(died.code).toBe('BRIDGE_EXITED');
    expect(died.message).toContain('Stand-in bridge exited (code 3)');
    expect(died.message).toContain('stand-in bridge crashed on exists');
    const later = (await transport.request({ op: 'ping' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(later.code).toBe('BRIDGE_EXITED');
    await transport.close(); // closing a dead transport is fine
  });

  test('a program that cannot be started is reported as such', async () => {
    const error = (await ProcessTransport.start({ command: '/definitely/not/a/program', args: [], label: 'Ghost' }).catch((e: unknown) => e)) as SapGuiTransportError;
    expect(error.code).toBe('BRIDGE_EXITED');
    expect(error.message).toContain('could not start Ghost');
  });

  test('close is idempotent', async () => {
    const transport = await start();
    await transport.close();
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

test.describe('a whole session over the process protocol', () => {
  test('SapGuiSession drives the simulator through a real child process: logon, locate, act, read', async () => {
    const transport = await start();
    const sap = await SapGuiSession.attach(transport, { timeoutMs: 3000, pollMs: 10 });
    await sap.getByLabel('User').fill('TESTUSER');
    await sap.getByLabel('Password').fill('correct-horse');
    await sap.getByLabel('Client').fill('100');
    await sap.sendVKey(0);
    expect(await sap.getText('wnd[0]')).toBe('SAP Easy Access');
    expect(sap.currentContext).toMatchObject({ transaction: 'SESSION_MANAGER' });
    expect(await sap.healthCheck()).toBe(true);
    await sap.close();
  });

  test('a lost bridge is visible as an unhealthy session', async () => {
    const transport = await start({ BRIDGE_CRASH_OP: 'busy' });
    const sap = await SapGuiSession.attach(transport, { timeoutMs: 1000, pollMs: 10, trackContext: false });
    expect(await sap.healthCheck()).toBe(false);
  });
});
