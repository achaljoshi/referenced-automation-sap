/**
 * Parses what the SAP GUI Scripting recorder produces (VBScript) into a flat
 * list of steps.
 *
 * Scope, deliberately: the recorder emits straight-line code - property sets,
 * method calls, `With` blocks, the connect-to-SAP preamble. That is converted
 * fully. Anything with logic (If / For / Do / Select / Sub / Function) is NOT
 * guessed at: it comes out as an `unsupported` step carrying the original
 * line, so a human converts it knowingly rather than the tool silently
 * changing what a script does.
 */
import { formatLink } from '../gui/memberPath';
import { looksSecret, redactWith } from './secrets';
import type { SapGuiValue } from '../gui/types';

export type Expr =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'variable'; name: string }
  | { kind: 'concat'; parts: Expr[] }
  /** Not in a recording: written by the converter in place of a secret literal - read from the environment when the test runs. */
  | { kind: 'env'; envVar: string; secret: boolean };

export type Step =
  | { kind: 'set'; id: string; prop: string; value: Expr; line: number }
  /** id '' = the session itself. `into` set when the call's result is assigned to a variable. */
  | { kind: 'call'; id: string; method: string; args: Expr[]; into?: string; line: number }
  | { kind: 'get'; id: string; prop: string; into: string; line: number }
  | { kind: 'let'; name: string; value: Expr; line: number }
  | { kind: 'sleep'; ms: number; line: number }
  | { kind: 'comment'; text: string; line: number }
  | { kind: 'unsupported'; source: string; reason: string; line: number };

export interface ParseWarning {
  line: number;
  message: string;
  /** 'todo' (default): needs a human decision and fails `--strict`. 'info': reports something the converter did on purpose (a secret replaced by an environment read). */
  severity?: 'todo' | 'info';
}

export interface ParseResult {
  steps: Step[];
  warnings: ParseWarning[];
}

class Unsupported extends Error {}

const VBS_CONSTANTS: Record<string, string> = {
  vbcr: '\r',
  vblf: '\n',
  vbcrlf: '\r\n',
  vbnewline: '\r\n',
  vbtab: '\t',
  vbnullstring: '',
  vbback: '\b',
};

// ------------------------------------------------------------ scanning helpers

/** Splits `text` on `separator` wherever it is not inside a string literal or parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      current += ch;
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Index of the `)` matching the `(` at `open`, ignoring parentheses inside strings; -1 if none. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseStringLiteral(text: string): string | undefined {
  const match = /^"((?:[^"]|"")*)"$/.exec(text.trim());
  return match ? (match[1] as string).replace(/""/g, '"') : undefined;
}

export function parseExpression(text: string): Expr {
  const parts = splitTopLevel(text.trim(), '&').map((part) => parseOperand(part.trim()));
  return parts.length === 1 ? (parts[0] as Expr) : { kind: 'concat', parts };
}

function parseOperand(text: string): Expr {
  if (text === '') throw new Unsupported('empty expression');
  const str = parseStringLiteral(text);
  if (str !== undefined) return { kind: 'string', value: str };
  if (/^-?\d+(\.\d+)?$/.test(text)) return { kind: 'number', value: Number(text) };
  if (/^true$/i.test(text)) return { kind: 'boolean', value: true };
  if (/^false$/i.test(text)) return { kind: 'boolean', value: false };
  const chr = /^chrw?\(\s*(\d+)\s*\)$/i.exec(text);
  if (chr) return { kind: 'string', value: String.fromCharCode(Number(chr[1])) };
  const constant = VBS_CONSTANTS[text.toLowerCase()];
  if (constant !== undefined) return { kind: 'string', value: constant };
  if (/^[A-Za-z_]\w*$/.test(text)) return { kind: 'variable', name: text };
  throw new Unsupported(`expression not supported: ${text}`);
}

function parseArgs(text: string): Expr[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  return splitTopLevel(trimmed, ',').map((arg) => parseExpression(arg));
}

// ------------------------------------------------------------ logical lines

interface LogicalLine {
  text: string;
  line: number;
}

/** Joins `_` continuations, removes comments (keeping whole-line ones as comment steps), and tracks original line numbers. */
function logicalLines(source: string): { lines: LogicalLine[]; comments: Array<{ text: string; line: number }> } {
  const raw = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines: LogicalLine[] = [];
  const comments: Array<{ text: string; line: number }> = [];
  let pending = '';
  let pendingStart = 0;

  raw.forEach((original, index) => {
    const lineNo = index + 1;
    let inString = false;
    let code = '';
    let comment: string | undefined;
    for (let i = 0; i < original.length; i++) {
      const ch = original[i] as string;
      if (ch === '"') {
        if (inString && original[i + 1] === '"') {
          code += '""';
          i++;
          continue;
        }
        inString = !inString;
      }
      if (!inString && ch === "'") {
        comment = original.slice(i + 1).trim();
        break;
      }
      code += ch;
    }
    const trimmed = code.trim();
    if (trimmed === '' && comment !== undefined && pending === '') {
      if (comment) comments.push({ text: comment, line: lineNo });
      return;
    }
    if (/^rem\s/i.test(trimmed) && pending === '') {
      comments.push({ text: trimmed.slice(4).trim(), line: lineNo });
      return;
    }
    if (pending === '') pendingStart = lineNo;
    if (/\s_$/.test(trimmed) || trimmed === '_') {
      pending += `${trimmed.replace(/\s?_$/, '')} `;
      return;
    }
    const joined = (pending + trimmed).trim();
    pending = '';
    if (joined !== '') lines.push({ text: joined, line: pendingStart });
  });
  if (pending.trim() !== '') lines.push({ text: pending.trim(), line: pendingStart });
  return { lines, comments };
}

