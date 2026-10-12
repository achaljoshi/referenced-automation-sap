import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * .env.example is the reference for every setting, so it must never drift from the code: a variable the code reads that .env.example
 * does not list, or a variable it lists that nothing reads, fails this test - and so do a missing explanation, a secret that is not
 * marked as one, and a README table that disagrees. (The scanner itself is tested at the end with made-up sources, so it cannot
 * silently stop finding things.)
 */
const root = path.resolve(__dirname, '../..');
const utils = path.join(root, 'node_modules/@automation/referenced-automation-utils/dist');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

// ------------------------------------------------------------------------------------------------------------ the scanner

const NAME = '[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{2,}';
/** The environment variables a piece of source code reads. `SAP_PASSWORD_${user}` is the template `SAP_PASSWORD_<USER>`. */
export function namesRead(source: string): string[] {
  const found = new Set<string>();
  const add = (name: string | undefined) => {
    if (name) found.add(name.replace(/_?\$\{[^}]*\}/, '_<USER>'));
  };
  for (const m of source.matchAll(new RegExp(`\\.(?:get|getOptional|getBoolean|getInt|getList|has)\\(\\s*(['"\`])((?:${NAME})(?:_?\\$\\{[^}]*\\})?)\\1`, 'g'))) add(m[2]);
  for (const m of source.matchAll(new RegExp(`process\\.env\\.(${NAME})\\b`, 'g'))) add(m[1]);
  for (const m of source.matchAll(new RegExp(`process\\.env\\[\\s*(['"])(${NAME})\\1\\s*\\]`, 'g'))) add(m[2]);
  for (const m of source.matchAll(new RegExp(`resolveSecret\\(\\s*(['"\`])((?:${NAME})(?:_?\\$\\{[^}]*\\})?)\\1`, 'g'))) add(m[2]);
  for (const m of source.matchAll(new RegExp(`wordsFor\\(\\s*'(${NAME})'`, 'g'))) add(m[1]); // the secrets a converted test reads
  for (const m of source.matchAll(new RegExp(`envVar:\\s*'(${NAME})'`, 'g'))) add(m[1]); // the settings a converted test reads
  for (const m of source.matchAll(new RegExp(`baseUrlKey:\\s*'(${NAME})'`, 'g'))) add(m[1]);
  return [...found];
}

/** The variables an env example file lists, active or commented out (`NAME=...` / `# NAME=...`), with the comment block above each. */
export function listed(text: string): Array<{ name: string; line: number; block: string[]; value: string }> {
  const lines = text.split(/\r?\n/);
  const variable = new RegExp(`^#?\\s?((?:${NAME})(?:_<[A-Z]+>)?)=(.*)$`);
  const out: Array<{ name: string; line: number; block: string[]; value: string }> = [];
  lines.forEach((line, index) => {
    const m = variable.exec(line);
    if (!m) return;
    const block: string[] = [];
    for (let i = index - 1; i >= 0; i--) {
      const above = lines[i] as string;
      if (!above.startsWith('#') || variable.test(above)) break;
      block.unshift(above);
    }
    out.push({ name: m[1] as string, line: index + 1, block, value: (m[2] as string).trim() });
  });
  return out;
}

/** What is wrong between the names the code reads, the names the example lists and the allowed pass-through names. */
export function drift(input: { readByCode: string[]; listed: string[]; readAnywhere: string[]; passThrough: string[] }): { missing: string[]; unused: string[] } {
  const listedSet = new Set(input.listed);
  const known = new Set([...input.readAnywhere, ...input.passThrough]);
  return {
    missing: [...new Set(input.readByCode)].filter((n) => !listedSet.has(n)).sort(),
    unused: [...listedSet].filter((n) => !known.has(n)).sort(),
  };
}

function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel, accept));
    else if (accept(rel)) out.push(rel);
  }
  return out;
}

const isCode = (file: string) => /\.(ts|js)$/.test(file) && !/\.d\.ts$/.test(file);
const scan = (files: string[]) => files.flatMap((file) => namesRead(read(file)));

/** What the code of this repo (the package, the shared Playwright config call) reads - the part nobody may leave out of .env.example. */
const readByCode = [...new Set(scan([...walk('src', isCode), 'playwright.config.ts']))];
/** Everything this repo reads, tests and scripts included. */
const readAnywhere = [...new Set([...readByCode, ...scan([...walk('tests/sapgui', isCode), ...walk('tests/support', isCode), ...walk('features', isCode), ...walk('scripts', isCode)])])];

