import { expect, test } from '@playwright/test';
import { createSampleSapSystem, logon, sapGuiTest, SapGuiSession, type FakeSapGui } from '../../src';
import { test as supportTest } from '../sapgui/support/sapTest';
import { test as fakeTest } from './sapFakeTest';

/**
 * `loggedInSap` is part of the package's own `sapGuiTest`: any generated (or hand-written) test can ask for it. `sap` stays what it
 * was - the connection as it is, which is the logon screen after a new connection.
 */
fakeTest('loggedInSap logs on from the logon screen and is the same session as `sap`', async ({ sap, loggedInSap }) => {
  expect(loggedInSap).toBe(sap);
  expect(await loggedInSap.getText('wnd[0]')).toBe('SAP Easy Access');
});

fakeTest('`sap` alone is NOT logged on: a recording of the logon starts from the logon screen', async ({ sap }) => {
  expect(await sap.exists('wnd[0]/usr/pwdRSYST-BCODE')).toBe(true);
  expect(await sap.exists('wnd[0]/tbar[0]/okcd')).toBe(false);
});

fakeTest('loggedInSap lets a recording made inside SAP run: its first step finds the command field', async ({ loggedInSap: sap }) => {
  await sap.startTransaction('VA01');
  expect(await sap.getText('wnd[0]')).toBe('Create Sales Order: Initial Screen');
});

test('tests/sapgui/support/sapTest.ts re-exports the package test, so its samples get loggedInSap from the framework', () => {
  expect(supportTest).toBe(sapGuiTest);
});

let alreadyLoggedOn: FakeSapGui | undefined;
const attachedToOpenSession = fakeTest.extend({
  sapGuiTransport: [
    async ({}, use) => {
      await use(async () => {
        const fake = createSampleSapSystem({ transitionDelayMs: 10 });
        // somebody logged on before the test connected (attach mode on a session that is already open)
        await logon(await SapGuiSession.attach(fake, { timeoutMs: 3_000, pollMs: 10 }), { client: '100', user: 'TESTUSER', password: 'correct-horse' });
        fake.calls.length = 0;
        alreadyLoggedOn = fake;
        return fake;
      });
    },
    { scope: 'worker' },
  ],
});

attachedToOpenSession('an already logged-on session is left alone: nothing is typed into SAP, whatever the credentials say', async ({ loggedInSap: sap }) => {
  expect(await sap.getText('wnd[0]')).toBe('SAP Easy Access');
  expect(alreadyLoggedOn?.calls).toEqual([]); // no setText, no Enter: ensureLoggedIn found no logon screen
});
