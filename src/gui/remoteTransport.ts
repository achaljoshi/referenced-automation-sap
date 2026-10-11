import { getLogger, remote } from '@automation/referenced-automation-utils';
import { BRIDGE_SCRIPT } from './bridgeScript';
import { decodeLine, encodeRequest } from './bridgeProtocol';
import { SapGuiTransportError, type SapGuiCommand, type SapGuiTransport } from './types';

export interface RemoteTransportOptions {
  /** The connected remote desktop host (`remote.getRemoteHost()`). It is NOT closed by this transport: other steps may still use it. */
  host: remote.RemoteHost;
  /**
   * A bridge script that is already on the remote host (SAP_GUI_REMOTE_BRIDGE_FILE, e.g. an approved, signed copy), run instead of the
   * script text this framework ships. Default: the shipped PowerShell bridge (BRIDGE_SCRIPT), delivered through the agent.
   */
  bridgeFile?: string;
  /** Per-request limit. A "the bridge is hung" backstop, NOT a screen-wait. Default 60 s. */
  requestTimeoutMs?: number;
  /** How long to wait for the bridge to say it is ready. Default 30 s. */
  startupTimeoutMs?: number;
  /** How long close() waits for the bridge to answer `quit`. Default 2 s. */
  quitTimeoutMs?: number;
}

/** Lines that are not our answer (a banner, the ready line, a stale reply) skipped while waiting for one reply. */
const MAX_STRAY_LINES = 20;

/**
 * Runs the SAP GUI bridge on a remote desktop host and talks to it through the remote agent (`proc.start` / `proc.send`). SAP GUI Scripting
 * only sees the interactive session, so the bridge has to run inside the logged-in RDP session the agent lives in.
 *
 * It is the same line protocol as ProcessTransport (see bridgeProtocol.ts) with one difference the agent imposes: `send(line)` writes one
 * line and returns the NEXT line the process prints. So requests go one at a time (the agent works one request at a time anyway), the
 * bridge's unsolicited ready line is read by sending an empty line (the bridge ignores blank lines), and a stray line is skipped by
 * reading again with an empty line until the reply carrying our `rid` arrives.
 *
 * A request that gets no reply stops the bridge (the agent kills it - a late reply would be taken for the next answer): every later request
 * fails at once. An agent that stopped answering (AGENT_STALE: the RDP session was closed, locked out or logged off) does the same.
 * close() ends the bridge process only; the RemoteHost stays open for its other users.
 */
export class RemoteTransport implements SapGuiTransport {
  private readonly log = getLogger('sap-gui-remote');
  private queue: Promise<unknown> = Promise.resolve();
  private nextRid = 1;
  private closed = false;
  /** Why the bridge was given up, once it has been: the message of every later request. */
  private stopped?: SapGuiTransportError;
  private stopping?: Promise<void>;

  private constructor(
    private readonly process_: remote.RemoteProcess,
    private readonly options: RemoteTransportOptions,
  ) {}

  static async start(options: RemoteTransportOptions): Promise<RemoteTransport> {
    const spec = options.bridgeFile ? { file: options.bridgeFile } : { scriptText: BRIDGE_SCRIPT };
    let process_: remote.RemoteProcess;
    try {
      process_ = await options.host.startProcess({ ...spec, shell: 'powershell' });
    } catch (error) {
      throw mapRemoteError(error, 'start the SAP GUI bridge on the remote host');
    }
    const transport = new RemoteTransport(process_, options);
    try {
      await transport.awaitReady(options.startupTimeoutMs ?? 30_000);
    } catch (error) {
      // Never `close()` here: that asks a bridge that just failed to start to quit.
      await transport.abort();
      throw error;
    }
    return transport;
  }

