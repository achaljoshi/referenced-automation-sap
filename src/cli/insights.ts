#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compare, DEFAULT_INSIGHTS_DIR, loadInsights, makeBaseline, markdownReport, timings, type Baseline } from '../insights';

const USAGE = `sap-gui-insights - what your SAP tests covered, how long it took, and whether it got slower

  sap-gui-insights report   [--dir <dir>] [--out <file.md>] [--expected VA01,VA02 | <file>] [--baseline <file>]
  sap-gui-insights baseline [--dir <dir>] [--out sap-baseline.json]
  sap-gui-insights check    [--dir <dir>] [--baseline sap-baseline.json] [--threshold 30] [--min-ms 250] [--min-samples 3]
                            exits 1 if any step kind got slower than the thresholds

Reads the files every SAP test run writes to ${DEFAULT_INSIGHTS_DIR}/ (SAP_GUI_INSIGHTS=off disables).
--expected lists the transactions that SHOULD be covered (a comma list or a file, one per line); the report names those no test touched.
`;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

function expectedList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const text = fs.existsSync(value) ? fs.readFileSync(value, 'utf8') : value;
  return text.split(/[\s,]+/).filter(Boolean);
}

function readBaseline(file: string): Baseline {
  if (!fs.existsSync(file)) throw new Error(`no baseline at ${file} - create one from a good run with: sap-gui-insights baseline`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;
}

function main(): void {
  const command = process.argv[2];
  const dir = arg('--dir', DEFAULT_INSIGHTS_DIR) as string;
  const records = loadInsights(dir);
  if (!['report', 'baseline', 'check'].includes(command ?? '')) {
    process.stdout.write(USAGE);
    process.exit(command ? 2 : 0);
  }
  if (records.length === 0) throw new Error(`no insights found in ${dir} - run the SAP tests first`);

  const options = { thresholdPct: Number(arg('--threshold', '30')), minAbsoluteMs: Number(arg('--min-ms', '250')), minSamples: Number(arg('--min-samples', '3')) };

  if (command === 'baseline') {
    const out = arg('--out', 'sap-baseline.json') as string;
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(makeBaseline(timings(records)), null, 2)}\n`);
    process.stdout.write(`baseline written to ${out} (${timings(records).length} step kinds from ${records.length} test(s))\n`);
    return;
  }

  const baselineFile = arg('--baseline');
  const comparison = baselineFile || command === 'check' ? compare(readBaseline(baselineFile ?? 'sap-baseline.json'), timings(records), options) : undefined;

  if (command === 'report') {
    const text = markdownReport(records, { expected: expectedList(arg('--expected')), comparison });
    const out = arg('--out');
    if (out) {
      fs.writeFileSync(out, text);
      process.stdout.write(`report written to ${out}\n`);
    } else process.stdout.write(`${text}\n`);
    return;
  }

  // check
  const c = comparison as NonNullable<typeof comparison>;
  for (const r of c.regressions) process.stdout.write(`REGRESSION ${r.transaction} ${r.op}: ${r.baselineMs} ms -> ${r.currentMs} ms (+${r.deltaPct}%, ${r.samples} samples)\n`);
  process.stdout.write(`${c.regressions.length} regression(s), ${c.improvements.length} improvement(s), ${c.missing.length} no longer exercised, ${c.added.length} new\n`);
  if (c.regressions.length > 0) process.exit(1);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
