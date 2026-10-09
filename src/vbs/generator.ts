import { parseVbs, type Expr, type ParseWarning, type Step } from './parser';

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

export interface GenerateOptions {
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
}

export interface Generated {
  /** The whole spec file. */
  code: string;
  /** Just the statements inside the test body - valid plain JavaScript, so a unit test can execute exactly what was generated. */
  body: string[];
  warnings: ParseWarning[];
  /** The environment variables the generated test reads. */
  envVars: string[];
}

export function quote(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}'`;
}

const RESERVED = new Set(['default', 'new', 'class', 'function', 'var', 'let', 'const', 'delete', 'in', 'of', 'with', 'switch', 'case', 'sap', 'env', 'test']);
export function identifier(name: string): string {
  return RESERVED.has(name) ? `${name}_` : name;
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
  }
}

export function generateFromSteps(steps: Step[], parseWarnings: ParseWarning[], options: GenerateOptions): Generated {
  const rules = [...(options.params ?? []), ...DEFAULT_PARAM_RULES];
  const warnings = [...parseWarnings];
  const envVars = new Set<string>();
  const declared = new Set<string>();
  const stripPrefix = options.stripSessionPrefix ?? true;
  const lineComments = options.lineComments ?? true;
  const body: string[] = [];

  const idOf = (id: string) => quote(stripPrefix ? id.replace(/^\/app\/con\[\d+\]\/ses\[\d+\]\//i, '') : id);
  const trace = (line: number) => (lineComments ? ` // vbs:${line}` : '');
  const emit = (code: string, line: number) => body.push(`${code}${trace(line)}`);

  const textValue = (id: string, value: Expr, line: number): string => {
    if (value.kind === 'string') {
      const rule = rules.find((r) => r.idPattern.test(id));
      if (rule) {
        envVars.add(rule.envVar);
        if (rule.secret) {
          warnings.push({ line, message: `the recorded value for "${id}" was replaced with env ${rule.envVar} - it is not in the generated file` });
          return `env.get(${quote(rule.envVar)})`;
        }
        return `env.get(${quote(rule.envVar)}, ${quote(value.value)})`;
      }
    }
    return renderExpr(value);
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
        emit(`${declared.has(name) ? '' : 'let '}${name} = ${renderExpr(step.value)};`, step.line);
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
          emit(`await sap.startTransaction(${args[0]});`, step.line);
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
  const header = [
    '/**',
    ` * Converted from ${options.sourceName ?? 'a SAP GUI Scripting recording'} by sap-vbs-to-playwright.`,
    ' * Review before committing:',
    ...(usesEnv ? [` *  - reads ${[...envVars].join(', ')} from the environment (.env.<name> / CI variables); none of those values is stored here`] : []),
    ' *  - no waits are needed: every step waits for SAP to be idle and for its element to exist',
    ...warnings.map((w) => ` *  - line ${w.line}: ${w.message}`),
    ' */',
  ];
  const code = [
    `import { sapGuiTest as test } from ${quote(options.testImport ?? '@automation/referenced-automation-sap')};`,
    ...(usesEnv ? ["import { loadEnv } from '@automation/referenced-automation-utils';", '', 'const env = loadEnv();'] : []),
    '',
    ...header,
    `test(${quote(`${options.testName} ${tag}`.trim())}, async ({ sap }) => {`,
    ...body.map((line) => `  ${line}`),
    '});',
    '',
  ].join('\n');

  return { code, body, warnings, envVars: [...envVars] };
}

/** VBScript recording in, Playwright spec out. */
export function convertVbs(source: string, options: GenerateOptions): Generated {
  const { steps, warnings } = parseVbs(source);
  return generateFromSteps(steps, warnings, options);
}
