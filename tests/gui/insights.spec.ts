import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { appendInsight, compare, coverage, loadInsights, makeBaseline, markdownReport, median, percentile, timings, uncovered, type StepRecord, type TestInsight } from '../../src';

const cli = path.resolve(__dirname, '../../dist/cli/insights.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sapinsights-'));

const step = (tx: string, label: string, ms: number, extra: Partial<StepRecord> = {}): StepRecord => ({ tx, label, ms, ok: true, ...extra });
const insight = (test: string, steps: StepRecord[], status = 'passed'): TestInsight => ({ test, status, durationMs: 1000, system: 'QA1', client: '100', steps });
/** n tests that each press once in VA01 for `ms`. */
const runOf = (n: number, ms: number): TestInsight[] => Array.from({ length: n }, (_, i) => insight(`t${i}`, [step('VA01', 'press', ms)]));

test.describe('statistics', () => {
  test('median and nearest-rank percentile', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 90)).toBe(5);
  });
});

test.describe('coverage and timings', () => {
  const records = [
    insight('create order', [step('VA01', 'startTransaction', 800, { serverMs: 600 }), step('VA01', 'set', 20), step('VA01', 'press', 1200, { serverMs: 900 })]),
    insight('display order', [step('VA03', 'startTransaction', 500), step('VA01', 'press', 1000)]),
    insight('broken', [step('MM01', 'press', 5000, { ok: false })], 'failed'),
  ];

  test('lists transactions with the tests that touched them and the failures in them', () => {
    const cov = coverage(records);
    expect(cov.map((c) => c.transaction)).toEqual(['MM01', 'VA01', 'VA03']);
    expect(cov.find((c) => c.transaction === 'VA01')).toMatchObject({ tests: ['create order', 'display order'], steps: 4, failedSteps: 0, totalServerMs: 1500 });
    expect(cov.find((c) => c.transaction === 'MM01')).toMatchObject({ failedSteps: 1 });
  });

  test('timings are per transaction and kind of step; a failed step is not a timing', () => {
    const stats = timings(records);
    expect(stats.find((s) => s.key === 'VA01|press')).toMatchObject({ count: 2, medianMs: 1100, maxMs: 1200, medianServerMs: 900 });
    expect(stats.some((s) => s.transaction === 'MM01')).toBe(false); // its only step failed
  });

  test('house-keeping steps are not timings', () => {
    expect(timings([insight('x', [step('VA01', 'home', 100), step('VA01', 'logoff', 100)])])).toEqual([]);
  });

  test('uncovered: names the expected transactions nobody touched (case-insensitive)', () => {
    expect(uncovered(records, ['va01', 'VA02', ' MM01 ', 'FB60'])).toEqual(['VA02', 'FB60']);
  });
});

test.describe('baseline comparison is conservative, so it can be trusted', () => {
  const base = makeBaseline(timings(runOf(5, 1000)));

  test('flags a step kind that is much slower in percentage AND milliseconds', () => {
    const result = compare(base, timings(runOf(5, 1600)));
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatchObject({ transaction: 'VA01', op: 'press', baselineMs: 1000, currentMs: 1600, deltaMs: 600, deltaPct: 60 });
  });

  test('negative control: the same run against itself has nothing to report', () => {
    const result = compare(base, timings(runOf(5, 1000)));
    expect(result).toMatchObject({ regressions: [], improvements: [], added: [], missing: [] });
  });

  test('a big percentage of a tiny time is not a regression (40 ms -> 80 ms)', () => {
    const small = makeBaseline(timings(runOf(5, 40)));
    expect(compare(small, timings(runOf(5, 80))).regressions).toEqual([]);
  });

  test('a big absolute change that is a small percentage is not a regression (10 s -> 10.4 s)', () => {
    const slow = makeBaseline(timings(runOf(5, 10_000)));
    expect(compare(slow, timings(runOf(5, 10_400))).regressions).toEqual([]);
  });

  test('too few samples are noise, not a finding', () => {
    const result = compare(base, timings(runOf(2, 5000)));
    expect(result.regressions).toEqual([]);
    expect(result.skippedForSamples).toBe(1);
  });

  test('thresholds are adjustable', () => {
    expect(compare(base, timings(runOf(5, 1200)), { thresholdPct: 10, minAbsoluteMs: 100 }).regressions).toHaveLength(1);
    expect(compare(base, timings(runOf(5, 1200))).regressions).toHaveLength(0);
  });

  test('reports improvements, steps no longer exercised and new ones', () => {
    const current = timings([...runOf(5, 400), ...Array.from({ length: 5 }, (_, i) => insight(`n${i}`, [step('VA02', 'press', 700)]))]);
    const result = compare(base, current);
    expect(result.improvements.map((c) => c.key)).toEqual(['VA01|press']);
    expect(result.added).toEqual(['VA02|press']);
    const gone = compare(base, timings(runOf(5, 1000).map((r) => ({ ...r, steps: [step('VA03', 'press', 1000)] }))));
    expect(gone.missing).toEqual(['VA01|press']);
  });
});

