#!/usr/bin/env node
import { loadEnv } from '@automation/referenced-automation-utils';
import { BRIDGE_SCRIPT } from '../gui/bridgeScript';
import { selectedTransport } from '../gui/transportFactory';
import { formatConformance, runConformance } from '../gui/conformance';
import { dumpScreen, formatScreenDump } from '../gui/inspect';
import { connectForCli, type CliConnection } from './connect';

const USAGE = `sap-gui-doctor - is this machine ready to run the SAP GUI tests, and if not, what is wrong?

  sap-gui-doctor                      check, in order: Windows, the bridge starts, SAP is reachable, the session answers
  sap-gui-doctor --conformance        also run the transport conformance suite against your SAP (changes nothing)
  sap-gui-doctor --conformance --write   ... plus a check that types into the command field and reads it back
  sap-gui-doctor --dump [wnd[1]]      list the controls on the current screen (or a pop-up) with their ids
  sap-gui-doctor --print-bridge       print the PowerShell the framework runs, for whoever must approve it

It does what the tests will do: opens SAP_GUI_CONNECTION_NAME (SAP_GUI_MODE=open) or attaches to the session you have open.
With SAP_GUI_SIMULATOR=true it runs against the built-in fake SAP, on any OS.
`;

const out = (ok: boolean, text: string) =>
  process.stdout.write(`${ok ? '  OK   ' : '  FAIL '} ${text}\n`);

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h'))
    return void process.stdout.write(USAGE);
  if (process.argv.includes('--print-bridge')) return void process.stdout.write(BRIDGE_SCRIPT);

  const env = loadEnv();
  const simulate = env.getBoolean('SAP_GUI_SIMULATOR', false);
  const remoteHost = !simulate && selectedTransport() === 'remote';
  out(
    simulate || remoteHost || process.platform === 'win32',
    simulate
      ? 'using the built-in simulator (SAP_GUI_SIMULATOR=true)'
      : remoteHost
        ? `using SAP GUI on the remote desktop host (SAP_GUI_TRANSPORT=remote; this machine: ${process.platform})`
        : `running on Windows (found: ${process.platform})`,
  );
  if (!simulate && !remoteHost && process.platform !== 'win32') process.exit(1);

  let connection: CliConnection;
  const mode = simulate ? 'attach' : env.get('SAP_GUI_MODE', 'attach');
  try {
    connection = await connectForCli(15_000);
    out(true, `bridge started (${connection.transportName})`);
    out(
      true,
      mode === 'open'
        ? `opened connection "${env.get('SAP_GUI_CONNECTION_NAME', env.get('SAP_GUI_CONNECTION_STRING', ''))}"`
        : 'attached to a running SAP GUI session',
    );
  } catch (error) {
    out(
      false,
      `could not ${mode === 'open' ? 'open the connection' : 'attach'}: ${(error as Error).message}`,
    );
    process.stdout.write(
      [
        '       Check, in order:',
        '        1. the bridge: script execution blocked by policy? try SAP_GUI_POWERSHELL=<path to powershell.exe>, an approved signed copy of the bridge (SAP_GUI_POWERSHELL_SCRIPT_DIR), or the Java/JACOB bridge (SAP_GUI_TRANSPORT=java, see docs); with SAP_GUI_TRANSPORT=remote: the RDP session must be connected and unlocked and REMOTE_ALLOW must include sap (automation-remote check)',
        '        2. attach mode: SAP Logon is open with a connection and a session.  open mode: SAP_GUI_CONNECTION_NAME matches a SAP Logon entry exactly',
        '        3. SAP GUI > Options > Accessibility & Scripting > Scripting: "Enable scripting" is ticked, and both "Notify when a script attaches / opens a connection" are UNticked (those popups stall a run)',
        '        4. The SAP server allows it: profile parameter sapgui/user_scripting = TRUE (ask your SAP Basis team)',
        '        5. 32-bit SAP GUI? Set SAP_GUI_POWERSHELL=C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  let failed = false;
  try {
    const { session } = connection;
    out(
      true,
      `main window title: ${String(await session.get('wnd[0]', 'text').catch(() => '(unreadable)'))}`,
    );
    out(true, `status bar: "${await session.statusBarText().catch(() => '(unreadable)')}"`);
    const alive = await session.healthCheck();
    out(alive, 'session answers a health check');
    failed ||= !alive;
    const where = await session.refreshContext();
    if (where)
      out(
        true,
        `SAP: system ${where.system}, client ${where.client}, user ${where.user}, transaction ${where.transaction || '(none)'}`,
      );

    const dump = process.argv.indexOf('--dump');
    if (dump !== -1) {
      const next = process.argv[dump + 1];
      const root = next && !next.startsWith('-') ? next : 'wnd[0]';
      process.stdout.write(
        `\nControls on ${root} (copy the ids into sap.setText / sap.press ...):\n\n${formatScreenDump(await dumpScreen(session, root))}\n`,
      );
    }

    if (process.argv.includes('--conformance')) {
      process.stdout.write(`\nTransport conformance (${connection.transportName}):\n\n`);
      const report = await runConformance(connection.transport, {
        write: process.argv.includes('--write'),
      });
      process.stdout.write(`${formatConformance(report)}\n`);
      failed ||= report.requiredFailed > 0;
    }
  } catch (error) {
    out(false, (error as Error).message);
    failed = true;
  } finally {
    await connection.close();
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
