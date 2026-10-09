import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger, loadEnv } from '@automation/referenced-automation-utils';

/**
 * Where a password comes from. The framework never stores one, and never
 * keeps the key to decrypt one next to the encrypted value - each provider
 * has a different answer to "who can read this?":
 *
 *  - env      the environment as the framework reads it: real environment variables (CI: masked),
 *             then `.env.<name>.local` (git-ignored), then `.env.<name>`.
 *  - dpapi    a file protected by Windows DPAPI for the CURRENT Windows user on THIS machine
 *             (`npx sap-gui-secret set SAP_PASSWORD`). Copied anywhere else, or opened by anyone
 *             else, it is just bytes - there is no key to steal.
 */
export interface SecretProvider {
  readonly name: string;
  get(key: string): Promise<string | undefined>;
}

const log = getLogger('sap-gui-secrets');

export const envSecrets: SecretProvider = {
  name: 'environment',
  async get(key) {
    const value = loadEnv().getOptional(key);
    return value === undefined || value === '' ? undefined : value;
  },
};

export interface PowerShellRunner {
  (script: string, env?: Record<string, string>, stdin?: string): { status: number | null; stdout: string; stderr: string };
}

const runPowerShell: PowerShellRunner = (script, env = {}, stdin) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: stdin,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const UNPROTECT = `Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $env:SAP_SECRET_FILE).Trim()); [Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')))`;
const PROTECT = `Add-Type -AssemblyName System.Security; $p = [Console]::In.ReadToEnd(); $b = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($p), $null, 'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($b))`;

export interface DpapiOptions {
  /** Where the protected files live. Default `.secrets` in the working directory (git-ignored). */
  dir?: string;
  /** Injected in tests. */
  run?: PowerShellRunner;
  platform?: NodeJS.Platform;
}

function secretFile(dir: string, key: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`secret name "${key}" may only contain letters, digits, _ . -`);
  return path.resolve(dir, `${key}.dpapi`);
}

/** Reads secrets stored with `sap-gui-secret set`. On anything but Windows it returns nothing (DPAPI is Windows-only). */
export function dpapiSecrets(options: DpapiOptions = {}): SecretProvider {
  const { dir = '.secrets', run = runPowerShell, platform = process.platform } = options;
  return {
    name: 'windows-dpapi',
    async get(key) {
      if (platform !== 'win32') return undefined;
      const file = secretFile(dir, key);
      if (!fs.existsSync(file)) return undefined;
      const result = run(UNPROTECT, { SAP_SECRET_FILE: file });
      if (result.status !== 0) {
        log.warn(`[sap-gui] could not unprotect ${file} (was it created by another Windows user or on another machine?): ${result.stderr.trim().split('\n')[0] ?? ''}`);
        return undefined;
      }
      return result.stdout;
    },
  };
}

/** Protects `value` for the current Windows user and writes it to `<dir>/<key>.dpapi`. */
export function storeDpapiSecret(key: string, value: string, options: DpapiOptions = {}): string {
  const { dir = '.secrets', run = runPowerShell, platform = process.platform } = options;
  if (platform !== 'win32') throw new Error('DPAPI protection is a Windows feature: run this on the Windows machine that will run the tests.');
  const result = run(PROTECT, {}, value);
  if (result.status !== 0 || result.stdout === '') throw new Error(`could not protect the secret: ${result.stderr.trim()}`);
  const file = secretFile(dir, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, result.stdout);
  return file;
}

/** Providers tried in order: the environment first (what CI uses), then a DPAPI file. */
export function defaultSecretProviders(): SecretProvider[] {
  return [envSecrets, dpapiSecrets()];
}

/** The first provider that has `key`. Never logs the value. */
export async function resolveSecret(key: string, providers: SecretProvider[] = defaultSecretProviders()): Promise<string | undefined> {
  for (const provider of providers) {
    const value = await provider.get(key);
    if (value !== undefined) {
      log.debug(`[sap-gui] ${key} resolved from ${provider.name}`);
      return value;
    }
  }
  return undefined;
}
