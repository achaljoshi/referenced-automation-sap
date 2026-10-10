import { locatorName, quote } from './names';

/**
 * The two objects a converted test starts with, so a changed input or a changed screen is one edit at the top:
 *
 *  - CONSTANTS.inputs - every value the recording typed (secrets and settings as getters that read the environment)
 *  - LOCATORS         - every control the recording touched, by its SAP GUI Scripting id
 *
 * Plain JavaScript on purpose (no `as const`): the generator's own tests run the generated code exactly as written.
 */
export class Objects {
  private readonly locators = new Map<string, string>();
  private readonly inputs: Array<{ name: string; code: string; getter: boolean; key: string }> = [];

  /** Registers a control id and returns the reference to use in a step: `LOCATORS.vbakAuart`. */
  locator(id: string): string {
    return `LOCATORS.${this.locatorKey(id)}`;
  }

  /** The key of a control id in LOCATORS. The same id always gets the same key; different ids that would collide are numbered. */
  locatorKey(id: string): string {
    const existing = this.locators.get(id);
    if (existing) return existing;
    const base = locatorName(id);
    const taken = new Set(this.locators.values());
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
    this.locators.set(id, key);
    return key;
  }

  /** A typed literal as CONSTANTS.inputs.<name>, named after the control it goes into. The same value into the same control is one entry. */
  input(id: string, literal: string): string {
    return this.add(id, quote(literal), false, `v:${literal}`);
  }

  /** A transaction code or other literal that is not typed into one control. */
  named(name: string, literal: string): string {
    return this.add(name, quote(literal), false, `v:${literal}`, true);
  }

  /** A value read from the environment when used (a missing variable names itself then, not at import). */
  fromEnv(id: string, expression: string): string {
    return this.add(id, expression, true, `e:${expression}`);
  }

  private add(idOrName: string, code: string, getter: boolean, key: string, rawName = false): string {
    const found = this.inputs.find((e) => e.key === `${idOrName}|${key}`);
    if (found) return `CONSTANTS.inputs.${found.name}`;
    const base = rawName ? idOrName : locatorName(idOrName);
    let name = base;
    for (let n = 2; this.inputs.some((e) => e.name === name); n++) name = `${base}${n}`;
    this.inputs.push({ name, code, getter, key: `${idOrName}|${key}` });
    return `CONSTANTS.inputs.${name}`;
  }

  get hasInputs(): boolean {
    return this.inputs.length > 0;
  }

  get hasLocators(): boolean {
    return this.locators.size > 0;
  }

  /** The two objects as source. */
  block(options: { exported?: boolean; only?: Array<'constants' | 'locators'> } = {}): string[] {
    const exp = options.exported ? 'export ' : '';
    const lines: string[] = [];
    if (this.hasInputs && (!options.only || options.only.includes('constants'))) {
      lines.push(
        '/** What the recording typed. Change a value here and every step that uses it follows. Secrets and settings are read from the environment. */',
        `${exp}const CONSTANTS = {`,
        '  inputs: {',
      );
      for (const entry of this.inputs) {
        if (entry.getter) lines.push(`    get ${entry.name}() {`, `      return ${entry.code};`, '    },');
        else lines.push(`    ${entry.name}: ${entry.code},`);
      }
      lines.push('  },', '};', '');
    }
    if (this.hasLocators && (!options.only || options.only.includes('locators'))) {
      lines.push(
        '/** Every control the recording touched, by its SAP GUI Scripting id. When a screen changes, fix the id here and every step follows. */',
        `${exp}const LOCATORS = {`,
        ...[...this.locators.entries()].map(([id, key]) => `  ${key}: ${quote(id)},`),
        '};',
        '',
      );
    }
    return lines;
  }
}
