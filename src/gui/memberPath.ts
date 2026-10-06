import type { ChainLink, SapGuiValue } from './types';

/**
 * A recorded line often reaches through several objects before it acts:
 *   .columns.elementAt(1).width = 18
 *   .getAbsoluteRow(3).selected = true
 *   .verticalScrollbar.position = 12
 * The framework keeps that as one readable string - `columns.elementAt(1).width` -
 * in the `prop`/`method` argument of sap.set / sap.get / sap.call, and splits it
 * here. Arguments are JSON literals (numbers, true/false, "double-quoted strings").
 */
export interface MemberPath {
  /** Objects to step through, in order, before the final member. */
  via: ChainLink[];
  /** The property to read/write or method to call. */
  name: string;
}

export function formatLink(name: string, args: SapGuiValue[] | undefined): string {
  return args && args.length > 0 ? `${name}(${args.map((a) => JSON.stringify(a)).join(',')})` : name;
}

/** Splits `text` on `separator`, ignoring separators inside "strings" and (...) groups. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseSegment(segment: string, whole: string): { name: string; args: SapGuiValue[] } {
  const match = /^\s*(\w+)\s*(?:\((.*)\))?\s*$/s.exec(segment);
  if (!match) throw new Error(`Cannot read "${segment.trim()}" in member path "${whole}"`);
  const rawArgs = (match[2] ?? '').trim();
  const args = rawArgs === '' ? [] : splitTopLevel(rawArgs, ',').map((a) => JSON.parse(a.trim()) as SapGuiValue);
  return { name: match[1] as string, args };
}

export function parseMemberPath(path: string): MemberPath {
  const segments = splitTopLevel(path, '.');
  const parsed = segments.map((segment) => parseSegment(segment, path));
  const last = parsed.pop();
  if (!last) throw new Error('Empty member path');
  return {
    via: parsed.map(({ name, args }) => ({ member: name, ...(args.length > 0 ? { args } : {}) })),
    name: last.name,
  };
}
