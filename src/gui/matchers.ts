import { expect as baseExpect, type ExpectMatcherState } from '@playwright/test';
import {
  captureContract,
  DEFAULT_CONTRACTS_DIR,
  diffContracts,
  formatDiff,
  loadContract,
  saveContract,
  type CaptureOptions,
} from './contract';
import type { SapLocator } from './locator';
import type { SapGuiSession } from './session';

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_MS = 100;

/** Options every SAP assertion accepts. */
export interface SapAssertionOptions {
  /** How long to keep re-checking before the assertion fails. Default 5000 ms. */
  timeout?: number;
}

interface Reading {
  /** Does the condition hold right now? */
  ok: boolean;
  /** What was found, for the failure message. */
  actual: string;
}

/**
 * Re-checks `read` until the assertion can pass (or, for `.not`, until the
 * opposite holds), the way Playwright's own web-first assertions do - SAP
 * screens change after a server round trip, so a one-shot read right after an
 * action is a race. Returns the last reading.
 */
async function until(
  isNot: boolean,
  timeout: number | undefined,
  read: () => Promise<Reading>,
): Promise<Reading> {
  const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT_MS);
  let last = await read();
  while (last.ok === isNot && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    last = await read();
  }
  return last;
}

function matches(actual: string, expected: string | RegExp, mode: 'equal' | 'contain'): boolean {
  if (typeof expected !== 'string') return expected.test(actual);
  return mode === 'equal'
    ? actual.trim() === expected.trim()
    : actual.toLowerCase().includes(expected.toLowerCase());
}

function result(
  state: ExpectMatcherState,
  name: string,
  reading: Reading,
  expected: unknown,
  subject: string,
) {
  const pass = reading.ok;
  return {
    name,
    pass,
    expected,
    actual: reading.actual,
    message: () =>
      `${state.utils.matcherHint(name, subject, '', { isNot: state.isNot })}\n\n` +
      `Expected${state.isNot ? ' not' : ''}: ${state.utils.printExpected(expected)}\n` +
      `Received: ${state.utils.printReceived(reading.actual)}`,
  };
}

/**
 * `expect` with SAP assertions that wait and retry:
 *
 *   await expect(sap.getByLabel('Order Number')).toHaveText('4711');
 *   await expect(sap.getByTooltip('Save')).toBeEditable();
 *   await expect(sap.locator('wnd[1]')).toExist();
 *   await expect(sap).toHaveStatusMessage(/has been saved/i, { type: 'S' });
 *   await expect(sap).toHaveTitle(/Create Standard Order/);
 *
 * Everything from Playwright's `expect` (`expect.soft`, `.not`, `toBe`, ...) works as usual.
 */
