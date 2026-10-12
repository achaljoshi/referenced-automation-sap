import { loadEnv } from '@automation/referenced-automation-utils';
import { AdapterError } from '@automation/referenced-automation-utils';
import {
  activeLogonCooldown,
  clearLogonFailure,
  isLockRisk,
  logonCooldownMinutes,
  logonFailureMessage,
  logonMarkerDir,
  logonMarkerPath,
  readLogonFailure,
  SapLogonCooldownError,
  writeLogonFailure,
} from './logonGuard';
import { resolveSecret } from './secrets';
import type { SapGuiSession } from './session';

export interface SapCredentials {
  client?: string;
  user?: string;
  password?: string;
  language?: string;
  /**
   * What to do when SAP says the user is already logged on elsewhere
   * ("multiple logon" pop-up). 'continue' (default) picks "continue without
   * ending the other sessions" and presses Continue - what the Java/JACOB
   * framework's SAPGUI_LoginScreen does. 'fail' stops with a clear message.
   * Default can be set with SAP_MULTIPLE_LOGON=continue|fail.
   */
  onMultipleLogon?: 'continue' | 'fail';
  /**
   * Minutes to refuse the same client + user + password after SAP rejected it, so that a retry cannot lock the user.
   * Default SAP_LOGON_FAILURE_COOLDOWN_MIN (15); 0 turns the protection off.
   */
  cooldownMinutes?: number;
  /** Folder of the logon-failure marker. Default SAP_GUI_LOGON_MARKER_DIR (`.sap-state`). */
  markerDir?: string;
}

const LOGON_USER_FIELD = 'wnd[0]/usr/txtRSYST-BNAME';
const LOGON_PASSWORD_FIELD = 'wnd[0]/usr/pwdRSYST-BCODE';
const LOGON_CLIENT_FIELD = 'wnd[0]/usr/txtRSYST-MANDT';
const LOGON_LANGUAGE_FIELD = 'wnd[0]/usr/txtRSYST-LANGU';
// The multiple-logon dialog (same ids the Java framework uses): OPT2 = continue without ending the other sessions.
const MULTI_LOGON_OPTION = 'wnd[1]/usr/radMULTI_LOGON_OPT2';
const MULTI_LOGON_CONTINUE = 'wnd[1]/tbar[0]/btn[0]';

/** True when SAP is showing the standard logon screen (user + password fields). */
export async function isOnLogonScreen(sap: SapGuiSession): Promise<boolean> {
  return sap.exists(LOGON_PASSWORD_FIELD);
}

/**
 * Logs on through the standard SAP logon screen (the same fields every
 * recording of a login contains). Credentials default to the environment:
 * SAP_CLIENT, SAP_USER, SAP_PASSWORD, SAP_LANGUAGE - put them in
 * `.env.<name>.local`, which is never committed.
 *
 * Fails with a clear message if SAP does not leave the logon screen (wrong
 * password, locked user) or shows a pop-up (e.g. "user already logged on
 * in another session"), instead of letting the next step time out. The message
 * keeps SAP's own status text and says what to check.
 *
 * Lockout protection: when SAP rejects the name or password (or says the user
 * is locked) a marker is written, and the same client + user + password is
 * refused - without touching SAP - for SAP_LOGON_FAILURE_COOLDOWN_MIN minutes
 * (default 15; see logonGuard.ts). A changed password, user or client clears
 * the stop by itself; a successful logon removes the marker.
 */
export async function logon(sap: SapGuiSession, credentials: SapCredentials = {}): Promise<void> {
  const env = loadEnv();
  const client = credentials.client ?? env.getOptional('SAP_CLIENT');
  const user = credentials.user ?? sap.assignedUser ?? env.getOptional('SAP_USER');
  // A pooled user may have its own password (SAP_PASSWORD_<USER>); otherwise the shared SAP_PASSWORD applies.
  const password =
    credentials.password ?? (sap.assignedUser ? await resolveSecret(`SAP_PASSWORD_${sap.assignedUser}`) : undefined) ?? (await resolveSecret('SAP_PASSWORD'));
  const language = credentials.language ?? env.getOptional('SAP_LANGUAGE');

  if (!user || !password) {
    throw new AdapterError(
      'sap-gui',
      'logon',
      `SAP_USER and SAP_PASSWORD must both be set. Put them in .env.${process.env.ENV ?? 'qa'}.local (git ignores that file), export them, or store the password with "npx sap-gui-secret set SAP_PASSWORD" - ` +
        `currently SAP_USER is ${user ? 'set' : 'EMPTY'} and SAP_PASSWORD is ${password ? 'set' : 'EMPTY'}.`,
    );
  }
  const cooldownMinutes = credentials.cooldownMinutes ?? logonCooldownMinutes();
  const markerDir = credentials.markerDir ?? logonMarkerDir();
  const stop = activeLogonCooldown({ client, user, password }, cooldownMinutes, markerDir);
  if (stop) throw new SapLogonCooldownError(stop.marker, stop.remainingMs, logonMarkerPath(markerDir), cooldownMinutes);

  if (client) await sap.setText(LOGON_CLIENT_FIELD, client);
  await sap.setText(LOGON_USER_FIELD, user);
  await sap.setText(LOGON_PASSWORD_FIELD, password);
  if (language) await sap.setText(LOGON_LANGUAGE_FIELD, language);
  await sap.sendVKey(0);

  const onMultipleLogon = credentials.onMultipleLogon ?? (env.get('SAP_MULTIPLE_LOGON', 'continue') as 'continue' | 'fail');
  if (onMultipleLogon === 'continue' && (await sap.exists(MULTI_LOGON_OPTION))) {
    await sap.select(MULTI_LOGON_OPTION);
    await sap.press(MULTI_LOGON_CONTINUE);
  }

  if (await sap.exists('wnd[1]')) {
    const title = await sap.getText('wnd[1]').catch(() => '(untitled)');
    throw new AdapterError(
      'sap-gui',
      'logon',
      `SAP showed a pop-up after logon: "${title}". Typical causes: the user is already logged on in another session ` +
        `(set SAP_MULTIPLE_LOGON=continue to handle that), or the password has expired. Run "npm run doctor -- --dump wnd[1]" while it is showing to see what it contains.`,
    );
  }
  if (await isOnLogonScreen(sap)) {
    const status = await sap.statusBarText();
    const markerFile =
      cooldownMinutes > 0 && isLockRisk(status) ? writeLogonFailure({ client, user, password, status }, markerDir) : undefined;
    throw new AdapterError(
      'sap-gui',
      'logon',
      logonFailureMessage(status, { client, user, passwordLength: password.length }, { cooldownMinutes, markerFile }),
    );
  }
  // Logged on: whatever an earlier failure for this user said no longer applies.
  const earlier = readLogonFailure(markerDir);
  if (earlier && earlier.client === (client ?? '') && earlier.user.toUpperCase() === user.toUpperCase()) clearLogonFailure(markerDir);
}

/**
 * Makes sure the session is logged on: logs on if SAP is showing the logon
 * screen, does nothing if you were already logged on (the usual case when
 * attaching to a SAP Logon window you opened yourself).
 */
export async function ensureLoggedIn(sap: SapGuiSession, credentials: SapCredentials = {}): Promise<void> {
  if (await isOnLogonScreen(sap)) await logon(sap, credentials);
}
