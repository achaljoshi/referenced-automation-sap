import { dumpScreen, type ScreenNode } from './inspect';
import type { SapGuiSession } from './session';

/**
 * "What is on the screen?" for a failure message: when a control an assertion or a locator was looking for is not there, the
 * useful question is what IS there - the title, the status bar, the labels / buttons / tabs / menu entries with their ids, and
 * the ones that look most like what was asked for ("Address" -> "Addresses"). Built from the session's own dump and info
 * operations, so it works on every transport and on the simulator.
 *
 * Bounded: at most MAX_LISTED entries are listed (the closest matches are searched in all of them), text is shortened, the walk
 * has a time budget and the whole block has a size limit - a failing test must not become a slow test or a huge message.
 * Never reveals a password: password fields and anything an input field holds are not listed at all. Never throws: it is
 * called while another failure is being reported.
 */
export const MAX_LISTED = 25;
const MAX_NEAREST = 5;
const MAX_TEXT_CHARS = 40;
const MAX_BLOCK_CHARS = 3_000;
const WALK_BUDGET_MS = 4_000;
const WALK_MAX_NODES = 300;
const MAX_TOOLTIP_LOOKUPS = 30;

/** Controls whose own text is something a user reads: not input fields (their text is data), never password fields. */
const READABLE = /^Gui(Label|Button|Tab|Menu|RadioButton|CheckBox|SimpleContainer|ToolbarButton)$/;

interface Entry {
  id: string;
  type: string;
  /** The text shown, or the tooltip when the control has no text (toolbar buttons). */
  label: string;
  via: 'text' | 'tooltip';
}

/** Levenshtein distance, stopping early once it is certain to exceed `limit`. */
export function editDistance(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] as number;
}

/** How close `candidate` is to `wanted`: 0 = one contains the other (case-insensitive), else the edit distance if it is small enough to be a typo or a plural; undefined = unrelated. */
export function closeness(wanted: string, candidate: string): number | undefined {
  const w = wanted.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (w === '' || c === '') return undefined;
  if (c.includes(w) || w.includes(c)) return 0;
  const limit = Math.max(2, Math.ceil(w.length / 3));
  const distance = editDistance(w, c, limit);
  return distance <= limit ? distance : undefined;
}

