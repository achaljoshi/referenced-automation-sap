#!/usr/bin/env node
import * as fs from 'node:fs';
import { DEFAULT_DATA_DIR, formatCreated, loadCreated, orphans } from '../gui/data';

const USAGE = `sap-gui-data - what the SAP tests created, and what is still lying around

  sap-gui-data list      [--dir <dir>] [--json] [--fail-on-orphans] [--require-data]
                         everything created, with its cleanup status
  sap-gui-data orphans   [--dir <dir>] [--json] [--require-data]
                         objects whose cleanup failed or was never registered (exit 1 if any)

  --fail-on-orphans      exit 1 when there are orphans (always the case for 'orphans'; this makes 'list' a gate too)
  --require-data         exit 2 when there is no data directory at all - a pipeline that expected SAP tests to have run
                         must not pass just because nothing was recorded

Exit codes: 0 nothing to clean, 1 orphans found, 2 usage error or unreadable/damaged data.
Reads ${DEFAULT_DATA_DIR}/ - written by the 'sapData' fixture (SAP_GUI_CLEANUP=off keeps everything).
`;

const command = process.argv[2];
const dirIndex = process.argv.indexOf('--dir');
const dir = dirIndex !== -1 ? (process.argv[dirIndex + 1] as string) : DEFAULT_DATA_DIR;
const json = process.argv.includes('--json');
const failOnOrphans = process.argv.includes('--fail-on-orphans') || command === 'orphans';
const requireData = process.argv.includes('--require-data');

if (command !== 'list' && command !== 'orphans') {
  process.stdout.write(USAGE);
  process.exit(command ? 2 : 0);
}
if (dirIndex !== -1 && !dir) {
  process.stderr.write(`--dir needs a folder\n\n${USAGE}`);
  process.exit(2);
}
if (requireData && !fs.existsSync(dir)) {
  process.stderr.write(`no created-data directory at ${dir} - did the SAP tests run? (--require-data)\n`);
  process.exit(2);
}
let all;
try {
  all = loadCreated(dir);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(2);
}
const objects = command === 'list' ? all : orphans(all);
process.stdout.write(json ? `${JSON.stringify(objects, null, 2)}\n` : `${formatCreated(objects)}\n`);
const remaining = command === 'list' ? orphans(all) : objects;
if (failOnOrphans && remaining.length > 0) {
  process.stderr.write(`${remaining.length} object(s) need cleaning by hand\n`);
  process.exit(1);
}
