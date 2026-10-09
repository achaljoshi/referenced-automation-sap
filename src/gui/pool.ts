import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AdapterError, getLogger } from '@automation/referenced-automation-utils';

const log = getLogger('sap-gui-pool');

/** A lock file that exists but cannot be parsed is a lease being written; only after this long is it considered abandoned. */
const UNREADABLE_GRACE_MS = 2_000;

/** Who holds a user right now. */
export interface LeaseHolder {
  user: string;
  pid: number;
  host: string;
  since: string;
  /** What the holder said it is (e.g. a worker index), for the "all users are taken" message. */
  owner?: string;
}

export interface UserLease {
  readonly user: string;
  release(): void;
}

export interface UserPoolOptions {
  /** Where lock files live. Default: a `sap-user-pool` folder in the OS temp directory (shared by every process on this machine). */
  dir?: string;
  /** A lock whose heartbeat is older than this is stale (its holder crashed) and may be taken over. Default 120 s. */
  staleAfterMs?: number;
  /** How often a held lease touches its lock file. Default 30 s. */
  heartbeatMs?: number;
  /** Poll interval while waiting for a free user. Default 500 ms. */
  pollMs?: number;
  /** Shown in the holder list and error messages. */
  owner?: string;
  /** Distinguishes pools for different SAP systems/clients that share user names. */
  scope?: string;
}

/**
 * Leases test users to workers so that two of them never log on as the same
 * SAP user at once - which SAP answers with "user already logged on" (a pop-up
 * that stalls the run) or, worse, by kicking the other session out.
 *
 * The lease is a lock file created atomically (`wx`), refreshed by a heartbeat
 * while held, released on dispose and on process exit, and taken over only
 * if its heartbeat has stopped or its process is gone. It coordinates every
 * process on ONE machine. Across several CI machines using the same SAP users
 * a file lock cannot work: give each machine its own users, or implement a
 * shared lease service behind the same two calls (lease / release).
 */
export class SapUserPool {
  private readonly dir: string;
  private readonly staleAfterMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly owner?: string;
  private readonly scope: string;

  constructor(
    readonly users: readonly string[],
    options: UserPoolOptions = {},
  ) {
    if (users.length === 0) throw new Error('a user pool needs at least one user');
    this.dir = options.dir ?? path.join(os.tmpdir(), 'sap-user-pool');
    this.staleAfterMs = options.staleAfterMs ?? 120_000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.pollMs = options.pollMs ?? 500;
    this.owner = options.owner;
    this.scope = (options.scope ?? 'default').replace(/[^A-Za-z0-9_.-]/g, '_');
  }

  private lockFile(user: string): string {
    return path.join(this.dir, `${this.scope}__${user.replace(/[^A-Za-z0-9_.-]/g, '_')}.lock`);
  }

  /** Takes the first free user, waiting up to `timeoutMs` for one to be released. */
  async lease(timeoutMs = 60_000): Promise<UserLease> {
    fs.mkdirSync(this.dir, { recursive: true });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const user of this.users) {
        const lease = this.tryLease(user);
        if (lease) return lease;
      }
      if (Date.now() >= deadline) {
        throw new AdapterError('sap-gui', 'lease user', `no free SAP user after ${timeoutMs}ms - all ${this.users.length} are leased:\n${this.holders().map((h) => `  ${h.user}: pid ${h.pid} on ${h.host} since ${h.since}${h.owner ? ` (${h.owner})` : ''}`).join('\n')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /** Current holders of this pool's users. */
  holders(): LeaseHolder[] {
    const found: LeaseHolder[] = [];
    for (const user of this.users) {
      const file = this.lockFile(user);
      const holder = this.read(file);
      if (holder && this.state(file) === 'held') found.push(holder);
    }
    return found;
  }

  private tryLease(user: string): UserLease | undefined {
    const file = this.lockFile(user);
    if (this.create(file, user)) return this.hold(user, file);
    if (this.state(file) !== 'stale') return undefined; // held by someone alive (or being written right now)

    // Taking over a stale lock is the one step where two contenders can both decide "it is stale" and
    // then each delete the other's brand-new lock. A guard file only one of them can create serialises it.
    const guard = `${file}.takeover`;
    this.clearOldGuard(guard);
    try {
      fs.writeFileSync(guard, String(process.pid), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; // someone else is taking over: try again next round
      throw error;
    }
    try {
      if (this.state(file) !== 'stale') return undefined; // it changed while we were getting the guard
      const holder = this.read(file);
      log.warn(`[sap-gui] taking over a stale lease on ${user}${holder ? ` (was pid ${holder.pid} on ${holder.host})` : ''}`);
      fs.rmSync(file, { force: true });
      return this.create(file, user) ? this.hold(user, file) : undefined;
    } finally {
      fs.rmSync(guard, { force: true });
    }
  }

  /** A guard left by a process that died mid-takeover must not block everyone forever. */
  private clearOldGuard(guard: string): void {
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > 10_000) fs.rmSync(guard, { force: true });
    } catch {
      /* no guard */
    }
  }

  /** Atomic: fails if the file exists. */
  private create(file: string, user: string): boolean {
    try {
      const holder: LeaseHolder = { user, pid: process.pid, host: os.hostname(), since: new Date().toISOString(), owner: this.owner };
      fs.writeFileSync(file, JSON.stringify(holder), { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  private read(file: string): LeaseHolder | undefined {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as LeaseHolder;
    } catch {
      return undefined;
    }
  }

  /**
   * free: no lock. held: someone alive has it - or is writing it this very moment. stale: its holder is gone.
   * A lock that exists but cannot be read yet is a lease being created (the file appears before its content),
   * so it counts as held until it has been unreadable for a couple of seconds.
   */
  private state(file: string): 'free' | 'held' | 'stale' {
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      return 'free';
    }
    const holder = this.read(file);
    if (!holder) return Date.now() - mtime > UNREADABLE_GRACE_MS ? 'stale' : 'held';
    if (Date.now() - mtime > this.staleAfterMs) return 'stale'; // heartbeat stopped
    if (holder.host === os.hostname() && !processAlive(holder.pid)) return 'stale'; // holder crashed on this machine
    return 'held';
  }

  private hold(user: string, file: string): UserLease {
    let released = false;
    const beat = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(file, now, now);
      } catch {
        /* lock removed from under us: nothing to keep alive */
      }
    }, this.heartbeatMs);
    beat.unref();

    const release = () => {
      if (released) return;
      released = true;
      clearInterval(beat);
      process.off('exit', release);
      const holder = this.read(file);
      if (holder && holder.pid === process.pid) fs.rmSync(file, { force: true }); // never delete a lock someone else took over
    };
    process.on('exit', release); // best effort if the worker dies without cleaning up
    log.info(`[sap-gui] leased SAP user ${user}`);
    return { user, release };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours
  }
}
