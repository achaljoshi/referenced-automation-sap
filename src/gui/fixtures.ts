import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test as uiTest } from '@automation/referenced-automation-ui';
import { getLogger, loadEnv } from '@automation/referenced-automation-utils';
import { createSampleSapSystem } from './fakeSapGui';
import { PowerShellTransport } from './powershellTransport';
import { SapGuiSession } from './session';
import type { SapGuiTransport } from './types';

export interface SapGuiOptions {
  /**
   * How to get a SAP GUI session:
   *  - 'attach' (default): use a SAP Logon connection/session that is already open. Safest on a shared system - it never creates or closes anyone's session.
   *  - 'open': open a new connection by its SAP Logon name (SAP_GUI_CONNECTION_NAME) or connection string (SAP_GUI_CONNECTION_STRING), landing on its logon screen - for a recording that starts with logging in.
   * Default comes from SAP_GUI_MODE in .env.<name> / the environment.
   */
  sapGuiMode: 'attach' | 'open' | undefined;
  /** Supply your own transport instead of the real PowerShell bridge (e.g. FakeSapGui in the framework's own tests). When set, `sapGuiMode` and the Windows requirement don't apply. */
  sapGuiTransport: (() => Promise<SapGuiTransport> | SapGuiTransport) | undefined;
  /**
   * 'worker' (default): one SAP session per Playwright worker, reused by every test it runs and reset to the
   *   start screen between them - log on once, not once per test. (SAP_GUI_REUSE)
   * 'test': a fresh connection per test - slower, and only for flows that must start from the logon screen.
   */
  sapGuiReuse: 'worker' | 'test' | undefined;
}

const log = getLogger('sap-gui');
const DEFAULT_LOGON_PATH = 'C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPgui\\saplogon.exe';

/** The SAP connection a worker owns: opened on first use, health-checked on reuse, closed when the worker ends. */
export class SapConnection {
  private session?: SapGuiSession;
  private opened = false;

  constructor(
    private readonly options: Pick<SapGuiOptions, 'sapGuiMode' | 'sapGuiTransport' | 'sapGuiReuse'>,
  ) {}

  private get env() {
    return loadEnv();
  }

  get simulated(): boolean {
    return this.env.getBoolean('SAP_GUI_SIMULATOR', false);
  }

  /** Can this machine run SAP GUI tests at all? (Windows, a custom transport, or the simulator.) */
  get canRun(): boolean {
    return process.platform === 'win32' || Boolean(this.options.sapGuiTransport) || this.simulated;
  }

  get reuse(): 'worker' | 'test' {
    return this.options.sapGuiReuse ?? (this.env.get('SAP_GUI_REUSE', 'worker') as 'worker' | 'test');
  }

  get evidence(): 'off' | 'failure' | 'steps' {
    return this.env.get('SAP_GUI_EVIDENCE', 'failure') as 'off' | 'failure' | 'steps';
  }

  /** The live session - reconnecting if the previous one has gone away (SAP closed, bridge died). */
  async acquire(): Promise<SapGuiSession> {
    if (this.session) {
      if (await this.session.healthCheck()) return this.session;
      log.warn('[sap-gui] the SAP session is no longer alive - reconnecting');
      await this.dispose();
    }
    this.session = await this.connect();
    return this.session;
  }

  /** Releases the bridge; ends the SAP session only if this framework opened it (never one you attached to). */
  async dispose(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    if (this.opened) await session.logoff().catch((error: unknown) => log.warn(`[sap-gui] logoff failed: ${String(error)}`));
    this.opened = false;
    await session.close().catch(() => undefined);
  }

  private async connect(): Promise<SapGuiSession> {
    const env = this.env;
    const simulate = this.simulated;
    const timeoutMs = env.getInt('SAP_GUI_TIMEOUT_MS', 30_000);
    const evidence = this.evidence === 'steps' ? 'steps' : 'off';
    // The simulator always starts at the logon screen, like mode=open does on a real system.
    const mode = simulate ? 'attach' : (this.options.sapGuiMode ?? (env.get('SAP_GUI_MODE', 'attach') as 'attach' | 'open'));

    const transport =
      (await this.options.sapGuiTransport?.()) ??
      (simulate
        ? createSampleSapSystem({ user: env.get('SAP_USER', 'TESTUSER'), password: env.get('SAP_PASSWORD', 'correct-horse'), client: env.get('SAP_CLIENT', '100'), transitionDelayMs: 100 })
        : undefined) ??
      (await PowerShellTransport.start({ powershellPath: env.getOptional('SAP_GUI_POWERSHELL') }));

    if (mode === 'open') {
      this.opened = true;
      return SapGuiSession.open(transport, env.getOptional('SAP_GUI_CONNECTION_NAME') ?? '', {
        timeoutMs,
        evidence,
        logonPath: env.get('SAP_GUI_LOGON_PATH', DEFAULT_LOGON_PATH),
        connectionString: env.getOptional('SAP_GUI_CONNECTION_STRING'),
      });
    }
    return SapGuiSession.attach(transport, {
      timeoutMs,
      evidence,
      connectionIndex: env.getInt('SAP_GUI_CONNECTION_INDEX', 0),
      sessionIndex: env.getInt('SAP_GUI_SESSION_INDEX', 0),
    });
  }
}

