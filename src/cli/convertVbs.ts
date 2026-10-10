#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { csvUtils } from '@automation/referenced-automation-utils';
import { convertToPageObjects, convertVbs, type ParamRule } from '../vbs';

const USAGE = `sap-vbs-to-playwright - turn SAP GUI Scripting recordings (.vbs) into Playwright tests

Usage:
  sap-vbs-to-playwright <file.vbs | folder> [options]

Options:
  --out <file.ts|folder>  Where to write the spec(s): a .ts file name, or a folder (created if needed). Default: next to the input, <name>.spec.ts.
  --test-import <module>  Module the spec imports \`sapGuiTest\` from. Default: @automation/referenced-automation-sap.
                          Point it at your own base test (a relative path) to add your project's fixtures.
  --param <id-regex>=<ENV_VAR>
                          Read the value typed into any field whose id matches from an environment variable
                          instead of embedding it. Repeatable. Passwords, user, client and language are
                          handled by default.
  --tag <tag>             Tag added to the test title. Default: @sapgui.
  --keep-session-prefix   Keep the recorder's /app/con[0]/ses[0]/ id prefix.
  --no-line-comments      Don't add "// vbs:<line>" trace comments.
  --inline                Write ids and values where they are used. By default the test starts with CONSTANTS (every typed value;
                          secrets as environment getters) and LOCATORS (every control id, named once) and the steps only refer to them,
                          so a changed input or screen is one edit at the top. Ignored with --page-objects, where the same two
                          objects are at the top of the pages file.
  --page-objects          Generate page objects (one class per screen, ids in one place) plus a test that uses them,
                          instead of one flat script. Written to <out>/pages/<Name>Pages.ts.
  --data                  Make every literal typed in the recording a column of <name>.data.csv and run one test per row
                          (implies --page-objects). The first row holds the values that were recorded.
  --sap-import <module>   Module the page objects import SapPage from. Default: @automation/referenced-automation-sap.
  --expect-status <regex> The test's assertion: at the end the status bar must match this (case-insensitive), e.g. "has been saved".
                          Without it a converted test has NO assertion (a recording only performs actions): it ends with a
                          TODO and a guard that FAILS the test until you add one.
  --expect-import <mod>   Module the spec imports the SAP assertions (sapExpect) from with --expect-status. Default: @automation/referenced-automation-sap.
  --allow-no-assertion    Leave the failing guard out (the TODO comment and the header note stay). For examples and spikes.
  --strict                Exit with an error if anything could not be converted automatically (control flow, unsupported lines).
                          Notes about what the converter did on purpose - a secret replaced by an environment read - do not count.
  -h, --help
`;

function parseArgs(argv: string[]) {
  const opts = {
    input: '',
    out: '',
    testImport: undefined as string | undefined,
    tag: undefined as string | undefined,
    params: [] as ParamRule[],
    keepPrefix: false,
    lineComments: true,
    strict: false,
    pageObjects: false,
    inline: false,
    data: false,
    sapImport: undefined as string | undefined,
    expectStatus: undefined as string | undefined,
    expectImport: undefined as string | undefined,
    allowNoAssertion: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === '--out') opts.out = value();
    else if (arg === '--test-import') opts.testImport = value();
    else if (arg === '--tag') opts.tag = value();
    else if (arg === '--keep-session-prefix') opts.keepPrefix = true;
    else if (arg === '--no-line-comments') opts.lineComments = false;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--expect-status') opts.expectStatus = value();
    else if (arg === '--expect-import') opts.expectImport = value();
    else if (arg === '--allow-no-assertion') opts.allowNoAssertion = true;
    else if (arg === '--inline') opts.inline = true;
    else if (arg === '--page-objects') opts.pageObjects = true;
    else if (arg === '--data') {
      opts.data = true;
      opts.pageObjects = true;
    } else if (arg === '--sap-import') opts.sapImport = value();
    else if (arg === '--param') {
      const [pattern, envVar] = value().split('=');
      if (!pattern || !envVar) throw new Error('--param expects <id-regex>=<ENV_VAR>');
      opts.params.push({ idPattern: new RegExp(pattern, 'i'), envVar });
    } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else opts.input = arg;
  }
  if (!opts.input) throw new Error('missing input file or folder');
  return opts;
}

