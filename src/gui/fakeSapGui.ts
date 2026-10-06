import { formatLink } from './memberPath';
import { SapGuiTransportError, type ChainLink, type SapGuiChild, type SapGuiCommand, type SapGuiTransport, type SapGuiValue } from './types';

export interface FakeElementSpec {
  type: string;
  props?: Record<string, SapGuiValue>;
  /** The element only exists this long after its screen appears - like a control SAP renders late. */
  appearsAfterMs?: number;
}

export interface FakeContext {
  get(id: string, prop: string): SapGuiValue;
}

export interface FakeScreen {
  name: string;
  elements: Record<string, FakeElementSpec>;
  /** `sendVKey`: return the name of the screen to go to (or nothing to stay). */
  onVKey?: (vKey: number, ctx: FakeContext) => string | undefined;
  /** `press` on a given id. */
  onPress?: Record<string, (ctx: FakeContext) => string | undefined>;
  /** `session.startTransaction`. */
  onTransaction?: (tcode: string, ctx: FakeContext) => string | undefined;
  /** Text for the status bar after arriving on this screen (set on `wnd[0]/sbar`). */
  status?: string | ((ctx: FakeContext) => string);
}

export interface FakeSapGuiOptions {
  screens: FakeScreen[];
  start: string;
  /**
   * How long a screen change takes, during which SAP reports busy and the
   * new screen's elements can't be found yet. This is what makes the fake a
   * faithful stand-in: the failure a recorded script hits against real SAP
   * is racing a screen change, and without this the fake could never fail
   * the way real SAP does.
   */
  transitionDelayMs?: number;
}

export interface FakeCall {
  op: 'set' | 'call';
  id: string;
  name: string;
  args: SapGuiValue[];
}

/**
 * An in-memory SAP GUI: same transport contract as the real bridge, driven
 * by a small screen/transition model. For the framework's own tests and for
 * trying a conversion without a SAP system - NOT a way to validate a real
 * recording (it only knows the screens you give it).
 */
/** `columns.elementAt(1).width` - how a chained access is recorded in `calls` and keyed in the fake's values. */
function fullName(via: ChainLink[] | undefined, name: string): string {
  return [...(via ?? []).map((link) => formatLink(link.member, link.args)), name].join('.');
}

export class FakeSapGui implements SapGuiTransport {
  /** Every set/call the session made, in order - assert against this. */
  readonly calls: FakeCall[] = [];
  private current: FakeScreen;
  private values = new Map<string, Record<string, SapGuiValue>>();
  private arrivedAt = 0;
  private readyAt = 0;
  private attached = false;
  private closed = false;

  constructor(private readonly options: FakeSapGuiOptions) {
    this.current = this.screen(options.start);
    this.enter(this.current, 0);
  }

  get currentScreen(): string {
    return this.current.name;
  }

  private screen(name: string): FakeScreen {
    const found = this.options.screens.find((s) => s.name === name);
    if (!found) throw new Error(`FakeSapGui: no screen named "${name}"`);
    return found;
  }

  private enter(screen: FakeScreen, delay: number): void {
    this.current = screen;
    this.values = new Map();
    this.arrivedAt = Date.now();
    this.readyAt = this.arrivedAt + delay;
    const status = typeof screen.status === 'function' ? screen.status(this.ctx) : screen.status;
    if (status !== undefined) this.values.set('wnd[0]/sbar', { text: status });
  }

  private get ctx(): FakeContext {
    return { get: (id, prop) => this.read(id, prop) };
  }

  private busy(): boolean {
    return Date.now() < this.readyAt;
  }

  private visible(id: string): boolean {
    if (id === '') return true;
    const spec = this.current.elements[id];
    if (!spec) return false;
    return Date.now() >= this.readyAt + (spec.appearsAfterMs ?? 0);
  }

  private read(id: string, prop: string): SapGuiValue {
    const stored = this.values.get(id)?.[prop];
    if (stored !== undefined) return stored;
    return this.current.elements[id]?.props?.[prop] ?? (prop === 'text' ? '' : null);
  }

  private require(id: string): void {
    if (!this.visible(id)) throw new SapGuiTransportError(`The control could not be found by id: ${id}`, 'NOT_FOUND');
  }

  private go(target: string | undefined): void {
    if (target) this.enter(this.screen(target), this.options.transitionDelayMs ?? 0);
  }

