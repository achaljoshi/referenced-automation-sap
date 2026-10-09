import { formatLink } from './memberPath';
import * as fs from 'node:fs';
import {
  SapGuiTransportError,
  type ChainLink,
  type ControlInfo,
  type SapContext,
  type SapGuiChild,
  type SapGuiCommand,
  type SapGuiTransport,
  type SapGuiValue,
} from './types';

export interface FakeElementSpec {
  type: string;
  /** Property values by lower-case name: text, tooltip, changeable, selected, leftLabel (the label text beside a field), ... */
  props?: Record<string, SapGuiValue>;
  /** For a drop-down: the values it accepts. Setting any other `value` fails, like SAP does. */
  options?: string[];
  /** Results for method calls on this control, e.g. a grid's getCellValue. Receives the call's arguments. */
  methods?: Record<string, (args: SapGuiValue[]) => SapGuiValue>;
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
  /** What SAP's session info reports on this screen. `transaction: '$TCODE'` means "whatever transaction code was entered". */
  context?: { transaction: string; program: string; screen: string };
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
/** Properties every SAP GUI control may have (or that scripts commonly read). Anything else not defined for a control is "unknown", as in real COM. */
const STANDARD_PROPS = new Set([
  'text',
  'tooltip',
  'changeable',
  'selected',
  'type',
  'name',
  'id',
  'messagetype',
  'value',
  'key',
  'maxlength',
  'leftlabel',
  'rightlabel',
  'rowcount',
  'columncount',
  'visiblerowcount',
  'selectednode',
  'selectedrows',
  'currentcellrow',
  'currentcellcolumn',
  'caretposition',
  'width',
  'height',
  'left',
  'top',
  'modified',
  'containertype',
  'defaulttooltip',
  'iconname',
  'highlighted',
  'entries',
  'children',
  'parent',
  'screenleft',
  'screentop',
  'busy',
  'title',
]);

function lookup(
  bag: Record<string, SapGuiValue> | undefined,
  prop: string,
): SapGuiValue | undefined {
  if (!bag) return undefined;
  const wanted = prop.toLowerCase();
  const key = Object.keys(bag).find((k) => k.toLowerCase() === wanted);
  return key === undefined ? undefined : bag[key];
}

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
  private enteredTcode = '';
  private lastTransitionMs = 0;
  private roundTrips = 0;
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
    if (!spec) {
      // Like real SAP, a container (wnd[0]/usr, wnd[0]/tbar[0] ...) exists whenever something inside it does,
      // even if the screen definition only lists the leaves.
      const inside = `${id}/`;
      return Object.keys(this.current.elements).some(
        (key) => key.startsWith(inside) && this.visible(key),
      );
    }
    return Date.now() >= this.readyAt + (spec.appearsAfterMs ?? 0);
  }

  /** COM property names are case-insensitive (`Text`, `text`, `LeftLabel`, `leftLabel`): so is the simulator. */
  private read(id: string, prop: string): SapGuiValue {
    const stored = lookup(this.values.get(id), prop);
    if (stored !== undefined) return stored;
    return (
      lookup(this.current.elements[id]?.props, prop) ?? (prop.toLowerCase() === 'text' ? '' : null)
    );
  }

  private require(id: string): void {
    if (!this.visible(id))
      throw new SapGuiTransportError(`The control could not be found by id: ${id}`, 'NOT_FOUND');
  }

  private hasScreen(name: string): boolean {
    return this.options.screens.some((screen) => screen.name === name);
  }

  /** Where `/n<tcode>` goes: the current screen's own transaction handler, else back to the start screen. */
  private screenFor(tcode: string): string | undefined {
    this.enteredTcode = tcode.toUpperCase();
    return (
      this.current.onTransaction?.(tcode, this.ctx) ??
      this.options.screens.find((s) => s.name === 'easyAccess')?.onTransaction?.(tcode, this.ctx) ??
      'easyAccess'
    );
  }

  private go(target: string | undefined): void {
    if (target) {
      this.lastTransitionMs = this.options.transitionDelayMs ?? 0;
      this.roundTrips++;
      this.enter(this.screen(target), this.lastTransitionMs);
    }
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
      case 'get': {
        this.require(command.id);
        const path = fullName(command.via, command.prop);
        // `children.count` is how scripts ask how many controls are inside a container
        if (path.toLowerCase() === 'children.count') return this.childIds(command.id).length;
        const known =
          lookup(this.values.get(command.id), path) !== undefined ||
          lookup(this.current.elements[command.id]?.props, path) !== undefined;
        if (!command.via && !known && !STANDARD_PROPS.has(command.prop.toLowerCase())) {
          throw new SapGuiTransportError(`Unknown property or method: ${command.prop}`, 'ERROR');
        }
        return this.read(command.id, path);
      }
      case 'children': {
        return this.childIds(command.id).map(
          (id): SapGuiChild => ({
            id,
            type: this.current.elements[id]?.type ?? 'GuiContainer',
            name: id.split('/').pop() ?? '',
            text: String(this.read(id, 'text')),
          }),
        );
      }
      case 'context':
        return this.contextOf();
      case 'info': {
        this.require(command.id);
        return this.infoOf(command.id);
      }
      case 'find': {
        const c = command.criteria;
        const root = c.root === '' ? '' : `${c.root}/`;
        const has = (needle: string | undefined, actual: string) =>
          needle === undefined ||
          (c.exact
            ? actual.trim().toLowerCase() === needle.trim().toLowerCase()
            : actual.toLowerCase().includes(needle.toLowerCase()));
        return Object.keys(this.current.elements)
          .filter((id) => id.startsWith(root) && id !== c.root && this.visible(id))
          .filter((id) => {
            const info = this.infoOf(id);
            const label =
              String(this.read(id, 'leftlabel') ?? '') +
              '\u0000' +
              String(this.read(id, 'rightlabel') ?? '');
            return (
              (c.type === undefined || info.type === c.type) &&
              (c.name === undefined || info.name === c.name) &&
              has(c.text, info.text) &&
              has(c.tooltip, info.tooltip) &&
              (c.label === undefined ||
                label.split('\u0000').some((l) => l !== '' && has(c.label, l)))
            );
          });
      }
      case 'set': {
        this.assertAttached();
        this.require(command.id);
        const spec = this.current.elements[command.id];
        if (
          spec?.options &&
          command.prop.toLowerCase() === 'value' &&
          !spec.options.includes(String(command.value))
        ) {
          throw new SapGuiTransportError(
            `The value "${String(command.value)}" is not valid for this drop-down`,
            'ERROR',
          );
        }
        const prop = fullName(command.via, command.prop);
        this.calls.push({ op: 'set', id: command.id, name: prop, args: [command.value] });
        this.values.set(command.id, {
          ...this.values.get(command.id),
          [prop.toLowerCase()]: command.value,
        });
        return null;
      }
      case 'call': {
        this.assertAttached();
        this.require(command.id);
        this.calls.push({
          op: 'call',
          id: command.id,
          name: fullName(command.via, command.method),
          args: command.args,
        });
        return this.invoke(command.id, command.method, command.args);
      }
    }
  }

  private childIds(parent: string): string[] {
    const prefix = parent === '' ? '' : `${parent}/`;
    const names = new Set<string>();
    for (const key of Object.keys(this.current.elements)) {
      if (key.startsWith(prefix) && key !== parent)
        names.add(`${prefix}${key.slice(prefix.length).split('/')[0]}`);
    }
    return [...names].filter((id) => this.visible(id));
  }

  private contextOf(): SapContext {
    const c = this.current.context ?? { transaction: '', program: 'SAPMSYST', screen: '0100' };
    return {
      system: 'FAKE',
      client: '100',
      user: 'TESTUSER',
      language: 'EN',
      transaction: c.transaction === '$TCODE' ? this.enteredTcode : c.transaction,
      program: c.program,
      screen: c.screen,
      responseMs: this.lastTransitionMs,
      roundTrips: this.roundTrips,
    };
  }

  private infoOf(id: string): ControlInfo {
    const spec = this.current.elements[id];
    return {
      type: spec?.type ?? 'GuiContainer',
      name: id.split('/').pop() ?? '',
      text: String(this.read(id, 'text') ?? ''),
      tooltip: String(this.read(id, 'tooltip') ?? ''),
      changeable: this.read(id, 'changeable') !== false,
    };
  }

  private invoke(id: string, method: string, args: SapGuiValue[]): unknown {
    const m = method.toLowerCase();
    const custom = Object.entries(this.current.elements[id]?.methods ?? {}).find(
      ([name]) => name.toLowerCase() === m,
    );
    if (custom) return custom[1](args);
    if (m === 'hardcopy' && typeof args[0] === 'string') {
      // a 1x1 PNG, so the evidence pipeline (screenshot -> attachment) can be exercised without a real screen
      fs.writeFileSync(
        args[0],
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      return null;
    }
    if (m === 'sendvkey' && Number(args[0]) === 0 && id === 'wnd[0]') {
      // the command field: /n = to the start screen (or straight into a transaction), /nex = end the session
      const okcd = 'wnd[0]/tbar[0]/okcd';
      const code = this.current.elements[okcd] ? String(this.read(okcd, 'text')).trim() : '';
      if (/^\/nex$/i.test(code)) return this.go('logon');
      if (/^\/n/i.test(code) && this.hasScreen('easyAccess')) {
        const tcode = code.slice(2);
        this.values.delete(okcd);
        return this.go(tcode ? this.screenFor(tcode) : 'easyAccess');
      }
    }
    if (m === 'press') {
      this.go(this.current.onPress?.[id]?.(this.ctx));
    } else if (m === 'sendvkey') {
      this.go(this.current.onVKey?.(Number(args[0]), this.ctx));
    } else if (m === 'starttransaction' && id === '') {
      this.go(this.screenFor(String(args[0])));
    }
    return null;
  }

  private assertAttached(): void {
    if (!this.attached)
      throw new SapGuiTransportError('not attached to a SAP GUI session', 'ERROR');
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
  /** After a correct logon, show the "user already logged on" pop-up first (like a real system does when the user has another session). */
  multipleLogon?: boolean;
}

/**
 * A small made-up SAP: logon -> Easy Access -> create sales order (VA01) ->
 * save. Ids follow what the recorder produces for the real thing (including
 * a table-control cell). Used by the example recording and the framework's
 * own tests.
 */
export function createSampleSapSystem(options: SampleSapSystemOptions = {}): FakeSapGui {
  const {
    user = 'TESTUSER',
    password = 'correct-horse',
    client = '100',
    transitionDelayMs = 150,
    multipleLogon = false,
  } = options;
  const wrongLogin = 'Name or password is incorrect (repeat logon)';
  let orderCounter = 0; // each save in this system gets the next order number

  return new FakeSapGui({
    start: 'logon',
    transitionDelayMs,
    screens: [
      {
        name: 'logon',
        context: { transaction: '', program: 'SAPMSYST', screen: '0100' },
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[0]/usr': { type: 'GuiUserArea' },
          'wnd[0]/usr/txtRSYST-MANDT': { type: 'GuiTextField', props: { leftLabel: 'Client' } },
          'wnd[0]/usr/txtRSYST-BNAME': { type: 'GuiTextField', props: { leftLabel: 'User' } },
          'wnd[0]/usr/pwdRSYST-BCODE': {
            type: 'GuiPasswordField',
            props: { leftLabel: 'Password' },
          },
          'wnd[0]/usr/txtRSYST-LANGU': { type: 'GuiTextField', props: { leftLabel: 'Language' } },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onVKey: (vKey, ctx) => {
          if (vKey !== 0) return undefined;
          const ok =
            ctx.get('wnd[0]/usr/txtRSYST-BNAME', 'text') === user &&
            ctx.get('wnd[0]/usr/pwdRSYST-BCODE', 'text') === password &&
            ctx.get('wnd[0]/usr/txtRSYST-MANDT', 'text') === client;
          return ok ? (multipleLogon ? 'multipleLogon' : 'easyAccess') : 'logonFailed';
        },
      },
      {
        // Real SAP: a dialog (wnd[1]) over the logon window; OPT2 = continue without ending the other sessions.
        name: 'multipleLogon',
        context: { transaction: '', program: 'SAPMSYST', screen: '0100' },
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[1]': {
            type: 'GuiModalWindow',
            props: { text: 'License Information for Multiple Logons' },
          },
          'wnd[1]/usr/radMULTI_LOGON_OPT1': { type: 'GuiRadioButton' },
          'wnd[1]/usr/radMULTI_LOGON_OPT2': { type: 'GuiRadioButton' },
          'wnd[1]/usr/radMULTI_LOGON_OPT3': { type: 'GuiRadioButton' },
          'wnd[1]/tbar[0]/btn[0]': { type: 'GuiButton' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onPress: { 'wnd[1]/tbar[0]/btn[0]': () => 'easyAccess' },
      },
      {
        name: 'logonFailed',
        context: { transaction: '', program: 'SAPMSYST', screen: '0100' },
        status: wrongLogin,
        elements: {
          'wnd[0]': { type: 'GuiMainWindow' },
          'wnd[0]/usr/txtRSYST-MANDT': { type: 'GuiTextField', props: { leftLabel: 'Client' } },
          'wnd[0]/usr/txtRSYST-BNAME': { type: 'GuiTextField', props: { leftLabel: 'User' } },
          'wnd[0]/usr/pwdRSYST-BCODE': {
            type: 'GuiPasswordField',
            props: { leftLabel: 'Password' },
          },
          'wnd[0]/usr/txtRSYST-LANGU': { type: 'GuiTextField', props: { leftLabel: 'Language' } },
          // real SAP stays on the logon screen and reports the error in the status bar (type E)
          'wnd[0]/sbar': { type: 'GuiStatusbar', props: { messageType: 'E' } },
        },
      },
      {
        name: 'easyAccess',
        context: { transaction: 'SESSION_MANAGER', program: 'SAPLSMTR_NAVIGATION', screen: '0100' },
        elements: {
          'wnd[0]': { type: 'GuiMainWindow', props: { text: 'SAP Easy Access' } },
          'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onTransaction: (tcode) =>
          tcode.toUpperCase() === 'VA01' ? 'va01Initial' : 'otherTransaction',
        onVKey: (vKey, ctx) => {
          if (vKey !== 0) return undefined;
          const code = String(ctx.get('wnd[0]/tbar[0]/okcd', 'text'))
            .replace(/^\/n/i, '')
            .toUpperCase();
          return code === 'VA01' ? 'va01Initial' : code ? 'otherTransaction' : undefined;
        },
      },
      {
        name: 'otherTransaction',
        context: { transaction: '$TCODE', program: 'SAPLXXXX', screen: '1000' },
        elements: {
          'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Some other transaction' } },
          'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
      },
      {
        name: 'va01Initial',
        context: { transaction: 'VA01', program: 'SAPMV45A', screen: '0101' },
        elements: {
          'wnd[0]': {
            type: 'GuiMainWindow',
            props: { text: 'Create Sales Order: Initial Screen' },
          },
          'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' },
          'wnd[0]/usr/ctxtVBAK-AUART': { type: 'GuiCTextField' },
          'wnd[0]/usr/ctxtVBAK-VKORG': { type: 'GuiCTextField' },
          'wnd[0]/usr/ctxtVBAK-VTWEG': { type: 'GuiCTextField' },
          'wnd[0]/usr/ctxtVBAK-SPART': { type: 'GuiCTextField' },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onVKey: (vKey, ctx) =>
          vKey === 0 && ctx.get('wnd[0]/usr/ctxtVBAK-AUART', 'text') === 'OR'
            ? 'va01Overview'
            : undefined,
      },
      {
        name: 'va01Overview',
        context: { transaction: 'VA01', program: 'SAPMV45A', screen: '4001' },
        elements: {
          'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Create Standard Order: Overview' } },
          'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' },
          'wnd[0]/usr/ctxtKUAGV-KUNNR': {
            type: 'GuiCTextField',
            props: { leftLabel: 'Sold-To Party' },
          },
          'wnd[0]/usr/txtVBKD-BSTKD': {
            type: 'GuiTextField',
            props: { leftLabel: 'Customer Reference' },
          },
          'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG': { type: 'GuiTableControl' },
          'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/ctxtRV45A-MABNR[1,0]': {
            type: 'GuiCTextField',
            appearsAfterMs: 120,
          },
          'wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG/txtRV45A-KWMENG[3,0]': {
            type: 'GuiTextField',
            appearsAfterMs: 120,
          },
          'wnd[0]/tbar[0]/btn[11]': { type: 'GuiButton', props: { tooltip: 'Save' } },
          'wnd[0]/tbar[0]/btn[3]': { type: 'GuiButton', props: { tooltip: 'Back' } },
          'wnd[0]/sbar': { type: 'GuiStatusbar' },
        },
        onPress: { 'wnd[0]/tbar[0]/btn[11]': () => 'saved' },
      },
      {
        name: 'saved',
        context: { transaction: 'VA01', program: 'SAPMV45A', screen: '4001' },
        status: () => `Standard Order ${4711 + orderCounter++} has been saved`,
        elements: {
          'wnd[0]': { type: 'GuiMainWindow', props: { text: 'Create Standard Order: Overview' } },
          'wnd[0]/tbar[0]/okcd': { type: 'GuiOkCodeField' },
          'wnd[0]/sbar': { type: 'GuiStatusbar', props: { messageType: 'S' } },
        },
      },
    ],
  });
}
