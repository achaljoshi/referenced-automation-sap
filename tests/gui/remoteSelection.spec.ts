import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { remote, testing } from '@automation/referenced-automation-utils';
import { releaseRemoteHost, SapConnection, selectedTransport, startRealTransport } from '../../src';
import { liveChildren, remoteEnv, rig, withEnv, type Rig } from './remoteSupport';

// Tested ONLY against the stand-in agent (utils testing.StandInAgent) hosting the stand-in bridge. NOT VERIFIED on a real RDP host with real SAP GUI.
test.describe.configure({ mode: 'serial' });

const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const connection = (mode: 'attach' | 'open' = 'attach') => new SapConnection({ sapGuiMode: mode, sapGuiTransport: undefined, sapGuiReuse: undefined });

let r: Rig | undefined;
test.afterEach(async () => {
  await releaseRemoteHost().catch(() => undefined);
  await r?.done();
  r = undefined;
});

test.describe('SAP_GUI_TRANSPORT selects the remote transport', () => {
  test('"remote" is accepted in any case; anything else is refused with the three valid values', async () => {
    await withEnv({ SAP_GUI_TRANSPORT: 'remote' }, () => expect(selectedTransport()).toBe('remote'));
    await withEnv({ SAP_GUI_TRANSPORT: 'REMOTE' }, () => expect(selectedTransport()).toBe('remote'));
    await withEnv({ SAP_GUI_TRANSPORT: 'java' }, () => expect(selectedTransport()).toBe('java'));
    await withEnv({ SAP_GUI_TRANSPORT: undefined }, () => expect(selectedTransport()).toBe('powershell'));
    await withEnv({ SAP_GUI_TRANSPORT: 'rdp' }, () => expect(() => selectedTransport()).toThrow('SAP_GUI_TRANSPORT must be "powershell", "java" or "remote" (found "rdp")'));
  });

  test('remote without REMOTE_ENABLED says what to set, and leaves nothing remembered', async () => {
    await withEnv({ SAP_GUI_TRANSPORT: 'remote', REMOTE_ENABLED: undefined }, async () => {
      await expect(startRealTransport()).rejects.toThrow(/SAP_GUI_TRANSPORT=remote needs the remote desktop host: set REMOTE_ENABLED=true/);
    });
  });

  test('starts the bridge on the stand-in host, names the transport, and release() leaves no process and no half-closed host', async () => {
    r = await rig();
    await withEnv(remoteEnv(r.dir), async () => {
      const started = await startRealTransport();
      expect(started.name).toBe('PowerShell on the remote desktop host');
      expect(started.release).toBeDefined();
      expect(await started.transport.request({ op: 'ping' })).toBe('pong');
      expect(liveChildren(r!)).toBe(1);
      await started.transport.close();
      expect(liveChildren(r!)).toBe(0);
      await started.release!();
      // a second start connects afresh through a new RemoteHost instead of finding a closed one
      const again = await startRealTransport();
      expect(await again.transport.request({ op: 'ping' })).toBe('pong');
      await again.transport.close();
      await again.release!();
      expect(liveChildren(r!)).toBe(0);
    });
  });

  test('DENIED (REMOTE_ALLOW without sap) names REMOTE_ALLOW; fixing it works at once - the failure is not remembered', async () => {
    r = await rig();
    await withEnv({ ...remoteEnv(r.dir), REMOTE_ALLOW: 'http,db' }, async () => {
      await expect(startRealTransport()).rejects.toThrow(/REMOTE_ALLOW must include "sap"/);
    });
    await withEnv({ ...remoteEnv(r.dir), REMOTE_ALLOW: 'http,db,sap' }, async () => {
      const started = await startRealTransport();
      expect(await started.transport.request({ op: 'ping' })).toBe('pong');
      await started.transport.close();
      await started.release!();
    });
  });
});

