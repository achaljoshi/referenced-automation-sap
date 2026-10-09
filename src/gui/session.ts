import * as os from 'node:os';
import * as path from 'node:path';
import { adapterStep, AdapterError, getLogger, type Adapter } from '@automation/referenced-automation-utils';
import { SapGrid, SapTable, SapTree } from './controls';
import { SapLocator } from './locator';
import { parseMemberPath } from './memberPath';
import { SapGuiTransportError, type ControlInfo, type SapContext, type FindCriteria, type SapGuiChild, type SapGuiTransport, type SapGuiValue } from './types';

export interface SapGuiSessionOptions {
  /** How long any single step may wait for its element / for SAP to go idle. Default 30s (SAP_GUI_TIMEOUT_MS). */
  timeoutMs?: number;
  /** How often to look while waiting. Default 100ms. */
  pollMs?: number;
  /** SAP must report "not busy" this many polls in a row before a step is considered finished - one idle blink between two server round trips isn't "done". Default 2. */
  stablePolls?: number;
  /** 'steps' also takes a screenshot after every step that changes the screen (SAP_GUI_EVIDENCE=steps); evidence you ask for with sap.evidence() is always kept. Default 'off'. */
  evidence?: 'off' | 'steps';
  /** Ask SAP which transaction/program/screen it is on after each screen change, and attribute every step to it (journal, coverage, response-time baseline, failure messages). One extra call per screen change. Default true. */
  trackContext?: boolean;
}

/** One line of the step journal: what the session did, how long it took, whether it worked. */
export interface JournalEntry {
  at: number;
  label: string;
  id: string;
  ms: number;
  ok: boolean;
  error?: string;
  /** The transaction / program / screen the step ran in (when context tracking is on). */
  tx?: string;
  program?: string;
  screen?: string;
  /** For a screen-changing step: SAP's own response time for that round trip, in ms (when SAP reports it). */
  serverMs?: number;
}

/** Say what to do when an unexpected pop-up (a modal window, wnd[1]...) appears in front of a step. */
export interface PopupMatch {
  /** The pop-up's title: a string (contains, case-insensitive) or a RegExp. */
  title?: string | RegExp;
  /** Or: a control id that exists inside the pop-up, e.g. 'wnd[1]/usr/radMULTI_LOGON_OPT2'. */
  contains?: string;
}

interface PopupHandler {
  name: string;
  match: PopupMatch;
  handle: (sap: SapGuiSession) => Promise<void>;
  remaining: number;
}

const JOURNAL_LIMIT = 300;
const log = getLogger('sap-gui');

/** The element a step needed was not on the screen in time - with what *is* on the screen, so the recording can be repaired without opening SAP. */
export class SapGuiElementNotFoundError extends AdapterError {
  constructor(
    readonly elementId: string,
    readonly waitedMs: number,
    readonly nearestExistingId: string,
    readonly siblings: SapGuiChild[],
    readonly statusBar: string,
    cause?: unknown,
    readonly where?: SapContext,
  ) {
    super(
      'sap-gui',
      'findById',
      `"${elementId}" not found after ${waitedMs}ms. ` +
        `Nearest id that does exist: "${nearestExistingId || '(session)'}"` +
        (siblings.length > 0
          ? `, which contains: ${siblings
              .slice(0, 12)
              .map((child) => child.id.split('/').pop())
              .join(', ')}${siblings.length > 12 ? ', ...' : ''}`
          : '') +
        (statusBar ? `. Status bar says: "${statusBar}"` : '') +
        (where && (where.transaction || where.program) ? `. SAP is on transaction ${where.transaction || '(none)'}, screen ${where.screen}, program ${where.program}` : ''),
      { cause },
    );
    this.name = 'SapGuiElementNotFoundError';
    Object.setPrototypeOf(this, SapGuiElementNotFoundError.prototype);
  }
}

// Methods that make SAP GUI talk to the server (a screen change, a new
// transaction, a dialog opening). After one of these returns, the next screen
// isn't there yet - so the session waits for SAP to settle before the next
// step runs, which is exactly the wait a recorded script is missing.
const SERVER_ROUND_TRIP_METHODS = new Set(
  [
    'press', 'sendVKey', 'select', 'doubleClick', 'doubleClickCurrentCell', 'clickCurrentCell',
    'doubleClickNode', 'doubleClickItem', 'clickLink', 'pressButton', 'pressToolbarButton',
    'pressToolbarContextButton', 'selectContextMenuItem', 'selectContextMenuItemByText',
    'selectContextMenuItemByPosition', 'contextMenu', 'nodeContextMenu', 'itemContextMenu',
    'selectNode', 'expandNode', 'collapseNode', 'startTransaction', 'endTransaction', 'close',
    'createSession', 'openContextMenu', 'pressEnter', 'sendCommand',
  ].map((m) => m.toLowerCase()),
);

