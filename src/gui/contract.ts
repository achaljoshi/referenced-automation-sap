import * as fs from 'node:fs';
import * as path from 'node:path';
import { dumpScreen } from './inspect';
import type { SapGuiSession } from './session';

/** One control in a screen contract: what a test can rely on being there. */
export interface ContractControl {
  id: string;
  type: string;
  /** Only for controls whose text is a fixed caption (buttons, labels, tabs, menus, checkboxes) - never the value of an input field. */
  text?: string;
}

/**
 * The shape of a SAP screen, saved as a file you commit: which controls exist, of what type, with which
 * captions. A test run compares the live screen with it, so a SAP release or customising change that
 * moves or retypes a control is reported as "screen X changed: control Y is gone" in one place, before
 * a dozen tests fail in a dozen confusing ways.
 */
export interface ScreenContract {
  version: 1;
  name: string;
  capturedAt: string;
  context?: { transaction: string; program: string; screen: string };
  controls: ContractControl[];
}

export interface ContractDiff {
  /** In the baseline, not on the screen now - tests that use these will fail. */
  removed: ContractControl[];
  /** On the screen now, not in the baseline - usually harmless (a new field), worth a look. */
  added: ContractControl[];
  /** Same id, different SAP class - actions chosen by type will change. */
  typeChanged: Array<{ id: string; was: string; now: string }>;
  /** Same control, different caption - a renamed label breaks label locators. */
  textChanged: Array<{ id: string; was: string; now: string }>;
  /** removed or typeChanged: something a test may depend on is gone or different. */
  breaking: boolean;
  /** For each removed control, an added one that looks like where it went (same name or same type and caption). */
  suggestions: Array<{ was: string; maybeNow: string }>;
}

export interface CaptureOptions {
  /** Where to start. Default the main window. Use 'wnd[1]' to contract a pop-up. */
  root?: string;
  maxDepth?: number;
  /** Controls whose id matches any of these are left out. Default: table and list cell positions, which change with scrolling and data. */
  ignore?: RegExp[];
}

const STATIC_TEXT_TYPES = new Set([
  'GuiButton',
  'GuiLabel',
  'GuiTab',
  'GuiMenu',
  'GuiCheckBox',
  'GuiRadioButton',
  'GuiTitlebar',
]);
const DEFAULT_IGNORE = [/\[\d+,\d+\]/];

export const DEFAULT_CONTRACTS_DIR = 'contracts';

export async function captureContract(
  sap: SapGuiSession,
  name: string,
  options: CaptureOptions = {},
): Promise<ScreenContract> {
  const { root = 'wnd[0]', maxDepth = 8, ignore = DEFAULT_IGNORE } = options;
  await sap.settle();
  const nodes = await dumpScreen(sap, root, maxDepth, 2000);
  const controls = nodes
    .filter((n) => !ignore.some((re) => re.test(n.id)))
    .map(
      (n): ContractControl => ({
        id: n.id,
        type: n.type,
        ...(STATIC_TEXT_TYPES.has(n.type) && n.text ? { text: n.text } : {}),
      }),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const where = await sap.refreshContext();
  return {
    version: 1,
    name,
    capturedAt: new Date().toISOString(),
    ...(where
      ? {
          context: { transaction: where.transaction, program: where.program, screen: where.screen },
        }
      : {}),
    controls,
  };
}

const baseName = (id: string) => (id.split('/').pop() ?? id).replace(/\[.*$/, '');

export function diffContracts(baseline: ScreenContract, current: ScreenContract): ContractDiff {
  const before = new Map(baseline.controls.map((c) => [c.id, c]));
  const now = new Map(current.controls.map((c) => [c.id, c]));
  const removed = baseline.controls.filter((c) => !now.has(c.id));
  const added = current.controls.filter((c) => !before.has(c.id));
  const typeChanged: ContractDiff['typeChanged'] = [];
  const textChanged: ContractDiff['textChanged'] = [];
  for (const [id, was] of before) {
    const is = now.get(id);
    if (!is) continue;
    if (was.type !== is.type) typeChanged.push({ id, was: was.type, now: is.type });
    if ((was.text ?? '') !== (is.text ?? ''))
      textChanged.push({ id, was: was.text ?? '', now: is.text ?? '' });
  }
  const suggestions: ContractDiff['suggestions'] = [];
  for (const gone of removed) {
    const match =
      added.find((a) => baseName(a.id) === baseName(gone.id)) ?? // moved to another container
      added.find((a) => a.type === gone.type && gone.text !== undefined && a.text === gone.text); // renamed, same caption
    if (match) suggestions.push({ was: gone.id, maybeNow: match.id });
  }
  return {
    removed,
    added,
    typeChanged,
    textChanged,
    breaking: removed.length > 0 || typeChanged.length > 0,
    suggestions,
  };
}

export function formatDiff(name: string, diff: ContractDiff): string {
  const lines = [`Screen contract "${name}" no longer matches the screen:`];
  const list = (title: string, items: string[]) =>
    items.length &&
    lines.push(
      '',
      `${title} (${items.length}):`,
      ...items.slice(0, 25).map((i) => `  ${i}`),
      ...(items.length > 25 ? [`  ... and ${items.length - 25} more`] : []),
    );
  list(
    'GONE - tests using these will fail',
    diff.removed.map((c) => `${c.id}  (${c.type}${c.text ? `, "${c.text}"` : ''})`),
  );
  list(
    'RETYPED - actions chosen by control type will change',
    diff.typeChanged.map((c) => `${c.id}: ${c.was} -> ${c.now}`),
  );
  list(
    'Probably moved',
    diff.suggestions.map((s) => `${s.was}  ->  ${s.maybeNow}`),
  );
  list(
    'Captions changed - label locators may break',
    diff.textChanged.map((c) => `${c.id}: "${c.was}" -> "${c.now}"`),
  );
  list(
    'New on the screen',
    diff.added.map((c) => `${c.id}  (${c.type}${c.text ? `, "${c.text}"` : ''})`),
  );
  lines.push(
    '',
    'If the change is expected, update the baseline: SAP_GUI_UPDATE_CONTRACTS=true (and commit the changed file).',
  );
  return lines.join('\n');
}

export function contractPath(dir: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name))
    throw new Error(`contract name "${name}" may only contain letters, digits, _ . -`);
  return path.resolve(dir, `${name}.contract.json`);
}

export function saveContract(dir: string, contract: ScreenContract): string {
  const file = contractPath(dir, contract.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`);
  return file;
}

export function loadContract(dir: string, name: string): ScreenContract | undefined {
  const file = contractPath(dir, name);
  return fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ScreenContract)
    : undefined;
}
