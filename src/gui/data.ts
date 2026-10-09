import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdapterError, getLogger } from '@automation/referenced-automation-utils';
import type { SapGuiSession } from './session';

const log = getLogger('sap-gui-data');

export type CreatedStatus = 'created' | 'cleaned' | 'cleanup-failed' | 'kept';

/** A business object a test created in SAP: an order, a business partner, a posted document... */
export interface CreatedObject {
  type: string;
  id: string;
  test: string;
  at: string;
  status: CreatedStatus;
  /** Why cleanup failed, or why the object was kept. */
  note?: string;
  system?: string;
  client?: string;
  user?: string;
}

export interface RecordOptions {
  /** Undo what the test created (cancel/delete the object). Receives the live session, already back on the start screen. */
  cleanup?: (sap: SapGuiSession) => Promise<void>;
  /** The object is meant to stay (reference data, a shared fixture): it is listed, but never cleaned and not reported as an orphan. */
  keep?: boolean;
}

interface Entry extends CreatedObject {
  cleanup?: (sap: SapGuiSession) => Promise<void>;
}

export const DEFAULT_DATA_DIR = 'test-results/sap-data';
const CLEANUP_TIMEOUT_MS = 60_000;

let uniqueCounter = 0;

/**
 * Everything one test created in SAP, so it can be undone - even when the
 * test failed, and even when it is a retry of a failed attempt that already
 * created something. Without this, a retried or re-run test finds the order
 * the last attempt left behind (duplicate key, "already exists", wrong totals)
 * and a shared system slowly fills with test data nobody owns.
 *
 *   const order = await sapData.captureFromStatusBar('SalesOrder', /Order (\d+)/, {
 *     cleanup: (s) => cancelOrder(s, order)   // runs after the test, in reverse order of creation
 *   });
 */
export class SapDataRegistry {
  private readonly entries: Entry[] = [];

  constructor(
    private readonly sap: SapGuiSession,
    private readonly testName: string,
  ) {}

  /** Registers an object you already know the id of. */
  record(type: string, id: string, options: RecordOptions = {}): CreatedObject {
    const where = this.sap.currentContext;
    const entry: Entry = {
      type,
      id,
      test: this.testName,
      at: new Date().toISOString(),
      status: options.keep ? 'kept' : 'created',
      ...(options.keep ? { note: 'marked keep: not cleaned up' } : {}),
      system: where?.system,
      client: where?.client,
      user: where?.user,
      cleanup: options.cleanup,
    };
    this.entries.push(entry);
    log.info(`[sap-gui] created ${type} ${id}${options.cleanup ? ' (cleanup registered)' : options.keep ? ' (kept)' : ' (NO cleanup registered)'}`);
    return entry;
  }

  /**
   * Reads the object number SAP just reported in the status bar ("Standard Order 4711 has been saved")
   * with `pattern` (first capture group, or the whole match) and registers it. Fails with the actual
   * message if the pattern does not match - a save that did not happen must not look like a success.
   */
  async captureFromStatusBar(type: string, pattern: RegExp, options: RecordOptions = {}): Promise<string> {
    const { text } = await this.sap.statusBar();
    const match = pattern.exec(text);
    if (!match) {
      throw new AdapterError('sap-gui', 'captureFromStatusBar', `expected the status bar to report a ${type} (${String(pattern)}) but it says: "${text || '(empty)'}"`);
    }
    const id = (match[1] ?? match[0]).trim();
    this.record(type, id, options);
    return id;
  }

  /**
   * A value that will not collide with what an earlier attempt or run left behind:
   * unique('CUST') -> 'CUSTK3F9Q2'. Keep `maxLength` to the field's length.
   */
  unique(prefix: string, maxLength = 12): string {
    const stamp = (Date.now() % 36 ** 5).toString(36).toUpperCase().padStart(5, '0');
    const suffix = `${stamp}${(uniqueCounter++ % 36 ** 2).toString(36).toUpperCase().padStart(2, '0')}`;
    const room = maxLength - prefix.length;
    if (room < 4) throw new Error(`unique("${prefix}") leaves only ${Math.max(room, 0)} character(s) for the unique part within maxLength ${maxLength} - too few to avoid collisions`);
    return prefix + suffix.slice(-room); // when space is tight keep the fastest-changing characters
  }

  get items(): readonly CreatedObject[] {
    return this.entries.map(({ cleanup: _cleanup, ...rest }) => rest);
  }

  /**
   * Undoes everything, newest first, continuing past failures (one stuck object must not leave the
   * rest behind). Each cleanup has a time limit. Returns the final list.
   */
  async cleanup(): Promise<CreatedObject[]> {
    for (const entry of [...this.entries].reverse()) {
      if (entry.status !== 'created') continue;
      if (!entry.cleanup) {
        entry.status = 'cleanup-failed';
        entry.note = 'no cleanup was registered - remove it by hand';
        continue;
      }
      try {
        await withTimeout(entry.cleanup(this.sap), CLEANUP_TIMEOUT_MS, `cleanup of ${entry.type} ${entry.id}`);
        entry.status = 'cleaned';
        log.info(`[sap-gui] cleaned ${entry.type} ${entry.id}`);
      } catch (error) {
        entry.status = 'cleanup-failed';
        entry.note = error instanceof Error ? error.message : String(error);
        log.warn(`[sap-gui] could NOT clean ${entry.type} ${entry.id}: ${entry.note}`);
      }
    }
    return [...this.items];
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Appends the final list to a per-process audit file (read by `sap-gui-data`). */
export function appendCreated(objects: readonly CreatedObject[], dir = DEFAULT_DATA_DIR): void {
  if (objects.length === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `created-${process.pid}.jsonl`), objects.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

export function loadCreated(dir = DEFAULT_DATA_DIR): CreatedObject[] {
  if (!fs.existsSync(dir)) return [];
  const all: CreatedObject[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (line.trim()) all.push(JSON.parse(line) as CreatedObject);
    }
  }
  return all;
}

/** What still needs a human: cleanup failed or was never registered. (Objects marked keep are not orphans.) */
export function orphans(objects: readonly CreatedObject[]): CreatedObject[] {
  return objects.filter((o) => o.status === 'cleanup-failed' || o.status === 'created');
}

export function formatCreated(objects: readonly CreatedObject[]): string {
  if (objects.length === 0) return '(nothing was created)';
  return objects
    .map((o) => `${o.status.padEnd(14)} ${o.type.padEnd(16)} ${o.id.padEnd(14)} ${o.system ?? ''}/${o.client ?? ''} ${o.user ?? ''}  ${o.test}${o.note ? `  -- ${o.note}` : ''}`)
    .join('\n');
}