/** Gap between the confirming polls once SAP has looked idle. */
const CONFIRM_GAP_MS = 20;

const SECRET_ID = /(^|\/)pwd/i;

/**
 * One live SAP GUI session, driven with the same technical ids the SAP GUI
 * Scripting recorder produces - so the recorded VBScript's `findById("...")`
 * strings are used unchanged.
 *
 * What it adds over the raw COM API a recorded script uses, and what makes a
 * converted recording run without failures:
 *  - Before every step it waits for SAP to be idle and for the element to
 *    exist (the recorder emits neither wait - a script that works when you
 *    recorded it, slowly, by hand, races on a faster run).
 *  - After a step that triggers a server round trip it waits for SAP to
 *    settle before returning.
 *  - A step that hits a transient "not found" while the screen is changing is
 *    retried until the timeout.
 *  - A genuine failure says what IS on the screen (nearest existing id, its
 *    children, the status bar), not just "findById failed".
 *  - Every step is logged like any other adapter's, passwords masked.
 */
export class SapGuiSession implements Adapter {
  readonly name = 'sap-gui';
  /** How long any one step may wait (SAP_GUI_TIMEOUT_MS). */
  readonly timeoutMs: number;
  /** How often to look while waiting. */
  readonly pollMs: number;
  private readonly stablePolls: number;
  private readonly evidenceMode: 'off' | 'steps';
  private readonly trackContext: boolean;
  /** The pooled SAP user this session was given (SAP_USER_POOL); `logon()` uses it. */
  assignedUser?: string;
  private lastContext?: SapContext;
  private roundTripped = false;
  private readonly journal: JournalEntry[] = [];
  private readonly popupHandlers: PopupHandler[] = [];
  private handlingPopup = false;
  private readonly evidenceFiles: Array<{ label: string; file: string }> = [];
  private evidenceCount = 0;

  constructor(
    private readonly transport: SapGuiTransport,
    options: SapGuiSessionOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 100;
    this.stablePolls = options.stablePolls ?? 2;
    this.evidenceMode = options.evidence ?? 'off';
    this.trackContext = options.trackContext ?? true;
  }

  /** Attaches to a SAP Logon connection/session that is already open (the safe default for a shared system - it never creates or closes anyone's session). */
  static async attach(
    transport: SapGuiTransport,
    options: SapGuiSessionOptions & { connectionIndex?: number; sessionIndex?: number } = {},
  ): Promise<SapGuiSession> {
    const { connectionIndex = 0, sessionIndex = 0, ...sessionOptions } = options;
    await adapterStep('sap-gui', 'attach', () => transport.request({ op: 'attach', connectionIndex, sessionIndex }), {
      details: { connectionIndex, sessionIndex },
    });
    const session = new SapGuiSession(transport, sessionOptions);
    await session.refreshContext();
    return session;
  }

  /** Opens a new connection by its SAP Logon name (e.g. "QR1 - Retail"), landing on its logon screen. If SAP Logon is not running it is started from `logonPath` first. */
  static async open(
    transport: SapGuiTransport,
    connectionName: string,
    options: SapGuiSessionOptions & { logonPath?: string; connectionString?: string } = {},
  ): Promise<SapGuiSession> {
    const { logonPath, connectionString, ...sessionOptions } = options;
    await adapterStep('sap-gui', 'open connection', () => transport.request({ op: 'open', connectionName, connectionString, logonPath }), {
      details: { connectionName: connectionString ? '(connection string)' : connectionName },
    });
    const session = new SapGuiSession(transport, sessionOptions);
    await session.refreshContext();
    return session;
  }

  // ---------------------------------------------------------------- waiting

  /** The controls directly inside `id` ('' = the session), with their technical ids. */
  async children(id: string): Promise<SapGuiChild[]> {
    return (await this.transport.request({ op: 'children', id })) as SapGuiChild[];
  }

  async exists(id: string): Promise<boolean> {
    return (await this.transport.request({ op: 'exists', id })) === true;
  }

