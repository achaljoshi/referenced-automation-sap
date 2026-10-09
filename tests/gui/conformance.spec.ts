import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { createSampleSapSystem, formatConformance, ProcessTransport, runConformance, SapGuiTransportError, type SapGuiCommand, type SapGuiTransport } from '../../src';

const bridge = path.resolve(__dirname, 'bridges/standInBridge.js');

/** A good transport with one behaviour broken, to show the suite notices. */
function broken(tweak: (command: SapGuiCommand, real: () => Promise<unknown>) => Promise<unknown> | undefined): SapGuiTransport {
  const fake = createSampleSapSystem({ transitionDelayMs: 0 });
  return {
    request: async (command) => {
      const real = () => fake.request(command);
      const tweaked = tweak(command, real);
      return tweaked === undefined ? real() : tweaked;
    },
    close: () => fake.close(),
  };
}

const failures = async (transport: SapGuiTransport, write = false) => (await runConformance(transport, { write })).results.filter((r) => r.status === 'fail').map((r) => r.id);

async function loggedOn(transport: SapGuiTransport) {
  await transport.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
  await transport.request({ op: 'set', id: 'wnd[0]/usr/txtRSYST-MANDT', prop: 'text', value: '100' });
  await transport.request({ op: 'set', id: 'wnd[0]/usr/txtRSYST-BNAME', prop: 'text', value: 'TESTUSER' });
  await transport.request({ op: 'set', id: 'wnd[0]/usr/pwdRSYST-BCODE', prop: 'text', value: 'correct-horse' });
  await transport.request({ op: 'call', id: 'wnd[0]', method: 'sendVKey', args: [0] });
}

test.describe('a conforming transport passes everything', () => {
  test('the simulator, called directly', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 0 });
    await fake.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
    const report = await runConformance(fake);
    expect(report.failed).toBe(0);
    expect(report.requiredFailed).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(14);
    expect(report.latency).toBeDefined();
  });

  test('the same simulator behind a real child process speaking the line protocol', async () => {
    const transport = await ProcessTransport.start({ command: process.execPath, args: [bridge], label: 'Stand-in', requestTimeoutMs: 3000 });
    await transport.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
    const report = await runConformance(transport);
    await transport.close();
    expect(report.results.filter((r) => r.status === 'fail')).toEqual([]);
  });

  test('--write is opt-in: without it nothing is typed; with it a Unicode value round-trips and the field is cleared', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 0 });
    await loggedOn(fake);
    const calls = fake.calls.length;
    const without = await runConformance(fake);
    expect(without.results.some((r) => r.group === 'write')).toBe(false);
    expect(fake.calls).toHaveLength(calls); // nothing was typed or pressed

    const withWrite = await runConformance(fake, { write: true });
    expect(withWrite.results.find((r) => r.id === 'write-roundtrip')?.status).toBe('pass');
    expect(fake.calls.length).toBeGreaterThan(calls);
    expect(await fake.request({ op: 'get', id: 'wnd[0]/tbar[0]/okcd', prop: 'text' })).toBe('');
  });

  test('--write is skipped, not failed, on a screen without a command field (the logon screen)', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 0 });
    await fake.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
    const result = (await runConformance(fake, { write: true })).results.find((r) => r.id === 'write-roundtrip');
    expect(result?.status).toBe('skip');
    expect(result?.detail).toContain('logon screen');
  });
});

test.describe('a broken transport is caught (negative controls)', () => {
  const attached = async (t: SapGuiTransport) => (await t.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 }), t);

  test('busy that is not a boolean: the framework could never tell when SAP is idle', async () => {
    const t = await attached(broken((c) => (c.op === 'busy' ? Promise.resolve('no') : undefined)));
    expect(await failures(t)).toContain('busy');
  });

  test('a missing control reported with the wrong code: retries during screen changes would not happen', async () => {
    const t = await attached(broken((c, real) => (c.op === 'get' ? real().catch((e: SapGuiTransportError) => Promise.reject(new SapGuiTransportError(e.message, 'ERROR'))) : undefined)));
    expect(await failures(t)).toContain('err-not-found');
  });

  test('exists that throws instead of answering false', async () => {
    const t = await attached(broken((c) => (c.op === 'exists' && String(c.id).includes('conformance') ? Promise.reject(new SapGuiTransportError('boom', 'ERROR')) : undefined)));
    const failed = await failures(t);
    expect(failed).toContain('exists-false');
    expect(failed).toContain('concurrent');
  });

  test('replies mixed up between concurrent requests', async () => {
    const t = await attached(broken((c) => (c.op === 'ping' ? Promise.resolve(false) : undefined)));
    expect(await failures(t)).toEqual(expect.arrayContaining(['ping', 'concurrent']));
  });

  test('chained access not supported', async () => {
    const t = await attached(broken((c) => (c.op === 'get' && 'via' in c && c.via ? Promise.resolve(null) : undefined)));
    expect(await failures(t)).toContain('chain');
  });

  test('a failure that is never reported (everything "succeeds")', async () => {
    const t = await attached(broken((c) => (c.op === 'get' && String(c.prop).includes('NoSuch') ? Promise.resolve(null) : undefined)));
    expect(await failures(t)).toContain('err-other');
  });

  test('text that loses non-ASCII characters on the way (a code-page problem)', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 0 });
    await loggedOn(fake);
    const t: SapGuiTransport = {
      request: (c) => (c.op === 'set' && c.prop === 'text' && typeof c.value === 'string' ? fake.request({ ...c, value: [...c.value].map((ch) => (ch.charCodeAt(0) > 127 ? '?' : ch)).join('') }) : fake.request(c)),
      close: () => fake.close(),
    };
    const report = await runConformance(t, { write: true });
    const roundtrip = report.results.find((r) => r.id === 'write-roundtrip');
    expect(roundtrip?.status).toBe('fail');
    expect(roundtrip?.detail).toContain('read back');
    expect(report.requiredFailed).toBe(0); // it is a warning: other things still work
  });

  test('no SAP session at all', async () => {
    const t = broken((c) => (c.op === 'exists' && c.id === 'wnd[0]' ? Promise.resolve(false) : undefined));
    const report = await runConformance(t);
    expect(report.results.find((r) => r.id === 'session')?.status).toBe('fail');
    expect(report.requiredFailed).toBeGreaterThan(0);
  });

  test('a slow bridge is flagged (every step of every test pays this)', async () => {
    const t = await attached(broken((c) => (c.op === 'ping' ? new Promise((r) => setTimeout(() => r('pong'), 1100)) : undefined)));
    test.setTimeout(60_000);
    const latency = (await runConformance(t)).results.find((r) => r.id === 'latency');
    expect(latency?.status).toBe('fail');
    expect(latency?.required).toBe(false);
  });
});

test.describe('the report', () => {
  test('says whether the transport conforms, distinguishing required failures from warnings', async () => {
    const good = createSampleSapSystem({ transitionDelayMs: 0 });
    await good.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
    expect(formatConformance(await runConformance(good))).toContain('This transport conforms');

    const bad = broken((c) => (c.op === 'busy' ? Promise.resolve('no') : undefined));
    await bad.request({ op: 'attach', connectionIndex: 0, sessionIndex: 0 });
    const text = formatConformance(await runConformance(bad));
    expect(text).toContain('FAIL');
    expect(text).toContain('does NOT conform');
  });
});
