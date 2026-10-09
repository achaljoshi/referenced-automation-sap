import { loadEnv } from '@automation/referenced-automation-utils';
import { JavaTransport } from './javaTransport';
import { PowerShellTransport } from './powershellTransport';
import type { SapGuiTransport } from './types';

export type TransportKind = 'powershell' | 'java';

export function selectedTransport(): TransportKind {
  const kind = loadEnv().get('SAP_GUI_TRANSPORT', 'powershell').toLowerCase();
  if (kind !== 'powershell' && kind !== 'java')
    throw new Error(`SAP_GUI_TRANSPORT must be "powershell" or "java" (found "${kind}")`);
  return kind;
}

/**
 * Starts the bridge to the real SAP GUI that SAP_GUI_TRANSPORT selects:
 *   powershell (default)  the PowerShell bridge - nothing to install
 *   java                  the Java/JACOB helper - SAP_GUI_BRIDGE_JAR, SAP_GUI_JACOB_JAR, SAP_GUI_JACOB_DLL (and SAP_GUI_JAVA)
 */
export async function startRealTransport(): Promise<{ transport: SapGuiTransport; name: string }> {
  const env = loadEnv();
  if (selectedTransport() === 'java') {
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
    }),
    name: 'PowerShell',
  };
}
