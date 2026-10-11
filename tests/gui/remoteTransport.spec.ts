import { expect, test } from '@playwright/test';
import { remote } from '@automation/referenced-automation-utils';
import { BRIDGE_SCRIPT, decodeLine, encodeRequest, RemoteTransport, runConformance, SapGuiSession, SapGuiTransportError, type SapGuiCommand, type SapGuiTransport } from '../../src';
import { liveChildren, rig, standInBridge, withEnv, type Rig } from './remoteSupport';

// Tested ONLY against the stand-in agent (utils testing.StandInAgent) hosting the stand-in bridge. NOT VERIFIED on a real RDP host with real SAP GUI.
test.describe.configure({ mode: 'serial' });

let r: Rig;
test.afterEach(async () => {
  await r?.done();
});

const start = (extra: Partial<Parameters<typeof RemoteTransport.start>[0]> = {}) =>
  RemoteTransport.start({ host: r.host, bridgeFile: standInBridge, requestTimeoutMs: 2000, startupTimeoutMs: 3000, ...extra });
const attach = { op: 'attach', connectionIndex: 0, sessionIndex: 0 } as const;
const caught = (promise: Promise<unknown>) => promise.then(() => undefined, (e: unknown) => e as SapGuiTransportError);

test.describe('RemoteTransport runs the bridge on the remote host', () => {
  test('sends the shipped PowerShell bridge as script text with shell powershell - or the approved file on the host', async () => {
    const specs: unknown[] = [];
    const sent: string[] = [];
    const host = {
      startProcess: async (spec: unknown) => {
        specs.push(spec);
        return { send: async (line: string) => (sent.push(line), line === '' ? '{"rid":0,"ok":true,"value":"ready"}' : '{"rid":1,"ok":true,"value":"pong"}'), stop: async () => undefined };
      },
    } as unknown as remote.RemoteHost;
    const a = await RemoteTransport.start({ host });
    expect(specs[0]).toEqual({ scriptText: BRIDGE_SCRIPT, shell: 'powershell' });
    expect(await a.request({ op: 'ping' })).toBe('pong');
    expect(sent).toEqual(['', JSON.stringify({ rid: 1, op: 'ping' })]);
    await a.close();
    await RemoteTransport.start({ host, bridgeFile: 'C:\\approved\\sap-gui-bridge.ps1' });
    expect(specs[1]).toEqual({ file: 'C:\\approved\\sap-gui-bridge.ps1', shell: 'powershell' });
  });

  test('starts, answers requests, and close() stops the remote process but leaves the RemoteHost usable', async () => {
    r = await rig();
    const transport = await start();
    expect(liveChildren(r)).toBe(1);
    expect(await transport.request({ op: 'ping' })).toBe('pong');
    expect(await transport.request({ op: 'busy' })).toBe(false);
    await transport.close();
    expect(liveChildren(r)).toBe(0);
    expect((await r.host.ping()).host).toBe('STAND-IN-HOST'); // the host is still open for other steps
    expect(await r.host.healthCheck()).toBe(true);
    await transport.close(); // twice is fine
    await expect(transport.request({ op: 'ping' })).rejects.toMatchObject({ code: 'BRIDGE_EXITED' });
  });

  test('the codes survive the line protocol: NOT_FOUND, SESSION_LOST, ERROR; null and structured values arrive intact', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_SESSION_LOST_OP: 'busy' }, () => start());
    expect(await t.request(attach)).toBeNull();
    const missing = await caught(t.request({ op: 'get', id: 'wnd[0]/usr/nope', prop: 'text' }));
    expect(missing).toBeInstanceOf(SapGuiTransportError);
    expect(missing?.code).toBe('NOT_FOUND');
    expect(missing?.message).toContain('could not be found');
    expect((await caught(t.request({ op: 'busy' })))?.code).toBe('SESSION_LOST');
    const other = await caught(t.request({ op: 'get', id: 'wnd[0]', prop: 'conformanceNoSuchProperty' }));
    expect(other?.code).toBe('ERROR');
    expect(other?.message.length).toBeGreaterThan(0);
    expect(await t.request({ op: 'context' })).toMatchObject({ system: 'FAKE' });
    expect(await t.request({ op: 'ping' })).toBe('pong'); // none of those failures stopped the bridge
    await t.close();
  });

  test('NOT_FOUND follows the bridge code, not the localised wording', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_NOT_FOUND_TEXT: 'Das Steuerelement konnte nicht gefunden werden' }, () => start());
    await t.request(attach);
    const missing = await caught(t.request({ op: 'get', id: 'wnd[0]/usr/nope', prop: 'text' }));
    expect(missing?.code).toBe('NOT_FOUND');
    expect(missing?.message).toBe('Das Steuerelement konnte nicht gefunden werden');
    await t.close();
  });

  test('chained access and find go through as one line each', async () => {
    r = await rig();
    const t = await start();
    await t.request(attach);
    const count = await t.request({ op: 'get', id: 'wnd[0]', prop: 'count', via: [{ member: 'children' }] });
    expect(typeof count).toBe('number');
    const found = (await t.request({ op: 'find', criteria: { root: 'wnd[0]', type: 'GuiStatusbar' } })) as string[];
    expect(found.some((id) => /\/sbar$/.test(id))).toBe(true);
    await t.close();
  });

  test('concurrent requests get their own replies even when the bridge answers out of order', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_DELAY_OPS: 'ping:300' }, () => start());
    const [slow, fast, again] = await Promise.all([t.request({ op: 'ping' }), t.request({ op: 'busy' }), t.request({ op: 'ping' })]);
    expect([slow, fast, again]).toEqual(['pong', false, 'pong']);
    await t.close();
  });

  test('a non-JSON line before the ready message is skipped, not fatal', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_JUNK: '1' }, () => start());
    expect(await t.request({ op: 'ping' })).toBe('pong');
    await t.close();
  });

  test('a bridge that never says ready fails the start with TIMEOUT and leaves no process behind', async () => {
    r = await rig();
    const error = await caught(withEnv({ BRIDGE_NO_READY: '1' }, () => start({ startupTimeoutMs: 400 })));
    expect(error?.code).toBe('TIMEOUT');
    expect(error?.message).toContain('did not become ready within 400ms');
    expect(liveChildren(r)).toBe(0);
  });

  test('a request that gets no reply: TIMEOUT, the remote process is killed, and every later request (queued or new) fails at once', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_HANG_OPS: 'busy' }, () => start({ requestTimeoutMs: 400 }));
    expect(liveChildren(r)).toBe(1);
    const queued = caught(t.request({ op: 'ping' }));
    const first = await caught(t.request({ op: 'busy' }));
    expect(first?.code).toBe('TIMEOUT');
    expect(first?.message).toContain('no reply to "busy" within 400ms');
    expect(liveChildren(r)).toBe(0);
    const started = Date.now();
    const later = await caught(t.request({ op: 'ping' }));
    expect(later?.code).toBe('BRIDGE_EXITED');
    expect(later?.message).toContain('stopped after "busy"');
    expect(Date.now() - started).toBeLessThan(100); // not another 400 ms
    // the request queued behind the hung one was ahead of it in line (it ran first and succeeded) - the one queued AFTER it fails fast
    expect(await queued).toBeUndefined();
    await t.close();
  });

  test('requests queued behind the one that times out fail at once instead of waiting their own timeout', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_HANG_OPS: 'busy' }, () => start({ requestTimeoutMs: 400 }));
    const started = Date.now();
    const results = await Promise.all([caught(t.request({ op: 'busy' })), caught(t.request({ op: 'ping' })), caught(t.request({ op: 'ping' }))]);
    expect(results.map((e) => e?.code)).toEqual(['TIMEOUT', 'BRIDGE_EXITED', 'BRIDGE_EXITED']);
    expect(Date.now() - started).toBeLessThan(1200);
    await t.close();
  });

  test('a bridge that crashes: BRIDGE_EXITED, then fast failures', async () => {
    r = await rig();
    const t = await withEnv({ BRIDGE_CRASH_OP: 'exists' }, () => start());
    const error = await caught(t.request({ op: 'exists', id: 'wnd[0]' }));
    expect(error?.code).toBe('BRIDGE_EXITED');
    expect((await caught(t.request({ op: 'ping' })))?.code).toBe('BRIDGE_EXITED');
    await t.close();
    expect(liveChildren(r)).toBe(0);
  });

  test('the agent dies mid-session: a clear stale-agent error (SESSION_LOST), the health check says dead, close() does not hang', async () => {
    r = await rig();
    const t = await start();
    const sap = await SapGuiSession.attach(t, { timeoutMs: 2000, pollMs: 10 });
    expect(await sap.healthCheck()).toBe(true);
    await r.agent.crash();
    const started = Date.now();
    expect(await sap.healthCheck()).toBe(false);
    const error = await caught(t.request({ op: 'ping' }));
    expect(error).toBeInstanceOf(SapGuiTransportError);
    expect(error?.code).toBe('SESSION_LOST');
    expect(error?.message).toMatch(/remote desktop host's agent stopped answering/);
    expect(error?.message).toMatch(/RDP session|connected and unlocked/);
    expect(Date.now() - started).toBeLessThan(4000);
    await t.close(); // no agent to ask: must not throw or wait for it
  });

  test('DENIED when REMOTE_ALLOW lacks sap: says to add it, and starts nothing', async () => {
    r = await rig(['http', 'db']);
    const error = await caught(start());
    expect(error).toBeInstanceOf(SapGuiTransportError);
    expect(error?.code).toBe('ERROR');
    expect(error?.message).toContain('REMOTE_ALLOW must include "sap"');
    expect(error?.message).toContain('refused');
    expect(liveChildren(r)).toBe(0);
  });

  test('negative control: with sap allowed the same start works', async () => {
    r = await rig(['sap']);
    const t = await start();
    expect(await t.request({ op: 'ping' })).toBe('pong');
    await t.close();
  });
});