/**
 * Names that are read by something this repo uses, not by this repo's own code - each with where, and checked against that source
 * below (when it is installed), so a name the library stops reading shows up here too.
 */
const PASS_THROUGH: Record<string, { file: string; reason: string }> = {};
for (const name of ['BROWSER', 'DEVICE', 'HEADLESS', 'RETRIES', 'MAX_FAILURES', 'SLOW_MO_MS', 'TEST_TIMEOUT_MS', 'EXPECT_TIMEOUT_MS', 'ACTION_TIMEOUT_MS', 'NAVIGATION_TIMEOUT_MS', 'GLOBAL_TIMEOUT_MS', 'LOCALE', 'TIMEZONE_ID', 'COLOR_SCHEME', 'IGNORE_HTTPS_ERRORS', 'VIEWPORT_WIDTH', 'VIEWPORT_HEIGHT', 'TEST_ID_ATTRIBUTE'])
  PASS_THROUGH[name] = { file: 'playwright/config.js', reason: 'the shared Playwright config (createPlaywrightConfig in referenced-automation-utils)' };
for (const name of ['LOG_LEVEL', 'LOG_TO_FILE', 'LOG_FILE', 'LOG_FILE_PER_WORKER']) PASS_THROUGH[name] = { file: 'logger/logger.js', reason: 'the shared logger in referenced-automation-utils' };
for (const name of [
  'REMOTE_ENABLED', 'REMOTE_RDP_HOST', 'REMOTE_RDP_PORT', 'REMOTE_RDP_USER', 'REMOTE_RDP_PASSWORD', 'REMOTE_RDP_DOMAIN', 'REMOTE_SHARE_DIR', 'REMOTE_DRIVE_LETTER', 'REMOTE_AGENT_START', 'REMOTE_ALLOW',
  'REMOTE_CONNECT_TIMEOUT_MS', 'REMOTE_REQUEST_TIMEOUT_MS', 'REMOTE_POLL_MS', 'REMOTE_HEARTBEAT_MS', 'REMOTE_HEARTBEAT_STALE_MS', 'REMOTE_RDP_WIDTH', 'REMOTE_RDP_HEIGHT', 'REMOTE_RDP_KEEP_OPEN', 'REMOTE_LOGOFF',
  'REMOTE_DB_PROVIDER', 'REMOTE_DB_CONNECTION_STRING',
])
  PASS_THROUGH[name] = { file: 'remote/config.js', reason: 'SAP_GUI_TRANSPORT=remote: the remote client in referenced-automation-utils (remoteConfigFromEnv)' };