export const expect = baseExpect.extend({
  async toHaveText(
    this: ExpectMatcherState,
    locator: SapLocator,
    expected: string | RegExp,
    options: SapAssertionOptions = {},
  ) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const snap = await locator.snapshot();
      return {
        ok: snap ? matches(snap.info.text, expected, 'equal') : false,
        actual: snap ? snap.info.text : '(control not on the screen)',
      };
    });
    return result(this, 'toHaveText', reading, expected, String(locator));
  },

  async toContainText(
    this: ExpectMatcherState,
    locator: SapLocator,
    expected: string | RegExp,
    options: SapAssertionOptions = {},
  ) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const snap = await locator.snapshot();
      return {
        ok: snap ? matches(snap.info.text, expected, 'contain') : false,
        actual: snap ? snap.info.text : '(control not on the screen)',
      };
    });
    return result(this, 'toContainText', reading, expected, String(locator));
  },

  async toExist(this: ExpectMatcherState, locator: SapLocator, options: SapAssertionOptions = {}) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const found = (await locator.count()) > 0;
      return { ok: found, actual: found ? 'on the screen' : 'not on the screen' };
    });
    return result(this, 'toExist', reading, 'on the screen', String(locator));
  },

  async toBeEditable(
    this: ExpectMatcherState,
    locator: SapLocator,
    options: SapAssertionOptions = {},
  ) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const snap = await locator.snapshot();
      return {
        ok: snap?.info.changeable === true,
        actual: snap
          ? snap.info.changeable
            ? 'editable'
            : 'read-only'
          : '(control not on the screen)',
      };
    });
    return result(this, 'toBeEditable', reading, 'editable', String(locator));
  },

  async toBeChecked(
    this: ExpectMatcherState,
    locator: SapLocator,
    options: SapAssertionOptions = {},
  ) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const snap = await locator.snapshot();
      if (!snap) return { ok: false, actual: '(control not on the screen)' };
      const selected = (await locator.get('selected').catch(() => false)) === true;
      return { ok: selected, actual: selected ? 'checked' : 'not checked' };
    });
    return result(this, 'toBeChecked', reading, 'checked', String(locator));
  },

  async toHaveStatusMessage(
    this: ExpectMatcherState,
    sap: SapGuiSession,
    expected: string | RegExp,
    options: SapAssertionOptions & { type?: 'S' | 'E' | 'W' | 'I' | 'A' } = {},
  ) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const bar = await sap.statusBar();
      const textOk = matches(bar.text, expected, 'contain');
      const typeOk = options.type === undefined || bar.type === options.type;
      return {
        ok: textOk && typeOk,
        actual: `${bar.type ? `[${bar.type}] ` : ''}${bar.text || '(empty)'}`,
      };
    });
    return result(
      this,
      'toHaveStatusMessage',
      reading,
      options.type ? `[${options.type}] ${String(expected)}` : expected,
      'sap',
    );
  },

  async toHaveTitle(
    this: ExpectMatcherState,
    sap: SapGuiSession,
    expected: string | RegExp,
    options: SapAssertionOptions = {},
  ) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const title = String((await sap.peekProp('wnd[0]', 'text')) ?? '');
      return { ok: matches(title, expected, 'contain'), actual: title || '(no title)' };
    });
    return result(this, 'toHaveTitle', reading, expected, 'sap');
  },

  /**
   * Compares the screen SAP is showing with a committed baseline (contracts/<name>.contract.json).
   * Fails if a control the baseline has is gone or changed type; new controls and changed captions
   * only fail with `strict: true`. With SAP_GUI_UPDATE_CONTRACTS=true (or `update: true`) it writes the
   * baseline instead of comparing - review and commit the file like any other code change.
   */
  async toMatchScreenContract(
    this: ExpectMatcherState,
    sap: SapGuiSession,
    name: string,
    options: CaptureOptions & { dir?: string; strict?: boolean; update?: boolean } = {},
  ) {
    const dir = options.dir ?? process.env.SAP_GUI_CONTRACTS_DIR ?? DEFAULT_CONTRACTS_DIR;
    const current = await captureContract(sap, name, options);
    const update = options.update ?? process.env.SAP_GUI_UPDATE_CONTRACTS === 'true';
    const baseline = loadContract(dir, name);

    if (update || !baseline) {
      if (!update) {
        return {
          name: 'toMatchScreenContract',
          pass: false,
          message: () =>
            `There is no screen contract "${name}" in ${dir}. Create it from the correct screen with SAP_GUI_UPDATE_CONTRACTS=true, review it and commit it.`,
        };
      }
      const file = saveContract(dir, current);
      return {
        name: 'toMatchScreenContract',
        pass: true,
        message: () =>
          `Screen contract "${name}" written to ${file} (${current.controls.length} controls).`,
      };
    }

    const diff = diffContracts(baseline, current);
    const differs =
      diff.breaking ||
      (options.strict === true && (diff.added.length > 0 || diff.textChanged.length > 0));
    return {
      name: 'toMatchScreenContract',
      pass: !differs,
      message: () =>
        differs
          ? formatDiff(name, diff)
          : `Screen contract "${name}" matched, but .not was asserted.`,
    };
  },
});
