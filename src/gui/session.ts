import { adapterStep, AdapterError, type Adapter } from '@automation/referenced-automation-utils';
import { parseMemberPath } from './memberPath';
import { SapGuiTransportError, type SapGuiChild, type SapGuiTransport, type SapGuiValue } from './types';

export interface SapGuiSessionOptions {
  /** How long any single step may wait for its element / for SAP to go idle. Default 30s (SAP_GUI_TIMEOUT_MS). */
  timeoutMs?: number;
  /** How often to look while waiting. Default 100ms. */
  pollMs?: number;
  /** SAP must report "not busy" this many polls in a row before a step is considered finished - one idle blink between two server round trips isn't "done". Default 2. */
  stablePolls?: number;
}

/** The element a step needed was not on the screen in time - with what *is* on the screen, so the recording can be repaired without opening SAP. */
export class SapGuiElementNotFoundError extends AdapterError {
  constructor(
    readonly elementId: string,
    readonly waitedMs: number,
    readonly nearestExistingId: string,
    readonly siblings: SapGuiChild[],
    readonly statusBar: string,
    cause?: unknown,
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
        (statusBar ? `. Status bar says: "${statusBar}"` : ''),
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
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly stablePolls: number;

  constructor(
    private readonly transport: SapGuiTransport,
    options: SapGuiSessionOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 100;
    this.stablePolls = options.stablePolls ?? 2;
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
    return new SapGuiSession(transport, sessionOptions);
  }

  /** Opens a new connection by its SAP Logon name (e.g. "QR1 - Retail"), landing on its logon screen. If SAP Logon is not running it is started from `logonPath` first. */
  static async open(
    transport: SapGuiTransport,
    connectionName: string,
    options: SapGuiSessionOptions & { logonPath?: string } = {},
  ): Promise<SapGuiSession> {
    const { logonPath, ...sessionOptions } = options;
    await adapterStep('sap-gui', 'open connection', () => transport.request({ op: 'open', connectionName, logonPath }), {
      details: { connectionName },
    });
    return new SapGuiSession(transport, sessionOptions);
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
    return new SapGuiElementNotFoundError(id, waitedMs, nearest, siblings, statusBar);
  }

  private async ready(id: string): Promise<void> {
    // Before a step one quiet reading is enough; the settle check that matters is after a round trip (see call()).
    await this.waitUntilIdle(this.timeoutMs, 1);
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

  async get<T = SapGuiValue>(id: string, prop: string): Promise<T> {
    return adapterStep(
      this.name,
      `get ${prop}`,
      async () => {
        await this.ready(id);
        const { via, name } = parseMemberPath(prop);
        return (await this.withRetry(id, () => this.transport.request({ op: 'get', id, prop: name, via }))) as T;
      },
      { level: 'debug', details: { id } },
    );
  }

  async set(id: string, prop: string, value: SapGuiValue): Promise<void> {
    await adapterStep(
      this.name,
      `set ${prop}`,
      async () => {
        await this.ready(id);
        const { via, name } = parseMemberPath(prop);
        await this.withRetry(id, () => this.transport.request({ op: 'set', id, prop: name, value, via }));
      },
      { details: { id, value: SECRET_ID.test(id) ? '[REDACTED]' : value } },
    );
  }

  async call(id: string, method: string, ...args: SapGuiValue[]): Promise<unknown> {
    return adapterStep(
      this.name,
      method,
      async () => {
        await this.ready(id);
        const { via, name } = parseMemberPath(method);
        const result = await this.withRetry(id, () => this.transport.request({ op: 'call', id, method: name, args, via }));
        if (SERVER_ROUND_TRIP_METHODS.has(name.toLowerCase())) await this.waitUntilIdle();
        return result;
      },
      { details: { id, args: args.length > 0 ? args : undefined } },
    );
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

  async statusBarText(): Promise<string> {
    if (!(await this.exists('wnd[0]/sbar'))) return '';
    return String(await this.transport.request({ op: 'get', id: 'wnd[0]/sbar', prop: 'text' }));
  }

  // -------------------------------------------------------------- Adapter

  async healthCheck(): Promise<boolean> {
    try {
      return (await this.transport.request({ op: 'ping' })) === 'pong';
    } catch {
      return false;
    }
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
