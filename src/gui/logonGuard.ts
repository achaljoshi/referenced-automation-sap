import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdapterError, getLogger, loadEnv } from '@automation/referenced-automation-utils';

/**
 * Protection against locking a SAP user by retrying a logon that cannot work.
 *
 * SAP counts every wrong logon and locks the user after a few (often three to five; the limit is the system's, login/fails_to_user_lock).
 * A test run that fails on a wrong password is routinely started again - by a CI retry, by the next test of the same worker, by a
 * person pressing "run" once more - and every repetition is another wrong logon. So after a logon that failed because the name or
 * password was incorrect (or the user is locked) the framework writes a marker and refuses to type the same client, user and
 * password into SAP again for SAP_LOGON_FAILURE_COOLDOWN_MIN minutes.
 *
 * The marker holds the client, the user, a salted fingerprint of the password (never the password), SAP's own status text and the
 * time. A different password, user or client does not match it, so fixing the credentials clears the stop by itself.
 *
 * Where it lives: `.sap-state/logon-failed.json` under the working directory (SAP_GUI_LOGON_MARKER_DIR). Not under test-results:
 * Playwright empties that folder at the start of every run, which would remove the marker exactly when the next run needs it.
 */

const log = getLogger('sap-gui');

export const DEFAULT_LOGON_MARKER_DIR = '.sap-state';
export const LOGON_MARKER_FILE = 'logon-failed.json';
export const DEFAULT_LOGON_COOLDOWN_MIN = 15;

export interface LogonFailureMarker {
  client: string;
  user: string;
  /** scrypt of the password with `salt` - enough to recognise the same password again, not to read it back. */
  passwordFingerprint: string;
  salt: string;
  /** ISO time of the failed logon. */
  at: string;
  /** SAP's own status bar text for the failure. */
  status: string;
}

/** SAP_LOGON_FAILURE_COOLDOWN_MIN: minutes to refuse the same logon after it failed (default 15; 0 turns the protection off). */
export function logonCooldownMinutes(): number {
  const minutes = loadEnv().getInt('SAP_LOGON_FAILURE_COOLDOWN_MIN', DEFAULT_LOGON_COOLDOWN_MIN);
  if (minutes < 0) throw new Error(`SAP_LOGON_FAILURE_COOLDOWN_MIN must be 0 (off) or a number of minutes (found ${minutes})`);
  return minutes;
}

/** SAP_GUI_LOGON_MARKER_DIR: where the marker is kept (default `.sap-state`). */
export function logonMarkerDir(): string {
  return loadEnv().get('SAP_GUI_LOGON_MARKER_DIR', DEFAULT_LOGON_MARKER_DIR);
}

export function logonMarkerPath(dir: string = logonMarkerDir()): string {
  return path.resolve(dir, LOGON_MARKER_FILE);
}

/**
 * Status bar texts after which another try with the same credentials is dangerous: the name or password was rejected, or the user is
 * already locked (English and German SAP texts). A pop-up (password expired, already logged on) is not a lock risk.
 */
export function isLockRisk(status: string): boolean {
  return /(name|user).{0,20}(password|kennwort).{0,40}(incorrect|invalid|not correct|wrong|falsch|nicht korrekt)|(password|kennwort).{0,30}(incorrect|invalid|wrong|falsch|nicht korrekt)|repeat logon|anmeldung wiederholen|\blocked\b|gesperrt/i.test(status);
}

function fingerprint(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 24).toString('hex');
}

