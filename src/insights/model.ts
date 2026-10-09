import * as fs from 'node:fs';
import * as path from 'node:path';

/** One step of one test, as written to the insights file. */
export interface StepRecord {
  tx: string;
  program?: string;
  screen?: string;
  label: string;
  ms: number;
  serverMs?: number;
  ok: boolean;
}

/** What one test did in SAP. */
export interface TestInsight {
  test: string;
  status: string;
  durationMs: number;
  system?: string;
  client?: string;
  user?: string;
  steps: StepRecord[];
}

export const DEFAULT_INSIGHTS_DIR = 'test-results/sap-insights';

/** Appends one test's record to a per-process file (workers never write to the same file). */
export function appendInsight(record: TestInsight, dir = DEFAULT_INSIGHTS_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `insights-${process.pid}.jsonl`), `${JSON.stringify(record)}\n`);
}

export function loadInsights(dir = DEFAULT_INSIGHTS_DIR): TestInsight[] {
  if (!fs.existsSync(dir)) return [];
  const records: TestInsight[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (line.trim()) records.push(JSON.parse(line) as TestInsight);
    }
  }
  return records;
}

/** The kind of a step: "press", "set", "get", "startTransaction", "sendVKey" ... - the control id and arguments dropped. */
export function opOf(label: string): string {
  return label.split(' ')[0] ?? label;
}