  async request(command: SapGuiCommand): Promise<unknown> {
    if (this.closed) throw new SapGuiTransportError('bridge is closed', 'BRIDGE_EXITED');
    switch (command.op) {
      case 'ping':
        return 'pong';
      case 'quit':
        return null;
      case 'attach':
      case 'open':
        this.attached = true;
        return null;
      case 'busy':
        return this.busy();
      case 'exists':
        return this.visible(command.id);
      case 'get':
        this.require(command.id);
        return this.read(command.id, fullName(command.via, command.prop));
      case 'children': {
        const prefix = command.id === '' ? '' : `${command.id}/`;
        return Object.keys(this.current.elements)
          .filter((id) => id.startsWith(prefix) && !id.slice(prefix.length).includes('/') && id !== command.id && this.visible(id))
          .map((id): SapGuiChild => ({ id, type: this.current.elements[id]?.type ?? '', name: id.split('/').pop() ?? '', text: String(this.read(id, 'text')) }));
      }
      case 'set': {
        this.assertAttached();
        this.require(command.id);
        const prop = fullName(command.via, command.prop);
        this.calls.push({ op: 'set', id: command.id, name: prop, args: [command.value] });
        this.values.set(command.id, { ...this.values.get(command.id), [prop]: command.value });
        return null;
      }
      case 'call': {
        this.assertAttached();
        this.require(command.id);
        this.calls.push({ op: 'call', id: command.id, name: fullName(command.via, command.method), args: command.args });
        return this.invoke(command.id, command.method, command.args);
      }
    }
  }

  private invoke(id: string, method: string, args: SapGuiValue[]): unknown {
    const m = method.toLowerCase();
    if (m === 'press') {
      this.go(this.current.onPress?.[id]?.(this.ctx));
    } else if (m === 'sendvkey') {
      this.go(this.current.onVKey?.(Number(args[0]), this.ctx));
    } else if (m === 'starttransaction' && id === '') {
      this.go(this.current.onTransaction?.(String(args[0]), this.ctx));
    }
    return null;
  }

  private assertAttached(): void {
    if (!this.attached) throw new SapGuiTransportError('not attached to a SAP GUI session', 'ERROR');
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface SampleSapSystemOptions {
  user?: string;
  password?: string;
  client?: string;
  transitionDelayMs?: number;
}

/**
 * A small made-up SAP: logon -> Easy Access -> create sales order (VA01) ->
 * save. Ids follow what the recorder produces for the real thing (including
 * a table-control cell). Used by the example recording and the framework's
 * own tests.
 */
export function createSampleSapSystem(options: SampleSapSystemOptions = {}): FakeSapGui {
  const { user = 'TESTUSER', password = 'correct-horse', client = '100', transitionDelayMs = 150 } = options;
  const wrongLogin = 'Name or password is incorrect (repeat logon)';

  return new FakeSapGui({
    start: 'logon',
    transitionDelayMs,
    screens: [
      {
        name: 'logon',
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[0]/usr': { type: 'GuiUserArea' },
          'wnd[0]/usr/txtRSYST-MANDT': { type: 'GuiTextField' },
          'wnd[0]/usr/txtRSYST-BNAME': { type: 'GuiTextField' },
          'wnd[0]/usr/pwdRSYST-BCODE': { type: 'GuiPasswordField' },
          'wnd[0]/usr/txtRSYST-LANGU': { type: 'GuiTextField' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onVKey: (vKey, ctx) => {
          if (vKey !== 0) return undefined;
          const ok =
            ctx.get('wnd[0]/usr/txtRSYST-BNAME', 'text') === user &&
            ctx.get('wnd[0]/usr/pwdRSYST-BCODE', 'text') === password &&
            ctx.get('wnd[0]/usr/txtRSYST-MANDT', 'text') === client;
          return ok ? 'easyAccess' : 'logonFailed';
        },
      },
      {
        name: 'logonFailed',
        status: wrongLogin,
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[0]/usr/txtRSYST-BNAME': { type: 'GuiTextField' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
      },
      {
        name: 'easyAccess',
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onTransaction: (tcode) => (tcode.toUpperCase() === 'VA01' ? 'va01Initial' : undefined),
        onVKey: (vKey, ctx) => {
          if (vKey !== 0) return undefined;
          const code = String(ctx.get('wnd[0]/tbar[0]/okcd', 'text')).replace(/^\/n/i, '').toUpperCase();
          return code === 'VA01' ? 'va01Initial' : undefined;
        },
      },
      {
        name: 'va01Initial',
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[0]/usr/ctxtVBAK-AUART': { type: 'GuiCTextField' },
          'wnd[0]/usr/ctxtVBAK-VKORG': { type: 'GuiCTextField' },
          'wnd[0]/usr/ctxtVBAK-VTWEG': { type: 'GuiCTextField' },
          'wnd[0]/usr/ctxtVBAK-SPART': { type: 'GuiCTextField' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onVKey: (vKey, ctx) => (vKey === 0 && ctx.get('wnd[0]/usr/ctxtVBAK-AUART', 'text') === 'OR' ? 'va01Overview' : undefined),
      },
      {
        name: 'va01Overview',
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[0]/usr/ctxtKUAGV-KUNNR': { type: 'GuiCTextField' },
          'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG': { type: 'GuiTableControl' },
          'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]': { type: 'GuiCTextField', appearsAfterMs: 120 },
          'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtRV45A-KWMENG[3,0]': { type: 'GuiTextField', appearsAfterMs: 120 },
          'wnd[0]/tbar[0]/btn[11]': { type: 'GuiButton', props: { tooltip: 'Save' } },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onPress: { 'wnd[0]/tbar[0]/btn[11]': () => 'saved' },
      },
      {
        name: 'saved',
        status: 'Standard Order 4711 has been saved',
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
      },
    ],
  });
}