function shorten(text: string, max = MAX_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

const quoted = (text: string) => `"${shorten(text)}"`;
const entryText = (e: Entry) => `${e.via === 'tooltip' ? 'tooltip ' : ''}${quoted(e.label)} (${e.id})`;

async function entriesOf(sap: SapGuiSession, root: string, deadline: number): Promise<{ entries: Entry[]; nodes: ScreenNode[] }> {
  const nodes = await dumpScreen(sap, root, 6, WALK_MAX_NODES, Math.max(100, deadline - Date.now()));
  const entries: Entry[] = [];
  let tooltipLookups = 0;
  for (const node of nodes) {
    if (!READABLE.test(node.type) || /(^|\/)pwd/i.test(node.id)) continue;
    const text = node.text.trim();
    if (text !== '') {
      entries.push({ id: node.id, type: node.type, label: text, via: 'text' });
    } else if (node.type !== 'GuiLabel' && tooltipLookups < MAX_TOOLTIP_LOOKUPS && Date.now() < deadline) {
      // toolbar buttons have no text: the tooltip is what the user sees ("Save (Ctrl+S)")
      tooltipLookups++;
      const info = await sap.peekInfo(node.id).catch(() => undefined);
      if (info?.tooltip.trim()) entries.push({ id: node.id, type: node.type, label: info.tooltip.trim(), via: 'tooltip' });
    }
  }
  return { entries, nodes };
}


/** What a failed locator looked for: a text / label / tooltip a user reads, or a control id (compared with the ids on the screen). */
export type ScreenTerm = string | { id: string };

const termText = (term: ScreenTerm) => (typeof term === 'string' ? term : (term.id.split('/').pop() ?? term.id).replace(/\[.*$/, '') || term.id);

/** The listed entries (or, for an id, the nodes) that look most like what was asked for. */
function nearest(term: ScreenTerm, entries: Entry[], nodes: ScreenNode[]): string[] {
  if (typeof term !== 'string') {
    const name = termText(term);
    return nodes
      .map((n) => ({ n, score: closeness(name.replace(/\[.*$/, ''), (n.id.split('/').pop() ?? '').replace(/\[.*$/, '')) }))
      .filter((x): x is { n: ScreenNode; score: number } => x.score !== undefined)
      .sort((a, b) => a.score - b.score)
      .slice(0, MAX_NEAREST)
      .map((x) => `${x.n.id} (${x.n.type}${x.n.text && !/pwd/i.test(x.n.id) && /Label|Button|Tab|Menu/.test(x.n.type) ? `, ${quoted(x.n.text)}` : ''})`);
  }
  return entries
    .map((e) => ({ e, score: closeness(term, e.label) }))
    .filter((x): x is { e: Entry; score: number } => x.score !== undefined)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_NEAREST)
    .map((x) => entryText(x.e));
}

/**
 * "On the screen now (wnd[0]): title ..., status bar ..., texts (N): ...", the closest matches for each of `terms`, and - when a
 * pop-up is in front - the same for the pop-up. `terms` are what the failed assertion or locator was looking for (a text, a label, a
 * tooltip or the last part of a control id).
 */
export async function describeScreen(sap: SapGuiSession, terms: ScreenTerm[] = []): Promise<string> {
  try {
    const deadline = Date.now() + WALK_BUDGET_MS;
    const seen = new Set<string>();
    const wanted = terms.filter((t) => {
      const key = `${typeof t === 'string' ? 'text' : 'id'}:${termText(t).trim()}`;
      if (termText(t).trim() === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const lines: string[] = [];

    const title = String((await sap.peekProp('wnd[0]', 'text').catch(() => '')) ?? '');
    const bar = await sap.statusBar().catch(() => ({ text: '', type: '' }));
    const main = await entriesOf(sap, 'wnd[0]', deadline);
    const listed = main.entries.slice(0, MAX_LISTED);
    lines.push(
      `On the screen now (wnd[0]): title ${quoted(title || '(none)')}, status bar ${bar.text ? `${quoted(bar.text)}${bar.type ? ` [${bar.type}]` : ''}` : '(empty)'}, texts ${
        main.entries.length === 0
          ? '(none found)'
          : `(${listed.length}${main.entries.length > listed.length ? ` of ${main.entries.length}` : ''}): ${listed.map(entryText).join(', ')}${main.entries.length > listed.length ? ', ...' : ''}`
      }`,
    );
    for (const term of wanted) {
      const close = nearest(term, main.entries, main.nodes);
      lines.push(close.length > 0 ? `Closest to ${quoted(termText(term))}: ${close.join(', ')}` : `Nothing on the screen looks like ${quoted(termText(term))}.`);
    }

    for (let n = 1; n <= 3 && (await sap.exists(`wnd[${n}]`).catch(() => false)); n++) {
      const root = `wnd[${n}]`;
      const popupTitle = String((await sap.peekProp(root, 'text').catch(() => '')) ?? '');
      const popup = await entriesOf(sap, root, deadline);
      const shown = popup.entries.slice(0, MAX_LISTED);
      lines.push(
        `A pop-up is in front (${root}, title ${quoted(popupTitle || '(none)')}) - the control may be behind it, or the flow took a different path. On the pop-up: texts ${
          popup.entries.length === 0 ? '(none found)' : `(${shown.length}${popup.entries.length > shown.length ? ` of ${popup.entries.length}` : ''}): ${shown.map(entryText).join(', ')}${popup.entries.length > shown.length ? ', ...' : ''}`
        }`,
      );
      for (const term of wanted) {
        const close = nearest(term, popup.entries, popup.nodes);
        if (close.length > 0) lines.push(`Closest to ${quoted(termText(term))} on the pop-up: ${close.join(', ')}`);
      }
    }

    const block = lines.join('\n');
    return block.length > MAX_BLOCK_CHARS ? `${block.slice(0, MAX_BLOCK_CHARS - 4)} ...` : block;
  } catch (error) {
    return `On the screen now: (could not be read: ${error instanceof Error ? error.message : String(error)})`;
  }
}
