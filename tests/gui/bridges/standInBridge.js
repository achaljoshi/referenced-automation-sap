#!/usr/bin/env node
/**
 * A stand-in for the PowerShell / Java bridge: speaks the same line protocol on stdin/stdout, backed by the
 * in-memory simulator. It lets the TypeScript side of the protocol (ProcessTransport) and the conformance
 * suite run for real on any machine. Fault injection through the environment:
 *
 *   BRIDGE_JUNK=1                 print a non-JSON line before the ready message
 *   BRIDGE_NO_READY=1             never say ready
 *   BRIDGE_DELAY_OPS=ping:300     answer `ping` 300 ms late (others immediately) -> out-of-order replies
 *   BRIDGE_HANG_OPS=busy          never answer `busy`
 *   BRIDGE_CRASH_OP=exists        write to stderr and exit(3) when `exists` arrives
 */
const readline = require('node:readline');
const path = require('node:path');
const { createSampleSapSystem } = require(path.resolve(__dirname, '../../../dist/gui/fakeSapGui'));

const fake = createSampleSapSystem({ transitionDelayMs: 0 });
const table = (name) => Object.fromEntries((process.env[name] || '').split(',').filter(Boolean).map((p) => p.split(':')));
const delays = table('BRIDGE_DELAY_OPS');
const hang = new Set((process.env.BRIDGE_HANG_OPS || '').split(',').filter(Boolean));
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (process.env.BRIDGE_JUNK) process.stdout.write('this is not json\n');
if (!process.env.BRIDGE_NO_READY) send({ rid: 0, ok: true, value: 'ready' });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const { rid, ...command } = JSON.parse(line);
  if (process.env.BRIDGE_CRASH_OP === command.op) {
    process.stderr.write(`stand-in bridge crashed on ${command.op}\n`);
    process.exit(3);
  }
  if (hang.has(command.op)) return;
  const reply = async () => {
    try {
      const value = await fake.request(command);
      send({ rid, ok: true, value: value === undefined ? null : value });
    } catch (error) {
      send({ rid, ok: false, error: error.message, code: error.code });
    }
    if (command.op === 'quit') process.exit(0);
  };
  if (delays[command.op]) setTimeout(reply, Number(delays[command.op]));
  else reply();
});
