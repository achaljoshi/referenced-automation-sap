import { COMMAND_FIELD, identifier, quote } from './names';
import { Objects } from './objects';
import { parseVbs, type Expr, type ParseWarning, type Step } from './parser';
import { protectSecrets, secretEnvVarForId } from './secrets';

export { identifier, quote } from './names';

/**
 * Replaces a recorded literal with a read from the environment. A recording
 * contains whatever was typed while recording - including the password - and
 * a generated test must never carry that into source control.
 */
export interface ParamRule {
  /** Matched against the element id of a `.text = "<literal>"` step. */
  idPattern: RegExp;
  /** The environment variable (from the repo's .env.<name> / CI variables) that supplies the value at run time. */
  envVar: string;
  /** A secret never has its recorded value written to the output, not even as a default. */
  secret?: boolean;
}

export const DEFAULT_PARAM_RULES: ParamRule[] = [
  { idPattern: /(^|\/)pwd[^/]*$/i, envVar: 'SAP_PASSWORD', secret: true },
  { idPattern: /txtRSYST-BNAME$/i, envVar: 'SAP_USER' },
  { idPattern: /txtRSYST-MANDT$/i, envVar: 'SAP_CLIENT' },
  { idPattern: /txtRSYST-LANGU$/i, envVar: 'SAP_LANGUAGE' },
];

/**
 * The rule for a control id: the first matching rule, else - for a field whose name is a secret (password, PIN, OTP, token ...)
 * even if no rule says so - a synthetic secret rule. A secret field never gets its recorded value written out.
 */
export function ruleFor(id: string, rules: ParamRule[]): ParamRule | undefined {
  const rule = rules.find((r) => r.idPattern.test(id));
  if (rule) return rule;
  const envVar = secretEnvVarForId(id);
  return envVar ? { idPattern: /^/, envVar, secret: true } : undefined;
}

/** The properties through which a typed value reaches a field. */
export const VALUE_PROPS = new Set(['text', 'value', 'key']);

/** What a converted recording is missing and a human must add: it only performs actions, so it passes whenever SAP does not throw. */
export const NO_ASSERTION_TODO =
  'TODO(converter): no assertion - this test only performs the recorded actions, so it passes whenever SAP does not throw.';

/** The assertions a caller can ask the converter to write. */
export interface AssertionOptions {
  /** A regular expression the status bar must match at the end. */
  expectStatus?: string;
  /** Texts that must be on the screen at the end (each becomes `getByText(...).first()` + `toExist()`). */
  expectText?: string[];
  /** A regular expression the main window's title must match at the end. */
  expectTitle?: string;
  /** What to emit when there is no assertion: 'fail' (default) a guard that throws, 'todo' only the comment. */
  noAssertion?: 'fail' | 'todo';
}

/** True when the caller asked for at least one assertion (status bar, text on the screen or window title): the TODO and the failing guard are then left out. */
export function hasAssertion(options: AssertionOptions): boolean {
  return options.expectStatus !== undefined || options.expectTitle !== undefined || (options.expectText?.length ?? 0) > 0;
}

/**
 * The last lines of a generated test body: the assertions the caller supplied (text on the screen, title, status bar - in that
 * order), else the TODO and (by default) a guard that fails until it is replaced.
 */
export function assertionLines(options: AssertionOptions): string[] {
  if (hasAssertion(options))
    return [
      ...(options.expectText ?? []).map((text) => `await expect(sap.getByText(${quote(text)}).first()).toExist();`),
      ...(options.expectTitle !== undefined ? [`await expect(sap).toHaveTitle(${pattern(options.expectTitle)});`] : []),
      ...(options.expectStatus !== undefined ? [`await expect(sap).toHaveStatusMessage(${pattern(options.expectStatus)});`] : []),
    ];
  return [
    `// ${NO_ASSERTION_TODO}`,
    "// Add a check of the business result, e.g.  await expect(sap.getByText('Order saved').first()).toExist();  or  await expect(sap).toHaveStatusMessage(/has been saved/i, { type: 'S' });",
    '// (the converter can write one for you: --expect-text, --expect-title, --expect-status).',
    'void expect; // delete this line once you use expect(...) - it only keeps the import of expect from being reported as unused',
    ...(options.noAssertion === 'todo'
      ? []
      : [
          '// then delete the next line (it fails the test on purpose; the converter option --allow-no-assertion leaves it out).',
          `throw new Error(${quote(`add an assertion: ${NO_ASSERTION_TODO}`)});`,
        ]),
  ];
}

