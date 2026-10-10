import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import { getLogger } from '@automation/referenced-automation-utils';
import { SapGuiTransportError, type SapGuiCommand, type SapGuiTransport } from './types';

export interface ProcessTransportOptions {
  /** The program that speaks the bridge protocol (powershell.exe, java, node ...). */
  command: string;
  args: string[];
  /** Names the bridge in messages: "PowerShell", "Java", ... */
  label: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Runs when the transport closes or fails to start (delete a temporary script, ...). */
  cleanup?: () => void;
  /** Per-request limit. A "the bridge is hung" backstop, NOT a screen-wait - waiting for SAP is the session's job. Default 60 s. */
  requestTimeoutMs?: number;
  /** How long to wait for the bridge to say it is ready. Default 30 s. */
  startupTimeoutMs?: number;
  /** How long close() waits for the bridge to answer `quit` and exit before killing it. Default 2 s. */
  quitTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

/**
 * Talks to a bridge process over stdin/stdout: one JSON message per line each way.
 *
 *   -> {"rid": 7, "op": "get", "id": "wnd[0]/usr/txtX", "prop": "text"}
 *   <- {"rid": 7, "ok": true, "value": "abc"}           or   {"rid": 7, "ok": false, "error": "...", "code": "NOT_FOUND"}
 *
 * The bridge first sends {"rid": 0, "ok": true} to say it is ready. Any program that follows this
 * protocol can be a bridge - the PowerShell script and the Java/JACOB helper both do, which is what
 * lets a restricted machine swap one for the other without touching a test.
 *
 * A bridge that stops answering is not waited for again: after a request times out, the pipe breaks (EPIPE) or the
 * process exits, the bridge is killed, every pending request is rejected at once and every later one fails immediately -
 * a hung PowerShell must cost one timeout, not one per remaining call.
 */
export class ProcessTransport implements SapGuiTransport {
  private readonly log = getLogger('sap-gui-bridge');
  private readonly pending = new Map<number, Pending>();
  private nextRid = 1;
  private exited = false;
  private cleanedUp = false;
  /** Why the bridge was stopped, once it has been (a timeout, a broken pipe): the message of every later request. */
  private stopped?: SapGuiTransportError;
  private stderrTail = '';

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: ProcessTransportOptions,
    ready: { resolve: () => void; reject: (error: Error) => void },
  ) {
    readline
      .createInterface({ input: child.stdout })
      .on('line', (line) => this.onLine(line, ready));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    child.on('exit', (code) => this.onExit(code, ready));
    child.on('error', (error) => {
      this.exited = true;
      ready.reject(
        new SapGuiTransportError(
          `could not start ${options.label}: ${error.message}`,
          'BRIDGE_EXITED',
        ),
      );
    });
    // A bridge that closed its end of the pipe (crashed, was killed) makes the next write emit 'error' (EPIPE);
    // without a listener that is an uncaught exception that takes the whole test worker down.
    child.stdin.on('error', (error) =>
      this.stop(
        new SapGuiTransportError(
          `the ${options.label} bridge closed its input (${error.message}) - it has stopped`,
          'BRIDGE_EXITED',
        ),
      ),
    );
  }