/** The setup scripts read these from the shell (scripts/setup.sh and setup.bat). */
const SETUP_SCRIPTS = ['NPM_REGISTRY_URL', 'USE_LOCAL_PACKAGES', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'];

const example = listed(read('.env.example'));
const exampleNames = example.map((v) => v.name);
const passThrough = [...Object.keys(PASS_THROUGH), ...SETUP_SCRIPTS];

// -------------------------------------------------------------------------------------------------------------- the checks

test.describe('.env.example lists exactly what the code reads', () => {
  test('the scanner finds the settings the code is known to read (a scan that finds nothing would pass everything)', () => {
    for (const name of ['SAP_GUI_MODE', 'SAP_PASSWORD', 'SAP_PASSWORD_<USER>', 'SAP_LOGON_FAILURE_COOLDOWN_MIN', 'SAP_GUI_JACOB_DLL', 'SAP_GUI_UPDATE_CONTRACTS', 'WORKERS', 'BASE_URL', 'ENV', 'CI', 'SAP_PIN'])
      expect(readByCode, name).toContain(name);
    expect(readAnywhere).toEqual(expect.arrayContaining(['SAP_SAMPLE_TCODE', 'SAP_RUN_TEMPLATES', 'MIN_EXECUTED']));
    expect(readByCode.length).toBeGreaterThan(45);
  });

  test('every variable read by src/ or playwright.config.ts is listed', () => {
    const { missing } = drift({ readByCode, listed: exampleNames, readAnywhere, passThrough });
    expect(missing, `read by the code but missing from .env.example: ${missing.join(', ')}`).toEqual([]);
  });

  test('every variable listed is read by something (this repo, or a documented pass-through)', () => {
    const { unused } = drift({ readByCode, listed: exampleNames, readAnywhere, passThrough });
    expect(unused, `listed in .env.example but nothing reads it: ${unused.join(', ')} - remove it, or add it to PASS_THROUGH with where it is read`).toEqual([]);
  });

  test('a name is listed once', () => {
    const seen = exampleNames.filter((name, i) => exampleNames.indexOf(name) !== i);
    expect(seen).toEqual([]);
  });

  test('each pass-through name is still read by the library it comes from (when that library is installed)', () => {
    test.skip(!fs.existsSync(utils), 'referenced-automation-utils is not installed here');
    for (const [name, { file }] of Object.entries(PASS_THROUGH)) {
      const source = fs.readFileSync(path.join(utils, file), 'utf8');
      expect(source, `${name} is no longer read by ${file}`).toMatch(new RegExp(`['"\`]${name}['"\`]|process\\.env\\.${name}\\b`));
    }
    const setup = read('scripts/setup.sh') + read('scripts/setup.bat');
    for (const name of SETUP_SCRIPTS) expect(setup, `${name} is no longer read by the setup scripts`).toContain(name);
  });

  test('the committed environment files use only settings that exist (a typo such as SAP_GUI_CONECTION_NAME is silently ignored otherwise)', () => {
    for (const file of ['.env.dev', '.env.qa', '.env.stage', '.env.simulator']) {
      const names = listed(read(file)).map((v) => v.name);
      expect(names.length, file).toBeGreaterThan(0);
      for (const name of names) expect(exampleNames, `${file}: ${name} is not a setting this repo reads`).toContain(name);
    }
  });
});

test.describe('each variable is explained', () => {
  const FIELDS = ['What:', 'Values:', 'Default:', 'Required:', 'Secret:', 'Find it:'];

  test('the comment block above every variable says what it is for, valid values, default, required, secret, and where to find it', () => {
    for (const variable of example) {
      const block = variable.block.join('\n');
      for (const field of FIELDS) expect(block, `.env.example line ${variable.line} (${variable.name}): no "${field}" above it`).toContain(`# ${field}`);
      expect(variable.block.length, variable.name).toBeGreaterThanOrEqual(FIELDS.length);
    }
  });

  test('secrets are marked "Secret: YES", say where they belong, and carry no value in the committed example', () => {
    const secretNames = /(^|_)(PASSWORD|SECRET|TOKEN|PIN|OTP|API_KEY)(_|$)|DB_CONNECTION_STRING$/;
    for (const variable of example) {
      const marked = variable.block.some((line) => /^# Secret:\s+YES/.test(line));
      expect(marked, `${variable.name} looks like a secret but is not marked "Secret: YES"`).toBe(secretNames.test(variable.name) || marked);
      if (marked) {
        expect(variable.block.join('\n'), `${variable.name}: say where a secret belongs`).toMatch(/\.env\.<ENV>\.local|masked CI variable/);
        expect(variable.value, `${variable.name}: a secret has no value in a committed file`).toBe('');
      }
    }
    for (const name of ['SAP_PASSWORD', 'SAP_PASSWORD_<USER>', 'REMOTE_RDP_PASSWORD', 'REMOTE_DB_CONNECTION_STRING']) {
      const variable = example.find((v) => v.name === name);
      expect(variable?.block.some((line) => /^# Secret:\s+YES/.test(line)), name).toBe(true);
    }
  });

  test('.env.qa.local.example (the secrets template) lists every secret of .env.example, and no live value', () => {
    const template = listed(read('.env.qa.local.example'));
    const secrets = example.filter((v) => v.block.some((line) => /^# Secret:\s+YES/.test(line))).map((v) => v.name);
    expect(secrets.length).toBeGreaterThan(5);
    for (const name of secrets) expect(template.map((v) => v.name), `.env.qa.local.example is missing ${name}`).toContain(name);
    for (const variable of template) expect(variable.value, `${variable.name} in the template must be a placeholder`).toMatch(/^(""|"change-me")?$/);
    // the file that is NOT the template must stay out of git
    expect(read('.gitignore')).toMatch(/^\.env\.\*\.local$/m);
  });

  test('the sections the reader looks for exist, in order', () => {
    const text = read('.env.example');
    const titles = ['1. FILL THESE FIRST', '2. LOGON', '3. SESSION AND TIMING', '4. EVIDENCE', '5. TEST DATA AND CLEANUP', '6. USER POOL', '7. TRANSPORTS', '8. SIMULATOR', '10. CI, SETUP'];
    let at = -1;
    for (const title of titles) {
      const found = text.indexOf(title, at + 1);
      expect(found, `section "${title}"`).toBeGreaterThan(at);
      at = found;
    }
    for (const sub of ['--- PowerShell ---', '--- Java / JACOB', '--- Remote desktop host']) expect(text).toContain(sub);
  });
});

test.describe('the README table', () => {
  const readme = read('README.md');
  const start = readme.indexOf('## Configuration reference');
  const section = readme.slice(start, readme.indexOf('\n## ', start + 1)); // up to the next top-level heading
  const rows = [...section.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*(?:<[A-Z]+>)?)`\s*\|(.*)\|\s*$/gm)];
  const tableNames = rows.map((m) => m[1] as string);

  test('has a "Configuration reference" section with the columns name | purpose | default | required | secret', () => {
    expect(readme).toContain('## Configuration reference');
    expect(section).toMatch(/\|\s*Name\s*\|\s*Purpose\s*\|\s*Default\s*\|\s*Required\s*\|\s*Secret\s*\|/);
  });

  test('lists every variable of .env.example, and only those', () => {
    const missing = exampleNames.filter((n) => !tableNames.includes(n));
    const extra = tableNames.filter((n) => !exampleNames.includes(n));
    expect(missing, `in .env.example but not in the README table: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `in the README table but not in .env.example: ${extra.join(', ')}`).toEqual([]);
  });

  test('its secret column agrees with .env.example', () => {
    for (const variable of example) {
      const row = rows.find((m) => m[1] === variable.name);
      const cells = (row?.[2] ?? '').split('|').map((c) => c.trim());
      const secret = variable.block.some((line) => /^# Secret:\s+YES/.test(line));
      expect(/^yes/i.test((cells[cells.length - 1] ?? '').replace(/\*/g, '')), `${variable.name}: secret column`).toBe(secret);
    }
  });
});

test.describe('the worked example (tests/sapgui/04_example_every_feature.spec.ts)', () => {
  const file = read('tests/sapgui/04_example_every_feature.spec.ts');

  test('is skipped on a real SAP (it creates data) unless the simulator is on or SAP_RUN_TEMPLATES=true', () => {
    expect(file).toMatch(/test\.skip\(\s*!env\.getBoolean\('SAP_GUI_SIMULATOR', false\) && !env\.getBoolean\('SAP_RUN_TEMPLATES', false\)/);
  });

  test('shows every feature it promises', () => {
    for (const feature of ['loggedInSap', 'getByLabel(', 'getByText(', 'getByTooltip(', 'sap.locator(', 'setText(', '.press()', 'sendVKey(', 'toHaveStatusMessage(', 'toExist(', 'On the screen now', 'sap.evidence(', 'captureFromStatusBar(', 'cleanup:'])
      expect(file, feature).toContain(feature);
  });

  test('every setting it names is a documented one, and every setting it reads is named in its comments', () => {
    const named = [...new Set([...file.matchAll(/\b(SAP_[A-Z0-9_]+)\b/g)].map((m) => m[1] as string))].filter((n) => n !== 'SAP_PASSWORD_');
    for (const name of named) expect(exampleNames, `${name} is named in the example but not documented in .env.example`).toContain(name);
    for (const name of namesRead(file)) expect(file.match(new RegExp(`\\b${name}\\b`, 'g'))?.length, `${name} is read but not explained in the comments`).toBeGreaterThan(1);
  });
});

test.describe('the Windows walk-through and the troubleshooting tables', () => {
  const docs = { 'README.md': read('README.md'), 'docs/SAP_GUI_GUIDE.md': read('docs/SAP_GUI_GUIDE.md') };

  test('both documents walk through the first run in PowerShell, for both modes', () => {
    for (const [file, text] of Object.entries(docs)) {
      expect(text, file).toContain('Windows first run');
      for (const needle of ['.\\scripts\\setup.bat', '$env:', 'Remove-Item Env:', 'SAP_GUI_MODE', 'open', 'attach', 'Alt+F12', 'Script Recording and Playback', 'C:\\Temp\\sap', 'new file name', 'Unicode', 'UTF-8', 'ANSI', 'recordings\\', 'npm run convert', 'node dist/cli/convertVbs.js', '--expect-text', '--expect-status', 'CONSTANTS', 'LOCATORS', 'npx playwright test tests/sapgui/my_recording.spec.ts', 'npx playwright test -g', 'show-report', 'forward slashes'])
        expect(text, `${file}: ${needle}`).toContain(needle);
    }
  });

  test('both troubleshooting tables carry the exact messages people saw', () => {
    for (const [file, text] of Object.entries(docs)) {
      for (const message of ["'tsc' is not recognized", 'Cannot find module', 'doctor.js', 'Illegal characters in path', '*.tgz', 'javac <options> <source files>', 'JDK 9', 'JAVA_HOME', 'terminal.integrated.env.windows', 'The process cannot access the file because it is being used by another process', 'No tests found', 'Name or password is incorrect', 'logon NOT attempted', 'toExist'])
        expect(text, `${file}: ${message}`).toContain(message);
    }
  });

  test('the messages quoted for the framework\'s own errors are really what the code says', () => {
    const code = walk('src', isCode).map(read).join('\n');
    for (const fragment of ['logon NOT attempted - it would have repeated a logon that SAP has just rejected', "SAP's status bar says:", 'On the screen now (wnd[0])', 'repeated wrong logons LOCK the SAP user', 'double quotes in the .env file'])
      expect(code, fragment).toContain(fragment);
  });

  test('the Java bridge README says what the build needs and what was verified', () => {
    const java = read('bridge/jacob/README.md');
    for (const needle of ['JDK 9 or later', 'javac <options> <source files>', 'not** the `-sources` jar', 'SAP_GUI_JACOB_JAR', 'SAP_GUI_JACOB_DLL', 'SAP_GUI_BRIDGE_JAR', 'bitness', 'terminal.integrated.env.windows', '15 conformance checks'])
      expect(java, needle).toContain(needle);
    expect(java).not.toContain('JDK (8 or later');
  });

  test('the CHANGELOG records it under Unreleased', () => {
    const changelog = read('CHANGELOG.md');
    const unreleased = changelog.slice(changelog.indexOf('## Unreleased'), changelog.indexOf('\n## ', changelog.indexOf('## Unreleased') + 1) === -1 ? undefined : changelog.indexOf('\n## ', changelog.indexOf('## Unreleased') + 1));
    for (const needle of ['--expect-text', '--expect-title', '--fixture', 'loggedInSap', 'SAP_LOGON_FAILURE_COOLDOWN_MIN', 'On the screen now', '.env.example', 'envDocs.spec.ts', 'Windows first run', '04_example_every_feature'])
      expect(unreleased, needle).toContain(needle);
  });
});

test.describe('the scanner can fail (made-up sources)', () => {
  test('finds each way the code reads a variable', () => {
    const source = `
      env.get('A_ONE'); loadEnv().getOptional("B_TWO"); env.getBoolean('C_THREE', false); env.getInt('D_FOUR', 1); env.getList('E_FIVE');
      process.env.F_SIX; process.env['G_SEVEN']; resolveSecret('H_EIGHT'); resolveSecret(\`I_NINE_\${user}\`); wordsFor('J_TEN', 'x'); envVar: 'K_ELEVEN'; baseUrlKey: 'L_TWELVE';
      env.get('lower_case'); env.get(variable); const text = 'M_NOT_READ';`;
    expect(namesRead(source).sort()).toEqual(['A_ONE', 'B_TWO', 'C_THREE', 'D_FOUR', 'E_FIVE', 'F_SIX', 'G_SEVEN', 'H_EIGHT', 'I_NINE_<USER>', 'J_TEN', 'K_ELEVEN', 'L_TWELVE'].sort());
  });

  test('a variable the code reads that the example lacks is reported as missing; one the example lists that nothing reads, as unused', () => {
    const result = drift({ readByCode: ['SAP_USER', 'SAP_NEW_SETTING'], listed: ['SAP_USER', 'SAP_OLD_SETTING', 'LOG_LEVEL'], readAnywhere: ['SAP_USER', 'SAP_NEW_SETTING'], passThrough: ['LOG_LEVEL'] });
    expect(result).toEqual({ missing: ['SAP_NEW_SETTING'], unused: ['SAP_OLD_SETTING'] });
    expect(drift({ readByCode: ['SAP_USER'], listed: ['SAP_USER'], readAnywhere: ['SAP_USER'], passThrough: [] })).toEqual({ missing: [], unused: [] });
  });

  test('the example parser takes active and commented variables, with the comment block above each, and ignores prose', () => {
    const text = ['# Quoting: write NAME="x" in quotes', '', '# What:     one', '# Secret:   NO', 'A_ONE=1', '# What:     two', '# SAP_PASSWORD_<USER>=', '#   not_a=variable', 'B_TWO='].join('\n');
    const result = listed(text);
    expect(result.map((v) => v.name)).toEqual(['A_ONE', 'SAP_PASSWORD_<USER>', 'B_TWO']);
    expect(result[0]?.block).toEqual(['# What:     one', '# Secret:   NO']);
    expect(result[1]?.block).toEqual(['# What:     two']);
    expect(result[2]?.block).toEqual(['#   not_a=variable']);
  });
});
