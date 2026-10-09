import { median, percentile } from '../insights/stats';
import { SapGuiTransportError, type SapGuiTransport } from './types';

export type ConformanceStatus = 'pass' | 'fail' | 'skip';

export interface ConformanceResult {
  id: string;
  group: 'protocol' | 'read' | 'errors' | 'write';
  description: string;
  /** The framework cannot work without it (a failure here means this transport is not usable). */
  required: boolean;
  status: ConformanceStatus;
  ms: number;
  detail: string;
}

export interface ConformanceReport {
  results: ConformanceResult[];
  passed: number;
  failed: number;
  skipped: number;
  /** Failures that make the transport unusable. */
  requiredFailed: number;
  latency?: { medianMs: number; p90Ms: number };
}

export interface ConformanceOptions {
  /** Also run the checks that type into SAP (the command field) and read it back. Off by default: nothing is changed. */
  write?: boolean;
}

class Skip extends Error {}

interface Check {
  id: string;
  group: ConformanceResult['group'];
  description: string;
  required: boolean;
  run(t: SapGuiTransport, state: { latency: number[] }): Promise<string | void>;
}

const MAIN = 'wnd[0]';
const COMMAND_FIELD = 'wnd[0]/tbar[0]/okcd';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to fail, but it succeeded');
}

