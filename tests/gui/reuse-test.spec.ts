import { expect } from '@playwright/test';
import { ensureLoggedIn } from '../../src';
import { countingTest, creds } from './countingTest';

const perTest = { opened: 0 };
const fresh = countingTest(perTest);
fresh.use({ sapGuiReuse: 'test', sapGuiMode: 'attach' });
fresh.describe("sapGuiReuse: 'test' gives every test its own connection, starting at the logon screen", () => {
  fresh.describe.configure({ mode: 'serial' });
  fresh('first', async ({ sap }) => {
    expect(await sap.exists('wnd[0]/usr/pwdRSYST-BCODE')).toBe(true);
    await ensureLoggedIn(sap, creds);
  });

  fresh('second', async ({ sap }) => {
    expect(perTest.opened).toBe(2);
    expect(await sap.exists('wnd[0]/usr/pwdRSYST-BCODE')).toBe(true); // a new connection: logged out again
  });
});

