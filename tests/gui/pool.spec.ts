import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { createSampleSapSystem, logon, SapConnection, SapUserPool } from '../../src';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sappool-'));
const fast = { pollMs: 10 };

test.describe('leasing', () => {
  test('hands out distinct users, never the same one twice', async () => {
    const dir = tmp();
    const pool = new SapUserPool(['U1', 'U2', 'U3'], { dir, ...fast });
    const leases = [await pool.lease(500), await pool.lease(500), await pool.lease(500)];
    expect(leases.map((l) => l.user).sort()).toEqual(['U1', 'U2', 'U3']);
    leases.forEach((l) => l.release());
  });

  test('a waiter gets a user as soon as one is released', async () => {
    const pool = new SapUserPool(['U1'], { dir: tmp(), ...fast });
    const first = await pool.lease(500);
    const waiting = pool.lease(2000);
    setTimeout(() => first.release(), 150);
    expect((await waiting).user).toBe('U1');
  });

  test('when every user is taken, the error says who holds each one', async () => {
    const pool = new SapUserPool(['U1', 'U2'], { dir: tmp(), owner: 'worker 3', ...fast });
    await pool.lease(500);
    await pool.lease(500);
    const error = (await pool.lease(150).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/no free SAP user after 150ms - all 2 are leased/);
    expect(error.message).toContain(`U1: pid ${process.pid}`);
    expect(error.message).toContain('(worker 3)');
  });

  test('release is idempotent and frees the user', async () => {
    const pool = new SapUserPool(['U1'], { dir: tmp(), ...fast });
    const lease = await pool.lease(500);
    lease.release();
    lease.release();
    expect((await pool.lease(500)).user).toBe('U1');
  });

  test('pools for different systems do not interfere (scope)', async () => {
    const dir = tmp();
    const qa = new SapUserPool(['U1'], { dir, scope: 'QA1', ...fast });
    const uat = new SapUserPool(['U1'], { dir, scope: 'UAT1', ...fast });
    await qa.lease(500);
    expect((await uat.lease(500)).user).toBe('U1');
  });

  test('needs at least one user', () => {
    expect(() => new SapUserPool([])).toThrow(/at least one user/);
  });
});

