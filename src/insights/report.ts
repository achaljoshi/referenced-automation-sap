import { coverage, timings, uncovered } from './aggregate';
import type { Comparison } from './baseline';
import type { TestInsight } from './model';

export interface ReportOptions {
  expected?: string[];
  comparison?: Comparison;
}

/** A Markdown summary: coverage by transaction, slowest steps, regressions, uncovered transactions. */
export function markdownReport(records: TestInsight[], options: ReportOptions = {}): string {
  const lines: string[] = ['# SAP GUI run insights', ''];
  const tests = records.length;
  const failed = records.filter((r) => r.status !== 'passed' && r.status !== 'skipped').length;
  const systems = [...new Set(records.map((r) => (r.system ? `${r.system}/${r.client ?? ''}` : '')).filter(Boolean))];
  lines.push(`${tests} test(s) touched SAP${failed ? `, ${failed} not passed` : ''}${systems.length ? `. System: ${systems.join(', ')}` : ''}.`, '');

  const cov = coverage(records);
  lines.push('## Transactions covered', '', '| Transaction | Tests | Steps | Failed steps | Client time | SAP server time |', '|---|---|---|---|---|---|');
  for (const c of cov) lines.push(`| ${c.transaction} | ${c.tests.length} | ${c.steps} | ${c.failedSteps} | ${c.totalMs} ms | ${c.totalServerMs ? `${c.totalServerMs} ms` : '-'} |`);
  lines.push('');

  if (options.expected) {
    const missing = uncovered(records, options.expected);
    lines.push('## Expected transactions', '', missing.length === 0 ? `All ${options.expected.length} expected transaction(s) were exercised.` : `**Not exercised (${missing.length} of ${options.expected.length}):** ${missing.join(', ')}`, '');
  }

  const drift = records.flatMap((r) => (r.drift ?? []).map((d) => ({ ...d, test: r.test })));
  if (drift.length > 0) {
    lines.push('## Locator drift', '', 'These controls were found by a fallback because their usual id is gone - update the page objects:', '', '| Expected id | Found at | Transaction | Test |', '|---|---|---|---|');
    for (const d of drift) lines.push(`| ${d.expected} | ${d.foundId} | ${d.tx ?? '-'} | ${d.test} |`);
    lines.push('');
  }

  const stats = timings(records);
  const slowest = [...stats].sort((a, b) => b.medianMs - a.medianMs).slice(0, 10);
  lines.push('## Slowest steps (median)', '', '| Transaction | Step | Samples | Median | p90 | Max | SAP server median |', '|---|---|---|---|---|---|---|');
  for (const s of slowest) lines.push(`| ${s.transaction} | ${s.op} | ${s.count} | ${s.medianMs} ms | ${s.p90Ms} ms | ${s.maxMs} ms | ${s.medianServerMs !== undefined ? `${s.medianServerMs} ms` : '-'} |`);
  lines.push('');

  const cmp = options.comparison;
  if (cmp) {
    lines.push('## Against the baseline', '');
    if (cmp.regressions.length === 0) lines.push('No regressions beyond the thresholds.', '');
    else {
      lines.push(`**${cmp.regressions.length} regression(s):**`, '', '| Transaction | Step | Baseline | Now | Change | Samples |', '|---|---|---|---|---|---|');
      for (const r of cmp.regressions) lines.push(`| ${r.transaction} | ${r.op} | ${r.baselineMs} ms | ${r.currentMs} ms | +${r.deltaMs} ms (+${r.deltaPct}%) | ${r.samples} |`);
      lines.push('');
    }
    if (cmp.improvements.length) lines.push(`${cmp.improvements.length} improvement(s): ${cmp.improvements.map((i) => `${i.transaction} ${i.op} ${i.deltaPct}%`).join(', ')}`, '');
    if (cmp.missing.length) lines.push(`No longer exercised: ${cmp.missing.join(', ')}`, '');
    if (cmp.added.length) lines.push(`New since the baseline: ${cmp.added.join(', ')}`, '');
    if (cmp.skippedForSamples) lines.push(`${cmp.skippedForSamples} step kind(s) skipped for too few samples.`, '');
  }
  lines.push('_Timings are measured by the test client and, where SAP reports it, by SAP itself. They indicate where to look; they are not a load test._', '');
  return lines.join('\n');
}
