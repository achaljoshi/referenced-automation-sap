import { AdapterError } from '@automation/referenced-automation-utils';
import type { SapGuiSession } from './session';
import type { ControlInfo, FindCriteria, SapGuiValue } from './types';

type Selector =
  | { kind: 'id'; id: string }
  | { kind: 'find'; criteria: FindCriteria; nth?: number | 'last' }
  | { kind: 'child'; parent: SapLocator; relative: string }
  | { kind: 'fallback'; primary: SapLocator; alternates: SapLocator[] };

const TEXT_LIKE_BUTTON_TYPES = new Set(['GuiButton']);
const SELECT_TYPES = new Set(['GuiTab', 'GuiMenu', 'GuiRadioButton']);

/**
 * A way to find a SAP control, used like a Playwright Locator: nothing is
 * looked up until you act, every action waits for the control (and for SAP to
 * be idle), and the action chosen depends on what the control IS - so a test
 * says `click()` for a button, a tab and a radio button, and `fill()` for a
 * text field, a drop-down and a checkbox, instead of remembering
 * press/select/setText/key per class.
 *
 *   await sap.getByLabel('Sold-To Party').fill('1000');
 *   await sap.getByTooltip('Save').click();
 *   await expect(sap).toHaveStatusMessage(/saved/i, { type: 'S' });
 *
 * Locators found by text/tooltip/label/type are strict like Playwright's:
 * if more than one control matches, the action fails and lists them - narrow
 * it, or say `.first()` / `.nth(i)` on purpose.
 */
export class SapLocator {
  constructor(
    private readonly sap: SapGuiSession,
    private readonly selector: Selector,
    private readonly description: string,
  ) {}

  toString(): string {
    return this.description;
  }

  // ------------------------------------------------------------ narrowing

  first(): SapLocator {
    return this.nth(0);
  }

  last(): SapLocator {
    return this.withNth('last');
  }

  nth(index: number): SapLocator {
    return this.withNth(index);
  }

  private withNth(nth: number | 'last'): SapLocator {
    if (this.selector.kind !== 'find') return this;
    return new SapLocator(this.sap, { ...this.selector, nth }, `${this.description} [${nth}]`);
  }

  /** A control inside this one, by the id fragment below it (`txtRV45A-KWMENG[3,0]` inside a table control). */
  locator(relativeId: string): SapLocator {
    return new SapLocator(
      this.sap,
      { kind: 'child', parent: this, relative: relativeId },
      `${this.description} > ${relativeId}`,
    );
  }

  /**
   * Fall back to other ways of finding the same control if this one is not on the screen - the
   * technical id changed after a SAP release or customising change, but the label is still there:
   *
   *   sap.locator('wnd[0]/usr/ctxtKUAGV-KUNNR').orElse(sap.getByLabel('Sold-To Party'))
   *
   * This is NOT silent self-healing. The primary gets a grace period first (a slow screen is not a
   * changed id). If a fallback is used the test continues but the drift is recorded - attached to
   * the report with the id to put in the page object - and `SAP_GUI_FALLBACKS=fail` turns it into
   * a failure that names the new id (for a nightly drift check), `off` ignores fallbacks.
   */
  orElse(...alternates: SapLocator[]): SapLocator {
    return new SapLocator(
      this.sap,
      { kind: 'fallback', primary: this, alternates },
      `${this.description} (or ${alternates.map(String).join(' / ')})`,
    );
  }

  // ----------------------------------------------------------- resolution

