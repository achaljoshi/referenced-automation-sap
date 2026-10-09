import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import { ensureLoggedIn, loadInsights } from '../../src';
import { countingTest, creds } from './countingTest';

// Where this file's tests record what they do. The fixture reads it lazily; it is set in beforeAll (not at import) because one worker can load several files and a global set at import would leak between them.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapinsights-fixture-'));

const test = countingTest({ opened: 0 });
test.use({ sapGuiMode: 'attach' });
test.describe.configure({ mode: 'serial' });
const saved: Record<string, string | undefined> = {};
test.beforeAll(() => {
  saved.SAP_GUI_INSIGHTS_DIR = process.env.SAP_GUI_INSIGHTS_DIR;
  process.env.SAP_GUI_INSIGHTS_DIR = dir;
});
test.afterAll(() => {
  if (saved.SAP_GUI_INSIGHTS_DIR === undefined) delete process.env.SAP_GUI_INSIGHTS_DIR;
  else process.env.SAP_GUI_INSIGHTS_DIR = saved.SAP_GUI_INSIGHTS_DIR;
});


test('first test does something in VA01', async ({ sap }) => {
  await ensureLoggedIn(sap, creds);
  await sap.startTransaction('VA01');
  await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR');
});

test('the finished test left a record of its transactions and timings', async () => {
  const records = loadInsights(dir);
  expect(records).toHaveLength(1);
  expect(records[0]?.test).toContain('first test does something in VA01');
  expect(records[0]?.status).toBe('passed');
  expect(records[0]?.system).toBe('FAKE');
  const va01 = records[0]?.steps.filter((s) => s.tx === 'VA01') ?? [];
  expect(va01.map((s) => s.label)).toContain('set text');
  expect(records[0]?.steps.some((s) => s.serverMs !== undefined)).toBe(true); // round-trip steps carry SAP's own response time
});
