import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { appendCreated, createSampleSapSystem, formatCreated, loadCreated, orphans, SapDataRegistry, SapGuiSession } from '../../src';
import { FAST } from './support';

const cli = path.resolve(__dirname, '../../dist/cli/data.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sapdata-'));

async function savedOrder() {
  const fake = createSampleSapSystem({ transitionDelayMs: 10 });
  const sap = await SapGuiSession.attach(fake, FAST);
  await sap.setText('wnd[0]/usr/txtRSYST-MANDT', '100');
  await sap.setText('wnd[0]/usr/txtRSYST-BNAME', 'TESTUSER');
  await sap.setText('wnd[0]/usr/pwdRSYST-BCODE', 'correct-horse');
  await sap.sendVKey(0);
  await sap.startTransaction('VA01');
  await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR');
  await sap.sendVKey(0);
  await sap.getByTooltip('Save').click(); // status bar: "Standard Order 4711 has been saved"
  return sap;
}

test.describe('capturing what a test created', () => {
  test('reads the object number out of the status bar message and registers it', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 'create order');
    const id = await registry.captureFromStatusBar('SalesOrder', /Order (\d+) has been saved/);
    expect(id).toBe('4711');
    expect(registry.items).toMatchObject([{ type: 'SalesOrder', id: '4711', test: 'create order', status: 'created', system: 'FAKE', client: '100', user: 'TESTUSER' }]);
  });

  test('uses the whole match when the pattern has no group', async () => {
    const sap = await savedOrder();
    expect(await new SapDataRegistry(sap, 't').captureFromStatusBar('Order', /\d{4}/)).toBe('4711');
  });

  test('a save that did not happen is an error that quotes what SAP actually said', async () => {
    const fake = createSampleSapSystem({ transitionDelayMs: 0 });
    const sap = await SapGuiSession.attach(fake, FAST);
    const registry = new SapDataRegistry(sap, 't');
    await expect(registry.captureFromStatusBar('SalesOrder', /Order (\d+)/)).rejects.toThrow(/expected the status bar to report a SalesOrder.*but it says: "\(empty\)"/);
    expect(registry.items).toHaveLength(0);
  });
});

test.describe('cleanup', () => {
  test('runs newest first, and one failure does not stop the rest', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 't');
    const ran: string[] = [];
    registry.record('Customer', 'C1', { cleanup: async () => void ran.push('C1') });
    registry.record('Order', 'O1', { cleanup: async () => { ran.push('O1'); throw new Error('document is locked by another user'); } });
    registry.record('Delivery', 'D1', { cleanup: async () => void ran.push('D1') });

    const result = await registry.cleanup();
    expect(ran).toEqual(['D1', 'O1', 'C1']); // reverse order: the delivery before the order it belongs to
    expect(result.map((r) => `${r.id}:${r.status}`)).toEqual(['C1:cleaned', 'O1:cleanup-failed', 'D1:cleaned']);
    expect(result.find((r) => r.id === 'O1')?.note).toContain('locked by another user');
  });

  test('an object with no cleanup registered is reported as an orphan, not silently ignored', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 't');
    registry.record('Customer', 'C9');
    const [only] = await registry.cleanup();
    expect(only).toMatchObject({ status: 'cleanup-failed', note: expect.stringContaining('no cleanup was registered') });
  });

  test('keep: true is listed but never cleaned, and is not an orphan', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 't');
    let touched = false;
    registry.record('Material', 'M1', { keep: true, cleanup: async () => void (touched = true) });
    const result = await registry.cleanup();
    expect(touched).toBe(false);
    expect(result[0]?.status).toBe('kept');
    expect(orphans(result)).toEqual([]);
  });

  test('cleanup gets the live session, so it can drive SAP', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 't');
    let sawTitle = '';
    registry.record('Order', '4711', { cleanup: async (s) => void (sawTitle = await s.getText('wnd[0]')) });
    await registry.cleanup();
    expect(sawTitle).toContain('Create Standard Order');
  });
});

test.describe('SAP-05: cleanups run one at a time on the session', () => {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  test('a cleanup that times out is signalled and AWAITED: the next cleanup never starts while it is still running', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 't', { cleanupTimeoutMs: 60, cleanupGraceMs: 2_000 });
    const timeline: string[] = [];
    let slowSignalAborted = false;
    // newest first: "slow" runs first, then "fast"
    registry.record('Fast', 'F1', { cleanup: async () => void timeline.push('fast:start', 'fast:end') });
    registry.record('Slow', 'S1', {
      cleanup: async (_sap, { signal }) => {
        timeline.push('slow:start');
        await sleep(250); // outlives its 60 ms limit, does not look at the signal until it is done
        slowSignalAborted = signal.aborted;
        timeline.push('slow:end');
      },
    });
    const result = await registry.cleanup();
    expect(timeline).toEqual(['slow:start', 'slow:end', 'fast:start', 'fast:end']); // old code: slow:start, fast:start, fast:end, slow:end
    expect(slowSignalAborted).toBe(true);
    expect(result.map((o) => `${o.id}:${o.status}`)).toEqual(['F1:cleaned', 'S1:cleanup-failed']);
    expect(result.find((o) => o.id === 'S1')?.note).toContain('took longer than 60ms');
  });

  test('a cleanup that will not stop even when asked blocks the rest: they are marked failed, not run concurrently', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 't', { cleanupTimeoutMs: 40, cleanupGraceMs: 80 });
    let fastRan = false;
    registry.record('Fast', 'F1', { cleanup: async () => void (fastRan = true) });
    registry.record('Stuck', 'S1', { cleanup: () => new Promise<void>(() => undefined) });
    const result = await registry.cleanup();
    expect(fastRan).toBe(false);
    const fast = result.find((o) => o.id === 'F1');
    expect(fast?.status).toBe('cleanup-failed');
    expect(fast?.note).toContain('not attempted');
    expect(fast?.note).toContain('Stuck S1');
    expect(result.find((o) => o.id === 'S1')?.note).toContain('did not stop within 80ms');
  });

  test('a cleanup that throws is simply a failure; the next one still runs', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 't');
    registry.record('A', 'A1', { cleanup: async () => undefined });
    registry.record('B', 'B1', { cleanup: async () => Promise.reject(new Error('boom')) });
    expect((await registry.cleanup()).map((o) => `${o.id}:${o.status}`)).toEqual(['A1:cleaned', 'B1:cleanup-failed']);
  });
});

