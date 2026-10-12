import type { SapGuiSession } from './session';
import type { SapGuiChild } from './types';

export interface ScreenNode extends SapGuiChild {
  depth: number;
}

/**
 * Lists the controls on the current screen with the technical ids a script
 * needs - the answer to "what do I put in findById?" without recording
 * anything. Walks down from `rootId` (default the main window).
 *
 * Ids are returned relative to the session (`wnd[0]/usr/txtRSYST-BNAME`),
 * ready to paste into `sap.setText(...)`.
 */
export async function dumpScreen(
  sap: SapGuiSession,
  rootId = 'wnd[0]',
  maxDepth = 6,
  maxNodes = 400,
  /** Stop walking after this many ms and return what was found so far (for diagnostics that must stay quick). Default: no limit. */
  budgetMs?: number,
): Promise<ScreenNode[]> {
  const out: ScreenNode[] = [];
  const deadline = budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + budgetMs;
  const strip = (id: string) => id.replace(/^\/app\/con\[\d+\]\/ses\[\d+\]\//i, '');

  const walk = async (id: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= maxNodes || Date.now() > deadline) return;
    const children = await sap.children(id).catch(() => [] as SapGuiChild[]); // a leaf control has no Children
    for (const child of children) {
      if (out.length >= maxNodes) return;
      const relative = strip(child.id);
      out.push({ ...child, id: relative, depth });
      await walk(relative, depth + 1);
    }
  };

  await walk(rootId, 0);
  return out;
}

/** One line per control, indented by depth: `GuiTextField   wnd[0]/usr/txtRSYST-BNAME   "TESTUSER"`. */
export function formatScreenDump(nodes: ScreenNode[]): string {
  return nodes
    .map((n) => `${'  '.repeat(n.depth)}${n.type.padEnd(18)} ${n.id}${n.text ? `   "${n.text.length > 40 ? `${n.text.slice(0, 37)}...` : n.text}"` : ''}`)
    .join('\n');
}