  /** The technical id this locator points at right now; waits for it to be on the screen. */
  async id(timeoutMs = this.sap.timeoutMs): Promise<string> {
    const s = this.selector;
    if (s.kind === 'id') return s.id;
    if (s.kind === 'child') return `${await s.parent.id(timeoutMs)}/${s.relative}`;
    if (s.kind === 'fallback') return this.resolveWithFallback(s, timeoutMs);

    await this.sap.settle();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ids = await this.sap.findIds(s.criteria);
      if (ids.length > 0) return this.pick(ids, s);
      if (Date.now() >= deadline) throw await this.notFound(timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, this.sap.pollMs));
    }
  }

  /** Where this locator points right now, without waiting; undefined if nothing matches. Throws if the match is ambiguous. */
  async peekId(): Promise<string | undefined> {
    const s = this.selector;
    if (s.kind === 'id') return (await this.sap.exists(s.id)) ? s.id : undefined;
    if (s.kind === 'child') {
      const parent = await s.parent.peekId();
      if (!parent) return undefined;
      const id = `${parent}/${s.relative}`;
      return (await this.sap.exists(id)) ? id : undefined;
    }
    if (s.kind === 'find') {
      const ids = await this.sap.findIds(s.criteria);
      return ids.length === 0 ? undefined : this.pick(ids, s);
    }
    const primary = await s.primary.peekId();
    if (primary) return primary;
    if (this.sap.fallbackMode === 'off') return undefined;
    for (const alternate of s.alternates) {
      try {
        const found = await alternate.peekId();
        if (found) return found;
      } catch {
        /* an ambiguous alternate is not a usable fallback - try the next */
      }
    }
    return undefined;
  }

  private async resolveWithFallback(
    s: Extract<Selector, { kind: 'fallback' }>,
    timeoutMs: number,
  ): Promise<string> {
    await this.sap.settle();
    const started = Date.now();
    const deadline = started + timeoutMs;
    // The primary gets time to appear before a fallback may be used: a slow screen is not a changed id.
    const grace = Math.min(3_000, Math.floor(timeoutMs / 3));
    for (;;) {
      const primary = await s.primary.peekId();
      if (primary) return primary;
      if (this.sap.fallbackMode !== 'off' && Date.now() - started >= grace) {
        for (const alternate of s.alternates) {
          let found: string | undefined;
          try {
            found = await alternate.peekId();
          } catch {
            continue;
          }
          if (found) return this.sap.reportDrift(String(s.primary), String(alternate), found);
        }
      }
      if (Date.now() >= deadline) throw await this.notFound(timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, this.sap.pollMs));
    }
  }

  private pick(ids: string[], s: Extract<Selector, { kind: 'find' }>): string {
    const strip = (id: string) => id.replace(/^\/app\/con\[\d+\]\/ses\[\d+\]\//i, '');
    const clean = ids.map(strip);
    if (s.nth === undefined) {
      if (clean.length > 1) {
        throw new AdapterError(
          'sap-gui',
          'locate',
          `${this.description} is ambiguous: ${clean.length} controls match (${clean.slice(0, 6).join(', ')}${clean.length > 6 ? ', ...' : ''}). ` +
            'Narrow it (add type / label / exact), or say .first() / .nth(i) if any of them will do.',
        );
      }
      return clean[0] as string;
    }
    const index = s.nth === 'last' ? clean.length - 1 : s.nth;
    const found = clean[index];
    if (found === undefined)
      throw new AdapterError(
        'sap-gui',
        'locate',
        `${this.description}: there is no match number ${s.nth} (only ${clean.length} found)`,
      );
    return found;
  }

  private async notFound(waitedMs: number): Promise<AdapterError> {
    const status = await this.sap.statusBarText().catch(() => '');
    return new AdapterError(
      'sap-gui',
      'locate',
      `no control matched ${this.description} after ${waitedMs}ms` +
        (status ? `. Status bar says: "${status}"` : '') +
        '. See what is on the screen with: npm run doctor -- --dump',
    );
  }

  // ------------------------------------------------------------- reading

  async info(): Promise<ControlInfo> {
    return this.sap.info(await this.id());
  }

  /** The control's SAP class: GuiButton, GuiTextField, GuiComboBox, ... */
  async type(): Promise<string> {
    return (await this.info()).type;
  }

  async text(): Promise<string> {
    return this.sap.getText(await this.id());
  }

  /** A drop-down's displayed value (its text is the label of the field). */
  async value(): Promise<string> {
    return String(await this.sap.get(await this.id(), 'value'));
  }

  /** A drop-down's entries (what the user sees in the list). */
  async options(): Promise<string[]> {
    const id = await this.id();
    const count = Number(await this.sap.get(id, 'entries.count'));
    const values: string[] = [];
    for (let i = 0; i < count; i++)
      values.push(String(await this.sap.get(id, `entries.item(${i}).value`)));
    return values;
  }

  async tooltip(): Promise<string> {
    return (await this.info()).tooltip;
  }

  async isEditable(): Promise<boolean> {
    return (await this.info()).changeable;
  }

  async isChecked(): Promise<boolean> {
    return (await this.sap.get(await this.id(), 'selected')) === true;
  }

  /** On the screen right now? Does not wait. */
  async exists(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  /** How many controls match right now. Does not wait. */
  async count(): Promise<number> {
    const s = this.selector;
    if (s.kind === 'find') return (await this.sap.findIds(s.criteria)).length;
    return (await this.peekId()) ? 1 : 0;
  }

  /** A property right now without waiting, `undefined` if the control is not there. This is what the retrying assertions poll. */
  async snapshot(): Promise<{ info: ControlInfo; id: string } | undefined> {
    const id = await this.peekId();
    if (!id) return undefined;
    const info = await this.sap.peekInfo(id);
    return info ? { info, id } : undefined;
  }

  async get(prop: string): Promise<SapGuiValue> {
    return this.sap.get(await this.id(), prop);
  }

  async waitFor(
    options: { state?: 'attached' | 'detached'; timeout?: number } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? this.sap.timeoutMs;
    const wantPresent = (options.state ?? 'attached') === 'attached';
    await this.sap.settle();
    const deadline = Date.now() + timeout;
    while ((await this.count()) > 0 !== wantPresent) {
      if (Date.now() >= deadline) {
        throw new AdapterError(
          'sap-gui',
          'waitFor',
          `${this.description} was ${wantPresent ? 'not on the screen' : 'still on the screen'} after ${timeout}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.sap.pollMs));
    }
  }

  // -------------------------------------------------------------- acting

  /**
   * The natural action for the control's type: press a button, select a tab /
   * menu entry / radio button, toggle a checkbox, focus a field.
   */
  async click(): Promise<void> {
    const id = await this.id();
    const { type } = await this.sap.info(id);
    if (TEXT_LIKE_BUTTON_TYPES.has(type)) return void (await this.sap.call(id, 'press'));
    if (SELECT_TYPES.has(type)) return void (await this.sap.call(id, 'select'));
    if (type === 'GuiCheckBox')
      return this.sap.set(id, 'selected', !(await this.sap.get(id, 'selected')));
    if (/^Gui(C?TextField|PasswordField|Textedit|ComboBox|OkCodeField)$/.test(type))
      return void (await this.sap.call(id, 'setFocus'));
    throw new AdapterError(
      'sap-gui',
      'click',
      `click() does not know what to do with a ${type} (${this.description} = ${id}). ` +
        `Use .call('<method>') with the SAP GUI Scripting method you need (for a grid or tree, sap.grid(...) / sap.tree(...)).`,
    );
  }

  /**
   * Put a value into the control: text into a field, an option into a drop-down, a tick into a checkbox.
   * `checkMaxLength: true` also refuses a value longer than the field's MaxLength before typing, and afterwards reads the field back
   * and fails if SAP kept nothing or cut the value short. Reformatting (upper-casing, leading zeros, date formats) is not a failure.
   * Never checked for password fields.
   */
  async fill(value: string, options: { checkMaxLength?: boolean } = {}): Promise<void> {
    const id = await this.id();
    const { type, changeable } = await this.sap.info(id);
    if (!changeable)
      throw new AdapterError(
        'sap-gui',
        'fill',
        `${this.description} (${type} ${id}) is read-only - SAP does not let anyone type there`,
      );

    if (type === 'GuiCheckBox' || type === 'GuiRadioButton')
      return this.setChecked(/^(true|x|1|yes)$/i.test(value));
    if (type === 'GuiComboBox') {
      try {
        return await this.sap.set(id, 'value', value);
      } catch (error) {
        throw new AdapterError(
          'sap-gui',
          'fill',
          `"${value}" is not an option of the drop-down ${this.description} (${id})`,
          { cause: error },
        );
      }
    }
    if (options.checkMaxLength) {
      const max = Number(await this.sap.peekProp(id, 'maxLength').catch(() => 0));
      if (max > 0 && value.length > max) {
        throw new AdapterError(
          'sap-gui',
          'fill',
          `"${value}" is ${value.length} characters but ${this.description} (${id}) allows ${max}`,
        );
      }
    }
    const secret = type === 'GuiPasswordField';
    await this.sap.set(id, 'text', value, { secret });
    if (options.checkMaxLength && !secret && value !== '') {
      // SAP accepts an over-long or rejected entry without an error: it just keeps less. Read it back.
      const kept = String((await this.sap.peekProp(id, 'text').catch(() => value)) ?? '');
      const truncated = kept.length < value.length && value.toLowerCase().startsWith(kept.toLowerCase());
      if (kept === '' || truncated) {
        throw new AdapterError(
          'sap-gui',
          'fill',
          `SAP did not accept "${value}" in ${this.description} (${id}): the field now holds "${kept}"`,
        );
      }
    }
  }

  async clear(): Promise<void> {
    await this.fill('');
  }

  async check(): Promise<void> {
    await this.setChecked(true);
  }

  async uncheck(): Promise<void> {
    await this.setChecked(false);
  }

  /** Ticks or unticks, doing nothing if it is already so (so it is safe to repeat). */
  async setChecked(checked: boolean): Promise<void> {
    const id = await this.id();
    if ((await this.sap.get(id, 'selected')) !== checked) {
      const { type } = await this.sap.info(id);
      if (type === 'GuiRadioButton') await this.sap.call(id, 'select');
      else await this.sap.set(id, 'selected', checked);
    }
  }

  async press(): Promise<void> {
    await this.sap.call(await this.id(), 'press');
  }

  async focus(): Promise<void> {
    await this.sap.call(await this.id(), 'setFocus');
  }

  /** A virtual key to this control's window: 0 Enter, 3 Back, 8 Execute, 11 Save, 12 Cancel. */
  async sendKey(vKey: number): Promise<void> {
    await this.sap.sendVKey(vKey, await this.id());
  }

  async set(prop: string, value: SapGuiValue): Promise<void> {
    await this.sap.set(await this.id(), prop, value);
  }

  /** Anything else the SAP GUI Scripting API offers on this control. */
  async call(method: string, ...args: SapGuiValue[]): Promise<unknown> {
    return this.sap.call(await this.id(), method, ...args);
  }
}
