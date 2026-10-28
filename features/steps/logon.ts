import { DataTable, createBdd } from 'playwright-bdd';
import { ensureLoggedIn, isOnLogonScreen, logon, sapExpect as expect, type SapCredentials } from '../../src';
import { test } from './fixtures';

// Steps for the logon feature: they call the same `logon` / `ensureLoggedIn` the "I am logged on to SAP" step uses, with
// credentials given in the scenario. Every value understands {{placeholders}}, so a password can come from {{env:SAP_PASSWORD}}.
const { Given, When, Then } = createBdd(test);

/** Where a refused logon leaves its message, for the steps that check what the user was told. */
const LOGON_ERROR = 'logon error';
const COMMAND_FIELD = 'wnd[0]/tbar[0]/okcd'; // exists on every screen once you are in
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function credentialsFrom(table: DataTable, vars: { interpolate(text: string): string }, markerDir: string): SapCredentials {
  const given = table.rowsHash();
  const value = (key: string): string | undefined =>
    given[key] === undefined ? undefined : vars.interpolate(given[key]);
  // an empty cell is an empty value ("no password"), not "use the default"
  return {
    client: value('client'),
    user: value('user'),
    password: value('password'),
    language: value('language'),
    markerDir,
  };
}

Given('SAP is showing the logon screen', async ({ sap }) => {
  if (!(await isOnLogonScreen(sap))) await sap.logoff();
  await expect
    .poll(() => isOnLogonScreen(sap), { message: 'SAP is not showing the logon screen' })
    .toBe(true);
});

When('I log on with:', async ({ sap, vars, logonMarkerDir }, credentials: DataTable) => {
  await logon(sap, credentialsFrom(credentials, vars, logonMarkerDir));
});

When('I try to log on with:', async ({ sap, sapScenario, vars, logonMarkerDir }, credentials: DataTable) => {
  sapScenario.delete(LOGON_ERROR);
  try {
    await logon(sap, credentialsFrom(credentials, vars, logonMarkerDir));
  } catch (error) {
    sapScenario.set(LOGON_ERROR, error instanceof Error ? error.message : String(error));
  }
});

When('I make sure I am logged on with:', async ({ sap, vars, logonMarkerDir }, credentials: DataTable) => {
  await ensureLoggedIn(sap, credentialsFrom(credentials, vars, logonMarkerDir));
});

When('I log off', async ({ sap }) => {
  await sap.logoff();
});

Then(
  'the logon is refused with a message matching {string}',
  async ({ sapScenario }, pattern: string) => {
    const message = sapScenario.get(LOGON_ERROR);
    expect(message, 'the logon was not refused').toBeDefined();
    expect(message).toMatch(new RegExp(pattern));
  },
);

// Fails when no refusal was recorded: "nothing to leak" on a logon that did not fail would prove nothing.
Then('the logon message does not contain {string}', async ({ sapScenario, vars }, text: string) => {
  const message = sapScenario.get(LOGON_ERROR);
  expect(message, 'the logon was not refused, so there is no message to check').toBeDefined();
  expect(message).not.toContain(vars.interpolate(text));
});

// Waits: after a log-off SAP needs a moment to show the logon screen again.
Then('the logon screen is showing', async ({ sap }) => {
  await expect
    .poll(() => isOnLogonScreen(sap), { message: 'SAP is not showing the logon screen' })
    .toBe(true);
});

Then('the command field is available', async ({ sap }) => {
  await expect(sap.locator(COMMAND_FIELD)).toExist();
});

// The whole title, not part of it ("the screen title contains" is the looser step).
Then('the screen title is {string}', async ({ sap, vars }, title: string) => {
  await expect(sap).toHaveTitle(new RegExp(`^${escapeRegExp(vars.interpolate(title))}$`));
});
