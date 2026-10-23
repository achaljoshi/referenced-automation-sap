import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BRIDGE_SCRIPT } from './bridgeScript';
import { ProcessTransport } from './processTransport';
import { SapGuiTransportError } from './types';

export interface PowerShellTransportOptions {
  /** PowerShell executable. Default 'powershell.exe' (Windows PowerShell 5.1, present on every Windows). A 32-bit install of SAP GUI may need the 32-bit one: C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe (SAP_GUI_POWERSHELL). */
  powershellPath?: string;
  /**
   * A folder holding an approved - typically code-signed - copy of the bridge script as `sap-gui-bridge.ps1`
   * (`npx sap-gui-doctor --print-bridge | Out-File -Encoding ascii sap-gui-bridge.ps1`, then sign it). With it set, that file is run instead of a temporary
   * one and `-ExecutionPolicy Bypass` is NOT passed, so the machine's own policy (AllSigned, ...) decides. The copy must be the
   * exact script this version of the framework ships (a signature block is ignored): a stale copy is refused. SAP_GUI_POWERSHELL_SCRIPT_DIR.
   */
  scriptDir?: string;
  /** Per-request limit. A "the bridge is hung" backstop, not a screen-wait. Default 60 s. */
  requestTimeoutMs?: number;
  /** How long to wait for PowerShell to start and say ready. Default 30 s. */
  startupTimeoutMs?: number;
}

export const APPROVED_SCRIPT_NAME = 'sap-gui-bridge.ps1';

/**
 * What the file holds apart from an Authenticode signature block, with line endings and trailing blanks normalised.
 * Only a block made of comment lines counts as a signature: code appended after a fake "# SIG # Begin signature block" line is
 * NOT cut off, so it makes the copy differ from the shipped script and the copy is refused.
 */
function withoutSignature(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n# SIG # Begin signature block(?:\n#[^\n]*)*\s*$/, '')
    .trim();
}

/**
 * The PowerShell arguments to run the bridge, and what to clean up afterwards.
 *
 * By default the script is written to a temporary file and run with `-ExecutionPolicy Bypass`: the process-level bypass is what
 * lets a script that is not signed run on a machine whose policy would otherwise refuse it, and it applies to this one
 * PowerShell process only - but on a managed desktop it also sidesteps a control the organisation set on purpose. Where that
 * is not acceptable, point `scriptDir` (SAP_GUI_POWERSHELL_SCRIPT_DIR) at an approved, signed copy and the policy is left alone.
 */
export function bridgeInvocation(options: Pick<PowerShellTransportOptions, 'scriptDir'>, tmp: string = os.tmpdir()): { args: string[]; cleanup: () => void } {
  const base = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (options.scriptDir) {
    const approved = path.join(options.scriptDir, APPROVED_SCRIPT_NAME);
    if (!fs.existsSync(approved))
      throw new SapGuiTransportError(`SAP_GUI_POWERSHELL_SCRIPT_DIR is set but ${approved} does not exist. Create it with: npx sap-gui-doctor --print-bridge | Out-File -Encoding ascii ${APPROVED_SCRIPT_NAME}  (and sign it if your policy requires).`, 'ERROR');
    if (withoutSignature(fs.readFileSync(approved, 'utf8')) !== withoutSignature(BRIDGE_SCRIPT))
      throw new SapGuiTransportError(`${approved} is not the bridge script this version of the framework ships (it is out of date or was edited). Regenerate it with: npx sap-gui-doctor --print-bridge, review it and sign it again.`, 'ERROR');
    return { args: [...base, '-File', approved], cleanup: () => undefined };
  }
  const scriptPath = path.join(tmp, `sap-gui-bridge-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(scriptPath, BRIDGE_SCRIPT, 'ascii');
  return { args: [...base, '-ExecutionPolicy', 'Bypass', '-File', scriptPath], cleanup: () => fs.rmSync(scriptPath, { force: true }) };
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
    const { args, cleanup } = bridgeInvocation(options);
    return ProcessTransport.start({
      command: options.powershellPath ?? 'powershell.exe',
      args,
      label: 'PowerShell',
      cleanup,
      requestTimeoutMs: options.requestTimeoutMs,
      startupTimeoutMs: options.startupTimeoutMs,
    });
  },
};
