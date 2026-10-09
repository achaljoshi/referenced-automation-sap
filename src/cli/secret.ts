#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { storeDpapiSecret } from '../gui/secrets';

const USAGE = `sap-gui-secret - keep a password for the SAP tests protected by Windows (DPAPI)

  sap-gui-secret set <NAME>      prompt for the value (hidden) and store it in .secrets/<NAME>.dpapi
  sap-gui-secret remove <NAME>   delete it
  sap-gui-secret list            names stored in .secrets/

The file can only be opened by the same Windows user on the same machine, so it is safe to leave on a
test machine and useless if copied. The framework looks for SAP_PASSWORD in the environment first and
then here. For CI use a masked CI variable instead.
`;

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8').on('data', (d) => (data += d)).on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const [command, name] = process.argv.slice(2);
  const dir = path.resolve('.secrets');
  if (command === 'list') {
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.dpapi')).map((f) => f.replace(/\.dpapi$/, '')) : [];
    process.stdout.write(names.length ? `${names.join('\n')}\n` : '(none)\n');
    return;
  }
  if (command === 'remove' && name) {
    const file = path.join(dir, `${name}.dpapi`);
    if (fs.existsSync(file)) fs.rmSync(file);
    process.stdout.write(`removed ${name}\n`);
    return;
  }
  if (command === 'set' && name) {
    const value = await readHidden(`${name}: `);
    if (!value) throw new Error('nothing entered');
    process.stdout.write(`stored in ${storeDpapiSecret(name, value, { dir })}\n`);
    return;
  }
  process.stdout.write(USAGE);
  process.exit(command ? 2 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
