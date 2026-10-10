import { assertionLines, DEFAULT_PARAM_RULES, NO_ASSERTION_TODO, renderExpr, ruleFor, VALUE_PROPS, type GenerateOptions, type ParamRule } from './generator';
import { protectSecrets } from './secrets';
import { COMMAND_FIELD, identifier, propertyName, quote, SESSION_PREFIX, STATUS_BAR, TABLE_CELL, TOOLBAR_BUTTON } from './names';
import { Objects } from './objects';

export { propertyName } from './names';
import { parseVbs, type Expr, type ParseWarning, type Step } from './parser';

export interface PageObjectOptions extends GenerateOptions {
  /** Base name for the generated classes and files, e.g. 'va01_create_order' -> VA01CreateOrder*. */
  baseName: string;
  /** Module `SapPage` is imported from. Default the published package. */
  sapImport?: string;
  /** Pages file name (without extension) the spec imports from './pages/<pagesFile>'. Default `<BaseName>Pages`. */
  pagesFile?: string;
  /** Turn every recorded literal typed into a field into a column of a CSV file, one test per row. */
  dataDriven?: boolean;
  /** File name of the CSV the spec reads (next to the spec). Default `<baseName>.data.csv`. */
  dataFile?: string;
}

export interface PageObjectResult {
  spec: string;
  pages: { fileName: string; code: string };
  /** The data file: header + one row with the recorded values. Only when dataDriven. */
  data?: { fileName: string; rows: Array<Record<string, string>> };
  warnings: ParseWarning[];
  envVars: string[];
  /** Page classes generated, in screen order. */
  screens: Array<{ className: string; marker: string; controls: string[] }>;
}

// A step that sends SAP to a new screen: what the recorded script does next belongs to the next page.
// `select` is deliberately not one: tabs and radio buttons change nothing server-side.
const SCREEN_CHANGING = new Set([
  'sendvkey',
  'starttransaction',
  'press',
  'doubleclick',
  'doubleclicknode',
  'doubleclickitem',
  'doubleclickcurrentcell',
  'clicklink',
  'presstoolbarbutton',
  'presstoolbarcontextbutton',
  'selectcontextmenuitem',
  'close',
]);
const pascal = (text: string) =>
  text
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join('');

interface Segment {
  index: number;
  steps: Step[];
  controls: Map<string, { prop: string; kind: 'control' | 'table'; id: string }>;
  className?: string;
  marker?: string;
  pageNo?: number;
}

const relative = (id: string, strip: boolean) => (strip ? id.replace(SESSION_PREFIX, '') : id);

/**
 * Recording -> page objects + a test that uses them (instead of one flat script of ids).
 *
 * The recording is cut into screens at every step that makes SAP change screen; each screen's controls become
 * a page class with named properties; the command field and toolbar buttons, which every screen has, live in a
 * shared base class. The names are mechanical (Screen1, vbakAuart): rename them to business terms when you
 * tidy up - the point is that the ids now live in ONE place and the test reads as a sequence of screens.
 */