  /**
   * Waits for SAP GUI to report not-busy `stablePolls` times in a row. Looks
   * every `pollMs` while SAP is busy, but confirms a quiet moment quickly (a
   * few ms apart) - so an already-idle session costs one cheap call, not a
   * poll interval, per step.
   */
  async waitUntilIdle(timeoutMs = this.timeoutMs, stablePolls = this.stablePolls): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let calm = 0;
    for (;;) {
      const busy = (await this.transport.request({ op: 'busy' })) === true;
      calm = busy ? 0 : calm + 1;
      if (calm >= stablePolls) return;
      if (Date.now() >= deadline) {
        throw new AdapterError('sap-gui', 'waitUntilIdle', `SAP GUI was still busy after ${timeoutMs}ms`);
      }
      await sleep(calm > 0 ? Math.min(this.pollMs, CONFIRM_GAP_MS) : this.pollMs);
    }
  }

  /** Waits for an element to exist; throws SapGuiElementNotFoundError (with the screen's actual contents) if it doesn't in time. */
  async waitFor(id: string, timeoutMs = this.timeoutMs): Promise<void> {
    if (id === '') return;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    while (!(await this.exists(id))) {
      if (Date.now() >= deadline) throw await this.notFound(id, Date.now() - startedAt);
      await sleep(this.pollMs);
    }
  }

  private async notFound(id: string, waitedMs: number): Promise<SapGuiElementNotFoundError> {
    // Walk up the id until something exists, and show what it contains.
    const parts = id.split('/');
    let nearest = '';
    for (let end = parts.length - 1; end > 0; end--) {
      const candidate = parts.slice(0, end).join('/');
      if (await this.exists(candidate).catch(() => false)) {
        nearest = candidate;
        break;
      }
    }
    const siblings = (await this.transport.request({ op: 'children', id: nearest }).catch(() => [])) as SapGuiChild[];
    const statusBar = await this.statusBarText().catch(() => '');
    const where = await this.refreshContext();
    return new SapGuiElementNotFoundError(id, waitedMs, nearest, siblings, statusBar, undefined, where);
  }

  private async ready(id: string): Promise<void> {
    // Before a step one quiet reading is enough; the settle check that matters is after a round trip (see call()).
    await this.waitUntilIdle(this.timeoutMs, 1);
    // A step aimed AT a pop-up (wnd[1]...) must not have that pop-up taken away from it by a handler.
    if (this.popupHandlers.length > 0 && !this.handlingPopup && !/^wnd\[[1-9]/.test(id)) await this.dismissPopups();
    await this.waitFor(id);
  }

  /** Runs `attempt`, retrying while the screen is mid-change (element momentarily gone) until the timeout. */
  private async withRetry<T>(id: string, attempt: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        const transient = error instanceof SapGuiTransportError && error.code === 'NOT_FOUND';
        if (!transient || Date.now() >= deadline) throw transient ? await this.notFound(id, this.timeoutMs) : error;
        await sleep(this.pollMs);
        await this.waitUntilIdle().catch(() => undefined);
      }
    }
  }

  // ---------------------------------------------------------- generic access

  /** One logged, timed, journaled step. */
  private async step<T>(label: string, id: string, details: Record<string, unknown>, action: () => Promise<T>, level: 'info' | 'debug' = 'info'): Promise<T> {
    const startedAt = Date.now();
    const where = this.lastContext ? { tx: this.lastContext.transaction, program: this.lastContext.program, screen: this.lastContext.screen } : {};
    this.roundTripped = false;
    try {
      const result = await adapterStep(this.name, label, action, { level, details });
      const serverMs = this.roundTripped ? this.lastContext?.responseMs : undefined;
      this.record({ at: startedAt, label, id, ms: Date.now() - startedAt, ok: true, ...where, ...(serverMs !== undefined ? { serverMs } : {}) });
      return result;
    } catch (error) {
      this.record({ at: startedAt, label, id, ms: Date.now() - startedAt, ok: false, error: error instanceof Error ? error.message : String(error), ...where });
      throw error;
    }
  }

  private record(entry: JournalEntry): void {
    this.journal.push(entry);
    if (this.journal.length > JOURNAL_LIMIT) this.journal.shift();
  }

  async get<T = SapGuiValue>(id: string, prop: string): Promise<T> {
    return this.step(
      `get ${prop}`,
      id,
      { id },
      async () => {
        await this.ready(id);
        const { via, name } = parseMemberPath(prop);
        return (await this.withRetry(id, () => this.transport.request({ op: 'get', id, prop: name, via }))) as T;
      },
      'debug',
    );
  }

  async set(id: string, prop: string, value: SapGuiValue, options: { secret?: boolean } = {}): Promise<void> {
    await this.step(
      `set ${prop}`,
      id,
      { id, value: options.secret || SECRET_ID.test(id) ? '[REDACTED]' : value },
      async () => {
        await this.ready(id);
        const { via, name } = parseMemberPath(prop);
        await this.withRetry(id, () => this.transport.request({ op: 'set', id, prop: name, value, via }));
      },
    );
  }

  async call(id: string, method: string, ...args: SapGuiValue[]): Promise<unknown> {
    return this.step(method, id, { id, args: args.length > 0 ? args : undefined }, async () => {
      await this.ready(id);
      const { via, name } = parseMemberPath(method);
      const result = await this.withRetry(id, () => this.transport.request({ op: 'call', id, method: name, args, via }));
      if (SERVER_ROUND_TRIP_METHODS.has(name.toLowerCase())) {
        await this.waitUntilIdle();
        await this.refreshContext();
        this.roundTripped = true;
        if (this.evidenceMode === 'steps') await this.evidence(`${name} ${id}`);
      }
      return result;
    });
  }

  // ------------------------------------------------- where SAP is

  /** Which system, user, transaction, program and screen SAP is on right now (and its own response time for the last round trip). */
  async context(): Promise<SapContext> {
    return (await this.transport.request({ op: 'context' })) as SapContext;
  }

  /** The last context we read - cheap, no SAP call. Updated after every screen-changing step. */
  get currentContext(): SapContext | undefined {
    return this.lastContext;
  }

  /** Re-reads the context; never throws (an older SAP GUI may not report everything). */
  async refreshContext(): Promise<SapContext | undefined> {
    if (!this.trackContext) return this.lastContext;
    try {
      this.lastContext = await this.context();
    } catch (error) {
      log.debug(`[sap-gui] could not read the session context: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.lastContext;
  }

  // ------------------------------------------------- finding controls (Playwright-style)

  /** A control by its technical id (what the recorder gives you). */
  locator(id: string): SapLocator {
    return new SapLocator(this, { kind: 'id', id }, id);
  }

  /** Controls whose text contains `text` (case-insensitive; `exact` for the whole text) - buttons, labels, tabs, menu entries. */
  getByText(text: string, options: { exact?: boolean; root?: string; type?: string } = {}): SapLocator {
    return this.byCriteria({ root: options.root ?? 'wnd[0]', text, exact: options.exact, type: options.type }, `text "${text}"`);
  }

  /** Controls whose tooltip contains `tooltip` - toolbar buttons are usually found this way ("Save", "Back"). */
  getByTooltip(tooltip: string, options: { exact?: boolean; root?: string; type?: string } = {}): SapLocator {
    return this.byCriteria({ root: options.root ?? 'wnd[0]', tooltip, exact: options.exact, type: options.type }, `tooltip "${tooltip}"`);
  }

  /** The input field next to the label the user sees: getByLabel('Sold-To Party'). */
  getByLabel(label: string, options: { exact?: boolean; root?: string } = {}): SapLocator {
    return this.byCriteria({ root: options.root ?? 'wnd[0]', label, exact: options.exact }, `label "${label}"`);
  }

  /** Controls of one SAP class, e.g. getByType('GuiButton'). */
  getByType(type: string, options: { name?: string; root?: string } = {}): SapLocator {
    return this.byCriteria({ root: options.root ?? 'wnd[0]', type, name: options.name }, `type ${type}${options.name ? ` named ${options.name}` : ''}`);
  }

  private byCriteria(criteria: FindCriteria, description: string): SapLocator {
    return new SapLocator(this, { kind: 'find', criteria }, description);
  }

  /** An ALV grid / GuiShell grid (the `cntlGRID1/shellcont/shell` controls). */
  grid(id: string): SapGrid {
    return new SapGrid(this, id);
  }

  /** A table control (the `tbl...` controls of classic dynpro screens: order items, etc.). */
  table(id: string): SapTable {
    return new SapTable(this, id);
  }

  /** A tree control (the SAP Easy Access menu, hierarchy lists). */
  tree(id: string): SapTree {
    return new SapTree(this, id);
  }

  /** Ids of every control matching `criteria` right now (document order). Does not wait. */
  async findIds(criteria: FindCriteria): Promise<string[]> {
    return (await this.transport.request({ op: 'find', criteria })) as string[];
  }

  /** What a control is (type, text, tooltip, read-only?) in one round trip. Waits for it to exist. */
  async info(id: string): Promise<ControlInfo> {
    await this.ready(id);
    return (await this.withRetry(id, () => this.transport.request({ op: 'info', id }))) as ControlInfo;
  }

  // ------------------------------------------------------ pop-up handlers

  /**
   * Say once what to do about a pop-up that SAP may show in front of any step -
   * "Information" boxes, license notices, system messages - instead of
   * sprinkling `if (popup exists)` through every test. Handlers run before a
   * step whenever a modal window is open; a step that targets the pop-up
   * itself (wnd[1]...) is never intercepted. Cleared between tests by the fixture.
   *
   *   sap.onPopup('system message', { title: /System Message/ }, (s) => s.press('wnd[1]/tbar[0]/btn[0]'));
   *
   * @returns a function that removes the handler again.
   */
  onPopup(name: string, match: PopupMatch, handle: (sap: SapGuiSession) => Promise<void>, options: { times?: number } = {}): () => void {
    const handler: PopupHandler = { name, match, handle, remaining: options.times ?? Number.POSITIVE_INFINITY };
    this.popupHandlers.push(handler);
    return () => {
      const index = this.popupHandlers.indexOf(handler);
      if (index !== -1) this.popupHandlers.splice(index, 1);
    };
  }

  clearPopupHandlers(): void {
    this.popupHandlers.length = 0;
  }

  /** Runs the matching handler for each modal window in front (up to 5 in a row). Returns how many were handled. */
  async dismissPopups(): Promise<number> {
    let handled = 0;
    this.handlingPopup = true;
    try {
      for (let round = 0; round < 5 && (await this.exists('wnd[1]')); round++) {
        const title = String((await this.transport.request({ op: 'get', id: 'wnd[1]', prop: 'text' }).catch(() => '')) ?? '');
        let chosen: PopupHandler | undefined;
        for (const handler of this.popupHandlers) {
          if (handler.remaining <= 0) continue;
          const titleOk = handler.match.title === undefined || (typeof handler.match.title === 'string' ? title.toLowerCase().includes(handler.match.title.toLowerCase()) : handler.match.title.test(title));
          const containsOk = handler.match.contains === undefined || (await this.exists(handler.match.contains));
          if (titleOk && containsOk) {
            chosen = handler;
            break;
          }
        }
        if (!chosen) break;
        log.info(`[sap-gui] pop-up "${title}" handled by "${chosen.name}"`);
        chosen.remaining--;
        await chosen.handle(this);
        await this.waitUntilIdle().catch(() => undefined);
        handled++;
      }
    } finally {
      this.handlingPopup = false;
    }
    return handled;
  }

  // ----------------------------------------------- diagnostics: journal and evidence

  /** The most recent steps, one per line - what ran, how long it took, which one failed and why. Attached to the report on failure. */
  journalText(limit = 40): string {
    const time = (at: number) => new Date(at).toISOString().slice(11, 23);
    return this.journal
      .slice(-limit)
      .map((e) => `${time(e.at)}  ${e.ok ? 'ok  ' : 'FAIL'}  ${(e.tx ?? '').padEnd(14)} ${e.label.padEnd(24)} ${e.id.padEnd(48)} ${String(e.ms).padStart(5)}ms${e.error ? `   ${e.error}` : ''}`)
      .join('\n');
  }

  get steps(): readonly JournalEntry[] {
    return this.journal;
  }

  /** Screenshot of the SAP window, kept and attached to the test report under `label`. Returns the file, or undefined if SAP could not take it. */
  async evidence(label: string): Promise<string | undefined> {
    const file = path.join(os.tmpdir(), `sap-evidence-${process.pid}-${Date.now()}-${++this.evidenceCount}.png`);
    try {
      await this.screenshot(file);
      this.evidenceFiles.push({ label, file });
      return file;
    } catch (error) {
      log.warn(`[sap-gui] could not capture evidence "${label}": ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  get evidenceItems(): ReadonlyArray<{ label: string; file: string }> {
    return this.evidenceFiles;
  }

  /** Forget per-test state (journal, evidence list, pop-up handlers) - the fixture calls this between tests so a reused session starts clean. */
  resetDiagnostics(): void {
    this.journal.length = 0;
    this.evidenceFiles.length = 0;
    this.popupHandlers.length = 0;
  }

  // ------------------------------------------------- the recorder's vocabulary

  async setText(id: string, value: string): Promise<void> {
    await this.set(id, 'text', value);
  }

  async getText(id: string): Promise<string> {
    return String(await this.get(id, 'text'));
  }

  async press(id: string): Promise<void> {
    await this.call(id, 'press');
  }

  async select(id: string): Promise<void> {
    await this.call(id, 'select');
  }

  async setFocus(id: string): Promise<void> {
    await this.call(id, 'setFocus');
  }

  async setSelected(id: string, selected: boolean): Promise<void> {
    await this.set(id, 'selected', selected);
  }

  /** Virtual key to the main window: 0 = Enter, 3 = Back, 11 = Save, 12 = Cancel, 8 = F8 (Execute), ... */
  async sendVKey(vKey: number, id = 'wnd[0]'): Promise<void> {
    await this.call(id, 'sendVKey', vKey);
  }

  /** The usual "type the t-code in the command field and press Enter" - `/n` is added for you. */
  async startTransaction(tcode: string): Promise<void> {
    await adapterStep(this.name, `startTransaction ${tcode}`, async () => {
      await this.call('', 'startTransaction', tcode);
    });
  }

  /** Waits for SAP to be idle and any registered pop-up handlers to run - the same preparation every step does first. */
  async settle(): Promise<void> {
    await this.ready('');
  }

  /** A control's info right now, without waiting; undefined if it is not on the screen. For polling - use info() to wait. */
  async peekInfo(id: string): Promise<ControlInfo | undefined> {
    try {
      return (await this.transport.request({ op: 'info', id })) as ControlInfo;
    } catch (error) {
      if (error instanceof SapGuiTransportError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  /** A property right now, without waiting; undefined if the control is not on the screen. */
  async peekProp(id: string, prop: string): Promise<SapGuiValue | undefined> {
    try {
      const { via, name } = parseMemberPath(prop);
      return (await this.transport.request({ op: 'get', id, prop: name, via })) as SapGuiValue;
    } catch (error) {
      if (error instanceof SapGuiTransportError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    }
  }

  /** The status bar message and its type: S success, E error, W warning, I information, A abort. */
  async statusBar(): Promise<{ text: string; type: string }> {
    if (!(await this.exists('wnd[0]/sbar'))) return { text: '', type: '' };
    const [text, type] = await Promise.all([this.peekProp('wnd[0]/sbar', 'text'), this.peekProp('wnd[0]/sbar', 'messageType')]);
    return { text: String(text ?? ''), type: String(type ?? '') };
  }

  async statusBarText(): Promise<string> {
    if (!(await this.exists('wnd[0]/sbar'))) return '';
    return String(await this.transport.request({ op: 'get', id: 'wnd[0]/sbar', prop: 'text' }));
  }

  // -------------------------------------------------------------- Adapter

  /** The bridge answers AND SAP GUI still has our session (reading `Busy` fails on a dead one). */
  async healthCheck(): Promise<boolean> {
    try {
      if ((await this.transport.request({ op: 'ping' })) !== 'pong') return false;
      await this.transport.request({ op: 'busy' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Back to a known starting point between tests: closes any modal windows
   * (Cancel) and returns to the start screen (/n). A session that is on the
   * logon screen has no command field and is left alone.
   */
  async home(): Promise<void> {
    await this.step('home', '', {}, async () => {
      await this.waitUntilIdle();
      for (let i = 0; i < 4 && (await this.exists('wnd[1]')); i++) {
        await this.call('wnd[1]', 'sendVKey', 12).catch(() => undefined);
      }
      if (!(await this.exists('wnd[0]/tbar[0]/okcd'))) return;
      await this.setText('wnd[0]/tbar[0]/okcd', '/n');
      await this.sendVKey(0);
    });
  }

  /** Ends the SAP session (`/nex`: no "save changes?" prompt). Use for a connection the framework opened itself - never call it on one you attached to. */
  async logoff(): Promise<void> {
    await this.step('logoff', '', {}, async () => {
      if (!(await this.exists('wnd[0]/tbar[0]/okcd'))) return;
      await this.transport.request({ op: 'set', id: 'wnd[0]/tbar[0]/okcd', prop: 'text', value: '/nex' });
      await this.transport.request({ op: 'call', id: 'wnd[0]', method: 'sendVKey', args: [0] }).catch(() => undefined);
    });
  }

  /** Releases the bridge process. Deliberately does NOT close SAP GUI windows or log anyone out. */
  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Screenshot of the main window, for failure evidence. */
  async screenshot(filePath: string): Promise<void> {
    await adapterStep(this.name, 'screenshot', async () => {
      await this.transport.request({ op: 'call', id: 'wnd[0]', method: 'HardCopy', args: [filePath, 'PNG'] });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
