import { loadEnv } from '@automation/referenced-automation-utils';
import { createSampleSapSystem } from '../gui/fakeSapGui';
import { selectedTransport, startRealTransport } from '../gui/transportFactory';
import { SapGuiSession } from '../gui/session';
import type { SapGuiTransport } from '../gui/types';

export interface CliConnection {
  session: SapGuiSession;
  transport: SapGuiTransport;
  /** Which bridge is in use, for messages. */
  transportName: string;
  /** Releases the bridge. Does not log anyone off. */
  close(): Promise<void>;
}

/**
 * Connects the way the tests will: opens SAP_GUI_CONNECTION_NAME (SAP_GUI_MODE=open) or attaches to
 * the session you have open. With SAP_GUI_SIMULATOR=true it uses the built-in fake SAP, on any OS.
 */
export async function connectForCli(timeoutMs = 15_000): Promise<CliConnection> {
  const env = loadEnv();
  const simulate = env.getBoolean('SAP_GUI_SIMULATOR', false);
  // With SAP_GUI_TRANSPORT=remote SAP GUI is on the remote desktop host; the remote layer reports an unsupported test machine itself.
  if (!simulate && process.platform !== 'win32' && selectedTransport() !== 'remote') {
    throw new Error(
      'SAP GUI Scripting is a Windows COM API: run this on the Windows machine that has SAP GUI (or set SAP_GUI_SIMULATOR=true to try it against the built-in fake SAP, or SAP_GUI_TRANSPORT=remote to use SAP GUI on a remote desktop host).',
    );
  }
  const started: { transport: SapGuiTransport; name: string; release?: () => Promise<void> } = simulate
    ? {
        transport: createSampleSapSystem({ transitionDelayMs: 0 }) as SapGuiTransport,
        name: 'simulator',
      }
    : await startRealTransport();
  const transport = started.transport;
  try {
    const mode = simulate ? 'attach' : env.get('SAP_GUI_MODE', 'attach');
    const session =
      mode === 'open'
        ? await SapGuiSession.open(transport, env.get('SAP_GUI_CONNECTION_NAME'), {
            timeoutMs,
            logonPath: env.get(
              'SAP_GUI_LOGON_PATH',
              'C:\\Program Files (x86)\\SAP\\FrontEnd\\SAPgui\\saplogon.exe',
            ),
            connectionString: env.getOptional('SAP_GUI_CONNECTION_STRING'),
          })
        : await SapGuiSession.attach(transport, {
            timeoutMs,
            connectionIndex: env.getInt('SAP_GUI_CONNECTION_INDEX', 0),
            sessionIndex: env.getInt('SAP_GUI_SESSION_INDEX', 0),
          });
    return {
      session,
      transport,
      transportName: started.name,
      close: async () => {
        await transport.close();
        await started.release?.(); // the remote host too: a CLI run is the only user
      },
    };
  } catch (error) {
    await transport.close().catch(() => undefined);
    await started.release?.().catch(() => undefined);
    throw error;
  }
}