export function convertToPageObjects(source: string, options: PageObjectOptions): PageObjectResult {
  const parsed = parseVbs(source);
  const warnings = [...parsed.warnings];
  const strip = options.stripSessionPrefix ?? true;
  const rules: ParamRule[] = [...(options.params ?? []), ...DEFAULT_PARAM_RULES];
  const base = pascal(options.baseName) || 'Recording';
  const envVars = new Set<string>();
  // Secrets first: a variable that carries a password (by name or because it flows into a password field) loses its literals.
  const protectedSteps = protectSecrets(parsed.steps, (id) => {
    const rule = ruleFor(id, rules);
    return rule?.secret ? rule.envVar : undefined;
  });
  const steps = protectedSteps.steps;
  warnings.push(...protectedSteps.warnings.map((w) => ({ ...w, severity: 'info' as const })));
  for (const name of protectedSteps.envVars) envVars.add(name);
  // The pages file starts with CONSTANTS (typed values, secrets as environment getters) and LOCATORS (every id, named once).
  const objects = new Objects();
  objects.locator(COMMAND_FIELD); // the base class reads these two
  objects.locator(STATUS_BAR);

  // Tables: anything that has `field[col,row]` cells under it, or is named like a table control (tbl...).
  const tableIds = new Set<string>();
  for (const step of steps) {
    const sid = 'id' in step && step.id !== '' ? relative(step.id, strip) : undefined;
    const cell = sid ? TABLE_CELL.exec(sid) : null;
    if (cell) tableIds.add(cell[1] as string);
  }

  // ---- 1. cut into screens, collecting each screen's own controls
  const segments: Segment[] = [{ index: 1, steps: [], controls: new Map() }];
  const idOf = (step: Step): string | undefined =>
    'id' in step && step.id !== '' ? relative(step.id, strip) : undefined;
  const isOwn = (id: string) =>
    id !== COMMAND_FIELD &&
    !TOOLBAR_BUTTON.test(id) &&
    /^wnd\[0\]\//.test(id) &&
    !/^wnd\[0\]\/(sbar|tbar)/.test(id);

  for (const step of steps) {
    const segment = segments[segments.length - 1] as Segment;
    segment.steps.push(step);
    const id = idOf(step);
    if (id && isOwn(id)) {
      const cell = TABLE_CELL.exec(id);
      const key = cell ? (cell[1] as string) : id;
      if (!segment.controls.has(key)) {
        const kind = tableIds.has(key) || /\/tbl[A-Z0-9_]*$/.test(key) ? 'table' : 'control';
        // named once for the whole recording (the same control on two screens keeps its name)
        const name = objects.locatorKey(key);
        segment.controls.set(key, { prop: kind === 'table' ? `${name}Table` : name, kind, id: key });
      }
    }
    if (
      step.kind === 'call' &&
      SCREEN_CHANGING.has(step.method.toLowerCase().split('.').pop() as string)
    ) {
      segments.push({ index: segments.length + 1, steps: [], controls: new Map() });
    }
  }

  // screens that have controls of their own become pages
  let pageNo = 0;
  for (const segment of segments) {
    if (segment.controls.size === 0) continue;
    pageNo++;
    segment.pageNo = pageNo;
    segment.className = `${base}Screen${pageNo}Page`;
    segment.marker = [...segment.controls.values()][0]?.id;
  }

  // ---- 2. data-driven parameters (named once, across the whole recording)
  const dataRow: Record<string, string> = {};
  const usedColumns = new Set<string>();
  const columnFor = (id: string): string => {
    const cell = TABLE_CELL.exec(id);
    const baseCol = cell
      ? `${propertyName(cell[2] as string)}_c${cell[3]}r${cell[4]}`
      : propertyName(id);
    let col = baseCol;
    for (let n = 2; usedColumns.has(col); n++) col = `${baseCol}_${n}`;
    usedColumns.add(col);
    return col;
  };

  // ---- 3. render the test body
  const body: string[] = [];
  const declared = new Set<string>();
  const trace = (line: number) => (options.lineComments ?? true ? ` // vbs:${line}` : '');
  let current: Segment | undefined;
  let currentVar = 'sap';
  let usesFrame = false;

  const access = (
    id: string,
    segment: Segment | undefined,
  ): { expr: string; cellOf?: { table: string; field: string; col: string; row: string } } => {
    if (id === COMMAND_FIELD) return { expr: `${currentVar}.commandField` };
    if (id === STATUS_BAR) return { expr: `${currentVar}.statusBar` };
    const tb = TOOLBAR_BUTTON.exec(id);
    if (tb) return { expr: `${currentVar}.toolbarButton(${tb[1]})` };
    const cell = TABLE_CELL.exec(id);
    const key = cell ? (cell[1] as string) : id;
    const control = segment?.controls.get(key);
    if (control && segment?.className) {
      if (cell)
        return {
          expr: `${currentVar}.${control.prop}.cell(${quote(cell[2] as string)}, ${cell[3]}, ${cell[4]})`,
        };
      // A table helper has no set/call of its own: reach the control itself through .locator
      return {
        expr:
          control.kind === 'table'
            ? `${currentVar}.${control.prop}.locator`
            : `${currentVar}.${control.prop}`,
      };
    }
    return { expr: `sap.locator(${objects.locator(id)})` }; // a pop-up, the status bar, or a control outside any page
  };

  const valueFor = (id: string, value: Expr, line: number): string => {
    const rule = ruleFor(id, rules);
    // a secret field: whatever literal (string, number, concatenation) the recording put there is replaced
    if (rule?.secret && value.kind !== 'variable') {
      envVars.add(rule.envVar);
      warnings.push({
        line,
        severity: 'info',
        message: `the recorded value for "${id}" was replaced with env ${rule.envVar} - it is not in the generated files`,
      });
      return objects.fromEnv(id, `env.get(${quote(rule.envVar)})`);
    }
    if (value.kind === 'string') {
      if (rule) {
        envVars.add(rule.envVar);
        return objects.fromEnv(id, `env.get(${quote(rule.envVar)}, ${quote(value.value)})`);
      }
      if (options.dataDriven) {
        const col = columnFor(id);
        dataRow[col] = value.value;
        return `field(data, ${quote(col)})`;
      }
      if (value.value !== '') return objects.input(id, value.value);
    }
    return renderValue(value, id);
  };

  /** An expression as code; a secret read from the environment becomes a CONSTANTS getter. */
  const renderValue = (value: Expr, name: string): string => {
    if (value.kind !== 'env') return renderExpr(value);
    envVars.add(value.envVar);
    return objects.fromEnv(name, renderExpr(value));
  };

  for (const segment of segments) {
    if (segment.className) {
      currentVar = `screen${segment.pageNo}`;
      current = segment;
      body.push(`const ${currentVar} = await new ${segment.className}(sap).waitUntilDisplayed();`);
    } else {
      current = undefined;
      const needsFrame = segment.steps.some((st) => {
        const sid = 'id' in st && st.id !== '' ? relative(st.id, strip) : '';
        return sid === COMMAND_FIELD || sid === STATUS_BAR || TOOLBAR_BUTTON.test(sid);
      });
      if (needsFrame) {
        usesFrame = true;
        currentVar = `frame${segment.index}`;
        body.push(`const ${currentVar} = await new ${base}Frame(sap).waitUntilDisplayed();`);
      } else currentVar = 'sap';
    }
    for (const step of segment.steps) {
      switch (step.kind) {
        case 'comment':
          body.push(`// ${step.text}`);
          break;
        case 'sleep':
          body.push(`// WScript.Sleep(${step.ms}) dropped - waiting for SAP is automatic`);
          break;
        case 'unsupported':
          body.push(`// TODO(manual, vbs:${step.line}): ${step.source}`, `//   ${step.reason}`);
          break;
        case 'let': {
          const name = identifier(step.name);
          body.push(
            `${declared.has(name) ? '' : 'let '}${name} = ${renderValue(step.value, step.name)};${trace(step.line)}`,
          );
          declared.add(name);
          break;
        }
        case 'get': {
          const id = relative(step.id, strip);
          const name = identifier(step.into);
          body.push(
            `${declared.has(name) ? '' : 'let '}${name} = await ${access(id, current).expr}.get(${quote(step.prop)});${trace(step.line)}`,
          );
          declared.add(name);
          break;
        }
        case 'set': {
          const id = relative(step.id, strip);
          const target = access(id, current).expr;
          const prop = step.prop.toLowerCase();
          if (prop === 'text')
            body.push(
              `await ${target}.fill(${valueFor(id, step.value, step.line)});${trace(step.line)}`,
            );
          else if (VALUE_PROPS.has(prop) && ruleFor(id, rules)?.secret)
            body.push(
              `await ${target}.set(${quote(step.prop)}, ${valueFor(id, step.value, step.line)});${trace(step.line)}`,
            );
          else if (prop === 'selected' && step.value.kind === 'boolean')
            body.push(`await ${target}.setChecked(${renderExpr(step.value)});${trace(step.line)}`);
          else
            body.push(
              `await ${target}.set(${quote(step.prop)}, ${renderExpr(step.value)});${trace(step.line)}`,
            );
          break;
        }
        case 'call': {
          const id = step.id === '' ? '' : relative(step.id, strip);
          const method = step.method;
          const m = method.toLowerCase();
          const args = step.args.map(renderExpr);
          const assign = step.into
            ? `${declared.has(identifier(step.into)) ? '' : 'let '}${identifier(step.into)} = `
            : '';
          if (step.into) declared.add(identifier(step.into));
          if (!step.into && id === '' && m === 'starttransaction' && args.length === 1) {
            const first = step.args[0];
            const transaction =
              !options.dataDriven && first?.kind === 'string' && first.value !== ''
                ? objects.named('transaction', first.value)
                : args[0];
            body.push(`await sap.startTransaction(${transaction});${trace(step.line)}`);
          }
          else if (!step.into && m === 'sendvkey' && args.length === 1) {
            body.push(
              id === 'wnd[0]'
                ? `await sap.sendVKey(${args[0]});${trace(step.line)}`
                : `await sap.sendVKey(${args[0]}, ${objects.locator(id)});${trace(step.line)}`,
            );
          } else if (!step.into && args.length === 0 && id !== '' && m === 'press')
            body.push(`await ${access(id, current).expr}.press();${trace(step.line)}`);
          else if (!step.into && args.length === 0 && id !== '' && m === 'select')
            body.push(`await ${access(id, current).expr}.click();${trace(step.line)}`);
          else if (!step.into && args.length === 0 && id !== '' && m === 'setfocus')
            body.push(`await ${access(id, current).expr}.focus();${trace(step.line)}`);
          else if (id === '')
            body.push(
              `${assign}await sap.call('', ${[quote(method), ...args].join(', ')});${trace(step.line)}`,
            );
          else
            body.push(
              `${assign}await ${access(id, current).expr}.call(${[quote(method), ...args].join(', ')});${trace(step.line)}`,
            );
          break;
        }
      }
    }
  }

  // ---- 4. the pages file
  const sapImport = options.sapImport ?? '@automation/referenced-automation-sap';
  const pageClasses = segments.filter((s) => s.className);
  const pagesUseEnv = envVars.size > 0;
  const pagesCode = [
    ...(pagesUseEnv ? ["import { loadEnv } from '@automation/referenced-automation-utils';"] : []),
    `import { SapPage } from ${quote(sapImport)};`,
    '',
    ...(pagesUseEnv ? ['const env = loadEnv();', ''] : []),
    ...objects.block({ exported: true }),
    '/**',
    ` * Page objects generated from ${options.sourceName ?? 'a SAP GUI Scripting recording'} by sap-vbs-to-playwright.`,
    ' * CONSTANTS and LOCATORS above hold every typed value and every id: change them there. The class and property names are mechanical (Screen1, vbakAuart): rename them to business terms.',
    ' */',
    `abstract class ${base}Screen extends SapPage {`,
    '  /** The command field: where a user types a transaction code. */',
    `  readonly commandField = this.sap.locator(${objects.locator(COMMAND_FIELD)});`,
    '',
    '  /** The message line at the bottom of the screen. */',
    `  readonly statusBar = this.sap.locator(${objects.locator(STATUS_BAR)});`,
    '',
    '  /** A button in the standard toolbar (btn[0] Enter, btn[3] Back, btn[11] Save, btn[12] Cancel, ...). */',
    '  toolbarButton(n: number) {',
    '    return this.sap.locator(`wnd[0]/tbar[0]/btn[${n}]`);',
    '  }',
    '}',
    ...(usesFrame
      ? [
          '',
          '/** The standard frame every screen has (command field, toolbar, status bar) - for steps that happen on a screen of their own. */',
          `export class ${base}Frame extends ${base}Screen {`,
          `  readonly marker = ${objects.locator(COMMAND_FIELD)};`,
          '}',
        ]
      : []),
    ...pageClasses.flatMap((segment) => [
      '',
      `export class ${segment.className} extends ${base}Screen {`,
      `  readonly marker = ${objects.locator(segment.marker as string)};`,
      '',
      ...[...segment.controls.values()].map((c) =>
        c.kind === 'table'
          ? `  readonly ${c.prop} = this.sap.table(${objects.locator(c.id)});`
          : `  readonly ${c.prop} = this.sap.locator(${objects.locator(c.id)});`,
      ),
      '}',
    ]),
    '',
  ].join('\n');

  // ---- 5. the spec
  const pagesFile = options.pagesFile ?? `${base}Pages`;
  const tag = options.tag ?? '@sapgui';
  const usesEnv = envVars.size > 0; // CONSTANTS (and so `env`) live in the pages file, not here
  const dataFile = options.dataFile ?? `${options.baseName}.data.csv`;
  const header = [
    '/**',
    ` * Converted from ${options.sourceName ?? 'a SAP GUI Scripting recording'} by sap-vbs-to-playwright (page-object mode).`,
    ' * Review before committing:',
    ...(usesEnv
      ? [
          ` *  - reads ${[...envVars].join(', ')} from the environment (.env.<name> / CI variables); none of those values is stored here`,
        ]
      : []),
    ` *  - every typed value (CONSTANTS) and every id (LOCATORS) is at the top of ./pages/${pagesFile}.ts: change them there; the page and property names are mechanical - rename them`,
    ' *  - no waits are needed: every step waits for SAP to be idle and for its control to exist',
    ...(options.dataDriven
      ? [
          ` *  - one test runs per row of ${dataFile}; the first row holds the values that were recorded`,
        ]
      : []),
    ...(options.expectStatus === undefined
      ? [` *  - NO ASSERTION: ${NO_ASSERTION_TODO.replace('TODO(converter): no assertion - ', '')} ${options.noAssertion === 'todo' ? 'Add one.' : 'It ends with a guard that fails until you add one.'}`]
      : []),
    ...warnings.map((w) => ` *  - line ${w.line}: ${w.message}`),
    ' */',
  ];
  const indent = options.dataDriven ? '    ' : '  ';
  const testBody = [...body, ...assertionLines(options)].map((line) => `${indent}${line}`);
  const title = `${options.testName} ${tag}`.trim();
  const lines = [
    ...(options.dataDriven ? ["import * as path from 'node:path';"] : []),
    `import { sapGuiTest as test } from ${quote(options.testImport ?? '@automation/referenced-automation-sap')};`,
    ...(options.expectStatus !== undefined ? [`import { sapExpect as expect } from ${quote(options.expectImport ?? '@automation/referenced-automation-sap')};`] : []),
    ...(options.dataDriven ? ["import { csvUtils } from '@automation/referenced-automation-utils';"] : []),
    `import { ${[...(objects.hasInputs ? ['CONSTANTS'] : []), ...(body.some((l) => l.includes('LOCATORS.')) ? ['LOCATORS'] : []), ...(usesFrame ? [`${base}Frame`] : []), ...pageClasses.map((s) => s.className)].join(', ')} } from './pages/${pagesFile}';`,
    '',
    ...(options.dataDriven
      ? [
          `const rows = csvUtils.parseCsvFile(path.join(__dirname, ${quote(dataFile)}));`,
          '',
          '/** One cell of the current row. A missing column is an error that names it, not a silent `undefined` typed into SAP. */',
          'function field(row: Record<string, string>, column: string): string {',
          '  const value = row[column];',
          `  if (value === undefined) throw new Error(\`${dataFile} has no column "\${column}" - add it (the recording typed a value there)\`);`,
          '  return value;',
          '}',
          '',
        ]
      : []),
    ...header,
    ...(options.dataDriven
      ? [
          `for (const [index, data] of rows.entries()) {`,
          `  test(\`${title.replace(/`/g, '\\`')} [row \${index + 1}]\`, async ({ sap }) => {`,
          ...testBody,
          '  });',
          '}',
        ]
      : [`test(${quote(title)}, async ({ sap }) => {`, ...testBody, '});']),
    '',
  ].join('\n');

  return {
    spec: lines,
    pages: { fileName: `${pagesFile}.ts`, code: pagesCode },
    ...(options.dataDriven ? { data: { fileName: dataFile, rows: [dataRow] } } : {}),
    warnings,
    envVars: [...envVars],
    screens: pageClasses.map((s) => ({
      className: s.className as string,
      marker: s.marker as string,
      controls: [...s.controls.values()].map((c) => c.prop),
    })),
  };
}