test.describe('crashes and stale locks', () => {
  test('a lock left by a process that no longer exists is taken over', async () => {
    const dir = tmp();
    const pool = new SapUserPool(['U1'], { dir, ...fast });
    const dead = spawnSync('node', ['-e', '']); // a pid that has exited
    fs.writeFileSync(path.join(dir, 'default__U1.lock'), JSON.stringify({ user: 'U1', pid: dead.pid, host: os.hostname(), since: 'long ago' }));
    expect((await pool.lease(500)).user).toBe('U1');
  });

  test('a lock held by a live process is NOT taken over (negative control)', async () => {
    const dir = tmp();
    const pool = new SapUserPool(['U1'], { dir, ...fast });
    const live = spawn('node', ['-e', 'setTimeout(()=>{}, 5000)']);
    try {
      fs.writeFileSync(path.join(dir, 'default__U1.lock'), JSON.stringify({ user: 'U1', pid: live.pid, host: os.hostname(), since: 'now' }));
      await expect(pool.lease(200)).rejects.toThrow(/no free SAP user/);
    } finally {
      live.kill();
    }
  });

  test('a lock whose heartbeat stopped is stale, even if its pid cannot be checked (another machine)', async () => {
    const dir = tmp();
    const pool = new SapUserPool(['U1'], { dir, staleAfterMs: 100, ...fast });
    const file = path.join(dir, 'default__U1.lock');
    fs.writeFileSync(file, JSON.stringify({ user: 'U1', pid: process.pid, host: 'some-other-machine', since: 'earlier' }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
    expect((await pool.lease(500)).user).toBe('U1');
  });

  test('a lock from another machine with a fresh heartbeat is respected', async () => {
    const dir = tmp();
    const pool = new SapUserPool(['U1'], { dir, ...fast });
    fs.writeFileSync(path.join(dir, 'default__U1.lock'), JSON.stringify({ user: 'U1', pid: 1, host: 'some-other-machine', since: 'now' }));
    await expect(pool.lease(150)).rejects.toThrow(/no free SAP user/);
  });

  test('the heartbeat keeps a held lease from going stale', async () => {
    const dir = tmp();
    const holder = new SapUserPool(['U1'], { dir, staleAfterMs: 300, heartbeatMs: 50, ...fast });
    const lease = await holder.lease(500);
    await new Promise((r) => setTimeout(r, 700)); // well past staleAfterMs
    const contender = new SapUserPool(['U1'], { dir, staleAfterMs: 300, ...fast });
    await expect(contender.lease(150)).rejects.toThrow(/no free SAP user/);
    lease.release();
  });

  test('releasing never deletes a lock someone else has since taken', async () => {
    const dir = tmp();
    const pool = new SapUserPool(['U1'], { dir, ...fast });
    const lease = await pool.lease(500);
    const file = path.join(dir, 'default__U1.lock');
    fs.writeFileSync(file, JSON.stringify({ user: 'U1', pid: process.pid + 1, host: os.hostname(), since: 'taken over' }));
    lease.release();
    expect(fs.existsSync(file)).toBe(true);
  });
});

test.describe('across real processes', () => {
  test('two processes competing for one user: exactly one wins at a time', async () => {
    const dir = tmp();
    const script = `
      const { SapUserPool } = require(${JSON.stringify(path.resolve(__dirname, '../../dist'))}.concat('/gui/pool'));
      new SapUserPool(['ONLY'], { dir: ${JSON.stringify(dir)}, pollMs: 10 }).lease(3000)
        .then((l) => { console.log('LEASED'); setTimeout(() => { l.release(); }, 700); })
        .catch(() => console.log('REFUSED'));`;
    const start = Date.now();
    const run = () =>
      new Promise<{ out: string; at: number }>((resolve) => {
        const child = spawn('node', ['-e', script]);
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', () => resolve({ out: out.trim(), at: Date.now() - start }));
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.out).toContain('LEASED');
    expect(b.out).toContain('LEASED'); // the second waited for the first to release (neither was REFUSED)
    expect(Math.abs(a.at - b.at)).toBeGreaterThanOrEqual(500); // ... which is why they finished at least ~0.7s apart, not together
  });
});

test.describe('stress: many processes, few users', () => {
  test('six processes competing for two users never exceed two holders at any instant', async () => {
    test.setTimeout(60_000);
    const dir = tmp();
    const script = `
      const { SapUserPool } = require(${JSON.stringify(path.resolve(__dirname, '../../dist/gui/pool'))});
      new SapUserPool(['A', 'B'], { dir: ${JSON.stringify(dir)}, pollMs: 5 }).lease(30000).then((l) => {
        const from = Date.now();
        setTimeout(() => { const to = Date.now(); l.release(); console.log('SPAN ' + l.user + ' ' + from + ' ' + to); }, 150);
      }).catch((e) => console.log('FAILED ' + e.message));`;
    const run = () =>
      new Promise<string>((resolve) => {
        const child = spawn('node', ['-e', script]);
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', () => resolve(out));
      });
    const outputs = await Promise.all(Array.from({ length: 6 }, run));
    expect(outputs.join('')).not.toContain('FAILED');
    const spans = outputs
      .flatMap((o) => o.split('\n'))
      .filter((l) => l.startsWith('SPAN '))
      .map((l) => l.split(' '))
      .map(([, user, from, to]) => ({ user: user as string, from: Number(from), to: Number(to) }));
    expect(spans).toHaveLength(6);

    // Sweep line: the highest number of holders at any single instant, overall and per user.
    const peak = (items: typeof spans) => {
      const events = items.flatMap((i) => [{ at: i.from, d: 1 }, { at: i.to, d: -1 }]).sort((x, y) => x.at - y.at || x.d - y.d); // at a tie, releases count before acquisitions
      let now = 0;
      let max = 0;
      for (const e of events) max = Math.max(max, (now += e.d));
      return max;
    };
    expect(peak(spans)).toBeLessThanOrEqual(2);
    expect(peak(spans.filter((x) => x.user === 'A'))).toBe(1);
    expect(peak(spans.filter((x) => x.user === 'B'))).toBe(1);
  });
});

test.describe('integrated with the connection and logon', () => {
  test.beforeEach(() => {
    process.env.SAP_USER_POOL = 'U1,U2';
    process.env.SAP_GUI_POOL_DIR = tmp();
    process.env.SAP_GUI_POOL_TIMEOUT_MS = '500';
    process.env.SAP_GUI_SIMULATOR = 'true';
    process.env.SAP_PASSWORD_U1 = 'pw-for-u1';
    process.env.SAP_PASSWORD_U2 = 'pw-for-u2';
  });
  test.afterEach(() => {
    for (const k of ['SAP_USER_POOL', 'SAP_GUI_POOL_DIR', 'SAP_GUI_POOL_TIMEOUT_MS', 'SAP_GUI_SIMULATOR', 'SAP_PASSWORD_U1', 'SAP_PASSWORD_U2']) delete process.env[k];
  });

  const connectionFor = (user: string, password: string) =>
    new SapConnection({ sapGuiMode: 'open', sapGuiReuse: undefined, sapGuiTransport: () => createSampleSapSystem({ user, password, client: '100', transitionDelayMs: 0 }) });

  test('two workers get different users, each logs on with its own user and its own password', async () => {
    const a = connectionFor('U1', 'pw-for-u1');
    const b = connectionFor('U2', 'pw-for-u2');
    const sa = await a.acquire();
    const sb = await b.acquire();
    expect([sa.assignedUser, sb.assignedUser]).toEqual(['U1', 'U2']);
    await logon(sa, { client: '100' });
    await logon(sb, { client: '100' }); // would fail on the wrong password or user
    expect(await sa.exists('wnd[0]/usr/pwdRSYST-BCODE')).toBe(false);
    expect(await sb.exists('wnd[0]/usr/pwdRSYST-BCODE')).toBe(false);
    await a.dispose();
    await b.dispose();
  });

  test('a third worker waits, and gets the user back when a connection is disposed', async () => {
    const a = connectionFor('U1', 'pw-for-u1');
    const b = connectionFor('U2', 'pw-for-u2');
    await a.acquire();
    await b.acquire();
    const c = connectionFor('U1', 'pw-for-u1');
    await expect(c.acquire()).rejects.toThrow(/no free SAP user after 500ms/);
    await a.dispose(); // releases U1
    const session = await c.acquire();
    expect(session.assignedUser).toBe('U1');
    await b.dispose();
    await c.dispose();
  });

  test('a failed connection gives its user back instead of leaking the lease', async () => {
    const broken = new SapConnection({ sapGuiMode: 'open', sapGuiReuse: undefined, sapGuiTransport: () => { throw new Error('bridge would not start'); } });
    await expect(broken.acquire()).rejects.toThrow(/bridge would not start/);
    const ok = connectionFor('U1', 'pw-for-u1');
    expect((await ok.acquire()).assignedUser).toBe('U1');
    await ok.dispose();
  });
});
