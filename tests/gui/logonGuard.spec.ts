import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  activeLogonCooldown,
  createSampleSapSystem,
  ensureLoggedIn,
  isLockRisk,
  logon,
  logonMarkerPath,
  readLogonFailure,
  SapGuiSession,
  SapLogonCooldownError,
  writeLogonFailure,
} from '../../src';

/**
 * A wrong logon is counted by SAP and a few of them lock the user. A test run that fails on it is started again by CI retries, by
 * the next test of the worker, by a person pressing "run" - so after a rejected logon the same client + user + password is refused,
 * without touching SAP, for SAP_LOGON_FAILURE_COOLDOWN_MIN minutes.
 */
const FAST = { timeoutMs: 3_000, pollMs: 10 };
const good = { client: '100', user: 'TESTUSER', password: 'correct-horse', language: 'EN' };
const wrong = { ...good, password: 'Wr0ng-pa55#word' };
const WRONG_STATUS = /Name or password is incorrect \(repeat logon\)/;

const SAVED = ['SAP_GUI_LOGON_MARKER_DIR', 'SAP_LOGON_FAILURE_COOLDOWN_MIN', 'ENV'] as const;
const saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]));
let dir = '';

test.describe.configure({ mode: 'serial' }); // they share process.env

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-logon-guard-'));
  process.env.SAP_GUI_LOGON_MARKER_DIR = dir;
  delete process.env.SAP_LOGON_FAILURE_COOLDOWN_MIN;
});
test.afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function fresh(options: Parameters<typeof createSampleSapSystem>[0] = {}) {
  const fake = createSampleSapSystem({ transitionDelayMs: 20, ...options });
  return { fake, sap: await SapGuiSession.attach(fake, FAST) };
}

/** What the session was asked to do to SAP: any typing or pressing at all. */
const touched = (fake: { calls: unknown[] }) => fake.calls.length;

