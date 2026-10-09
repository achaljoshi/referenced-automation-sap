import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect } from '@playwright/test';
import { ensureLoggedIn, loadCreated } from '../../src';
import { countingTest, creds } from './countingTest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sapdata-fixture-'));

const test = countingTest({ opened: 0 });
test.use({ sapGuiMode: 'attach' });
test.describe.configure({ mode: 'serial' });
const saved: Record<string, string | undefined> = {};
test.beforeAll(() => {
  saved.SAP_GUI_DATA_DIR = process.env.SAP_GUI_DATA_DIR;
  process.env.SAP_GUI_DATA_DIR = dir;
});
test.afterAll(() => {
  if (saved.SAP_GUI_DATA_DIR === undefined) delete process.env.SAP_GUI_DATA_DIR;
  else process.env.SAP_GUI_DATA_DIR = saved.SAP_GUI_DATA_DIR;
});


const cleaned: string[] = [];

test('a passing test creates an order and registers its cleanup', async ({ sap, sapData }) => {
  await ensureLoggedIn(sap, creds);
  await sap.startTransaction('VA01');
  await sap.setText('wnd[0]/usr/ctxtVBAK-AUART', 'OR');
  await sap.sendVKey(0);
  await sap.getByTooltip('Save').click();
  const id = await sapData.captureFromStatusBar('SalesOrder', /Order (\d+) has been saved/, {
    cleanup: async (s) => {
      // cleanup starts from the start screen, whatever state the test left SAP in
      cleaned.push(`${id}@${await s.getText('wnd[0]')}`);
    },
  });
});

test.fail('a FAILING test still gets its cleanup (expected to fail)', async ({ sap, sapData }) => {
  await ensureLoggedIn(sap, creds);
  sapData.record('Customer', 'C-FAILED-TEST', { cleanup: async () => void cleaned.push('C-FAILED-TEST') });
  expect(1).toBe(2);
});

test('both objects were cleaned, newest first-per-test, and the audit list says so', async () => {
  expect(cleaned).toEqual(['4711@SAP Easy Access', 'C-FAILED-TEST']);
  const audit = loadCreated(dir);
  expect(audit.map((o) => `${o.id}:${o.status}`)).toEqual(['4711:cleaned', 'C-FAILED-TEST:cleaned']);
});
