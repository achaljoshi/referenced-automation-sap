#!/usr/bin/env node
// Runs the sample SAP GUI tests against the built-in fake SAP (no SAP, any OS).
// A script rather than `SAP_GUI_SIMULATOR=true playwright ...` in package.json,
// because that inline form does not work in Windows cmd.exe.
const { spawnSync } = require('node:child_process');

const result = spawnSync('npx', ['playwright', 'test', 'tests/sapgui', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, ENV: 'simulator' },
});
process.exit(result.status ?? 1);
