export type SapGuiValue = string | number | boolean | null;

/** One step of reaching through objects: `columns`, or `elementAt` with args [1]. */
export interface ChainLink {
  member: string;
  args?: SapGuiValue[];
}

/** What a control is, in one round trip - the basis for choosing the right action for its type. */
export interface ControlInfo {
  /** SAP's class name: GuiButton, GuiTextField, GuiComboBox, GuiCheckBox, GuiTab, ... */
  type: string;
  name: string;
  text: string;
  tooltip: string;
  /** False for a read-only field. */
  changeable: boolean;
}

/**
 * Where SAP is, from the session's own info object: which system, who, and which
 * transaction / program / screen is showing. Makes a failure say "VA01, screen 4001,
 * program SAPMV45A" instead of just "control not found".
 */
export interface SapContext {
  system: string;
  client: string;
  user: string;
  language: string;
  transaction: string;
  program: string;
  screen: string;
  /** SAP's own measure of the last server response, in ms, when the system reports it. */
  responseMs?: number;
  /** How many server round trips the session has made. */
  roundTrips?: number;
}

/**
 * A cheap "has anything happened yet?" reading: SAP's server round-trip counter plus what is on screen. Taken before an
 * action and again after it, a change proves the server answered - Busy=false alone cannot (it is false in the moment
 * between the request leaving and SAP GUI noticing it is waiting).
 */
export interface SapProgress {
  /** Session.Info.RoundTrips; null when this SAP GUI release does not report it (then the screen fields decide). */
  roundTrips: number | null;
  transaction: string;
  program: string;
  screen: string;
  /** Title of the main window. */
  title: string;
  /** How many windows are open (1 = main window only, 2 = a pop-up in front, ...). */
  windows: number;
}

/** How to find controls without knowing their technical id: every given field must match. */
export interface FindCriteria {
  /** Search below this id. Default the main window. */
  root: string;
  text?: string;
  tooltip?: string;
  type?: string;
  name?: string;
  /** The text of the control's left or right label (what the user sees next to a field). */
  label?: string;
  /** Match the whole text instead of "contains". Matching is case-insensitive. */
  exact?: boolean;
}

/**
 * Everything the framework ever asks SAP GUI to do, as plain data. The same
 * handful of operations covers the whole SAP GUI Scripting API, because every
 * recorded line is one of: read a property, write a property, call a method,
 * or look something up by its technical id.
 *
 * `id` is the id the SAP GUI Scripting recorder produces, e.g.
 * "wnd[0]/usr/txtRSYST-BNAME". An empty id means the session itself.
 */
export type SapGuiCommand =
  | { op: 'ping' }
  | { op: 'attach'; connectionIndex: number; sessionIndex: number }
  | { op: 'open'; connectionName: string; connectionString?: string; logonPath?: string }
  | { op: 'exists'; id: string }
  | { op: 'get'; id: string; prop: string; via?: ChainLink[] }
  | { op: 'set'; id: string; prop: string; value: SapGuiValue; via?: ChainLink[] }
  | { op: 'call'; id: string; method: string; args: SapGuiValue[]; via?: ChainLink[] }
  | { op: 'children'; id: string }
  | { op: 'find'; criteria: FindCriteria }
  | { op: 'info'; id: string }
  | { op: 'context' }
  | { op: 'busy' }
  | { op: 'progress' }
  | { op: 'quit' };

export interface SapGuiChild {
  id: string;
  type: string;
  name: string;
  text: string;
}

/**
 * The seam between the framework and SAP GUI. Production uses
 * PowerShellTransport (drives the real SAP GUI over COM, Windows only);
 * tests and local development can use FakeSapGui. Anything implementing this
 * interface works - which is also how a different bridge (a 32-bit helper,
 * a remote agent on a dedicated desktop) could be slotted in later.
 */
export interface SapGuiTransport {
  request(command: SapGuiCommand): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Thrown by a transport when SAP GUI (or the bridge) reports a failure. `code`:
 *  - NOT_FOUND     the technical id doesn't exist on the current screen (the one code the session retries)
 *  - SESSION_LOST  the COM connection to SAP GUI is dead (RPC server unavailable, object disconnected, ...): retrying is pointless
 *  - TIMEOUT       the bridge did not answer in time; the transport kills the bridge, so every later request fails fast
 *  - BRIDGE_EXITED the bridge process is gone (crashed, killed, pipe closed)
 *  - ERROR         anything else SAP GUI or the bridge reported
 */
export class SapGuiTransportError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'SESSION_LOST' | 'ERROR' | 'TIMEOUT' | 'BRIDGE_EXITED' = 'ERROR',
  ) {
    super(message);
    this.name = 'SapGuiTransportError';
  }
}
