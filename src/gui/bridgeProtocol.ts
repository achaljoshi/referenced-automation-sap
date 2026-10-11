import { SapGuiTransportError, type SapGuiCommand } from './types';

/**
 * The bridge's line protocol, shared by every transport that talks to a bridge (a local process, a process on a remote host):
 *
 *   -> {"rid": 7, "op": "get", "id": "wnd[0]/usr/txtX", "prop": "text"}
 *   <- {"rid": 7, "ok": true, "value": "abc"}           or   {"rid": 7, "ok": false, "error": "...", "code": "NOT_FOUND"}
 *
 * and the ready message {"rid": 0, "ok": true}. Only the codes the retry logic depends on survive; any other failure is ERROR.
 */
export type BridgeLine =
  | { kind: 'junk' }
  | { kind: 'ready' }
  | { kind: 'reply'; rid: number; ok: true; value: unknown }
  | { kind: 'reply'; rid: number; ok: false; error: SapGuiTransportError };

/** One request as the line the bridge reads (no line break inside: JSON.stringify escapes them). */
export function encodeRequest(rid: number, command: SapGuiCommand): string {
  return JSON.stringify({ rid, ...command });
}

/** Reads one line the bridge printed. A line that is not JSON (a banner, a warning) is `junk`: ignored by the caller. */
export function decodeLine(line: string): BridgeLine {
  let message: { rid: number; ok: boolean; value?: unknown; error?: string; code?: string };
  try {
    message = JSON.parse(line);
  } catch {
    return { kind: 'junk' };
  }
  if (message === null || typeof message !== 'object') return { kind: 'junk' };
  if (message.rid === 0) return { kind: 'ready' };
  if (message.ok) return { kind: 'reply', rid: message.rid, ok: true, value: message.value ?? null };
  return {
    kind: 'reply',
    rid: message.rid,
    ok: false,
    error: new SapGuiTransportError(
      message.error ?? 'unknown bridge error',
      message.code === 'NOT_FOUND' || message.code === 'SESSION_LOST' ? message.code : 'ERROR',
    ),
  };
}
