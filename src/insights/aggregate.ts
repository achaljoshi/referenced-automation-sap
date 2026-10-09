import { median, percentile } from './stats';
import { opOf, type TestInsight } from './model';

export interface TransactionCoverage {
  transaction: string;
  tests: string[];
  steps: number;
  failedSteps: number;
  totalMs: number;
  totalServerMs: number;
}

export interface TimingStat {
  key: string;
  transaction: string;
  op: string;
  count: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
  /** SAP's own response time for the round trip, when it was reported for these steps. */
  medianServerMs?: number;
}

const EXCLUDED_OPS = new Set(['home', 'logoff', 'screenshot']);

/** Which transactions the suite touched, by which tests, and how much time each took. */
export function coverage(records: TestInsight[]): TransactionCoverage[] {
  const map = new Map<string, TransactionCoverage>();
  for (const record of records) {
    for (const step of record.steps) {
      const transaction = step.tx || '(none)';
      const entry = map.get(transaction) ?? { transaction, tests: [], steps: 0, failedSteps: 0, totalMs: 0, totalServerMs: 0 };
      if (!entry.tests.includes(record.test)) entry.tests.push(record.test);
      entry.steps++;
      if (!step.ok) entry.failedSteps++;
      entry.totalMs += step.ms;
      entry.totalServerMs += step.serverMs ?? 0;
      map.set(transaction, entry);
    }
  }
  return [...map.values()].sort((a, b) => a.transaction.localeCompare(b.transaction));
}

/** Median / p90 / max duration of each kind of step within each transaction. Failed steps are excluded: a timeout is not a timing. */
export function timings(records: TestInsight[]): TimingStat[] {
  const groups = new Map<string, { transaction: string; op: string; ms: number[]; server: number[] }>();
  for (const record of records) {
    for (const step of record.steps) {
      const op = opOf(step.label);
      if (!step.ok || EXCLUDED_OPS.has(op)) continue;
      const transaction = step.tx || '(none)';
      const key = `${transaction}|${op}`;
      const group = groups.get(key) ?? { transaction, op, ms: [], server: [] };
      group.ms.push(step.ms);
      if (step.serverMs !== undefined) group.server.push(step.serverMs);
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .map(([key, g]): TimingStat => ({
      key,
      transaction: g.transaction,
      op: g.op,
      count: g.ms.length,
      medianMs: Math.round(median(g.ms)),
      p90Ms: Math.round(percentile(g.ms, 90)),
      maxMs: Math.max(...g.ms),
      ...(g.server.length > 0 ? { medianServerMs: Math.round(median(g.server)) } : {}),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Transactions you said should be covered, that no test touched. */
export function uncovered(records: TestInsight[], expected: string[]): string[] {
  const seen = new Set(coverage(records).map((c) => c.transaction.toUpperCase()));
  return expected.map((e) => e.trim().toUpperCase()).filter((e) => e && !seen.has(e));
}
