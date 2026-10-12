import * as fs from 'node:fs';
import * as path from 'node:path';
import { test as uiTest } from '@automation/referenced-automation-ui';
import { getLogger, loadEnv } from '@automation/referenced-automation-utils';
import { appendCreated, DEFAULT_DATA_DIR, formatCreated, SapDataRegistry, type CreatedObject } from './data';
import { createSampleSapSystem } from './fakeSapGui';
import { ensureLoggedIn } from './logon';
import { selectedTransport, startRealTransport } from './transportFactory';
import { appendInsight, DEFAULT_INSIGHTS_DIR } from '../insights';
import { SapUserPool, type UserLease } from './pool';
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
  /**
   * What happens when a test's cleanup of the SAP data it created fails (or was never registered):
   *  - 'fail' (default): the test fails after its cleanup, naming each orphan - a leftover order in a shared system is a defect, not a log line
   *  - 'warn': recorded as a test annotation and in the audit list only
   * (SAP_GUI_CLEANUP_FAILURE=warn)
   */
  sapCleanupFailure: 'fail' | 'warn' | undefined;
  /**
   * What happens when the session cannot be returned to the start screen before a test (`home()` failed):
   *  - 'fail' (default): the test fails - it would otherwise start on whatever screen the previous test left behind
   *  - 'warn': log it and run the test anyway
   * (SAP_GUI_HOME_FAILURE=warn)
   */
  sapHomeFailure: 'fail' | 'warn' | undefined;
}

const log = getLogger('sap-gui');
const DEFAULT_LOGON_PATH = 'C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPgui\\saplogon.exe';

/** The SAP connection a worker owns: opened on first use, health-checked on reuse, closed when the worker ends. */
export class SapConnection {
  private session?: SapGuiSession;
  private opened = false;
  private lease?: UserLease;
  /** Ends this worker's use of the remote desktop host (SAP_GUI_TRANSPORT=remote); set once the real transport has started. */
  private releaseRemote?: () => Promise<void>;

  constructor(
    private readonly options: Pick<SapGuiOptions, 'sapGuiMode' | 'sapGuiTransport' | 'sapGuiReuse'>,
  ) {}

  private get env() {
    return loadEnv();
  }

  /** How the session is obtained: the option, else SAP_GUI_MODE (default attach). The simulator always behaves like 'attach' to a private fake. */
  get mode(): 'attach' | 'open' {
    return (
      this.options.sapGuiMode ?? (this.env.get('SAP_GUI_MODE', 'attach') as 'attach' | 'open')
    );
  }

  /**
   * Attach mode drives THE session someone already has open: every worker would attach to the same SAP window and
   * interleave keystrokes in it. Refuse that instead of producing tests that fail (or worse, pass) at random. Not an
   * issue for the simulator or a custom transport (each worker has its own), nor for mode=open (a connection per worker).
   */
  assertSessionNotShared(workers: number): void {
    // Remote: one interactive RDP desktop and one agent that handles one request at a time, whatever the mode.
    if (workers > 1 && this.remoteSelected) {
      throw new Error(
        `SAP_GUI_TRANSPORT=remote with ${workers} workers: every worker would drive the same SAP GUI on the one remote desktop (and its agent answers one request at a time). ` +
          'Run with --workers=1 (this repo\'s playwright.config.ts does that by default - was WORKERS or --workers set?).',
      );
    }
    if (workers > 1 && this.mode === 'attach' && !this.simulated && !this.options.sapGuiTransport) {
      throw new Error(
        `SAP_GUI_MODE=attach with ${workers} workers: every worker would drive the same SAP GUI window. ` +
          'Run with --workers=1 (this repo\'s playwright.config.ts does that by default - was WORKERS or --workers set?), ' +
          'or use SAP_GUI_MODE=open with SAP_USER_POOL so each worker gets its own connection and user.',
      );
    }
  }

  get simulated(): boolean {
    return this.env.getBoolean('SAP_GUI_SIMULATOR', false);
  }

  /** SAP GUI is on a remote desktop host: SAP_GUI_TRANSPORT=remote with the real transport (not the simulator, not a custom transport). */
  get remoteSelected(): boolean {
    return !this.simulated && !this.options.sapGuiTransport && selectedTransport() === 'remote';
  }