// ------------------------------------------------------------ the parser

const FIND_BY_ID = /^session\.findById\s*\(\s*("(?:[^"]|"")*")\s*\)/i;
const BLOCK_OPEN = /^(for\b|do\b|while\b|select\s+case\b|sub\b|function\b)/i;
const BLOCK_CLOSE = /^(next\b|loop\b|wend\b|end\s+select\b|end\s+sub\b|end\s+function\b)/i;
const BLOCK_MIDDLE = /^(else\b|elseif\b|case\b)/i;
const IF_BLOCK_OPEN = /^if\b.*\bthen\s*$/i;
const IF_SINGLE_LINE = /^if\b.*\bthen\b\s+\S/i;

function joinIds(base: string, relative: string): string {
  return base === '' ? relative : `${base}/${relative}`;
}

export function parseVbs(source: string): ParseResult {
  const { lines, comments } = logicalLines(source);
  const steps: Step[] = [];
  const warnings: ParseWarning[] = [];
  const warn = (line: number, message: string) => warnings.push({ line, message });

  const elementVars = new Map<string, string>();
  /** One entry per open `With`: the element id it targets, '' for the session, or null when the target could not be resolved. */
  const withStack: Array<string | null> = [];
  let preambleDepth = 0;
  let unsupportedDepth = 0;
  /** Open `With` blocks (nested ones included) inside a `With` whose target is unknown: nothing in there can be resolved. */
  let unknownWithDepth = 0;
  const unsupported = (source: string, reason: string, line: number, unknownTarget = false): Step => {
    // the source and the reason end up in comments and warnings of a committed file: typed secrets must not
    const secret = looksSecret(source, { unknownTarget });
    return { kind: 'unsupported', source: redactWith(source, secret), reason: redactWith(reason, secret), line };
  };

  const commentsByLine = new Map(comments.map((c) => [c.line, c.text]));
  const emitCommentsBefore = (line: number) => {
    for (const [commentLine, text] of commentsByLine) {
      if (commentLine < line) {
        steps.push({ kind: 'comment', text, line: commentLine });
        commentsByLine.delete(commentLine);
      }
    }
  };

  /** Resolves a statement's leading target to an element id (or '' for the session) and the text that follows it. */
  const resolveTarget = (text: string): { id: string; rest: string; isSession: boolean } => {
    const find = FIND_BY_ID.exec(text);
    if (find) {
      return { id: parseStringLiteral(find[1] as string) as string, rest: text.slice(find[0].length), isSession: false };
    }
    if (/^session\./i.test(text)) return { id: '', rest: text.slice('session'.length), isSession: true };
    if (text.startsWith('.')) {
      const base = withStack[withStack.length - 1];
      if (base === undefined) throw new Unsupported('"." used outside a With block');
      if (base === null) throw new Unsupported('inside a With block whose target could not be converted');
      // `.findById("rel")` inside `With session.findById("parent")`
      const rel = /^\.findById\s*\(\s*("(?:[^"]|"")*")\s*\)/i.exec(text);
      if (rel) {
        return { id: joinIds(base, parseStringLiteral(rel[1] as string) as string), rest: text.slice(rel[0].length), isSession: false };
      }
      return { id: base, rest: text, isSession: base === '' };
    }
    const variable = /^([A-Za-z_]\w*)\./.exec(text);
    if (variable) {
      const name = variable[1] as string;
      const id = elementVars.get(name.toLowerCase());
      if (id === undefined) throw new Unsupported(`"${name}" is not a known element variable`);
      return { id, rest: text.slice(name.length), isSession: id === '' };
    }
    throw new Unsupported('statement does not start with session.findById(...), a With target, or an element variable');
  };

  /** An argument inside a member path must be a literal - the path is data, not code. */
  const literalArg = (expr: Expr): SapGuiValue => {
    if (expr.kind === 'string' || expr.kind === 'number' || expr.kind === 'boolean') return expr.value;
    throw new Unsupported('a variable or expression inside a chained member path (e.g. getAbsoluteRow(i)) - convert by hand');
  };

  const parseMemberStatement = (text: string, line: number, into?: string): Step => {
    const { id, rest } = resolveTarget(text);
    let remaining = rest.trim();

    // Walk `.a.b(1).c`: every link before the last is an object to step through.
    const links: string[] = [];
    for (;;) {
      const member = /^\.\s*(\w+)\s*/.exec(remaining);
      if (!member) throw new Unsupported('expected .property or .method after the element');
      const name = member[1] as string;
      let tail = remaining.slice(member[0].length);

      let args: Expr[] = [];
      let hadParens = false;
      if (tail.startsWith('(')) {
        const close = matchingParen(tail, 0);
        if (close === -1) throw new Unsupported('unbalanced parentheses');
        args = parseArgs(tail.slice(1, close));
        hadParens = true;
        tail = tail.slice(close + 1).trim();
      }

      if (tail.startsWith('.')) {
        links.push(formatLink(name, args.map(literalArg)));
        remaining = tail;
        continue;
      }

      const path = [...links, name].join('.');
      const assign = /^=\s*(.+)$/.exec(tail);
      if (assign && !into && !hadParens) return { kind: 'set', id, prop: path, value: parseExpression(assign[1] as string), line };
      if (assign) throw new Unsupported('assignment inside an expression');

      if (!hadParens && tail !== '') args = parseArgs(tail);
      else if (hadParens && tail !== '') throw new Unsupported(`unexpected text after call: ${tail}`);

      // `x = session.findById("..").text` reads a property; `x = ...GetCellValue(0, "COL")` calls a method with arguments.
      if (into && args.length === 0 && !hadParens) return { kind: 'get', id, prop: path, into, line };
      return { kind: 'call', id, method: path, args, into, line };
    }
  };

  for (const { text, line } of lines) {
    emitCommentsBefore(line);

    // --- control flow we don't convert: everything inside it is passed through as TODO, never executed unconditionally
    if (unsupportedDepth > 0) {
      if (BLOCK_CLOSE.test(text) || /^end\s+if\b/i.test(text)) unsupportedDepth--;
      else if (IF_BLOCK_OPEN.test(text) || BLOCK_OPEN.test(text)) unsupportedDepth++;
      steps.push(unsupported(text, 'inside control flow (If/For/Do/...) - convert by hand', line, true));
      continue;
    }

    // --- everything inside a With block whose target we could not resolve: a leading `.text = ...` must never be read against the session
    if (unknownWithDepth > 0) {
      if (/^end\s+with\b/i.test(text)) {
        unknownWithDepth--;
        withStack.pop();
      } else if (/^with\b/i.test(text)) {
        unknownWithDepth++;
        withStack.push(null);
      }
      steps.push(unsupported(text, 'inside a With block whose target could not be converted - convert by hand', line, true));
      continue;
    }

    // --- the recorder's connect-to-SAP preamble: not needed, the fixture attaches the session
    if (preambleDepth > 0) {
      if (/^end\s+if\b/i.test(text)) preambleDepth--;
      else if (IF_BLOCK_OPEN.test(text)) preambleDepth++;
      continue;
    }
    if (/^if\s+not\s+isobject\s*\(\s*(application|connection|session)\s*\)\s*then\s*$/i.test(text) || /^if\s+isobject\s*\(\s*wscript\s*\)\s*then\s*$/i.test(text)) {
      preambleDepth = 1;
      continue;
    }
    if (/^set\s+(sapguiauto|application|connection|session)\s*=/i.test(text)) continue;
    if (/^wscript\.connectobject\b/i.test(text)) continue;

    // --- structure
    const withMatch = /^with\s+(.+)$/i.exec(text);
    if (withMatch) {
      const target = (withMatch[1] as string).trim();
      try {
        if (/^session$/i.test(target)) withStack.push('');
        else if (/^[A-Za-z_]\w*$/.test(target) && elementVars.has(target.toLowerCase())) withStack.push(elementVars.get(target.toLowerCase()) as string);
        else withStack.push(resolveTarget(target).id);
      } catch (error) {
        withStack.push(null);
        unknownWithDepth = 1;
        steps.push(unsupported(text, (error as Error).message, line, true));
        warn(line, 'a With block was not converted - everything inside it is left as TODO comments');
      }
      continue;
    }
    if (/^end\s+with\b/i.test(text)) {
      withStack.pop();
      continue;
    }
    if (IF_SINGLE_LINE.test(text) && !IF_BLOCK_OPEN.test(text)) {
      steps.push(unsupported(text, 'conditional statement - convert by hand', line));
      warn(line, 'conditional logic was not converted');
      continue;
    }
    if (IF_BLOCK_OPEN.test(text) || BLOCK_OPEN.test(text)) {
      unsupportedDepth = 1;
      steps.push(unsupported(text, 'control flow (If/For/Do/...) - convert by hand', line));
      warn(line, 'control flow was not converted - everything inside it is left as TODO comments');
      continue;
    }
    if (BLOCK_CLOSE.test(text) || BLOCK_MIDDLE.test(text) || /^end\s+if\b/i.test(text)) {
      steps.push(unsupported(text, 'stray block keyword', line));
      continue;
    }

    // --- things with no equivalent that are safe to drop
    if (/^(option\s+explicit|on\s+error\b|dim\b|const\b)/i.test(text)) {
      if (/^on\s+error\b/i.test(text)) warn(line, '"On Error" was ignored - failures now fail the test instead of being swallowed');
      if (/^const\b/i.test(text)) {
        const c = /^const\s+(\w+)\s*=\s*(.+)$/i.exec(text);
        if (c) {
          try {
            steps.push({ kind: 'let', name: c[1] as string, value: parseExpression(c[2] as string), line });
          } catch {
            steps.push(unsupported(text, 'Const value not supported', line));
          }
        }
      }
      continue;
    }
    if (/^(wscript\.echo|msgbox)\b/i.test(text)) {
      steps.push(unsupported(text, 'dialog/echo has no equivalent in an automated run - dropped', line));
      warn(line, 'a MsgBox/Echo was dropped');
      continue;
    }
    if (/^wscript\.quit\b/i.test(text)) continue;

    const sleep = /^wscript\.sleep\s*\(?\s*(\d+)\s*\)?$/i.exec(text);
    if (sleep) {
      steps.push({ kind: 'sleep', ms: Number(sleep[1]), line });
      continue;
    }

    try {
      // Set x = session.findById("...")  -> remember the id; no step of its own
      const setElement = /^set\s+(\w+)\s*=\s*(.+)$/i.exec(text);
      if (setElement) {
        const { id, rest } = resolveTarget(setElement[2] as string);
        if (rest.trim() !== '') throw new Unsupported('Set ... = <something more than an element>');
        elementVars.set((setElement[1] as string).toLowerCase(), id);
        continue;
      }
      // x = <expression or read>
      const assignment = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(text);
      if (assignment) {
        const name = assignment[1] as string;
        const rhs = (assignment[2] as string).trim();
        if (/^(session\.|\.|[A-Za-z_]\w*\.)/.test(rhs) && !/^"/.test(rhs)) {
          steps.push(parseMemberStatement(rhs, line, name));
        } else {
          steps.push({ kind: 'let', name, value: parseExpression(rhs), line });
        }
        continue;
      }
      steps.push(parseMemberStatement(text, line));
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      const step = unsupported(text, error.message, line);
      steps.push(step);
      warn(line, `could not convert: ${(step as { reason: string }).reason}`);
    }
  }

  for (const [commentLine, text] of commentsByLine) steps.push({ kind: 'comment', text, line: commentLine });
  return { steps, warnings };
}