test.describe('unique values', () => {
  test('carry the worker index and a random part, so two workers (or two runs) cannot collide', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 't');
    const saved = { worker: process.env.TEST_WORKER_INDEX, random: Math.random };
    try {
      process.env.TEST_WORKER_INDEX = '7';
      Math.random = () => 0;
      const a = registry.unique('X', 12); // 'X' + 11 characters: time(5) counter(2) worker(1) random(3)
      process.env.TEST_WORKER_INDEX = '9';
      Math.random = () => 0.5;
      const b = registry.unique('X', 12);
      expect(a[8]).toBe('7');
      expect(b[8]).toBe('9');
      expect(a.slice(-3)).toBe('000');
      expect(b.slice(-3)).not.toBe('000');
    } finally {
      if (saved.worker === undefined) delete process.env.TEST_WORKER_INDEX;
      else process.env.TEST_WORKER_INDEX = saved.worker;
      Math.random = saved.random;
    }
  });

  test('differ every time, keep the prefix and respect the length', async () => {
    const sap = await savedOrder();
    const registry = new SapDataRegistry(sap, 't');
    const values = Array.from({ length: 200 }, () => registry.unique('CUST', 12));
    expect(new Set(values).size).toBe(200);
    expect(values.every((v) => v.startsWith('CUST') && v.length <= 12)).toBe(true);
    expect(registry.unique('A', 6)).toHaveLength(6);
  });

  test('refuses when there is not enough room to be unique', async () => {
    const sap = await savedOrder();
    expect(() => new SapDataRegistry(sap, 't').unique('CUSTOMER', 10)).toThrow(/too few to avoid collisions/);
  });
});

test.describe('SAP-05: `sap-gui-data` as a gate', () => {
  const run = (...args: string[]) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  const entry = (status: string, id: string) => JSON.stringify({ type: 'SalesOrder', id, test: 't', at: 'now', status });

  test('`list --fail-on-orphans` exits 1 while something is left, 0 when everything was cleaned', () => {
    const bad = tmp();
    fs.writeFileSync(path.join(bad, 'created-1.jsonl'), `${entry('cleaned', '1')}\n${entry('cleanup-failed', '2')}\n`);
    const failing = run('list', '--dir', bad, '--fail-on-orphans');
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('1 object(s) need cleaning by hand');
    expect(run('list', '--dir', bad).status).toBe(0); // plain `list` only reports

    const good = tmp();
    fs.writeFileSync(path.join(good, 'created-1.jsonl'), `${entry('cleaned', '1')}\n`);
    expect(run('list', '--dir', good, '--fail-on-orphans').status).toBe(0);
  });

  test('--require-data: no data directory is exit 2 (the SAP tests did not run), not a pass', () => {
    const missing = path.join(tmp(), 'nothing-here');
    expect(run('orphans', '--dir', missing).status).toBe(0); // legacy: nothing recorded, nothing to clean
    const required = run('orphans', '--dir', missing, '--require-data');
    expect(required.status).toBe(2);
    expect(required.stderr).toContain('did the SAP tests run');
  });

  test('a damaged list is exit 2 with a message, never a stack trace and never a quiet pass', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'created-1.jsonl'), `${entry('cleanup-failed', '1')}\n{"type":"SalesOrd\n`);
    const result = run('orphans', '--dir', dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('created-1.jsonl line 2 is not valid JSON');
    expect(result.stderr).not.toContain('at JSON.parse');
  });
});

test.describe('audit list and CLI', () => {
  const sample = (status: 'cleaned' | 'cleanup-failed' | 'kept', id: string) => ({ type: 'SalesOrder', id, test: 't', at: 'now', status, system: 'QA1', client: '100', user: 'U' });

  test('written by processes, read back together; orphans are the unfinished ones', () => {
    const dir = tmp();
    appendCreated([sample('cleaned', '1'), sample('cleanup-failed', '2')], dir);
    appendCreated([sample('kept', '3')], dir);
    const all = loadCreated(dir);
    expect(all.map((o) => o.id)).toEqual(['1', '2', '3']);
    expect(orphans(all).map((o) => o.id)).toEqual(['2']);
    expect(formatCreated(all)).toContain('cleanup-failed');
  });

  test('sap-gui-data orphans exits 1 and names what to clean; exits 0 when nothing is left', () => {
    const dirBad = tmp();
    appendCreated([sample('cleanup-failed', '4711')], dirBad);
    const bad = spawnSync('node', [cli, 'orphans', '--dir', dirBad], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('4711');

    const dirGood = tmp();
    appendCreated([sample('cleaned', '1')], dirGood);
    expect(spawnSync('node', [cli, 'orphans', '--dir', dirGood], { encoding: 'utf8' }).status).toBe(0);
    expect(JSON.parse(spawnSync('node', [cli, 'list', '--dir', dirGood, '--json'], { encoding: 'utf8' }).stdout)).toHaveLength(1);
  });
});