  /** Can this machine run SAP GUI tests at all? (Windows, a custom transport, the simulator, or SAP GUI on a remote desktop host.) */
  get canRun(): boolean {
    return process.platform === 'win32' || Boolean(this.options.sapGuiTransport) || this.simulated || this.remoteSelected;
  }

  get reuse(): 'worker' | 'test' {
    return (
      this.options.sapGuiReuse ?? (this.env.get('SAP_GUI_REUSE', 'worker') as 'worker' | 'test')
    );
  }

  /** Record what each test did in SAP (transactions, step timings) for `sap-gui-insights`. SAP_GUI_INSIGHTS=off disables. */
  get insights(): boolean {
    return this.env.get('SAP_GUI_INSIGHTS', 'on') !== 'off';
  }

  get insightsDir(): string {
    return this.env.get('SAP_GUI_INSIGHTS_DIR', DEFAULT_INSIGHTS_DIR);
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
      await this.releaseHost(); // a dead agent means a dead host: reconnect from scratch, not through a half-closed one
    }
    this.session = await this.connect();
    return this.session;
  }

  /** Releases the bridge; ends the SAP session only if this framework opened it (never one you attached to). */
  async dispose(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    if (this.opened)
      await session
        .logoff()
        .catch((error: unknown) => log.warn(`[sap-gui] logoff failed: ${String(error)}`));
    this.opened = false;
    await session.close().catch(() => undefined);
    this.lease?.release();
    this.lease = undefined;
  }

  /**
   * Ends this worker's use of the remote desktop host and forgets it (the next use connects afresh). Not part of dispose(): with
   * SAP_GUI_REUSE=test the bridge is replaced per test, but the RDP session must not be reopened per test. A no-op unless remote.
   */
  async releaseHost(): Promise<void> {
    const release = this.releaseRemote;
    this.releaseRemote = undefined;
    await release?.().catch((error: unknown) => log.warn(`[sap-gui] could not release the remote desktop host: ${String(error)}`));
  }

  private async connect(): Promise<SapGuiSession> {
    const env = this.env;
    const simulate = this.simulated;
    const timeoutMs = env.getInt('SAP_GUI_TIMEOUT_MS', 30_000);
    const evidence = this.evidence === 'steps' ? 'steps' : 'off';
    const roundTripWaitMs = env.getInt('SAP_GUI_ROUNDTRIP_WAIT_MS', 250);
    const fallbacks = env.get('SAP_GUI_FALLBACKS', 'report') as 'report' | 'fail' | 'off';
    // The simulator always starts at the logon screen, like mode=open does on a real system.
    const mode = simulate ? 'attach' : this.mode;

    // Lease a user BEFORE starting the bridge: a pool timeout must not leave a PowerShell process behind.
    const poolUsers = env.getList('SAP_USER_POOL');
    if (poolUsers.length > 0 && mode !== 'open' && !simulate) {
      log.warn(
        '[sap-gui] SAP_USER_POOL is ignored in attach mode (you are using a session someone already logged on) - use SAP_GUI_MODE=open',
      );
    }
    if (poolUsers.length > 0 && (mode === 'open' || simulate)) {
      const pool = new SapUserPool(poolUsers, {
        scope: env.get('SAP_GUI_POOL_SCOPE', env.get('SAP_GUI_CONNECTION_NAME', 'default')),
        owner: `worker ${process.env.TEST_WORKER_INDEX ?? '?'}`,
        dir: env.getOptional('SAP_GUI_POOL_DIR'),
      });
      this.lease = await pool.lease(env.getInt('SAP_GUI_POOL_TIMEOUT_MS', 120_000));
    }

    let transport: SapGuiTransport | undefined;
    try {
      transport =
        (await this.options.sapGuiTransport?.()) ??
        (simulate
          ? createSampleSapSystem({
              user: env.get('SAP_USER', 'TESTUSER'),
              password: env.get('SAP_PASSWORD', 'correct-horse'),
              client: env.get('SAP_CLIENT', '100'),
              transitionDelayMs: 100,
            })
          : undefined) ??
        (await this.startReal()).transport;
      const session = await this.openSession(mode, transport, env, timeoutMs, evidence, fallbacks, roundTripWaitMs);
      if (this.lease) session.assignedUser = this.lease.user;
      return session;
    } catch (error) {
      await transport?.close().catch(() => undefined);
      this.lease?.release();
      this.lease = undefined;
      throw error;
    }
  }

  private async startReal() {
    const started = await startRealTransport();
    this.releaseRemote = started.release;
    return started;
  }

  private async openSession(
    mode: 'attach' | 'open',
    transport: SapGuiTransport,
    env: ReturnType<typeof loadEnv>,
    timeoutMs: number,
    evidence: 'off' | 'steps',
    fallbacks: 'report' | 'fail' | 'off' = 'report',
    roundTripWaitMs = 250,
  ): Promise<SapGuiSession> {
    const common = { timeoutMs, evidence, fallbacks, roundTripWaitMs, evidenceDir: env.getOptional('SAP_GUI_EVIDENCE_DIR') };
    if (mode === 'open') {
      this.opened = true;
      return SapGuiSession.open(transport, env.getOptional('SAP_GUI_CONNECTION_NAME') ?? '', {
        ...common,
        logonPath: env.get('SAP_GUI_LOGON_PATH', DEFAULT_LOGON_PATH),
        connectionString: env.getOptional('SAP_GUI_CONNECTION_STRING'),
      });
    }
    return SapGuiSession.attach(transport, {
      ...common,
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
 * Two fixtures give a test its session:
 *   sap          the session as the connection leaves it: with SAP_GUI_MODE=open the LOGON SCREEN (use it for a recording that
 *                contains the logon), with attach mode whatever you have open
 *   loggedInSap  the same session, logged on first when SAP shows the logon screen (SAP_USER / SAP_PASSWORD / SAP_CLIENT /
 *                SAP_LANGUAGE) and left alone when it is already logged on (use it for a recording made inside SAP, and for
 *                hand-written tests). A wrong password stops the run with what to check and arms the logon cooldown
 *                (SAP_LOGON_FAILURE_COOLDOWN_MIN) so a retry cannot lock the user.
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
 *   SAP_GUI_TRANSPORT         powershell | java | remote (SAP GUI on a remote desktop host; REMOTE_* keys, one worker)
 *   SAP_GUI_POWERSHELL        path to powershell.exe (32-bit SAP GUI may need the SysWOW64 one)
 *   SAP_GUI_LOGON_PATH        saplogon.exe, started for mode=open if SAP Logon isn't running
 *                             (default C:\Program Files (x86)\SAP\FrontEnd\SAPgui\saplogon.exe)
 *   SAP_GUI_SIMULATOR         true = run against the built-in fake SAP instead of a real one (any OS) -
 *                             to try the sample tests before you have a SAP system to point at
 *
 * On a machine that isn't Windows the test is SKIPPED with the reason shown
 * in the report - never silently passed.
 */
export const sapGuiTest = uiTest.extend<
  { sap: SapGuiSession; loggedInSap: SapGuiSession; sapData: SapDataRegistry; sapScenario: Map<string, string> },
  SapGuiOptions & { sapConnection: SapConnection }
>({
  sapGuiMode: [undefined, { option: true, scope: 'worker' }],
  sapGuiTransport: [undefined, { option: true, scope: 'worker' }],
  sapGuiReuse: [undefined, { option: true, scope: 'worker' }],
  sapCleanupFailure: [undefined, { option: true, scope: 'worker' }],
  sapHomeFailure: [undefined, { option: true, scope: 'worker' }],

  sapConnection: [
    async ({ sapGuiMode, sapGuiTransport, sapGuiReuse }, use) => {
      const connection = new SapConnection({ sapGuiMode, sapGuiTransport, sapGuiReuse });
      await use(connection);
      await connection.dispose();
      await connection.releaseHost();
    },
    { scope: 'worker' },
  ],

  sap: async ({ sapConnection, sapHomeFailure }, use, testInfo) => {
    testInfo.skip(
      !sapConnection.canRun,
      'SAP GUI Scripting needs Windows with SAP GUI installed - this test was skipped, not run. (Set SAP_GUI_SIMULATOR=true to run against the built-in fake SAP.)',
    );
    sapConnection.assertSessionNotShared(testInfo.config.workers);

    const session = await sapConnection.acquire();
    session.resetDiagnostics();
    if (sapConnection.reuse === 'worker')
      await startFromHome(session, sapHomeFailure ?? loadEnv().get('SAP_GUI_HOME_FAILURE', 'fail'), () => sapConnection.dispose());

    try {
      await use(session);
    } finally {
      await attachDiagnostics(
        session,
        testInfo,
        sapConnection.evidence,
        testInfo.status !== testInfo.expectedStatus,
      );
      if (sapConnection.insights) recordInsight(session, testInfo, sapConnection.insightsDir);
      if (sapConnection.reuse === 'test') await sapConnection.dispose();
    }
  },

  /** `sap`, logged on first if SAP shows the logon screen; an already logged-on session is left alone. See `ensureLoggedIn`. */
  loggedInSap: async ({ sap }, use) => {
    await ensureLoggedIn(sap);
    await use(sap);
  },

  /** Values remembered between the steps of one scenario (used by the BDD steps: "I remember the number ... as ..."). Fresh for every test. */
  sapScenario: async ({}, use) => {
    await use(new Map<string, string>());
  },

  /**
   * Everything the test created in SAP. Register what you create (`sapData.record(...)` /
   * `captureFromStatusBar(...)`) with a cleanup, and it is undone after the test - pass or fail,
   * and after every retry. SAP_GUI_CLEANUP=off leaves everything (the audit list is still written).
   */
  sapData: async ({ sap, sapCleanupFailure }, use, testInfo) => {
    const registry = new SapDataRegistry(sap, testInfo.titlePath.slice(1).join(' > '), {
      cleanupTimeoutMs: loadEnv().getInt('SAP_GUI_CLEANUP_TIMEOUT_MS', 60_000),
    });
    await use(registry);
    if (registry.items.length === 0) return;
    if (loadEnv().get('SAP_GUI_CLEANUP', 'on') !== 'off') {
      await sap.home().catch(() => undefined); // cleanup starts from a known screen, even after a failed test
      await registry.cleanup();
    }
    try {
      appendCreated(registry.items, loadEnv().get('SAP_GUI_DATA_DIR', DEFAULT_DATA_DIR));
      await testInfo.attach('sap-created-data', {
        body: formatCreated(registry.items),
        contentType: 'text/plain',
      });
    } catch (error) {
      log.warn(`[sap-gui] could not write the created-data audit list: ${String(error)}`);
    }
    surfaceCleanupFailures(registry.items, testInfo, sapCleanupFailure ?? loadEnv().get('SAP_GUI_CLEANUP_FAILURE', 'fail'));
  },
});

/**
 * Logged-only cleanup failures are how orphan orders pile up in a shared system: every failed cleanup becomes a test annotation
 * and, unless `mode` is 'warn', fails the test with the list of what is still in SAP.
 */
export function surfaceCleanupFailures(
  items: readonly CreatedObject[],
  testInfo: { annotations: Array<{ type: string; description?: string }> },
  mode: string,
): void {
  const failed = items.filter((o) => o.status === 'cleanup-failed');
  for (const o of failed)
    testInfo.annotations.push({ type: 'sap-cleanup-failed', description: `${o.type} ${o.id}: ${o.note ?? 'cleanup failed'}` });
  if (failed.length > 0 && mode !== 'warn') {
    throw new Error(
      `${failed.length} SAP object(s) created by this test could not be cleaned up and are still in SAP:\n` +
        failed.map((o) => `  ${o.type} ${o.id}: ${o.note ?? 'cleanup failed'}`).join('\n') +
        '\n(SAP_GUI_CLEANUP_FAILURE=warn only records them; `sap-gui-data orphans` lists them afterwards)',
    );
  }
}

/**
 * Brings a reused session back to the start screen before a test. When that fails the test would start on whatever the previous
 * one left behind, so by default it fails (`mode` 'fail'); 'warn' logs it and runs the test anyway. `onFail` runs first on failure
 * (the fixture drops the connection so the next test gets a fresh one).
 */
export async function startFromHome(session: SapGuiSession, mode: string, onFail: () => Promise<void> = async () => undefined): Promise<void> {
  try {
    await session.home();
  } catch (error) {
    const message = `could not return to the start screen before the test: ${error instanceof Error ? error.message : String(error)}`;
    if (mode === 'warn') {
      log.warn(`[sap-gui] ${message}`);
      return;
    }
    await onFail().catch(() => undefined);
    throw new Error(`${message} (SAP_GUI_HOME_FAILURE=warn runs the test anyway)`);
  }
}

/** Appends this test's SAP activity to the insights file. Never throws. */
function recordInsight(
  session: SapGuiSession,
  testInfo: { titlePath: string[]; status?: string; duration: number },
  dir: string,
): void {
  try {
    const where = session.currentContext;
    appendInsight(
      {
        test: testInfo.titlePath.slice(1).join(' > '),
        status: testInfo.status ?? 'unknown',
        durationMs: testInfo.duration,
        system: where?.system,
        client: where?.client,
        user: where?.user,
        drift: session.driftItems.map((d) => ({
          expected: d.expected,
          foundId: d.foundId,
          tx: d.tx,
          screen: d.screen,
        })),
        steps: session.steps.map((e) => ({
          tx: e.tx ?? '',
          program: e.program,
          screen: e.screen,
          label: e.label,
          ms: e.ms,
          serverMs: e.serverMs,
          ok: e.ok,
        })),
      },
      dir,
    );
  } catch (error) {
    log.warn(
      `[sap-gui] could not record insights: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type Attacher = {
  attach(
    name: string,
    options: { body?: string; path?: string; contentType: string },
  ): Promise<void>;
};

/**
 * What goes into the report. Always: evidence you asked for with sap.evidence().
 * On failure (unless SAP_GUI_EVIDENCE=off): the step journal, the status bar text, a screenshot.
 * Never throws - it must not mask the real failure.
 */
export async function attachDiagnostics(
  session: SapGuiSession,
  testInfo: Attacher,
  mode: 'off' | 'failure' | 'steps',
  failed: boolean,
): Promise<void> {
  for (const item of session.evidenceItems) {
    if (fs.existsSync(item.file))
      await testInfo
        .attach(`sap-evidence: ${item.label}`, { path: item.file, contentType: 'image/png' })
        .catch(() => undefined);
  }
  session.discardEvidenceFiles(); // the report holds its own copy now
  if (session.driftItems.length > 0) {
    const body = session.driftItems
      .map(
        (d) =>
          `${d.expected}\n  now found via ${d.usedFallback} at ${d.foundId}${d.tx ? `  (transaction ${d.tx}, screen ${d.screen})` : ''}`,
      )
      .join('\n');
    await testInfo
      .attach('sap-locator-drift', { body, contentType: 'text/plain' })
      .catch(() => undefined);
  }
  if (!failed || mode === 'off') return;

  const where = await session.refreshContext().catch(() => undefined);
  if (where) {
    await testInfo
      .attach('sap-context', {
        body: `system ${where.system}, client ${where.client}, user ${where.user}, language ${where.language}\ntransaction ${where.transaction || '(none)'}, screen ${where.screen}, program ${where.program}`,
        contentType: 'text/plain',
      })
      .catch(() => undefined);
  }
  const journal = session.journalText();
  if (journal)
    await testInfo
      .attach('sap-steps', { body: journal, contentType: 'text/plain' })
      .catch(() => undefined);
  try {
    const statusBar = await session.statusBarText();
    await testInfo.attach('sap-status-bar', {
      body: statusBar || '(empty)',
      contentType: 'text/plain',
    });
    log.error(`SAP status bar at failure: ${statusBar || '(empty)'}`);
  } catch (error) {
    log.warn(
      `could not read the SAP status bar after failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const file = path.join(session.screenshotDir(), `sap-failure-${process.pid}-${Date.now()}.png`);
    try {
      await session.screenshot(file);
      if (fs.existsSync(file))
        await testInfo.attach('sap-screenshot', { path: file, contentType: 'image/png' });
    } finally {
      fs.rmSync(file, { force: true });
    }
  } catch (error) {
    log.warn(
      `could not capture a SAP screenshot after failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
