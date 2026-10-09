import type { TimingStat } from './aggregate';

export interface Baseline {
  version: 1;
  createdAt: string;
  entries: TimingStat[];
}

export interface CompareOptions {
  /** A step kind is a regression if its median is this much slower than the baseline's. Default 30. */
  thresholdPct?: number;
  /** ... AND slower by at least this many ms (so 40 ms -> 60 ms is not "50% slower"). Default 250. */
  minAbsoluteMs?: number;
  /** Ignore step kinds with fewer samples than this, in either run - one measurement is noise. Default 3. */
  minSamples?: number;
}

export interface Change {
  key: string;
  transaction: string;
  op: string;
  baselineMs: number;
  currentMs: number;
  deltaMs: number;
  deltaPct: number;
  samples: number;
}

export interface Comparison {
  regressions: Change[];
  improvements: Change[];
  /** In this run but not in the baseline. */
  added: string[];
  /** In the baseline but not in this run - a transaction that stopped being exercised. */
  missing: string[];
  skippedForSamples: number;
}

export function makeBaseline(entries: TimingStat[], now = new Date()): Baseline {
  return { version: 1, createdAt: now.toISOString(), entries };
}

/**
 * Compares this run's step timings with a stored baseline. Deliberately
 * conservative - SAP response times are noisy - so a change must be large in
 * percentage AND in milliseconds, and backed by enough samples, to be called a
 * regression. It tells you where to look; it is not a performance test.
 */
export function compare(baseline: Baseline, current: TimingStat[], options: CompareOptions = {}): Comparison {
  const { thresholdPct = 30, minAbsoluteMs = 250, minSamples = 3 } = options;
  const before = new Map(baseline.entries.map((e) => [e.key, e]));
  const now = new Map(current.map((e) => [e.key, e]));
  const result: Comparison = { regressions: [], improvements: [], added: [], missing: [], skippedForSamples: 0 };

  for (const [key, cur] of now) {
    const base = before.get(key);
    if (!base) {
      result.added.push(key);
      continue;
    }
    if (cur.count < minSamples || base.count < minSamples) {
      result.skippedForSamples++;
      continue;
    }
    const deltaMs = cur.medianMs - base.medianMs;
    const deltaPct = base.medianMs === 0 ? (deltaMs === 0 ? 0 : 100) : (deltaMs / base.medianMs) * 100;
    const change: Change = { key, transaction: cur.transaction, op: cur.op, baselineMs: base.medianMs, currentMs: cur.medianMs, deltaMs, deltaPct: Math.round(deltaPct), samples: cur.count };
    if (deltaMs >= minAbsoluteMs && deltaPct >= thresholdPct) result.regressions.push(change);
    else if (-deltaMs >= minAbsoluteMs && -deltaPct >= thresholdPct) result.improvements.push(change);
  }
  for (const key of before.keys()) if (!now.has(key)) result.missing.push(key);
  result.regressions.sort((a, b) => b.deltaMs - a.deltaMs);
  result.improvements.sort((a, b) => a.deltaMs - b.deltaMs);
  return result;
}
