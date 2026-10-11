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
 *   BRIDGE_CLOSE_STDIN=1          after saying ready, close the read end of stdin but stay alive -> the next write is EPIPE
 *   BRIDGE_RESPONSE_LAG_MS=200    the simulated SAP answers a screen-changing action 200 ms late (Busy=false and the old screen
 *                                 meanwhile) - the window in which "Busy twice" wrongly looks idle
 *   BRIDGE_NO_ROUNDTRIPS=1        report no RoundTrips counter (an older SAP GUI)
 *   BRIDGE_NOT_FOUND_TEXT=...     the text of the "control not found" error (SAP GUI localises it); the code stays NOT_FOUND
 *   BRIDGE_SESSION_LOST_OP=busy   answer that op with code SESSION_LOST (dead COM connection)
 */
const readline = require('node:readline');
const path = require('node:path');
const { createSampleSapSystem } = require(path.resolve(__dirname, '../../../dist/gui/fakeSapGui'));

const fake = createSampleSapSystem({
  transitionDelayMs: 0,
  responseLagMs: Number(process.env.BRIDGE_RESPONSE_LAG_MS || 0),
  reportRoundTrips: !process.env.BRIDGE_NO_ROUNDTRIPS,
  notFoundMessage: process.env.BRIDGE_NOT_FOUND_TEXT || undefined,
});
const table = (name) => Object.fromEntries((process.env[name] || '').split(',').filter(Boolean).map((p) => p.split(':')));
const delays = table('BRIDGE_DELAY_OPS');
const hang = new Set((process.env.BRIDGE_HANG_OPS || '').split(',').filter(Boolean));
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (process.env.BRIDGE_JUNK) process.stdout.write('this is not json\n');
if (!process.env.BRIDGE_NO_READY) send({ rid: 0, ok: true, value: 'ready' });
if (process.env.BRIDGE_CLOSE_STDIN) {
  setInterval(() => undefined, 1000); // stay alive without reading
  process.stdin.destroy();
  try {
    require('node:fs').closeSync(0); // really close the read end, so the parent's next write fails with EPIPE
  } catch {
    // already closed
  }
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (line.trim().length === 0) return; // like the PowerShell bridge: a blank line is ignored (the remote transport sends one to read the ready line)
  const { rid, ...command } = JSON.parse(line);
  if (process.env.BRIDGE_CRASH_OP === command.op) {
    process.stderr.write(`stand-in bridge crashed on ${command.op}\n`);
    process.exit(3);
  }
  if (hang.has(command.op)) return;
  if (process.env.BRIDGE_SESSION_LOST_OP === command.op) {
    send({ rid, ok: false, error: 'The RPC server is unavailable.', code: 'SESSION_LOST' });
    return;
  }
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