  static async start(options: ProcessTransportOptions): Promise<ProcessTransport> {
    const child = spawn(options.command, options.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
      cwd: options.cwd,
    });
    let transport!: ProcessTransport;
    const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new SapGuiTransportError(
              `${options.label} did not become ready within ${startupTimeoutMs}ms`,
              'TIMEOUT',
            ),
          ),
        startupTimeoutMs,
      );
      transport = new ProcessTransport(child, options, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    }).catch((error) => {
      // Never `close()` here: that sends `quit` and waits for an answer from a bridge that just failed to start.
      if (transport) {
        transport.stop(error instanceof SapGuiTransportError ? error : undefined);
        transport.runCleanup();
      } else {
        child.kill();
        options.cleanup?.();
      }
      throw error;
    });
    return transport;
  }

  private onLine(line: string, ready: { resolve: () => void }): void {
    let message: { rid: number; ok: boolean; value?: unknown; error?: string; code?: string };
    try {
      message = JSON.parse(line);
    } catch {
      this.log.warn(
        `ignoring non-JSON line from the ${this.options.label} bridge: ${line.slice(0, 200)}`,
      );
      return;
    }
    if (message.rid === 0) {
      ready.resolve();
      return;
    }
    const pending = this.pending.get(message.rid);
    if (!pending) return;
    this.pending.delete(message.rid);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value ?? null);
    else
      pending.reject(
        new SapGuiTransportError(
          message.error ?? 'unknown bridge error',
          message.code === 'NOT_FOUND' || message.code === 'SESSION_LOST' ? message.code : 'ERROR',
        ),
      );
  }

  private onExit(code: number | null, ready: { reject: (error: Error) => void }): void {
    this.exited = true;
    const detail = `${this.options.label} bridge exited (code ${code})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`;
    const error = this.stopped ?? new SapGuiTransportError(detail, 'BRIDGE_EXITED');
    ready.reject(error);
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const [rid, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(rid);
    }
  }

  /**
   * Gives up on the bridge: kills it, fails everything that is waiting for it and makes every later request fail at once.
   * `reason` is what they are told; the first reason wins.
   */
  private stop(reason?: SapGuiTransportError): void {
    if (!this.stopped) {
      this.stopped =
        reason ??
        new SapGuiTransportError(
          `the ${this.options.label} bridge was stopped`,
          'BRIDGE_EXITED',
        );
    }
    this.exited = true;
    this.rejectAll(this.stopped);
    this.child.kill();
  }

  private runCleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.options.cleanup?.();
  }

  request(command: SapGuiCommand): Promise<unknown> {
    return this.send(command, this.options.requestTimeoutMs ?? 60_000);
  }

  private send(command: SapGuiCommand, timeoutMs: number): Promise<unknown> {
    if (this.exited)
      return Promise.reject(
        this.stopped ??
          new SapGuiTransportError(
            `the ${this.options.label} bridge is not running`,
            'BRIDGE_EXITED',
          ),
      );
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A bridge that did not answer is hung (typically SAP GUI is showing a dialog that blocks scripting). Waiting the
        // full timeout again for every later call would turn one failure into minutes: stop it, fail them all now.
        const error = new SapGuiTransportError(
          `no reply to "${command.op}" within ${timeoutMs}ms - SAP GUI may be showing a dialog that blocks scripting; the ${this.options.label} bridge was stopped`,
          'TIMEOUT',
        );
        this.pending.delete(rid);
        reject(error);
        this.stop(
          new SapGuiTransportError(
            `the ${this.options.label} bridge was stopped after "${command.op}" got no reply within ${timeoutMs}ms`,
            'BRIDGE_EXITED',
          ),
        );
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer, command: command.op });
      try {
        this.child.stdin.write(`${JSON.stringify({ rid, ...command })}\n`, (error) => {
          if (error)
            this.stop(
              new SapGuiTransportError(
                `could not send "${command.op}" to the ${this.options.label} bridge: ${error.message}`,
                'BRIDGE_EXITED',
              ),
            );
        });
      } catch (error) {
        this.stop(
          new SapGuiTransportError(
            `could not send "${command.op}" to the ${this.options.label} bridge: ${error instanceof Error ? error.message : String(error)}`,
            'BRIDGE_EXITED',
          ),
        );
      }
    });
  }

  async close(): Promise<void> {
    if (!this.exited) {
      // `quit` gets a short deadline of its own (a timeout kills the bridge); the request timeout is for real work.
      const quitMs = this.options.quitTimeoutMs ?? 2_000;
      await this.send({ op: 'quit' }, quitMs).catch(() => undefined);
      if (!this.exited) {
        this.child.stdin.end();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.child.kill();
            resolve();
          }, quitMs);
          this.child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    this.runCleanup();
  }
}
