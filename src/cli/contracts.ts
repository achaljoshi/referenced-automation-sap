#!/usr/bin/env node
import * as fs from 'node:fs';
import { captureContract, DEFAULT_CONTRACTS_DIR, diffContracts, formatDiff, loadContract, saveContract, type ScreenContract } from '../gui/contract';
import { connectForCli } from './connect';

const USAGE = `sap-gui-contracts - save the shape of a SAP screen, and notice when it changes

  sap-gui-contracts capture <name> [--root wnd[1]] [--dir ${DEFAULT_CONTRACTS_DIR}]
        Capture the screen SAP is showing NOW and save it as ${DEFAULT_CONTRACTS_DIR}/<name>.contract.json.
        Navigate to the right screen first (SAP_GUI_MODE=attach), review the file and commit it.
  sap-gui-contracts check <name>   [--root wnd[1]] [--dir ${DEFAULT_CONTRACTS_DIR}] [--strict]
        Compare the screen SAP is showing now with the saved contract. Exit 1 if a control is gone or retyped
        (--strict: also if anything was added or a caption changed).
  sap-gui-contracts diff <old.json> <new.json>
        Compare two saved contracts, e.g. the committed one and last night's capture. No SAP needed.

In a test:  await expect(sap).toMatchScreenContract('va01-overview');
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, first, second] = process.argv.slice(2);
  const dir = arg('--dir') ?? DEFAULT_CONTRACTS_DIR;
  const root = arg('--root');

  if (command === 'diff' && first && second) {
    const diff = diffContracts(JSON.parse(fs.readFileSync(first, 'utf8')) as ScreenContract, JSON.parse(fs.readFileSync(second, 'utf8')) as ScreenContract);
    process.stdout.write(`${formatDiff(first, diff)}\n`);
    process.exit(diff.breaking ? 1 : 0);
  }
  if ((command === 'capture' || command === 'check') && first) {
    const connection = await connectForCli();
    try {
      const current = await captureContract(connection.session, first, { root });
      if (command === 'capture') {
        process.stdout.write(`saved ${saveContract(dir, current)} (${current.controls.length} controls${current.context ? `, transaction ${current.context.transaction}, screen ${current.context.screen}` : ''})\n`);
        return;
      }
      const baseline = loadContract(dir, first);
      if (!baseline) throw new Error(`no contract "${first}" in ${dir} - create it with: sap-gui-contracts capture ${first}`);
      const diff = diffContracts(baseline, current);
      const strict = process.argv.includes('--strict');
      const differs = diff.breaking || (strict && (diff.added.length > 0 || diff.textChanged.length > 0));
      process.stdout.write(differs ? `${formatDiff(first, diff)}\n` : `contract "${first}" matches (${current.controls.length} controls)\n`);
      if (differs) process.exit(1);
    } finally {
      await connection.close();
    }
    return;
  }
  process.stdout.write(USAGE);
  process.exit(command ? 2 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
