import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test as uiTest } from '@automation/referenced-automation-ui';
import { getLogger, loadEnv } from '@automation/referenced-automation-utils';
import { PowerShellTransport } from './powershellTransport';
import { SapGuiSession } from './session';
import type { SapGuiTransport } from './types';

export interface SapGuiOptions {
  /**
   * How to get a SAP GUI session:
   *  - 'attach' (default): use a SAP Logon connection/session that is already open. Safest on a shared system - it never creates or closes anyone's session.
   *  - 'open': open a new connection by its SAP Logon name (SAP_GUI_CONNECTION_NAME), landing on its logon screen - for a recording that starts with logging in.
   * Default comes from SAP_GUI_MODE in .env.<name> / the environment.
   */
  sapGuiMode: 'attach' | 'open' | undefined;
  /** Supply your own transport instead of the real PowerShell bridge (e.g. FakeSapGui in the framework's own tests). When set, `sapGuiMode` and the Windows requirement don't apply. */
  sapGuiTransport: (() => Promise<SapGuiTransport> | SapGuiTransport) | undefined;
}

const log = getLogger('sap-gui');

/**
 * `test` with a `sap` fixture: a SapGuiSession that waits for SAP on every
 * step. Built on the ui package's `test`, so it also has that one's scenario
 * banner and correlation ID - and a test can take both `sap` and `page` to
 * drive a Fiori app and classic SAP GUI in the same flow.
 *
 * Configuration (all optional, from .env.<name> or the environment):
 *   SAP_GUI_MODE              attach | open                     (default attach)
 *   SAP_GUI_CONNECTION_NAME   SAP Logon entry to open, for mode=open
 *   SAP_GUI_CONNECTION_INDEX  which open connection, for mode=attach (default 0)
 *   SAP_GUI_SESSION_INDEX     which session in it, for mode=attach     (default 0)
 *   SAP_GUI_TIMEOUT_MS        longest any one step waits               (default 30000)
 *   SAP_GUI_POWERSHELL        path to powershell.exe (32-bit SAP GUI may need the SysWOW64 one)
 *
 * On a machine that isn't Windows the test is SKIPPED with the reason shown
 * in the report - never silently passed.
 */
export const sapGuiTest = uiTest.extend<{ sap: SapGuiSession } & SapGuiOptions>({
  sapGuiMode: [undefined, { option: true }],
  sapGuiTransport: [undefined, { option: true }],

  sap: async ({ sapGuiMode, sapGuiTransport }, use, testInfo) => {
    if (!sapGuiTransport) {
      testInfo.skip(process.platform !== 'win32', 'SAP GUI Scripting needs Windows with SAP GUI installed - this test was skipped, not run.');
    }
    const env = loadEnv();
    const timeoutMs = env.getInt('SAP_GUI_TIMEOUT_MS', 30_000);
    const mode = sapGuiMode ?? (env.get('SAP_GUI_MODE', 'attach') as 'attach' | 'open');

    const transport =
      (await sapGuiTransport?.()) ??
      (await PowerShellTransport.start({ powershellPath: env.getOptional('SAP_GUI_POWERSHELL') }));

    const session =
      mode === 'open'
        ? await SapGuiSession.open(transport, env.get('SAP_GUI_CONNECTION_NAME'), { timeoutMs })
        : await SapGuiSession.attach(transport, {
            timeoutMs,
            connectionIndex: env.getInt('SAP_GUI_CONNECTION_INDEX', 0),
            sessionIndex: env.getInt('SAP_GUI_SESSION_INDEX', 0),
          });

    try {
      await use(session);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) await attachFailureEvidence(session, testInfo);
      await session.close();
    }
  },
});

/** On failure, add what SAP was showing to the report: the status bar text, and a screenshot of the window. Never throws - it must not mask the real failure. */
async function attachFailureEvidence(
  session: SapGuiSession,
  testInfo: { attach(name: string, options: { body?: string; path?: string; contentType: string }): Promise<void> },
): Promise<void> {
  try {
    const statusBar = await session.statusBarText();
    await testInfo.attach('sap-status-bar', { body: statusBar || '(empty)', contentType: 'text/plain' });
    log.error(`SAP status bar at failure: ${statusBar || '(empty)'}`);
  } catch (error) {
    log.warn(`could not read the SAP status bar after failure: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const file = path.join(os.tmpdir(), `sap-failure-${Date.now()}.png`);
    await session.screenshot(file);
    if (fs.existsSync(file)) await testInfo.attach('sap-screenshot', { path: file, contentType: 'image/png' });
  } catch (error) {
    log.warn(`could not capture a SAP screenshot after failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}