const CHECKS: Check[] = [
  {
    id: 'ping',
    group: 'protocol',
    description: 'the bridge answers ping with "pong"',
    required: true,
    async run(t) {
      assert((await t.request({ op: 'ping' })) === 'pong', 'ping did not answer "pong"');
    },
  },
  {
    id: 'session',
    group: 'protocol',
    description: `there is a SAP session with a main window (${MAIN})`,
    required: true,
    async run(t) {
      assert(
        (await t.request({ op: 'exists', id: MAIN })) === true,
        `${MAIN} does not exist - attach/open did not give a usable session`,
      );
    },
  },
  {
    id: 'busy',
    group: 'protocol',
    description: '`busy` returns true or false (this is how the framework waits for SAP)',
    required: true,
    async run(t) {
      const busy = await t.request({ op: 'busy' });
      assert(typeof busy === 'boolean', `busy returned ${JSON.stringify(busy)}, not a boolean`);
      return `busy=${String(busy)}`;
    },
  },
  {
    id: 'concurrent',
    group: 'protocol',
    description: 'concurrent requests each get their own answer (replies are matched to requests)',
    required: true,
    async run(t) {
      const [a, b, c, d] = await Promise.all([
        t.request({ op: 'ping' }),
        t.request({ op: 'busy' }),
        t.request({ op: 'exists', id: MAIN }),
        t.request({ op: 'exists', id: 'wnd[0]/usr/conformance-no-such-control' }),
      ]);
      assert(
        a === 'pong' && typeof b === 'boolean' && c === true && d === false,
        `answers were mixed up: ${JSON.stringify([a, b, c, d])}`,
      );
    },
  },
  {
    id: 'latency',
    group: 'protocol',
    description: 'round-trip time of a trivial request (informational)',
    required: false,
    async run(t, state) {
      // Up to 20 pings, but a very slow bridge must not make this check itself take a minute: stop after ~3 s (at least 3 samples).
      const began = Date.now();
      for (let i = 0; i < 20; i++) {
        const started = Date.now();
        await t.request({ op: 'ping' });
        state.latency.push(Date.now() - started);
        if (Date.now() - began > 3000 && state.latency.length >= 3) break;
      }
      const med = median(state.latency);
      assert(med < 1000, `median round trip is ${med} ms - every step of every test pays this`);
      return `median ${med} ms, p90 ${percentile(state.latency, 90)} ms over ${state.latency.length} pings`;
    },
  },
  {
    id: 'exists-false',
    group: 'read',
    description: '`exists` is false (not an error) for a control that is not there',
    required: true,
    async run(t) {
      assert(
        (await t.request({ op: 'exists', id: 'wnd[0]/usr/conformance-no-such-control' })) === false,
        'exists should be false for a missing id',
      );
    },
  },
  {
    id: 'info',
    group: 'read',
    description: "`info` gives a control's class, name, text, tooltip and whether it is changeable",
    required: true,
    async run(t) {
      const info = (await t.request({ op: 'info', id: MAIN })) as Record<string, unknown>;
      assert(
        info && typeof info.type === 'string' && info.type !== '',
        `info.type missing: ${JSON.stringify(info)}`,
      );
      assert(
        typeof info.name === 'string' &&
          typeof info.text === 'string' &&
          typeof info.tooltip === 'string' &&
          typeof info.changeable === 'boolean',
        `info has the wrong shape: ${JSON.stringify(info)}`,
      );
      return `${MAIN} is a ${String(info.type)}`;
    },
  },
  {
    id: 'get-text',
    group: 'read',
    description: "`get` reads a property (the main window's text)",
    required: true,
    async run(t) {
      const text = await t.request({ op: 'get', id: MAIN, prop: 'text' });
      assert(typeof text === 'string', `text was ${JSON.stringify(text)}, not a string`);
      return `title: "${text}"`;
    },
  },
  {
    id: 'chain',
    group: 'read',
    description:
      '`get` can step through objects first (children.count) - the chained access recordings use',
    required: true,
    async run(t) {
      const count = await t.request({
        op: 'get',
        id: MAIN,
        prop: 'count',
        via: [{ member: 'children' }],
      });
      assert(
        typeof count === 'number' && count >= 0,
        `children.count was ${JSON.stringify(count)}, not a number`,
      );
      return `${MAIN} has ${String(count)} children`;
    },
  },
  {
    id: 'children',
    group: 'read',
    description: '`children` lists the controls inside a container with their ids',
    required: true,
    async run(t) {
      const kids = (await t.request({ op: 'children', id: MAIN })) as Array<
        Record<string, unknown>
      >;
      assert(Array.isArray(kids) && kids.length > 0, 'the main window has no children');
      assert(
        kids.every(
          (k) =>
            typeof k.id === 'string' &&
            typeof k.type === 'string' &&
            typeof k.name === 'string' &&
            typeof k.text === 'string',
        ),
        `a child has the wrong shape: ${JSON.stringify(kids[0])}`,
      );
      return `${kids.length} children`;
    },
  },
  {
    id: 'find',
    group: 'read',
    description:
      '`find` locates controls by class (the basis of getByLabel / getByTooltip / getByType)',
    required: true,
    async run(t) {
      const ids = (await t.request({
        op: 'find',
        criteria: { root: MAIN, type: 'GuiStatusbar' },
      })) as string[];
      assert(
        Array.isArray(ids) && ids.some((id) => /\/sbar$/.test(id)),
        `no status bar found: ${JSON.stringify(ids)}`,
      );
    },
  },
  {
    id: 'context',
    group: 'read',
    description:
      '`context` reports the system, user, transaction, program and screen (older SAP GUIs may not)',
    required: false,
    async run(t) {
      const ctx = (await t.request({ op: 'context' })) as Record<string, unknown>;
      assert(
        ctx &&
          ['system', 'user', 'transaction', 'program', 'screen'].every(
            (k) => typeof ctx[k] === 'string',
          ),
        `context has the wrong shape: ${JSON.stringify(ctx)}`,
      );
      return `system ${String(ctx.system)}, user ${String(ctx.user)}, transaction "${String(ctx.transaction)}"`;
    },
  },
  {
    id: 'err-not-found',
    group: 'errors',
    description:
      'a missing control is reported with code NOT_FOUND (the framework retries these while a screen changes)',
    required: true,
    async run(t) {
      const error = await rejection(
        t.request({ op: 'get', id: 'wnd[0]/usr/conformance-no-such-control', prop: 'text' }),
      );
      assert(
        error instanceof SapGuiTransportError && error.code === 'NOT_FOUND',
        `expected NOT_FOUND, got ${error instanceof SapGuiTransportError ? error.code : String(error)}: ${(error as Error).message}`,
      );
      const onSet = await rejection(
        t.request({
          op: 'set',
          id: 'wnd[0]/usr/conformance-no-such-control',
          prop: 'text',
          value: 'x',
        }),
      );
      assert(
        onSet instanceof SapGuiTransportError && onSet.code === 'NOT_FOUND',
        `set on a missing control gave ${onSet instanceof SapGuiTransportError ? onSet.code : String(onSet)}, not NOT_FOUND`,
      );
    },
  },
  {
    id: 'err-other',
    group: 'errors',
    description: 'any other failure is an ERROR with a message (it is not retried)',
    required: true,
    async run(t) {
      const error = await rejection(
        t.request({ op: 'get', id: MAIN, prop: 'conformanceNoSuchProperty' }),
      );
      assert(
        error instanceof SapGuiTransportError && error.code === 'ERROR' && error.message.length > 0,
        `expected ERROR with a message, got ${error instanceof SapGuiTransportError ? error.code : String(error)}`,
      );
    },
  },
  {
    id: 'recovers',
    group: 'errors',
    description: 'the bridge still works after errors',
    required: true,
    async run(t) {
      assert(
        (await t.request({ op: 'ping' })) === 'pong' &&
          (await t.request({ op: 'exists', id: MAIN })) === true,
        'the bridge did not recover after the failed requests',
      );
    },
  },
  {
    id: 'write-roundtrip',
    group: 'write',
    description:
      'text typed into the command field comes back unchanged, including non-ASCII (then it is cleared)',
    required: false,
    async run(t) {
      if ((await t.request({ op: 'exists', id: COMMAND_FIELD })) !== true)
        throw new Skip('no command field on this screen (are you on the logon screen?)');
      const probe = 'sap-conformance éü ✓';
      try {
        await t.request({ op: 'set', id: COMMAND_FIELD, prop: 'text', value: probe });
        const back = await t.request({ op: 'get', id: COMMAND_FIELD, prop: 'text' });
        assert(
          back === probe,
          `typed ${JSON.stringify(probe)} but read back ${JSON.stringify(back)}`,
        );
      } finally {
        await t
          .request({ op: 'set', id: COMMAND_FIELD, prop: 'text', value: '' })
          .catch(() => undefined);
      }
    },
  },
];

