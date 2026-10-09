import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { dpapiSecrets, envSecrets, resolveSecret, storeDpapiSecret } from '../../src';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sapsecrets-'));

test.describe('secret providers', () => {
  test('env: reads a variable, ignores empty ones', async () => {
    process.env.SAP_TEST_SECRET = 'from-env';
    process.env.SAP_TEST_EMPTY = '';
    expect(await envSecrets.get('SAP_TEST_SECRET')).toBe('from-env');
    expect(await envSecrets.get('SAP_TEST_EMPTY')).toBeUndefined();
    expect(await envSecrets.get('SAP_TEST_MISSING')).toBeUndefined();
  });

  test('dpapi: decrypts a stored file through PowerShell, passing the path in the environment (not the command line)', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'SAP_PASSWORD.dpapi'), 'AAAAprotectedbytes');
    let seenEnv: Record<string, string> = {};
    let seenScript = '';
    const provider = dpapiSecrets({
      dir,
      platform: 'win32',
      run: (script, env) => {
        seenScript = script;
        seenEnv = env ?? {};
        return { status: 0, stdout: 'p@ss w0rd', stderr: '' };
      },
    });
    expect(await provider.get('SAP_PASSWORD')).toBe('p@ss w0rd');
    expect(seenEnv.SAP_SECRET_FILE).toBe(path.resolve(dir, 'SAP_PASSWORD.dpapi'));
    expect(seenScript).toContain("'CurrentUser'"); // bound to the Windows user, not a machine-wide or shared key
    expect(seenScript).not.toContain('p@ss'); // the value is never part of a command line
  });

  test('dpapi: a file made by another user or machine is refused, not guessed at', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'K.dpapi'), 'x');
    const provider = dpapiSecrets({ dir, platform: 'win32', run: () => ({ status: 1, stdout: '', stderr: 'Key not valid for use in specified state.' }) });
    expect(await provider.get('K')).toBeUndefined();
  });

  test('dpapi: nothing on non-Windows, and nothing when there is no file', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'K.dpapi'), 'x');
    expect(await dpapiSecrets({ dir, platform: 'darwin' }).get('K')).toBeUndefined();
    expect(await dpapiSecrets({ dir, platform: 'win32', run: () => ({ status: 0, stdout: 'x', stderr: '' }) }).get('OTHER')).toBeUndefined();
  });

  test('a secret name cannot walk out of the secrets folder', async () => {
    const provider = dpapiSecrets({ dir: tmp(), platform: 'win32', run: () => ({ status: 0, stdout: 'x', stderr: '' }) });
    await expect(provider.get('../../etc/passwd')).rejects.toThrow(/may only contain/);
  });

  test('store: protects the value (piped on stdin, never on the command line) and writes only ciphertext', async () => {
    const dir = tmp();
    let stdinSeen = '';
    let scriptSeen = '';
    const file = storeDpapiSecret('SAP_PASSWORD', 'my-secret', {
      dir,
      platform: 'win32',
      run: (script, _env, stdin) => {
        scriptSeen = script;
        stdinSeen = stdin ?? '';
        return { status: 0, stdout: 'Y2lwaGVydGV4dA==', stderr: '' };
      },
    });
    expect(stdinSeen).toBe('my-secret');
    expect(scriptSeen).not.toContain('my-secret');
    expect(fs.readFileSync(file, 'utf8')).toBe('Y2lwaGVydGV4dA==');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('my-secret');
  });

  test('store: refuses off Windows instead of writing something that is not protected', () => {
    expect(() => storeDpapiSecret('K', 'v', { dir: tmp(), platform: 'linux' })).toThrow(/Windows/);
  });

  test('resolveSecret tries providers in order and stops at the first hit', async () => {
    const calls: string[] = [];
    const first = { name: 'first', get: async () => (calls.push('first'), undefined) };
    const second = { name: 'second', get: async () => (calls.push('second'), 'found') };
    const third = { name: 'third', get: async () => (calls.push('third'), 'never') };
    expect(await resolveSecret('K', [first, second, third])).toBe('found');
    expect(calls).toEqual(['first', 'second']);
  });
});