test.describe('the sap fixture with the remote transport', () => {
  test('one worker only, in every mode - but not for the simulator or a custom transport', async () => {
    await withEnv({ SAP_GUI_TRANSPORT: 'remote', SAP_GUI_SIMULATOR: 'false' }, async () => {
      for (const mode of ['attach', 'open'] as const) {
        expect(() => connection(mode).assertSessionNotShared(2)).toThrow(/SAP_GUI_TRANSPORT=remote with 2 workers.*same SAP GUI.*--workers=1/s);
        connection(mode).assertSessionNotShared(1);
      }
      new SapConnection({ sapGuiMode: 'attach', sapGuiTransport: () => ({ request: async () => null, close: async () => undefined }), sapGuiReuse: undefined }).assertSessionNotShared(8);
    });
    await withEnv({ SAP_GUI_TRANSPORT: 'remote', SAP_GUI_SIMULATOR: 'true' }, () => connection('open').assertSessionNotShared(8));
    // negative control: without the remote transport, mode=open still allows many workers
    await withEnv({ SAP_GUI_TRANSPORT: 'powershell', SAP_GUI_SIMULATOR: 'false' }, () => connection('open').assertSessionNotShared(8));
  });

  test('canRun is true for the remote transport on any OS', async () => {
    await withEnv({ SAP_GUI_TRANSPORT: 'remote', SAP_GUI_SIMULATOR: 'false' }, () => expect(connection().canRun).toBe(true));
    if (process.platform !== 'win32') await withEnv({ SAP_GUI_TRANSPORT: 'powershell', SAP_GUI_SIMULATOR: 'false' }, () => expect(connection().canRun).toBe(false));
  });

  test('acquire attaches through the remote bridge; dispose stops the bridge; releaseHost closes the host', async () => {
    r = await rig();
    await withEnv(remoteEnv(r.dir), async () => {
      const c = connection();
      const session = await c.acquire();
      expect(await session.healthCheck()).toBe(true);
      expect(await session.get('wnd[0]/usr/txtRSYST-MANDT', 'text')).toBeDefined();
      expect(liveChildren(r!)).toBe(1);
      await c.dispose();
      expect(liveChildren(r!)).toBe(0);
      expect(await remote.getRemoteHost().then((h) => h?.healthCheck())).toBe(true); // dispose alone keeps the host for the next test
      await c.releaseHost();
      await c.releaseHost(); // idempotent
      expect(liveChildren(r!)).toBe(0);
    });
  });

  test('a dead agent is reported by the health check and the next acquire reconnects through a fresh host', async () => {
    r = await rig();
    let second: InstanceType<typeof testing.StandInAgent> | undefined;
    try {
      await withEnv(remoteEnv(r.dir), async () => {
        const c = connection();
        const first = await c.acquire();
        expect(await first.healthCheck()).toBe(true);
        await r!.agent.crash();
        expect(await first.healthCheck()).toBe(false);
        second = new testing.StandInAgent({ shareDir: r!.dir });
        await second.start();
        const next = await c.acquire();
        expect(next).not.toBe(first);
        expect(await next.healthCheck()).toBe(true);
        await c.dispose();
        await c.releaseHost();
      });
    } finally {
      await second?.stop();
    }
  });
});

test.describe('worker teardown', () => {
  test('the sapConnection worker fixture disposes the bridge and then releases the remote host (checked in the source: a worker fixture cannot be observed from inside a test)', () => {
    const source = fs.readFileSync(path.join(root, 'src/gui/fixtures.ts'), 'utf8');
    expect(source).toMatch(/await use\(connection\);\s*await connection\.dispose\(\);\s*await connection\.releaseHost\(\);/);
  });
});

test.describe('sap-gui-doctor --conformance with the remote transport', () => {
  const doctor = (env: Record<string, string>, ...args: string[]) =>
    run(process.execPath, [path.join(root, 'dist/cli/doctor.js'), ...args], { cwd: os.tmpdir(), env: { ...process.env, SAP_GUI_SIMULATOR: 'false', ...env }, timeout: 40_000 }).then(
      (out) => ({ code: 0, out: out.stdout + out.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
    );

  test('runs the suite through the stand-in host and says which transport it ran', async () => {
    test.setTimeout(60_000);
    r = await rig();
    const result = await doctor(remoteEnv(r.dir), '--conformance');
    expect(result.out).toContain('using SAP GUI on the remote desktop host');
    expect(result.out).toContain('bridge started (PowerShell on the remote desktop host)');
    expect(result.out).toContain('Transport conformance (PowerShell on the remote desktop host)');
    expect(result.out).toContain('This transport conforms');
    expect(result.code).toBe(0);
    expect(liveChildren(r)).toBe(0); // the CLI released the remote process
  });

  test('negative control: without REMOTE_ENABLED it fails and says what is missing', async () => {
    test.setTimeout(60_000);
    r = await rig();
    const result = await doctor({ ...remoteEnv(r.dir), REMOTE_ENABLED: 'false' }, '--conformance');
    expect(result.code).toBe(1);
    expect(result.out).toContain('REMOTE_ENABLED=true');
    expect(result.out).not.toContain('This transport conforms');
  });
});