/** Records that this client / user / password was just rejected by SAP. Never throws: a marker that cannot be written must not hide the logon failure. */
export function writeLogonFailure(
  credentials: { client?: string; user: string; password: string; status: string },
  dir: string = logonMarkerDir(),
  now: number = Date.now(),
): string | undefined {
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const marker: LogonFailureMarker = {
      client: credentials.client ?? '',
      user: credentials.user,
      passwordFingerprint: fingerprint(credentials.password, salt),
      salt,
      at: new Date(now).toISOString(),
      status: credentials.status,
    };
    const file = logonMarkerPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    return file;
  } catch (error) {
    log.warn(`[sap-gui] could not write the logon-failure marker: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** The marker on disk; undefined when there is none or it cannot be read (a damaged marker protects nothing, so it is ignored). */
export function readLogonFailure(dir: string = logonMarkerDir()): LogonFailureMarker | undefined {
  try {
    const marker = JSON.parse(fs.readFileSync(logonMarkerPath(dir), 'utf8')) as Partial<LogonFailureMarker>;
    if (
      typeof marker.user === 'string' &&
      typeof marker.client === 'string' &&
      typeof marker.salt === 'string' &&
      typeof marker.passwordFingerprint === 'string' &&
      typeof marker.at === 'string' &&
      !Number.isNaN(Date.parse(marker.at))
    )
      return marker as LogonFailureMarker;
  } catch {
    /* no marker, or not readable */
  }
  return undefined;
}

export function clearLogonFailure(dir: string = logonMarkerDir()): void {
  try {
    fs.rmSync(logonMarkerPath(dir), { force: true });
  } catch (error) {
    log.warn(`[sap-gui] could not remove the logon-failure marker: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Is a marker for exactly this client, user and password still within its cooldown? */
export function activeLogonCooldown(
  credentials: { client?: string; user: string; password: string },
  cooldownMinutes: number,
  dir: string = logonMarkerDir(),
  now: number = Date.now(),
): { marker: LogonFailureMarker; remainingMs: number } | undefined {
  if (cooldownMinutes <= 0) return undefined;
  const marker = readLogonFailure(dir);
  if (!marker) return undefined;
  if (marker.client !== (credentials.client ?? '') || marker.user.toUpperCase() !== credentials.user.toUpperCase()) return undefined;
  if (marker.passwordFingerprint !== fingerprint(credentials.password, marker.salt)) return undefined;
  const cooldownMs = cooldownMinutes * 60_000;
  const elapsed = now - Date.parse(marker.at);
  if (elapsed > cooldownMs || elapsed < -cooldownMs) return undefined; // over, or a timestamp too far in the future to be trusted
  return { marker, remainingMs: cooldownMs - Math.max(0, elapsed) };
}

/** Thrown instead of typing credentials into SAP that SAP has just rejected. Nothing was sent to SAP. */
export class SapLogonCooldownError extends AdapterError {
  constructor(
    readonly marker: LogonFailureMarker,
    readonly remainingMs: number,
    readonly markerFile: string,
    cooldownMinutes: number,
  ) {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    super(
      'sap-gui',
      'logon',
      `logon NOT attempted - it would have repeated a logon that SAP has just rejected, and repeated wrong logons LOCK the SAP user. ` +
        `At ${marker.at} the logon as "${marker.user}" in client "${marker.client || '(default)'}" failed: "${marker.status || '(no status text)'}", ` +
        `and this run has the same client, user and password. Nothing was typed into SAP.\n` +
        `To go on, do ONE of these:\n` +
        `  1. fix the credentials (SAP_USER, SAP_CLIENT, SAP_PASSWORD) - a changed password, user or client clears this stop by itself;\n` +
        `  2. if the password was reset or the user unlocked in SAP and you are sure the current values are right: delete ${markerFile}\n` +
        `  3. wait ${minutes} more minute(s) (SAP_LOGON_FAILURE_COOLDOWN_MIN=${cooldownMinutes}; 0 turns this protection off - not advised on a shared system).`,
    );
    this.name = 'SapLogonCooldownError';
    Object.setPrototypeOf(this, SapLogonCooldownError.prototype);
  }
}

/**
 * What to check after SAP rejected the logon. Keeps SAP's own status text and adds the usual causes; the password is never printed.
 */
export function logonFailureMessage(
  status: string,
  who: { client?: string; user: string; passwordLength: number },
  protection: { cooldownMinutes: number; markerFile?: string },
): string {
  const envFile = `.env.${process.env.ENV ?? 'qa'}.local`;
  return (
    `still on the logon screen after sending Enter. SAP's status bar says: "${status || '(empty)'}"\n` +
    `Logon was attempted as user "${who.user}" in client "${who.client ?? '(not set - the system default)'}" with a password of ${who.passwordLength} characters (SAP_USER / SAP_CLIENT / SAP_PASSWORD).\n` +
    `What to check:\n` +
    `  - SAP_USER, SAP_CLIENT and SAP_PASSWORD are the ones that work in SAP Logon (System > Status shows client and user); a value exported in your shell wins over ${envFile} (PowerShell: Get-ChildItem Env:SAP_*).\n` +
    `  - a password with special characters (# $ spaces ...) must be in double quotes in the .env file: SAP_PASSWORD="my#pass word" - an unquoted # starts a comment and cuts the password. Inside double quotes \\n is read as a new line; use single quotes if the password contains a backslash.\n` +
    `  - the user may be locked or its password expired: ask your SAP administrator (transaction SU01).\n` +
    `WARNING: repeated wrong logons LOCK the SAP user. Do NOT run the tests again until the credentials are fixed.` +
    (protection.cooldownMinutes > 0 && isLockRisk(status)
      ? ` Until then this framework refuses to repeat the same logon for ${protection.cooldownMinutes} minute(s)${protection.markerFile ? ` (marker: ${protection.markerFile})` : ''}.`
      : '')
  );
}
