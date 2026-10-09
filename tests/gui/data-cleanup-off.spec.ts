import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import { ensureLoggedIn, loadCreated } from '../../src';
import { countingTest, creds } from './countingTest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapdata-off-'));

const test = countingTest({ opened: 0 });
test.use({ sapGuiMode: 'attach' });
test.describe.configure({ mode: 'serial' });
const saved: Record<string, string | undefined> = {};
test.beforeAll(() => {
  saved.SAP_GUI_DATA_DIR = process.env.SAP_GUI_DATA_DIR;
  saved.SAP_GUI_CLEANUP = process.env.SAP_GUI_CLEANUP;
  process.env.SAP_GUI_DATA_DIR = dir;
  process.env.SAP_GUI_CLEANUP = 'off';
});
test.afterAll(() => {
  if (saved.SAP_GUI_DATA_DIR === undefined) delete process.env.SAP_GUI_DATA_DIR;
  else process.env.SAP_GUI_DATA_DIR = saved.SAP_GUI_DATA_DIR;
  if (saved.SAP_GUI_CLEANUP === undefined) delete process.env.SAP_GUI_CLEANUP;
  else process.env.SAP_GUI_CLEANUP = saved.SAP_GUI_CLEANUP;
});


let cleanupRan = false;

test('with SAP_GUI_CLEANUP=off the test leaves its data for inspection', async ({ sap, sapData }) => {
  await ensureLoggedIn(sap, creds);
  sapData.record('SalesOrder', '4711', { cleanup: async () => void (cleanupRan = true) });
});

test('nothing was cleaned, but the audit list still names it as an orphan', async () => {
  expect(cleanupRan).toBe(false);
  expect(loadCreated(dir)).toMatchObject([{ id: '4711', status: 'created' }]);
});