  /** Reads lines until the ready message. The first read is an empty line: it only makes the agent hand over the bridge's first line. */
  private async awaitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i <= MAX_STRAY_LINES; i++) {
      let answer: string;
      try {
        answer = await this.process_.send('', Math.max(1, deadline - Date.now()));
      } catch (error) {
        if (error instanceof remote.RemoteError && error.code === 'TIMEOUT')
          throw new SapGuiTransportError(`the remote SAP GUI bridge did not become ready within ${timeoutMs}ms`, 'TIMEOUT');
        throw mapRemoteError(error, 'wait for the SAP GUI bridge on the remote host');
      }
      if (decodeLine(answer).kind === 'ready') return;
      this.log.warn(`ignoring a line before ready from the remote bridge: ${answer.slice(0, 200)}`);
    }
    throw new SapGuiTransportError('the remote SAP GUI bridge printed too many lines without saying it is ready', 'ERROR');
  }

  request(command: SapGuiCommand): Promise<unknown> {
    return this.enqueue(command, this.options.requestTimeoutMs ?? 60_000);
  }

  private enqueue(command: SapGuiCommand, timeoutMs: number): Promise<unknown> {
    if (this.stopped) return Promise.reject(this.stopped);
    const run = this.queue.then(() => this.exchange(command, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async exchange(command: SapGuiCommand, timeoutMs: number): Promise<unknown> {
    if (this.stopped) throw this.stopped; // an earlier request in the queue stopped the bridge
    const rid = this.nextRid++;
    const deadline = Date.now() + timeoutMs;
    let line = encodeRequest(rid, command);
    for (let i = 0; i <= MAX_STRAY_LINES; i++) {
      let answer: string;
      try {
        answer = await this.process_.send(line, Math.max(1, deadline - Date.now()));
      } catch (error) {
        throw this.fail(error, command, timeoutMs);
      }
      const decoded = decodeLine(answer);
      if (decoded.kind === 'reply' && decoded.rid === rid) {
        if (decoded.ok) return decoded.value;
        throw decoded.error;
      }
      // Not our reply: ours is still to come, so read the next line without writing another request.
      line = '';
    }
    throw this.giveUp(new SapGuiTransportError(`the remote SAP GUI bridge printed ${MAX_STRAY_LINES} lines that are not the reply to "${command.op}" - it was stopped`, 'BRIDGE_EXITED'));
  }

  /** Turns a failed send into the transport error, and gives the bridge up when it cannot be trusted any more. */
  private fail(error: unknown, command: SapGuiCommand, timeoutMs: number): SapGuiTransportError {
    const mapped = mapRemoteError(error, `send "${command.op}" to the SAP GUI bridge`);
    if (!(error instanceof remote.RemoteError) || error.code === 'DENIED') return mapped;
    if (error.code === 'TIMEOUT') {
      this.giveUp(new SapGuiTransportError(`the remote SAP GUI bridge was stopped after "${command.op}" got no reply within ${timeoutMs}ms`, 'BRIDGE_EXITED'));
      return new SapGuiTransportError(
        `no reply to "${command.op}" within ${timeoutMs}ms - SAP GUI may be showing a dialog that blocks scripting (or the remote agent is busy); the remote bridge was stopped`,
        'TIMEOUT',
      );
    }
    this.giveUp(new SapGuiTransportError(`the remote SAP GUI bridge is gone: ${mapped.message}`, mapped.code === 'ERROR' ? 'BRIDGE_EXITED' : mapped.code));
    return mapped;
  }

  /** Marks the bridge unusable (first reason wins) and, in the background, makes sure the remote process is stopped. */
  private giveUp(reason: SapGuiTransportError): SapGuiTransportError {
    this.stopped ??= reason;
    this.stopping ??= this.process_.stop().catch((error: unknown) => {
      this.log.warn(`could not stop the remote bridge: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.stopped;
  }

  private async abort(): Promise<void> {
    this.closed = true;
    this.giveUp(new SapGuiTransportError('the remote SAP GUI bridge was stopped', 'BRIDGE_EXITED'));
    await this.stopping;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.stopped) {
      // `quit` gets a short deadline of its own; a timeout stops the bridge, which is what we want anyway.
      await this.enqueue({ op: 'quit' }, this.options.quitTimeoutMs ?? 2_000).catch(() => undefined);
    }
    this.stopped ??= new SapGuiTransportError('the remote SAP GUI bridge was closed', 'BRIDGE_EXITED');
    this.stopping ??= this.process_.stop().catch((error: unknown) => {
      this.log.warn(`could not stop the remote bridge: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.stopping;
  }
}

/** What went wrong on the remote host, as a transport error that says what to do about it. */
export function mapRemoteError(error: unknown, doing: string): SapGuiTransportError {
  if (error instanceof SapGuiTransportError) return error;
  if (!(error instanceof remote.RemoteError)) return new SapGuiTransportError(`could not ${doing}: ${error instanceof Error ? error.message : String(error)}`, 'ERROR');
  switch (error.code) {
    case 'DENIED':
      return new SapGuiTransportError(
        `the remote desktop host refused to ${doing}: ${error.message}. REMOTE_ALLOW must include "sap" (for example REMOTE_ALLOW=http,db,sap).`,
        'ERROR',
      );
    case 'AGENT_STALE':
      return new SapGuiTransportError(
        `the remote desktop host's agent stopped answering while trying to ${doing}: ${error.message} Keep the RDP session connected and unlocked.`,
        'SESSION_LOST',
      );
    case 'TIMEOUT':
      return new SapGuiTransportError(`the remote desktop host did not answer in time while trying to ${doing}: ${error.message}`, 'TIMEOUT');
    default:
      return new SapGuiTransportError(`could not ${doing} on the remote desktop host (${error.code}): ${error.message}`, error.code === 'REMOTE_ERROR' && /ended|exited|write to the process/.test(error.message) ? 'BRIDGE_EXITED' : 'ERROR');
  }
}