/**
 * Runs the conformance checks against a transport that already has a SAP session (attached or opened).
 * This is how you decide whether a transport - the PowerShell bridge, the Java/JACOB helper, anything
 * you write - is fit to run the tests on a given machine and SAP release: run it on that machine first.
 * Nothing is changed in SAP unless `write: true`.
 */
export async function runConformance(
  transport: SapGuiTransport,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const state = { latency: [] as number[] };
  const results: ConformanceResult[] = [];
  for (const check of CHECKS) {
    if (check.group === 'write' && !options.write) continue;
    const started = Date.now();
    let status: ConformanceStatus = 'pass';
    let detail = '';
    try {
      detail = (await check.run(transport, state)) ?? '';
    } catch (error) {
      status = error instanceof Skip ? 'skip' : 'fail';
      detail = error instanceof Error ? error.message : String(error);
    }
    results.push({
      id: check.id,
      group: check.group,
      description: check.description,
      required: check.required,
      status,
      ms: Date.now() - started,
      detail,
    });
  }
  return {
    results,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length,
    requiredFailed: results.filter((r) => r.status === 'fail' && r.required).length,
    latency: state.latency.length
      ? { medianMs: median(state.latency), p90Ms: percentile(state.latency, 90) }
      : undefined,
  };
}

export function formatConformance(report: ConformanceReport): string {
  const lines = report.results.map(
    (r) =>
      `  ${r.status === 'pass' ? 'OK  ' : r.status === 'skip' ? 'SKIP' : r.required ? 'FAIL' : 'WARN'}  ${r.group.padEnd(8)} ${r.description}${r.detail ? `\n        ${r.detail}` : ''}`,
  );
  lines.push(
    '',
    `${report.passed} passed, ${report.failed} failed (${report.requiredFailed} required), ${report.skipped} skipped.`,
  );
  lines.push(
    report.requiredFailed === 0
      ? 'This transport conforms: the framework can use it.'
      : 'This transport does NOT conform: fix the required failures above before running tests with it.',
  );
  return lines.join('\n');
}