test.describe('report', () => {
  test('summarises coverage, expected transactions, slowest steps and regressions in Markdown', () => {
    const records = runOf(5, 1600);
    const comparison = compare(makeBaseline(timings(runOf(5, 1000))), timings(records));
    const md = markdownReport(records, { expected: ['VA01', 'VA02'], comparison });
    expect(md).toContain('## Transactions covered');
    expect(md).toMatch(/\| VA01 \| 5 \| 5 \| 0 \|/);
    expect(md).toContain('**Not exercised (1 of 2):** VA02');
    expect(md).toContain('## Slowest steps');
    expect(md).toMatch(/\*\*1 regression\(s\):\*\*[\s\S]*\+600 ms \(\+60%\)/);
    expect(md).toContain('System: QA1/100');
  });
});

test.describe('files and CLI', () => {
  test('records written by workers are read back together', () => {
    const dir = tmp();
    appendInsight(insight('a', [step('VA01', 'press', 1)]), dir);
    appendInsight(insight('b', [step('VA03', 'press', 1)]), dir);
    expect(loadInsights(dir).map((r) => r.test)).toEqual(['a', 'b']);
    expect(loadInsights(path.join(dir, 'missing'))).toEqual([]);
  });

  const run = (args: string[]) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  test('baseline, then check: exit 0 when unchanged, exit 1 and a named regression when slower', () => {
    const good = tmp();
    const slow = tmp();
    const baselineFile = path.join(tmp(), 'baseline.json');
    for (const r of runOf(5, 1000)) appendInsight(r, good);
    for (const r of runOf(5, 2000)) appendInsight(r, slow);

    expect(run(['baseline', '--dir', good, '--out', baselineFile]).status).toBe(0);
    expect(run(['check', '--dir', good, '--baseline', baselineFile]).status).toBe(0);

    const bad = run(['check', '--dir', slow, '--baseline', baselineFile]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('REGRESSION VA01 press: 1000 ms -> 2000 ms (+100%, 5 samples)');
  });

  test('report writes a file and names uncovered transactions', () => {
    const dir = tmp();
    for (const r of runOf(3, 500)) appendInsight(r, dir);
    const out = path.join(tmp(), 'insights.md');
    expect(run(['report', '--dir', dir, '--out', out, '--expected', 'VA01,FB60']).status).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toContain('**Not exercised (1 of 2):** FB60');
  });

  test('clear errors: no data, no baseline, unknown command', () => {
    expect(run(['report', '--dir', path.join(tmp(), 'nothing')]).stderr).toMatch(/no insights found/);
    const dir = tmp();
    for (const r of runOf(3, 500)) appendInsight(r, dir);
    expect(run(['check', '--dir', dir, '--baseline', '/nonexistent/b.json']).stderr).toMatch(/no baseline at/);
    expect(run(['wat']).status).toBe(2);
  });
});
