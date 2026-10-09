#!/usr/bin/env node
import { DEFAULT_DATA_DIR, formatCreated, loadCreated, orphans } from '../gui/data';

const USAGE = `sap-gui-data - what the SAP tests created, and what is still lying around

  sap-gui-data list      [--dir <dir>] [--json]    everything created, with its cleanup status
  sap-gui-data orphans   [--dir <dir>] [--json]    objects whose cleanup failed or was never registered (exit 1 if any)

Reads ${DEFAULT_DATA_DIR}/ - written by the 'sapData' fixture (SAP_GUI_CLEANUP=off keeps everything).
`;

const command = process.argv[2];
const dirIndex = process.argv.indexOf('--dir');
const dir = dirIndex !== -1 ? (process.argv[dirIndex + 1] as string) : DEFAULT_DATA_DIR;
const json = process.argv.includes('--json');

if (command !== 'list' && command !== 'orphans') {
  process.stdout.write(USAGE);
  process.exit(command ? 2 : 0);
}
const objects = command === 'list' ? loadCreated(dir) : orphans(loadCreated(dir));
process.stdout.write(json ? `${JSON.stringify(objects, null, 2)}\n` : `${formatCreated(objects)}\n`);
if (command === 'orphans' && objects.length > 0) {
  process.stderr.write(`${objects.length} object(s) need cleaning by hand\n`);
  process.exit(1);
}
