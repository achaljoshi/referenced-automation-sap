import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProcessTransport } from './processTransport';
import { SapGuiTransportError } from './types';

export interface JavaTransportOptions {
  /** `java` executable. Default 'java' from PATH (SAP_GUI_JAVA). Use the bitness your JACOB DLL matches. */
  javaPath?: string;
  /** The helper built from bridge/jacob (sap-bridge.jar). */
  bridgeJar: string;
  /** Your existing JACOB jar. */
  jacobJar: string;
  /** FULL PATH of the JACOB DLL for your Java's bitness, e.g. C:\tools\jacob\jacob-1.18-x64.dll - what the existing framework passes as jacob.dll.path. */
  jacobDll: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
}

/**
 * The alternative way to reach SAP GUI, for machines where PowerShell is restricted but the existing Java/JACOB
 * framework runs: a small Java process (bridge/jacob/src/SapBridge.java) that speaks the same line protocol as the
 * PowerShell bridge, so nothing above the transport changes. Select it with SAP_GUI_TRANSPORT=java.
 */
export const JavaTransport = {
  async start(options: JavaTransportOptions): Promise<ProcessTransport> {
    for (const [label, file] of [
      ['bridge jar (SAP_GUI_BRIDGE_JAR)', options.bridgeJar],
      ['JACOB jar (SAP_GUI_JACOB_JAR)', options.jacobJar],
      ['JACOB DLL (SAP_GUI_JACOB_DLL)', options.jacobDll],
    ] as const) {
      if (!file || !fs.existsSync(file)) {
        throw new SapGuiTransportError(
          `the ${label} was not found${file ? `: ${file}` : ' - it is not configured'}. See bridge/jacob/README.md for how to build and configure the Java bridge.`,
          'ERROR',
        );
      }
    }
    return ProcessTransport.start({
      command: options.javaPath ?? 'java',
      args: [
        `-Djacob.dll.path=${options.jacobDll}`,
        '-cp',
        [options.bridgeJar, options.jacobJar].join(path.delimiter),
        'SapBridge',
      ],
      label: 'Java',
      requestTimeoutMs: options.requestTimeoutMs,
      startupTimeoutMs: options.startupTimeoutMs,
    });
  },
};