test.describe('the conformance suite through the remote transport', () => {
  test('passes everything against the stand-in bridge', async () => {
    r = await rig();
    const t = await start({ requestTimeoutMs: 3000 });
    await t.request(attach);
    const report = await runConformance(t);
    await t.close();
    expect(report.results.filter((x) => x.status === 'fail')).toEqual([]);
    expect(report.passed).toBeGreaterThanOrEqual(14);
    expect(liveChildren(r)).toBe(0);
  });

  test('negative control: the suite notices a remote transport that mislabels NOT_FOUND', async () => {
    r = await rig();
    const real = await start({ requestTimeoutMs: 3000 });
    await real.request(attach);
    const wrapped: SapGuiTransport = {
      request: (c: SapGuiCommand) => real.request(c).catch((e: SapGuiTransportError) => Promise.reject(e.code === 'NOT_FOUND' ? new SapGuiTransportError(e.message, 'ERROR') : e)),
      close: () => real.close(),
    };
    const failed = (await runConformance(wrapped)).results.filter((x) => x.status === 'fail').map((x) => x.id);
    await wrapped.close();
    expect(failed).toContain('err-not-found');
  });
});

test.describe('the shared line codec', () => {
  test('encodes one request per line and decodes ready, replies, errors with their codes, and junk', () => {
    expect(encodeRequest(3, { op: 'get', id: 'a\nb', prop: 'text' })).toBe('{"rid":3,"op":"get","id":"a\\nb","prop":"text"}');
    expect(decodeLine('{"rid":0,"ok":true}')).toEqual({ kind: 'ready' });
    expect(decodeLine('{"rid":4,"ok":true}')).toEqual({ kind: 'reply', rid: 4, ok: true, value: null });
    const bad = decodeLine('{"rid":5,"ok":false,"error":"x","code":"SESSION_LOST"}');
    expect(bad).toMatchObject({ kind: 'reply', rid: 5, ok: false, error: { code: 'SESSION_LOST', message: 'x' } });
    expect(decodeLine('{"rid":5,"ok":false,"error":"x","code":"WHATEVER"}')).toMatchObject({ error: { code: 'ERROR' } });
    expect(decodeLine('not json')).toEqual({ kind: 'junk' });
    expect(decodeLine('null')).toEqual({ kind: 'junk' });
  });
});
