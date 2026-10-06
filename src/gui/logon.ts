import { loadEnv } from '@automation/referenced-automation-utils';
import { AdapterError } from '@automation/referenced-automation-utils';
import type { SapGuiSession } from './session';

export interface SapCredentials {
  client?: string;
  user?: string;
  password?: string;
  language?: string;
}

const LOGON_USER_FIELD = 'wnd[0]/usr/txtRSYST-BNAME';
const LOGON_PASSWORD_FIELD = 'wnd[0]/usr/pwdRSYST-BCODE';
const LOGON_CLIENT_FIELD = 'wnd[0]/usr/txtRSYST-MANDT';
const LOGON_LANGUAGE_FIELD = 'wnd[0]/usr/txtRSYST-LANGU';

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
 * in another session"), instead of letting the next step time out.
 */
export async function logon(sap: SapGuiSession, credentials: SapCredentials = {}): Promise<void> {
  const env = loadEnv();
  const client = credentials.client ?? env.getOptional('SAP_CLIENT');
  const user = credentials.user ?? env.getOptional('SAP_USER');
  const password = credentials.password ?? env.getOptional('SAP_PASSWORD');
  const language = credentials.language ?? env.getOptional('SAP_LANGUAGE');

  if (!user || !password) {
    throw new AdapterError(
      'sap-gui',
      'logon',
      `SAP_USER and SAP_PASSWORD must both be set. Put them in .env.${process.env.ENV ?? 'qa'}.local (git ignores that file) or export them - ` +
        `currently SAP_USER is ${user ? 'set' : 'EMPTY'} and SAP_PASSWORD is ${password ? 'set' : 'EMPTY'}.`,
    );
  }
  if (client) await sap.setText(LOGON_CLIENT_FIELD, client);
  await sap.setText(LOGON_USER_FIELD, user);
  await sap.setText(LOGON_PASSWORD_FIELD, password);
  if (language) await sap.setText(LOGON_LANGUAGE_FIELD, language);
  await sap.sendVKey(0);

  if (await sap.exists('wnd[1]')) {
    const title = await sap.getText('wnd[1]').catch(() => '(untitled)');
    throw new AdapterError(
      'sap-gui',
      'logon',
      `SAP showed a pop-up after logon: "${title}". Typical causes: the user is already logged on in another session, ` +
        `or the password has expired. Run "npm run doctor -- --dump wnd[1]" while it is showing to see what it contains.`,
    );
  }
  if (await isOnLogonScreen(sap)) {
    const status = await sap.statusBarText();
    throw new AdapterError('sap-gui', 'logon', `still on the logon screen after sending Enter. Status bar: "${status || '(empty)'}"`);
  }
}

/**
 * Makes sure the session is logged on: logs on if SAP is showing the logon
 * screen, does nothing if you were already logged on (the usual case when
 * attaching to a SAP Logon window you opened yourself).
 */
export async function ensureLoggedIn(sap: SapGuiSession, credentials: SapCredentials = {}): Promise<void> {
  if (await isOnLogonScreen(sap)) await logon(sap, credentials);
}