/**
 * `test` with a `sap` fixture: a SapGuiSession that waits for SAP on every
 * step. Built on the ui package's `test`, so it also has that one's scenario
 * banner and correlation ID - and a test can take both `sap` and `page` to
 * drive a Fiori app and classic SAP GUI in the same flow.
 *
 * Per worker, one SAP connection is opened (or attached to) and reused by
 * every test, reset to the start screen between them; per test, the journal,
 * evidence and pop-up handlers start empty. On failure the report gets the
 * step journal, the status bar text and a screenshot.
 *
 * Configuration (all optional, from .env.<name> or the environment):
 *   SAP_GUI_MODE              attach | open                     (default attach)
 *   SAP_GUI_CONNECTION_NAME   SAP Logon entry to open, for mode=open
 *   SAP_GUI_CONNECTION_STRING open a system by connection string instead (mode=open)
 *   SAP_GUI_CONNECTION_INDEX  which open connection, for mode=attach (default 0)
 *   SAP_GUI_SESSION_INDEX     which session in it, for mode=attach     (default 0)
 *   SAP_GUI_TIMEOUT_MS        longest any one step waits               (default 30000)
 *   SAP_GUI_REUSE             worker | test                            (default worker)
 *   SAP_GUI_EVIDENCE          off | failure | steps                    (default failure)
 *   SAP_GUI_POWERSHELL        path to powershell.exe (32-bit SAP GUI may need the SysWOW64 one)
 *   SAP_GUI_LOGON_PATH        saplogon.exe, started for mode=open if SAP Logon isn't running
 *                             (default C:\Program Files (x86)\SAP\FrontEnd\SAPgui\saplogon.exe)
 *   SAP_GUI_SIMULATOR         true = run against the built-in fake SAP instead of a real one (any OS) -
 *                             to try the sample tests before you have a SAP system to point at
 *
 * On a machine that isn't Windows the test is SKIPPED with the reason shown
 * in the report - never silently passed.
 */
export const sapGuiTest = uiTest.extend<{ sap: SapGuiSession }, SapGuiOptions & { sapConnection: SapConnection }>({
  sapGuiMode: [undefined, { option: true, scope: 'worker' }],
  sapGuiTransport: [undefined, { option: true, scope: 'worker' }],
  sapGuiReuse: [undefined, { option: true, scope: 'worker' }],

  sapConnection: [
    async ({ sapGuiMode, sapGuiTransport, sapGuiReuse }, use) => {
      const connection = new SapConnection({ sapGuiMode, sapGuiTransport, sapGuiReuse });
      await use(connection);
      await connection.dispose();
    },
    { scope: 'worker' },
  ],

  sap: async ({ sapConnection }, use, testInfo) => {
    testInfo.skip(
      !sapConnection.canRun,
      'SAP GUI Scripting needs Windows with SAP GUI installed - this test was skipped, not run. (Set SAP_GUI_SIMULATOR=true to run against the built-in fake SAP.)',
    );

    const session = await sapConnection.acquire();
    session.resetDiagnostics();
    if (sapConnection.reuse === 'worker') await session.home().catch((error: unknown) => log.warn(`[sap-gui] could not return to the start screen: ${String(error)}`));

    try {
      await use(session);
    } finally {
      await attachDiagnostics(session, testInfo, sapConnection.evidence, testInfo.status !== testInfo.expectedStatus);
      if (sapConnection.reuse === 'test') await sapConnection.dispose();
    }
  },
});

export type Attacher = { attach(name: string, options: { body?: string; path?: string; contentType: string }): Promise<void> };

/**
 * What goes into the report. Always: evidence you asked for with sap.evidence().
 * On failure (unless SAP_GUI_EVIDENCE=off): the step journal, the status bar text, a screenshot.
 * Never throws - it must not mask the real failure.
 */
export async function attachDiagnostics(session: SapGuiSession, testInfo: Attacher, mode: 'off' | 'failure' | 'steps', failed: boolean): Promise<void> {
  for (const item of session.evidenceItems) {
    if (fs.existsSync(item.file)) await testInfo.attach(`sap-evidence: ${item.label}`, { path: item.file, contentType: 'image/png' }).catch(() => undefined);
  }
  if (!failed || mode === 'off') return;

  const journal = session.journalText();
  if (journal) await testInfo.attach('sap-steps', { body: journal, contentType: 'text/plain' }).catch(() => undefined);
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
