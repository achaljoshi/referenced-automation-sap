#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { convertVbs, type ParamRule } from '../vbs';

const USAGE = `sap-vbs-to-playwright - turn SAP GUI Scripting recordings (.vbs) into Playwright tests

Usage:
  sap-vbs-to-playwright <file.vbs | folder> [options]

Options:
  --out <file|folder>     Where to write the spec(s). Default: next to the input, <name>.spec.ts.
  --test-import <module>  Module the spec imports \`sapGuiTest\` from. Default: @automation/referenced-automation-sap.
                          Point it at your own base test (a relative path) to add your project's fixtures.
  --param <id-regex>=<ENV_VAR>
                          Read the value typed into any field whose id matches from an environment variable
                          instead of embedding it. Repeatable. Passwords, user, client and language are
                          handled by default.
  --tag <tag>             Tag added to the test title. Default: @sapgui.
  --keep-session-prefix   Keep the recorder's /app/con[0]/ses[0]/ id prefix.
  --no-line-comments      Don't add "// vbs:<line>" trace comments.
  --strict                Exit with an error if anything could not be converted automatically.
  -h, --help
`;

function parseArgs(argv: string[]) {
  const opts = { input: '', out: '', testImport: undefined as string | undefined, tag: undefined as string | undefined, params: [] as ParamRule[], keepPrefix: false, lineComments: true, strict: false };
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
    ? fs.readdirSync(opts.input).filter((f) => f.toLowerCase().endsWith('.vbs')).map((f) => path.join(opts.input, f))
    : [opts.input];
  if (inputs.length === 0) {
    process.stderr.write(`no .vbs files found in ${opts.input}\n`);
    process.exit(2);
  }

  let totalWarnings = 0;
  for (const file of inputs) {
    const name = path.basename(file, path.extname(file));
    const outPath =
      inputs.length === 1 && opts.out && !fs.existsSync(opts.out)
        ? opts.out
        : path.join(opts.out || path.dirname(file), `${name}.spec.ts`);
    const result = convertVbs(fs.readFileSync(file, 'utf8'), {
      testName: `recorded: ${name}`,
      sourceName: path.relative(process.cwd(), file).replace(/\\/g, '/'),
      testImport: opts.testImport,
      tag: opts.tag,
      stripSessionPrefix: !opts.keepPrefix,
      params: opts.params,
      lineComments: opts.lineComments,
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.code);
    process.stdout.write(`${file}  ->  ${outPath}\n`);
    if (result.envVars.length > 0) process.stdout.write(`    reads from the environment: ${result.envVars.join(', ')}\n`);
    for (const warning of result.warnings) process.stdout.write(`    line ${warning.line}: ${warning.message}\n`);
    totalWarnings += result.warnings.length;
  }
  if (opts.strict && totalWarnings > 0) {
    process.stderr.write(`\n${totalWarnings} item(s) need attention (--strict).\n`);
    process.exit(1);
  }
}

main();
