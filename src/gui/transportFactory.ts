import { loadEnv, remote } from '@automation/referenced-automation-utils';
import { JavaTransport } from './javaTransport';
import { PowerShellTransport } from './powershellTransport';
import { RemoteTransport } from './remoteTransport';
import { SapGuiTransportError, type SapGuiTransport } from './types';

export type TransportKind = 'powershell' | 'java' | 'remote';

export function selectedTransport(): TransportKind {
  const kind = loadEnv().get('SAP_GUI_TRANSPORT', 'powershell').toLowerCase();
  if (kind !== 'powershell' && kind !== 'java' && kind !== 'remote')
    throw new Error(`SAP_GUI_TRANSPORT must be "powershell", "java" or "remote" (found "${kind}")`);
  return kind;
}

/**
 * Ends this process's use of the remote desktop host (the one `getRemoteHost()` shares per worker) - and forgets it, so the next
 * use connects afresh instead of finding a half-closed host. Safe to call when it was never opened.
 */
export function releaseRemoteHost(): Promise<void> {
  return remote.closeRemoteHost();
}

/**
 * Starts the bridge to the real SAP GUI that SAP_GUI_TRANSPORT selects:
 *   powershell (default)  the PowerShell bridge - nothing to install
 *   java                  the Java/JACOB helper - SAP_GUI_BRIDGE_JAR, SAP_GUI_JACOB_JAR, SAP_GUI_JACOB_DLL (and SAP_GUI_JAVA)
 *   remote                the PowerShell bridge run on a remote desktop host through the RDP agent (REMOTE_* keys; SAP_GUI_REMOTE_BRIDGE_FILE)
 * `release` (remote only) ends this process's use of the remote host; call it after `transport.close()` when the worker is done.
 */
export async function startRealTransport(): Promise<{ transport: SapGuiTransport; name: string; release?: () => Promise<void> }> {
  const env = loadEnv();
  const kind = selectedTransport();
  if (kind === 'remote') {
    try {
      const host = await remote.getRemoteHost(env);
      if (!host)
        throw new SapGuiTransportError(
          'SAP_GUI_TRANSPORT=remote needs the remote desktop host: set REMOTE_ENABLED=true and the REMOTE_* keys (REMOTE_RDP_HOST, REMOTE_RDP_USER, REMOTE_RDP_PASSWORD in .env.<env>.local ... - see referenced-automation-utils docs/REMOTE_DESKTOP.md)',
          'ERROR',
        );
      const transport = await RemoteTransport.start({ host, bridgeFile: env.getOptional('SAP_GUI_REMOTE_BRIDGE_FILE') });
      return { transport, name: 'PowerShell on the remote desktop host', release: releaseRemoteHost };
    } catch (error) {
      await releaseRemoteHost().catch(() => undefined); // a failed start must not leave a connected (or remembered-as-failed) host behind
      throw error;
    }
  }
  if (kind === 'java') {
    const transport = await JavaTransport.start({
      javaPath: env.getOptional('SAP_GUI_JAVA'),
      bridgeJar: env.get('SAP_GUI_BRIDGE_JAR', ''),
      jacobJar: env.get('SAP_GUI_JACOB_JAR', ''),
      jacobDll: env.get('SAP_GUI_JACOB_DLL', ''),
    });
    return { transport, name: 'Java/JACOB' };
  }
  return {
    transport: await PowerShellTransport.start({
      powershellPath: env.getOptional('SAP_GUI_POWERSHELL'),
      scriptDir: env.getOptional('SAP_GUI_POWERSHELL_SCRIPT_DIR'),
    }),
    name: 'PowerShell',
  };
}
