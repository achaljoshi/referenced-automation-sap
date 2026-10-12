import { loadEnv } from '@automation/referenced-automation-utils';
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
  /** The control itself was not on the screen: the failure message then says what is. */
  missing?: boolean;
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

function isCi(): boolean {
  const ci = process.env.CI;
  return ci !== undefined && ci !== '' && !/^(0|false)$/i.test(ci);
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
  screen = '',
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
      `Received: ${state.utils.printReceived(reading.actual)}` +
      (screen ? `\n\n${screen}` : ''),
  };
}

/**
 * The result of an assertion on a locator. When it failed because the control is not on the screen, the message says what is
 * (title, status bar, labels / buttons / tabs with their ids, the closest matches, a pop-up in front) - "expected on the screen,
 * received not on the screen" alone leaves a person to open SAP and look.
 */
async function resultFor(
  state: ExpectMatcherState,
  name: string,
  reading: Reading,
  expected: unknown,
  locator: SapLocator,
) {
  const screen = !reading.ok && !state.isNot && reading.missing ? await locator.whatIsOnScreen() : '';
  return result(state, name, reading, expected, String(locator), screen);
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
        missing: !snap,
      };
    });
    return resultFor(this, 'toHaveText', reading, expected, locator);
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
        missing: !snap,
      };
    });
    return resultFor(this, 'toContainText', reading, expected, locator);
  },

  async toExist(this: ExpectMatcherState, locator: SapLocator, options: SapAssertionOptions = {}) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const found = (await locator.count()) > 0;
      return { ok: found, actual: found ? 'on the screen' : 'not on the screen', missing: !found };
    });
    return resultFor(this, 'toExist', reading, 'on the screen', locator);
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
        missing: !snap,
      };
    });
    return resultFor(this, 'toBeEditable', reading, 'editable', locator);
  },

  async toBeChecked(
    this: ExpectMatcherState,
    locator: SapLocator,
    options: SapAssertionOptions = {},
  ) {
    const reading = await until(this.isNot, options.timeout, async () => {
      const snap = await locator.snapshot();
      if (!snap) return { ok: false, actual: '(control not on the screen)', missing: true };
      const selected = (await locator.get('selected').catch(() => false)) === true;
      return { ok: selected, actual: selected ? 'checked' : 'not checked' };
    });
    return resultFor(this, 'toBeChecked', reading, 'checked', locator);
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

  /**
   * The last action ended without an error message: after waiting (bounded) for evidence that SAP has answered - a status bar
   * message of type S, I or W, or the screen / title / round-trip counter having moved since the last action - the status bar is
   * not an error (type E) or abort (type A). An error that appears is reported at once. If nothing at all is observed within
   * the timeout this FAILS: a status bar that is still empty on the old screen proves nothing about the action.
   * `requireOutcome: false` checks the status bar as it is right now (types E and A only).
   * Not usable with `.not`.
   */
  async toHaveNoStatusError(
    this: ExpectMatcherState,
    sap: SapGuiSession,
    options: SapAssertionOptions & { requireOutcome?: boolean } = {},
  ) {
    if (this.isNot)
      throw new Error('toHaveNoStatusError cannot be negated - to expect an error use toHaveStatusMessage(/.../, { type: "E" })');
    const requireOutcome = options.requireOutcome ?? true;
    const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT_MS);
    let actual = '(nothing observed yet)';
    let ok = false;
    for (;;) {
      const bar = await sap.statusBar();
      actual = `${bar.type ? `[${bar.type}] ` : ''}${bar.text || '(empty status bar)'}`;
      if (bar.type === 'E' || bar.type === 'A') break; // an error: no need to wait
      const outcome =
        (bar.text !== '' && ['S', 'I', 'W'].includes(bar.type)) ||
        (await sap.screenMovedSinceLastAction());
      if (outcome || !requireOutcome) {
        ok = true;
        break;
      }
      if (Date.now() >= deadline) {
        actual += ' - and the screen did not change: nothing shows that SAP has answered the last action yet';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return {
      name: 'toHaveNoStatusError',
      pass: ok,
      expected: 'no error or abort message, after SAP has answered',
      actual,
      message: () =>
        `${this.utils.matcherHint('toHaveNoStatusError', 'sap', '', { isNot: false })}\n\n` +
        `Expected: no error (E) or abort (A) status message, once SAP has answered the last action\n` +
        `Received: ${this.utils.printReceived(actual)}`,
    };
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
    // through the shared config like every other setting: a value in .env.<name> counts, a real environment variable wins
    const env = loadEnv();
    const dir = options.dir ?? env.getOptional('SAP_GUI_CONTRACTS_DIR') ?? DEFAULT_CONTRACTS_DIR;
    const current = await captureContract(sap, name, options);
    const update = options.update ?? env.getOptional('SAP_GUI_UPDATE_CONTRACTS') === 'true';
    if (update && isCi()) {
      // Updating writes the baseline from whatever screen SAP shows: in CI that would "fix" a drift by accepting it,
      // and the changed file would be thrown away with the runner anyway. Baselines are captured on a workstation, reviewed and committed.
      return {
        name: 'toMatchScreenContract',
        pass: false,
        message: () =>
          `Refusing to update the screen contract "${name}" in CI (CI is set): SAP_GUI_UPDATE_CONTRACTS / update:true would accept the current screen as the new baseline. Update it on a workstation, review the diff and commit it.`,
      };
    }
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