test.describe('what the failure message says', () => {
  test('keeps SAP\'s own status text and says what to check - without the password', async () => {
    process.env.ENV = 'qa';
    const { sap } = await fresh();
    const error = (await logon(sap, wrong).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/still on the logon screen after sending Enter\. SAP's status bar says: "Name or password is incorrect \(repeat logon\)"/);
    expect(error.message).toContain('user "TESTUSER" in client "100"');
    expect(error.message).toContain('SAP_USER, SAP_CLIENT and SAP_PASSWORD');
    expect(error.message).toContain('.env.qa.local');
    expect(error.message).toMatch(/special characters.*double quotes.*SAP_PASSWORD="/s);
    expect(error.message).toMatch(/user may be locked/);
    expect(error.message).toMatch(/WARNING: repeated wrong logons LOCK the SAP user\. Do NOT run the tests again until the credentials are fixed/);
    expect(error.message).not.toContain('Wr0ng-pa55#word');
  });

  test('mentions the cooldown and the marker file when it armed it, and says nothing about it when the protection is off', async () => {
    const armed = (await logon((await fresh()).sap, wrong).catch((e: unknown) => e)) as Error;
    expect(armed.message).toContain('refuses to repeat the same logon for 15 minute(s)');
    expect(armed.message).toContain(logonMarkerPath(dir));

    const off = (await logon((await fresh()).sap, { ...wrong, cooldownMinutes: 0 }).catch((e: unknown) => e)) as Error;
    expect(off.message).not.toContain('refuses to repeat');
    expect(off.message).toMatch(WRONG_STATUS);
  });

  test('a locked user is reported with SAP\'s text and also arms the cooldown', async () => {
    const { sap, fake } = await fresh({ lockAfterFailures: 1 });
    const error = (await logon(sap, wrong).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/status bar says: "User TESTUSER is locked/);
    expect(fake.sample.locked).toBe(true);
    expect(readLogonFailure(dir)?.status).toMatch(/is locked/);
  });

  test('isLockRisk: rejected name/password and locked users (English and German texts), not other messages', () => {
    for (const status of ['Name or password is incorrect (repeat logon)', 'User TEST is locked', 'Name oder Kennwort ist nicht korrekt (Anmeldung wiederholen)', 'Benutzer ist gesperrt', 'Password logon no longer possible - too many failed attempts - user locked'])
      expect(isLockRisk(status), status).toBe(true);
    for (const status of ['', 'Client 999 is not available in this system', 'Standard Order 4711 has been saved'])
      expect(isLockRisk(status), status).toBe(false);
  });
});

test.describe('the marker', () => {
  test('holds client, user, a salted fingerprint of the password and a time - and the password is nowhere in the file', async () => {
    const before = Date.now();
    await logon((await fresh()).sap, wrong).catch(() => undefined);
    const file = logonMarkerPath(dir);
    const text = fs.readFileSync(file, 'utf8');
    const marker = JSON.parse(text);
    expect(marker.client).toBe('100');
    expect(marker.user).toBe('TESTUSER');
    expect(marker.status).toMatch(WRONG_STATUS);
    expect(Date.parse(marker.at)).toBeGreaterThanOrEqual(before - 1_000);
    expect(marker.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(marker.passwordFingerprint).toMatch(/^[0-9a-f]{48}$/);
    expect(text).not.toContain('Wr0ng-pa55#word');
    expect(text).not.toContain('pa55');

    // a second marker for the same password has another salt, so two files cannot be compared to find a shared password
    const first = marker;
    writeLogonFailure({ client: '100', user: 'TESTUSER', password: 'Wr0ng-pa55#word', status: 'x' }, dir);
    const second = readLogonFailure(dir);
    expect(second?.salt).not.toBe(first.salt);
    expect(second?.passwordFingerprint).not.toBe(first.passwordFingerprint);
  });

  test('is not under test-results (Playwright empties that folder at the start of every run) - the default is .sap-state', async () => {
    delete process.env.SAP_GUI_LOGON_MARKER_DIR;
    const file = logonMarkerPath();
    expect(path.relative(process.cwd(), file)).toBe(path.join('.sap-state', 'logon-failed.json'));
    expect(file).not.toContain('test-results');
    expect(fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8')).toMatch(/^\.sap-state\/$/m);
  });

  test('is not written for a pop-up after logon (password expired, already logged on): no lock risk', async () => {
    const { sap } = await fresh({ multipleLogon: true });
    await expect(logon(sap, { ...good, onMultipleLogon: 'fail' })).rejects.toThrow(/pop-up after logon/);
    expect(fs.existsSync(logonMarkerPath(dir))).toBe(false);
  });

  test('a damaged marker protects nothing and breaks nothing', async () => {
    fs.writeFileSync(logonMarkerPath(dir), '{ not json');
    const { sap } = await fresh();
    await logon(sap, good);
    expect(await sap.getText('wnd[0]')).toBe('SAP Easy Access');
  });
});

test.describe('the cooldown', () => {
  test('the same client, user and password is refused at once - nothing is typed into SAP, the user is not counted again', async () => {
    const first = await fresh({ lockAfterFailures: 3 });
    await expect(logon(first.sap, wrong)).rejects.toThrow(WRONG_STATUS);
    expect(first.fake.sample.failedLogons).toBe(1);

    // "run it again" - a retry, the next test, a re-run: a new session on the same SAP system
    const second = await fresh({ lockAfterFailures: 3 });
    const error = (await logon(second.sap, wrong).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(SapLogonCooldownError);
    expect(touched(second.fake)).toBe(0);
    expect(second.fake.sample.failedLogons).toBe(0);
    expect(await second.sap.exists('wnd[0]/usr/pwdRSYST-BCODE')).toBe(true); // still untouched on the logon screen
  });

  test('says what happened, when, and the three ways on - and never the password', async () => {
    await logon((await fresh()).sap, wrong).catch(() => undefined);
    const error = (await logon((await fresh()).sap, wrong).catch((e: unknown) => e)) as SapLogonCooldownError;
    expect(error.message).toContain('logon NOT attempted');
    expect(error.message).toContain('repeated wrong logons LOCK the SAP user');
    expect(error.message).toContain(error.marker.at);
    expect(error.message).toMatch(/"TESTUSER" in client "100" failed: "Name or password is incorrect/);
    expect(error.message).toMatch(/1\. fix the credentials .*changed password, user or client clears this stop by itself/);
    expect(error.message).toContain(`2. if the password was reset or the user unlocked in SAP and you are sure the current values are right: delete ${logonMarkerPath(dir)}`);
    expect(error.message).toMatch(/3\. wait \d+ more minute\(s\) \(SAP_LOGON_FAILURE_COOLDOWN_MIN=15; 0 turns this protection off/);
    expect(error.message).not.toContain('Wr0ng-pa55#word');
  });

  test('ensureLoggedIn (and so the loggedInSap fixture) is stopped too', async () => {
    await ensureLoggedIn((await fresh()).sap, wrong).catch(() => undefined);
    const second = await fresh();
    await expect(ensureLoggedIn(second.sap, wrong)).rejects.toBeInstanceOf(SapLogonCooldownError);
    expect(touched(second.fake)).toBe(0);
  });

  test('in the same session too: a retry on the logon screen that showed the error is refused', async () => {
    const { sap, fake } = await fresh({ lockAfterFailures: 3 });
    await expect(logon(sap, wrong)).rejects.toThrow(WRONG_STATUS);
    const calls = touched(fake);
    await expect(logon(sap, wrong)).rejects.toBeInstanceOf(SapLogonCooldownError);
    expect(touched(fake)).toBe(calls);
    expect(fake.sample.failedLogons).toBe(1);
  });

  test('a changed password clears the stop by itself, and a successful logon removes the marker', async () => {
    await logon((await fresh()).sap, wrong).catch(() => undefined);
    expect(fs.existsSync(logonMarkerPath(dir))).toBe(true);
    const { sap } = await fresh();
    await logon(sap, good); // the right password: not the same fingerprint, so it goes through
    expect(await sap.getText('wnd[0]')).toBe('SAP Easy Access');
    expect(fs.existsSync(logonMarkerPath(dir))).toBe(false);
  });

  test('a changed user or client is not stopped (and its own failure replaces the marker)', async () => {
    await logon((await fresh()).sap, wrong).catch(() => undefined);
    for (const other of [{ ...wrong, user: 'OTHERUSER' }, { ...wrong, client: '200' }]) {
      const attempt = await fresh();
      const error = (await logon(attempt.sap, other).catch((e: unknown) => e)) as Error;
      expect(error).not.toBeInstanceOf(SapLogonCooldownError);
      expect(error.message).toMatch(WRONG_STATUS);
      expect(touched(attempt.fake)).toBeGreaterThan(0); // it really tried
    }
    expect(readLogonFailure(dir)?.client).toBe('200');
  });

  test('the user name is compared case-insensitively (SAP user names are upper case)', async () => {
    await logon((await fresh()).sap, wrong).catch(() => undefined);
    await expect(logon((await fresh()).sap, { ...wrong, user: 'testuser' })).rejects.toBeInstanceOf(SapLogonCooldownError);
  });

  test('ends after the cooldown, and deleting the marker ends it at once', async () => {
    const credentials = { client: '100', user: 'TESTUSER', password: wrong.password };
    writeLogonFailure({ ...credentials, status: 'Name or password is incorrect' }, dir, Date.now() - 20 * 60_000);
    expect(activeLogonCooldown(credentials, 15, dir)).toBeUndefined();
    expect(activeLogonCooldown(credentials, 30, dir)?.remainingMs).toBeGreaterThan(9 * 60_000);
    await expect(logon((await fresh()).sap, wrong)).rejects.toThrow(WRONG_STATUS); // really tried: not a cooldown error

    await logon((await fresh()).sap, wrong).catch(() => undefined);
    fs.rmSync(logonMarkerPath(dir));
    await expect(logon((await fresh()).sap, wrong)).rejects.toThrow(WRONG_STATUS);
  });

  test('SAP_LOGON_FAILURE_COOLDOWN_MIN sets the length; 0 turns the protection off - nothing is written and every attempt goes to SAP', async () => {
    process.env.SAP_LOGON_FAILURE_COOLDOWN_MIN = '0';
    const first = await fresh({ lockAfterFailures: 5 });
    await expect(logon(first.sap, wrong)).rejects.toThrow(WRONG_STATUS);
    expect(fs.existsSync(logonMarkerPath(dir))).toBe(false);
    const second = await fresh({ lockAfterFailures: 5 });
    await expect(logon(second.sap, wrong)).rejects.toThrow(WRONG_STATUS);
    expect(touched(second.fake)).toBeGreaterThan(0);

    process.env.SAP_LOGON_FAILURE_COOLDOWN_MIN = '1';
    writeLogonFailure({ client: '100', user: 'TESTUSER', password: wrong.password, status: 'x' }, dir, Date.now() - 90_000);
    await expect(logon((await fresh()).sap, wrong)).rejects.toThrow(WRONG_STATUS); // 1.5 minutes ago, cooldown 1 minute: over

    process.env.SAP_LOGON_FAILURE_COOLDOWN_MIN = 'soon';
    await expect(logon((await fresh()).sap, wrong)).rejects.toThrow(/SAP_LOGON_FAILURE_COOLDOWN_MIN.*not a valid integer/);
  });

  test('negative control - without the protection a retry loop locks the user; with it the user is hit once', async () => {
    const attempts = async (cooldownMinutes: number) => {
      const fake = createSampleSapSystem({ transitionDelayMs: 10, lockAfterFailures: 3 });
      for (let run = 0; run < 5; run++) {
        const sap = await SapGuiSession.attach(fake, FAST); // five CI retries / re-runs against the same SAP user
        await logon(sap, { ...wrong, cooldownMinutes }).catch(() => undefined);
      }
      return fake.sample;
    };
    expect((await attempts(0)).locked).toBe(true);
    fs.rmSync(logonMarkerPath(dir), { force: true });
    const protectedRun = await attempts(15);
    expect(protectedRun.locked).toBe(false);
    expect(protectedRun.failedLogons).toBe(1);
  });
});
