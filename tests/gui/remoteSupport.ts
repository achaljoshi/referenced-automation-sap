import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { remote, testing } from '@automation/referenced-automation-utils';

/**
 * Everything here runs against the utils package's STAND-IN agent (a Node implementation of the PowerShell agent over a temp
 * folder) hosting the stand-in bridge below. Nothing in these tests has touched RDP, the PowerShell agent or a real SAP GUI.
 */
export const standInBridge = path.resolve(__dirname, 'bridges/standInBridge.js');

export interface Rig {
  dir: string;
  agent: InstanceType<typeof testing.StandInAgent>;
  host: remote.RemoteHost;
  /** The OS processes the stand-in agent currently hosts (proc.start children). */
  hosted(): number;
  /** Stops host, agent and the temp folder. Never throws. */
  done(): Promise<void>;
}

/** A temp mailbox, a stand-in agent on it, and a connected RemoteHost client. The bridge's fault injection is read from `process.env` when it starts. */
export async function rig(allow: remote.RemoteCapability[] = ['http', 'db', 'sap']): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-remote-'));
  const agent = new testing.StandInAgent({ shareDir: dir, allow });
  await agent.start();
  const host = new remote.RemoteHost(testing.standInRemoteConfig(dir, { allow }));
  await host.connect();
  return {
    dir,
    agent,
    host,
    hosted: () => hostedProcs(agent).size,
    done: async () => {
      await host.close().catch(() => undefined);
      await agent.stop().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Hosted = Map<string, { child: { pid?: number; exitCode: number | null; signalCode: string | null } }>;
const hostedProcs = (agent: object): Hosted => (agent as unknown as { procs: Hosted }).procs;

/** Child processes of the stand-in agent that are still running (the stand-in keeps its `procs` map private; read here for the assertions). */
export function liveChildren(r: Rig): number {
  return [...hostedProcs(r.agent).values()].filter((p) => p.child.exitCode === null && p.child.signalCode === null).length;
}

/** Sets environment variables for one test and puts them back. */
export async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    return await run();
  } finally {
    apply(saved);
  }
}

/** The REMOTE_* environment that makes `getRemoteHost()` use the stand-in agent over `dir` (manual start: the test plays the agent). */
export function remoteEnv(dir: string): Record<string, string> {
  return {
    SAP_GUI_TRANSPORT: 'remote',
    SAP_GUI_SIMULATOR: 'false',
    SAP_GUI_REMOTE_BRIDGE_FILE: standInBridge,
    REMOTE_ENABLED: 'true',
    REMOTE_RDP_HOST: 'rdp-host.test',
    REMOTE_AGENT_START: 'manual',
    REMOTE_SHARE_DIR: dir,
    REMOTE_POLL_MS: '20',
    REMOTE_HEARTBEAT_MS: '100',
    REMOTE_HEARTBEAT_STALE_MS: '1000',
    REMOTE_CONNECT_TIMEOUT_MS: '5000',
    REMOTE_REQUEST_TIMEOUT_MS: '5000',
  };
}