function main(): void {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  const inputs = fs.statSync(opts.input).isDirectory()
    ? fs
        .readdirSync(opts.input)
        .filter((f) => f.toLowerCase().endsWith('.vbs'))
        .map((f) => path.join(opts.input, f))
    : [opts.input];
  if (inputs.length === 0) {
    process.stderr.write(`no .vbs files found in ${opts.input}\n`);
    process.exit(2);
  }

  let totalWarnings = 0;
  for (const file of inputs) {
    const name = path.basename(file, path.extname(file));
    // --out is a file only if it names one (ends in .ts); otherwise it is a folder, whether or not it exists yet.
    const outPath =
      inputs.length === 1 && opts.out.endsWith('.ts')
        ? opts.out
        : path.join(opts.out || path.dirname(file), `${name}.spec.ts`);
    const common = {
      testName: `recorded: ${name}`,
      sourceName: path.relative(process.cwd(), file).replace(/\\/g, '/'),
      testImport: opts.testImport,
      tag: opts.tag,
      stripSessionPrefix: !opts.keepPrefix,
      params: opts.params,
      lineComments: opts.lineComments,
      inline: opts.inline,
      expectStatus: opts.expectStatus,
      noAssertion: opts.allowNoAssertion ? ('todo' as const) : ('fail' as const),
      expectImport: opts.expectImport,
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    let result: { warnings: Array<{ line: number; message: string; severity?: 'todo' | 'info' }>; envVars: string[] };
    if (opts.pageObjects) {
      const generated = convertToPageObjects(fs.readFileSync(file, 'utf8'), {
        ...common,
        baseName: name,
        sapImport: opts.sapImport,
        dataDriven: opts.data,
      });
      const outDir = path.dirname(outPath);
      fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true });
      const pagesPath = path.join(outDir, 'pages', generated.pages.fileName);
      fs.writeFileSync(outPath, generated.spec);
      fs.writeFileSync(pagesPath, generated.pages.code);
      process.stdout.write(
        `${file}  ->  ${outPath}\n    pages: ${pagesPath} (${generated.screens.length} screen(s))\n`,
      );
      if (generated.data) {
        const dataPath = path.join(outDir, generated.data.fileName);
        fs.writeFileSync(dataPath, csvUtils.toCsv(generated.data.rows));
        process.stdout.write(
          `    data:  ${dataPath} (${Object.keys(generated.data.rows[0] ?? {}).length} column(s); add a row per case)\n`,
        );
      }
      result = generated;
    } else {
      const flat = convertVbs(fs.readFileSync(file, 'utf8'), common);
      fs.writeFileSync(outPath, flat.code);
      process.stdout.write(`${file}  ->  ${outPath}\n`);
      result = flat;
    }
    if (result.envVars.length > 0)
      process.stdout.write(`    reads from the environment: ${result.envVars.join(', ')}\n`);
    for (const warning of result.warnings)
      process.stdout.write(`    line ${warning.line}: ${warning.message}\n`);
    totalWarnings += result.warnings.filter((w) => w.severity !== 'info').length;
    if (opts.expectStatus === undefined)
      process.stdout.write(
        `    no assertion: ${opts.allowNoAssertion ? 'add one (TODO in the file)' : 'the test fails until you add one (use --expect-status to generate it)'}\n`,
      );
  }
  if (opts.strict && totalWarnings > 0) {
    process.stderr.write(`\n${totalWarnings} item(s) need attention (--strict).\n`);
    process.exit(1);
  }
}

main();
