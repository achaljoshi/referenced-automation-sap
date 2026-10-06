#!/usr/bin/env node
import { loadEnv } from '@automation/referenced-automation-utils';
import { BRIDGE_SCRIPT } from '../gui/bridgeScript';
import { PowerShellTransport } from '../gui/powershellTransport';
import { dumpScreen, formatScreenDump } from '../gui/inspect';
import { SapGuiSession } from '../gui/session';

/**
 * Run this ON the Windows machine that will run the recorded tests, before
 * anything else: it checks each thing that has to be true, in order, and
 * says which one isn't.
 */
async function main(): Promise<void> {
  if (process.argv.includes('--print-bridge')) {
    process.stdout.write(BRIDGE_SCRIPT);
    return;
  }
  const out = (ok: boolean, text: string) => process.stdout.write(`${ok ? '  OK   ' : '  FAIL '} ${text}\n`);
  const env = loadEnv();

  out(process.platform === 'win32', `running on Windows (found: ${process.platform})`);
  if (process.platform !== 'win32') process.exit(1);

  let transport: PowerShellTransport;
  try {
    transport = await PowerShellTransport.start({ powershellPath: env.getOptional('SAP_GUI_POWERSHELL') });
    out(true, 'PowerShell bridge started');
  } catch (error) {
    out(false, `PowerShell bridge did not start: ${(error as Error).message}`);
    process.stdout.write('       (script execution blocked by policy? try SAP_GUI_POWERSHELL=<path to powershell.exe>)\n');
    process.exit(1);
  }

  try {
    // Do what the tests will do: open the named connection, or attach to one you have open.
    const mode = env.get('SAP_GUI_MODE', 'attach');
    const session =
      mode === 'open'
        ? await SapGuiSession.open(transport, env.get('SAP_GUI_CONNECTION_NAME'), {
            timeoutMs: 15_000,
            logonPath: env.get('SAP_GUI_LOGON_PATH', 'C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPgui\\saplogon.exe'),
          })
        : await SapGuiSession.attach(transport, {
            connectionIndex: env.getInt('SAP_GUI_CONNECTION_INDEX', 0),
            sessionIndex: env.getInt('SAP_GUI_SESSION_INDEX', 0),
            timeoutMs: 5_000,
          });
    out(true, mode === 'open' ? `opened connection "${env.get('SAP_GUI_CONNECTION_NAME')}"` : 'attached to a running SAP GUI session');
    const title = await session.get('wnd[0]', 'text').catch(() => '(unreadable)');
    out(true, `main window title: ${String(title)}`);
    out(true, `status bar: "${await session.statusBarText().catch(() => '(unreadable)')}"`);
    out(await session.healthCheck(), 'session answers a health check');

    const dumpIndex = process.argv.indexOf('--dump');
    if (dumpIndex !== -1) {
      const root = process.argv[dumpIndex + 1] && !process.argv[dumpIndex + 1]?.startsWith('-') ? (process.argv[dumpIndex + 1] as string) : 'wnd[0]';
      process.stdout.write(`\nControls on ${root} (copy the ids into sap.setText / sap.press ...):\n\n${formatScreenDump(await dumpScreen(session, root))}\n`);
    }
  } catch (error) {
    out(false, `could not ${env.get('SAP_GUI_MODE', 'attach') === 'open' ? 'open the connection' : 'attach'}: ${(error as Error).message}`);
    process.stdout.write(
      [
        '       Check, in order:',
        '        1. attach mode: SAP Logon is open with a connection and a session.  open mode: SAP_GUI_CONNECTION_NAME matches a SAP Logon entry exactly',
        '        2. SAP GUI > Options > Accessibility & Scripting > Scripting: "Enable scripting" is ticked',
        '           and both "Notify when a script attaches" / "...opens a connection" are UNticked (those popups stall a run)',
        '        3. The SAP server allows it: profile parameter sapgui/user_scripting = TRUE (ask your SAP Basis team)',
        '        4. 32-bit SAP GUI? Set SAP_GUI_POWERSHELL=C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
  } finally {
    await transport.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