/** A source regular expression as a case-insensitive literal; throws a clear SyntaxError for a bad pattern, at conversion time. */
function pattern(source: string): string {
  new RegExp(source);
  return source.includes('/') ? `new RegExp(${quote(source)}, 'i')` : `/${source}/i`;
}

/** What the test body's first lines tell about how the recording starts. */
export type SessionFixture = 'sap' | 'loggedInSap';

const LOGON_FIELD = /RSYST-(MANDT|BNAME|BCODE|LANGU)$/i;
const PASSWORD_FIELD = /(^|\/)pwd[^/]*$/i;

/**
 * Does the recording log on? It does when it types into the logon screen's fields (client, user, password, language) or into a
 * password field before the first command-field entry / transaction start (a password changed later, inside SAP, is not a logon).
 * Returns the line of the first logon step.
 */
export function logonStepLine(steps: Step[]): number | undefined {
  let insideSap = false;
  for (const step of steps) {
    if (step.kind === 'call' && step.id === '' && step.method.toLowerCase() === 'starttransaction') insideSap = true;
    if (!('id' in step)) continue;
    const id = step.id.replace(/^\/app\/con\[\d+\]\/ses\[\d+\]\//i, '');
    if (id === COMMAND_FIELD) insideSap = true;
    if (LOGON_FIELD.test(id) || (!insideSap && PASSWORD_FIELD.test(id))) return step.line;
  }
  return undefined;
}

/**
 * Which session fixture the generated test asks for. `sap` only opens the connection (SAP_GUI_MODE=open lands on the logon screen,
 * attach mode on whatever is open) so a recording that contains the logon needs it; `loggedInSap` logs on first when SAP shows the
 * logon screen and leaves an already logged-on session alone, so a recording made inside SAP needs that one. `auto` decides by
 * looking for logon steps.
 */
export function chooseFixture(
  steps: Step[],
  wanted: SessionFixture | 'auto' | undefined,
): { fixture: SessionFixture; warnings: ParseWarning[] } {
  const logon = logonStepLine(steps);
  if (wanted === undefined || wanted === 'auto') return { fixture: logon === undefined ? 'loggedInSap' : 'sap', warnings: [] };
  if (wanted === 'loggedInSap' && logon !== undefined)
    return {
      fixture: wanted,
      warnings: [
        {
          line: logon,
          message:
            '--fixture loggedInSap, but the recording logs on itself: the test logs on first, so these logon steps will not find the logon screen. Remove them or use --fixture sap (or auto).',
        },
      ],
    };
  return { fixture: wanted, warnings: [] };
}

/** The destructured fixture argument of the generated test; the body always calls the session `sap`. */
export function fixtureArg(fixture: SessionFixture): string {
  return fixture === 'sap' ? '{ sap }' : '{ loggedInSap: sap }';
}

/** The header line that says how the test gets its session, so a reader knows where the logon comes from. */
export function fixtureNote(fixture: SessionFixture, wanted: SessionFixture | 'auto' | undefined): string {
  const automatic = wanted === undefined || wanted === 'auto';
  return fixture === 'loggedInSap'
    ? ` *  - session: loggedInSap (${automatic ? 'the recording has no logon steps' : '--fixture loggedInSap'}): the fixture logs on with SAP_USER / SAP_PASSWORD / SAP_CLIENT / SAP_LANGUAGE when SAP shows the logon screen and leaves an already logged-on session alone`
    : ` *  - session: sap (${automatic ? 'the recording contains the logon' : '--fixture sap'}): the test starts on whatever the connection shows - the logon screen with SAP_GUI_MODE=open; in attach mode be on the logon screen too`;
}

export interface GenerateOptions extends AssertionOptions {
  // Assertions (from AssertionOptions): `expectStatus` the status bar message, `expectText` texts on the screen, `expectTitle` the window
  // title - any combination. Without any the test has NO assertion: it ends with a TODO and, unless `noAssertion: 'todo'`, a guard that
  // fails the test until a human adds one.
  /** Module the generated spec imports `sapExpect` (the SAP assertions) from - always imported, so an assertion added by hand works. Default: the published package. */
  expectImport?: string;
  /**
   * Which session fixture the test uses: `sap` (only opens the connection - for a recording that starts at the logon screen),
   * `loggedInSap` (logs on first unless already logged on - for a recording made inside SAP) or `auto` (default): `sap` when the
   * recording contains the logon steps, `loggedInSap` when it does not.
   */
  fixture?: SessionFixture | 'auto';
  /** Test title. */
  testName: string;
  /** Shown in the header comment, e.g. 'recordings/va01.vbs'. */
  sourceName?: string;
  /** Module the generated spec imports `sapGuiTest` from. Default: the published package. Use a relative path to your own base test (the one that adds your project's fixtures). */
  testImport?: string;
  /** Appended to the test title so a run can be selected with --grep. Default '@sapgui'. */
  tag?: string;
  /** Drop the recorder's `/app/con[0]/ses[0]/` prefix so the test runs against whichever session the fixture attached to. Default true. */
  stripSessionPrefix?: boolean;
  /** Extra rules, tried before the defaults. */
  params?: ParamRule[];
  /** Add `// vbs:<line>` after each statement to trace it back to the recording. Default true. */
  lineComments?: boolean;
  /**
   * By default the test starts with CONSTANTS (every typed value; secrets and settings as environment getters) and LOCATORS
   * (every control id, named once) and the steps only refer to them - a changed input or screen is one edit at the top.
   * `inline` writes ids and values in the steps instead.
   */
  inline?: boolean;
}

/** A conversion note: `todo` (default) needs a human decision and fails --strict; `info` only reports what the converter did (e.g. a secret replaced by an environment read). */
export type { ParseWarning };

export interface Generated {
  /** The whole spec file. */
  code: string;
  /** Just the statements inside the test body - valid plain JavaScript, so a unit test can execute exactly what was generated. */
  body: string[];
  /** The CONSTANTS / LOCATORS objects the body refers to (empty with `inline`) - plain JavaScript too: run `[...preamble, ...body]`. */
  preamble: string[];
  warnings: ParseWarning[];
  /** The environment variables the generated test reads. */
  envVars: string[];
  /** The session fixture the test asks for. */
  fixture: SessionFixture;
}

export function renderExpr(expr: Expr): string {
  switch (expr.kind) {
    case 'string':
      return quote(expr.value);
    case 'number':
      return String(expr.value);
    case 'boolean':
      return String(expr.value);
    case 'variable':
      return identifier(expr.name);
    case 'concat':
      return expr.parts.map(renderExpr).join(' + ');
    case 'env':
      return `env.get(${quote(expr.envVar)})`;
  }
}

export function generateFromSteps(recorded: Step[], parseWarnings: ParseWarning[], options: GenerateOptions): Generated {
  const rules = [...(options.params ?? []), ...DEFAULT_PARAM_RULES];
  const warnings = [...parseWarnings];
  const envVars = new Set<string>();
  // Secrets first: a variable that carries a password (by name or because it flows into a password field) loses its literals.
  const protectedSteps = protectSecrets(recorded, (id) => {
    const rule = ruleFor(id, rules);
    return rule?.secret ? rule.envVar : undefined;
  });
  const steps = protectedSteps.steps;
  warnings.push(...protectedSteps.warnings.map((w) => ({ ...w, severity: 'info' as const })));
  for (const name of protectedSteps.envVars) envVars.add(name);
  const chosen = chooseFixture(recorded, options.fixture);
  warnings.push(...chosen.warnings);
  const declared = new Set<string>();
  const stripPrefix = options.stripSessionPrefix ?? true;
  const lineComments = options.lineComments ?? true;
  const body: string[] = [];
  const objects = options.inline ? undefined : new Objects();

  const idOf = (id: string) => {
    const stripped = stripPrefix ? id.replace(/^\/app\/con\[\d+\]\/ses\[\d+\]\//i, '') : id;
    return objects ? objects.locator(stripped) : quote(stripped);
  };
  const trace = (line: number) => (lineComments ? ` // vbs:${line}` : '');
  const emit = (code: string, line: number) => body.push(`${code}${trace(line)}`);

  const textValue = (id: string, value: Expr, line: number): string => {
    const rule = ruleFor(id, rules);
    // a secret field: whatever literal (string, number, concatenation) the recording put there is replaced
    if (rule?.secret && value.kind !== 'variable') {
      envVars.add(rule.envVar);
      warnings.push({ line, severity: 'info', message: `the recorded value for "${id}" was replaced with env ${rule.envVar} - it is not in the generated file` });
      const read = `env.get(${quote(rule.envVar)})`;
      return objects ? objects.fromEnv(id, read) : read;
    }
    if (value.kind === 'string') {
      if (rule) {
        envVars.add(rule.envVar);
        const read = `env.get(${quote(rule.envVar)}, ${quote(value.value)})`;
        return objects ? objects.fromEnv(id, read) : read;
      }
      if (objects && value.value !== '') return objects.input(id, value.value);
    }
    return renderValue(value, id);
  };

  /** An expression as code; a secret read from the environment becomes a CONSTANTS getter when ids and values are collected at the top. */
  const renderValue = (value: Expr, name: string): string => {
    if (value.kind !== 'env') return renderExpr(value);
    envVars.add(value.envVar);
    const read = renderExpr(value);
    return objects ? objects.fromEnv(name, read) : read;
  };

  for (const step of steps) {
    switch (step.kind) {
      case 'comment':
        body.push(`// ${step.text}`);
        break;
      case 'sleep':
        body.push(`// WScript.Sleep(${step.ms}) dropped - waiting for SAP is automatic, a fixed sleep is either too short or too slow`);
        break;
      case 'unsupported':
        body.push(`// TODO(manual, vbs:${step.line}): ${step.source}`);
        body.push(`//   ${step.reason}`);
        break;
      case 'let': {
        const name = identifier(step.name);
        emit(`${declared.has(name) ? '' : 'let '}${name} = ${renderValue(step.value, step.name)};`, step.line);
        declared.add(name);
        break;
      }
      case 'get': {
        const name = identifier(step.into);
        emit(`${declared.has(name) ? '' : 'let '}${name} = await sap.get(${idOf(step.id)}, ${quote(step.prop)});`, step.line);
        declared.add(name);
        break;
      }
      case 'set': {
        const id = step.id.replace(/^\/app\/con\[\d+\]\/ses\[\d+\]\//i, '');
        if (step.prop.toLowerCase() === 'text') {
          emit(`await sap.setText(${idOf(step.id)}, ${textValue(id, step.value, step.line)});`, step.line);
        } else if (VALUE_PROPS.has(step.prop.toLowerCase()) && ruleFor(id, rules)?.secret) {
          emit(`await sap.set(${idOf(step.id)}, ${quote(step.prop)}, ${textValue(id, step.value, step.line)});`, step.line);
        } else if (step.prop.toLowerCase() === 'selected' && step.value.kind === 'boolean') {
          emit(`await sap.setSelected(${idOf(step.id)}, ${renderExpr(step.value)});`, step.line);
        } else {
          emit(`await sap.set(${idOf(step.id)}, ${quote(step.prop)}, ${renderExpr(step.value)});`, step.line);
        }
        break;
      }
      case 'call': {
        const method = step.method;
        const m = method.toLowerCase();
        const args = step.args.map(renderExpr);
        const assign = step.into ? `${declared.has(identifier(step.into)) ? '' : 'let '}${identifier(step.into)} = ` : '';
        if (step.into) declared.add(identifier(step.into));
        if (!step.into && step.id === '' && m === 'starttransaction' && args.length === 1) {
          const first = step.args[0];
          const transaction = objects && first?.kind === 'string' && first.value !== '' ? objects.named('transaction', first.value) : args[0];
          emit(`await sap.startTransaction(${transaction});`, step.line);
        } else if (!step.into && m === 'sendvkey' && args.length === 1) {
          emit(
            step.id.replace(/^\/app\/con\[\d+\]\/ses\[\d+\]\//i, '') === 'wnd[0]'
              ? `await sap.sendVKey(${args[0]});`
              : `await sap.sendVKey(${args[0]}, ${idOf(step.id)});`,
            step.line,
          );
        } else if (!step.into && args.length === 0 && ['press', 'select', 'setfocus'].includes(m) && step.id !== '') {
          emit(`await sap.${m === 'setfocus' ? 'setFocus' : m}(${idOf(step.id)});`, step.line);
        } else {
          emit(`${assign}await sap.call(${step.id === '' ? "''" : idOf(step.id)}, ${[quote(method), ...args].join(', ')});`, step.line);
        }
        break;
      }
    }
  }

  const tag = options.tag ?? '@sapgui';
  const usesEnv = envVars.size > 0;
  const preamble = objects ? objects.block() : [];
  const header = [
    '/**',
    ` * Converted from ${options.sourceName ?? 'a SAP GUI Scripting recording'} by sap-vbs-to-playwright.`,
    ' * Review before committing:',
    ...(usesEnv ? [` *  - reads ${[...envVars].join(', ')} from the environment (.env.<name> / CI variables); none of those values is stored here`] : []),
    fixtureNote(chosen.fixture, options.fixture),
    ' *  - no waits are needed: every step waits for SAP to be idle and for its element to exist',
    ...(!hasAssertion(options)
      ? [` *  - NO ASSERTION: ${NO_ASSERTION_TODO.replace('TODO(converter): no assertion - ', '')} ${options.noAssertion === 'todo' ? 'Add one.' : 'It ends with a guard that fails until you add one.'}`]
      : []),
    ...warnings.map((w) => ` *  - line ${w.line}: ${w.message}`),
    ' */',
  ];
  const assertion = assertionLines(options);
  const code = [
    `import { sapGuiTest as test } from ${quote(options.testImport ?? '@automation/referenced-automation-sap')};`,
    `import { sapExpect as expect } from ${quote(options.expectImport ?? '@automation/referenced-automation-sap')};`,
    ...(usesEnv ? ["import { loadEnv } from '@automation/referenced-automation-utils';", '', 'const env = loadEnv();'] : []),
    '',
    ...preamble,
    ...header,
    `test(${quote(`${options.testName} ${tag}`.trim())}, async (${fixtureArg(chosen.fixture)}) => {`,
    ...body.map((line) => `  ${line}`),
    ...assertion.map((line) => `  ${line}`),
    '});',
    '',
  ].join('\n');

  return { code, body, preamble, warnings, envVars: [...envVars], fixture: chosen.fixture };
}

/** VBScript recording in, Playwright spec out. */
export function convertVbs(source: string, options: GenerateOptions): Generated {
  const { steps, warnings } = parseVbs(source);
  return generateFromSteps(steps, warnings, options);
}
