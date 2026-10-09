import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BRIDGE_SCRIPT } from './bridgeScript';
import { ProcessTransport } from './processTransport';
import { SapGuiTransportError } from './types';

export interface PowerShellTransportOptions {
  /** PowerShell executable. Default 'powershell.exe' (Windows PowerShell 5.1, present on every Windows). A 32-bit install of SAP GUI may need the 32-bit one: C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe (SAP_GUI_POWERSHELL). */
  powershellPath?: string;
  /** Per-request limit. A "the bridge is hung" backstop, not a screen-wait. Default 60 s. */
  requestTimeoutMs?: number;
  /** How long to wait for PowerShell to start and say ready. Default 30 s. */
  startupTimeoutMs?: number;
}

/**
 * The default way to reach SAP GUI: one long-lived PowerShell process (see bridgeScript.ts) that holds the
 * COM connection, spoken to by ProcessTransport. Windows only, by nature - SAP GUI Scripting is a Windows COM API.
 */
export const PowerShellTransport = {
  async start(options: PowerShellTransportOptions = {}): Promise<ProcessTransport> {
    if (process.platform !== 'win32') {
      throw new SapGuiTransportError(
        'SAP GUI Scripting is a Windows COM API: run these tests on a Windows machine that has SAP GUI installed (see the sap README, "Running recorded scripts").',
        'ERROR',
      );
    }
    const scriptPath = path.join(os.tmpdir(), `sap-gui-bridge-${process.pid}-${Date.now()}.ps1`);
    fs.writeFileSync(scriptPath, BRIDGE_SCRIPT, 'ascii');
    return ProcessTransport.start({
      command: options.powershellPath ?? 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
      label: 'PowerShell',
      cleanup: () => fs.rmSync(scriptPath, { force: true }),
      requestTimeoutMs: options.requestTimeoutMs,
      startupTimeoutMs: options.startupTimeoutMs,
    });
  },
};
