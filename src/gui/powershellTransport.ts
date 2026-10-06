import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { getLogger } from '@automation/referenced-automation-utils';
import { BRIDGE_SCRIPT } from './bridgeScript';
import { SapGuiTransportError, type SapGuiCommand, type SapGuiTransport } from './types';

export interface PowerShellTransportOptions {
  /** PowerShell executable. Default 'powershell.exe' (Windows PowerShell 5.1, present on every Windows). A 32-bit install of SAP GUI may need the 32-bit one: C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe (SAP_GUI_POWERSHELL). */
  powershellPath?: string;
  /** Per-request limit. This is a "the bridge is hung" backstop, not a screen-wait - waiting for SAP is the session's job. Default 60s. */
  requestTimeoutMs?: number;
  /** How long to wait for PowerShell to start and say ready. Default 30s. */
  startupTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

/**
 * Drives the real SAP GUI: one long-lived PowerShell process (see
 * bridgeScript.ts) that holds the COM connection, spoken to over
 * stdin/stdout as one JSON message per line. Windows only, by nature - SAP
 * GUI Scripting is a Windows COM API.
 */
export class PowerShellTransport implements SapGuiTransport {
  private readonly log = getLogger('sap-gui-bridge');
  private readonly pending = new Map<number, Pending>();
  private nextRid = 1;
  private exited = false;
  private stderrTail = '';

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly scriptPath: string,
    private readonly requestTimeoutMs: number,
    ready: { resolve: () => void; reject: (error: Error) => void },
  ) {
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line, ready));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    child.on('exit', (code) => this.onExit(code, ready));
    child.on('error', (error) => {
      this.exited = true;
      ready.reject(new SapGuiTransportError(`could not start PowerShell: ${error.message}`, 'BRIDGE_EXITED'));
    });
  }

  static async start(options: PowerShellTransportOptions = {}): Promise<PowerShellTransport> {
    if (process.platform !== 'win32') {
      throw new SapGuiTransportError(
        'SAP GUI Scripting is a Windows COM API: run these tests on a Windows machine that has SAP GUI installed (see the sap README, "Running recorded scripts").',
        'ERROR',
      );
    }
    const scriptPath = path.join(os.tmpdir(), `sap-gui-bridge-${process.pid}-${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, BRIDGE_SCRIPT, 'ascii');
    const child = spawn(
      options.powershellPath ?? 'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let transport!: PowerShellTransport;
    const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SapGuiTransportError(`PowerShell did not become ready within ${startupTimeoutMs}ms`, 'TIMEOUT')),
        startupTimeoutMs,
      );
      transport = new PowerShellTransport(child, scriptPath, options.requestTimeoutMs ?? 60_000, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    }).catch(async (error) => {
      await transport?.close().catch(() => undefined);
      fs.rmSync(scriptPath, { force: true });
      throw error;
    });
    return transport;
  }

  private onLine(line: string, ready: { resolve: () => void }): void {
    let message: { rid: number; ok: boolean; value?: unknown; error?: string; code?: string };
    try {
      message = JSON.parse(line);
    } catch {
      this.log.warn(`ignoring non-JSON line from the bridge: ${line.slice(0, 200)}`);
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
    else pending.reject(new SapGuiTransportError(message.error ?? 'unknown bridge error', message.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'ERROR'));
  }

  private onExit(code: number | null, ready: { reject: (error: Error) => void }): void {
    this.exited = true;
    const detail = `PowerShell bridge exited (code ${code})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`;
    const error = new SapGuiTransportError(detail, 'BRIDGE_EXITED');
    ready.reject(error);
    for (const [rid, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(rid);
    }
  }

  request(command: SapGuiCommand): Promise<unknown> {
    if (this.exited) return Promise.reject(new SapGuiTransportError('the PowerShell bridge is not running', 'BRIDGE_EXITED'));
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new SapGuiTransportError(`no reply to "${command.op}" within ${this.requestTimeoutMs}ms - SAP GUI may be showing a dialog that blocks scripting`, 'TIMEOUT'));
      }, this.requestTimeoutMs);
      this.pending.set(rid, { resolve, reject, timer, command: command.op });
      this.child.stdin.write(`${JSON.stringify({ rid, ...command })}\n`);
    });
  }

  async close(): Promise<void> {
    if (!this.exited) {
      await this.request({ op: 'quit' }).catch(() => undefined);
      this.child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill();
          resolve();
        }, 3_000);
        this.child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    fs.rmSync(this.scriptPath, { force: true });
  }
}
