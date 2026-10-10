/** Shared by the flat generator and the page-object generator: quoting, identifiers, and names for SAP controls. */

export function quote(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}'`;
}

const RESERVED = new Set(['default', 'new', 'class', 'function', 'var', 'let', 'const', 'delete', 'in', 'of', 'with', 'switch', 'case', 'sap', 'env', 'test']);
export function identifier(name: string): string {
  return RESERVED.has(name) ? `${name}_` : name;
}

export const SESSION_PREFIX = /^\/app\/con\[\d+\]\/ses\[\d+\]\//i;
export const COMMAND_FIELD = 'wnd[0]/tbar[0]/okcd';
export const STATUS_BAR = 'wnd[0]/sbar';
export const TOOLBAR_BUTTON = /^wnd\[0\]\/tbar\[[01]\]\/btn\[(\d+)\]$/;
export const TABLE_CELL = /^(.*)\/([^/]+)\[(\d+),(\d+)\]$/;
export const TYPE_PREFIX =
  /^(ctxt|txt|pwd|chk|rad|btn|cmb|tabp|tabs|tbl|lbl|menu|mbar|ssub|sub|cntl|shellcont|shell|titl|tbar|sbar|usr|okcd)(?=[A-Z0-9_-])/;

export function camel(text: string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : (w[0]?.toUpperCase() ?? '') + w.slice(1).toLowerCase(),
    )
    .join('');
  const safe = /^[0-9]/.test(name) ? `_${name}` : name;
  return identifier(safe || 'control');
}

/** `wnd[0]/usr/ctxtVBAK-AUART` -> `vbakAuart`. */
export function propertyName(id: string): string {
  const last = (id.split('/').pop() ?? id).replace(/\[.*$/, '');
  const stripped = last.replace(TYPE_PREFIX, '');
  return camel(stripped || last);
}

/** A readable key for any control id: the command field, the status bar, toolbar buttons, windows, table cells, fields. */
export function locatorName(id: string): string {
  if (id === COMMAND_FIELD) return 'commandField';
  if (id === STATUS_BAR) return 'statusBar';
  const toolbar = TOOLBAR_BUTTON.exec(id);
  if (toolbar) return `toolbarButton${toolbar[1]}`;
  const window = /^wnd\[(\d+)\]$/.exec(id);
  if (window) return window[1] === '0' ? 'mainWindow' : `window${window[1]}`;
  const cell = TABLE_CELL.exec(id);
  if (cell) return `${propertyName(cell[2] as string)}C${cell[3]}R${cell[4]}`;
  // The logon screen's four fields, by what a person calls them.
  const logon = LOGON_FIELDS.find(([pattern]) => pattern.test(id));
  if (logon) return logon[1];
  return propertyName(id);
}

const LOGON_FIELDS: Array<[RegExp, string]> = [
  [/txtRSYST-MANDT$/i, 'logonClient'],
  [/txtRSYST-BNAME$/i, 'logonUser'],
  [/pwdRSYST-BCODE$/i, 'logonPassword'],
  [/txtRSYST-LANGU$/i, 'logonLanguage'],
];
