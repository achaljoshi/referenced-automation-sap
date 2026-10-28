# SAP GUI automation guide

> Why it is built this way, the alternatives considered and what has been verified: [`ARCHITECTURE.md`](ARCHITECTURE.md). Coming from the Java/JACOB framework: [`MIGRATION_FROM_JAVA.md`](MIGRATION_FROM_JAVA.md).

For testers and developers who need to automate the classic SAP GUI (the Windows client) with Playwright - from "I have never done this" to a running pipeline. The README has the commands; this explains how it fits together and what to do when it doesn't work.

## 1. How it works

```
 SAP GUI recording (.vbs)                      hand-written test (.ts)
        |                                              |
        |  npm run convert                             |
        v                                              v
   tests/sapgui/*.spec.ts  ------ npm run test:sapgui -----> Playwright test runner
                                                               |
                                                        SapGuiSession   (waits for SAP, logs, retries)
                                                               |
                                                   PowerShell bridge   (one JSON command per line)
                                                               |
                                                SAP GUI Scripting API  (Windows COM, built into SAP GUI)
                                                               |
                                                         your SAP system
```

- **SAP GUI Scripting** is SAP's own automation interface, built into SAP GUI. It addresses every control by a technical id such as `wnd[0]/usr/txtRSYST-BNAME`. The old Java framework drove it through JACOB; this one drives it through PowerShell.
- **The bridge** (`src/gui/bridgeScript.ts`) is a short PowerShell script that does exactly what a recorded VBScript does: find a control by id, read/write a property, call a method. `npm run doctor -- --print-bridge` prints it, for anyone who has to approve a script before it runs on a managed desktop. It makes no network calls and installs nothing; the one program it can start is SAP Logon, from a path you configure.
- **`SapGuiSession`** is what your tests use (`sap.setText`, `sap.press`, ...). It adds what a raw recording lacks: it waits for SAP to be idle and for the control to exist before every step, so there are no sleeps.
- **Playwright** is only the test runner: reporting, retries, filtering by tag, `expect`.

## 2. Why recordings fail when replayed, and what the framework does about it

A recording has no waits. It worked when you recorded it because you were slow; replayed at machine speed, the next screen isn't there yet and `findById` fails. `SapGuiSession`:

1. waits for SAP to report idle **and** the element to exist before each step;
2. after a step that triggers a server round trip (`press`, `sendVKey`, `startTransaction`, ...), waits for SAP to settle;
3. retries a "not found" that happens mid-screen-change, until the timeout (`SAP_GUI_TIMEOUT_MS`, default 30 s);
4. on a real failure, tells you what **is** on the screen: the nearest id that exists, what it contains, and the status bar text.

`tests/gui/session.spec.ts` demonstrates this against a simulator that models screen-change latency, including a control showing the same steps fail without the session.

## 3. One-time setup (Windows machine with SAP GUI)

1. **Enable scripting in the client.** SAP GUI > Options > Accessibility & Scripting > Scripting: tick *Enable scripting*; **untick** "Notify when a script attaches to running GUI" and "Notify when a script opens a connection". Those pop-ups block an unattended run.
2. **Enable it on the server.** Profile parameter `sapgui/user_scripting = TRUE` - ask your SAP Basis team.
3. **Install:** `npm install && npm run build` (Node 18+).
4. **Configure** (see section 4).
5. **Check:** `npm run doctor` (and `npm run doctor -- --conformance`, which runs a fixed set of checks against your SAP and says whether this transport conforms). It does what the tests will do and prints OK/FAIL per step with the fix.

## 3b. Windows first run (PowerShell)

From a clean Windows machine (an AWS WorkSpace, a laptop) with SAP GUI to your first recorded test that runs. Every command is PowerShell, typed in the VS Code terminal (**Terminal > New Terminal**; the prompt starts with `PS`). Two differences from the examples elsewhere that trip people up:

| bash / cmd.exe | PowerShell |
|---|---|
| `export NAME=value` / `set NAME=value` | `$env:NAME = "value"` (single quotes when the value contains `$`) |
| `unset NAME` / `set NAME=` | `Remove-Item Env:NAME` |
| `./scripts/setup.sh` | `.\scripts\setup.bat` |
| `cp a b` | `Copy-Item a b` |

A variable you set in the shell wins over every `.env` file and lasts until the terminal is closed - if a setting "does not take", run `Get-ChildItem Env:SAP_*`.

### Step by step

1. **Install.** Node 18+ (`node -v`) and SAP GUI with scripting enabled (section 3). In the repo folder run `.\scripts\setup.bat` (add `--local` when `referenced-automation-utils` and `-ui` are checked out next to this repo and are not in a registry). It runs `npm ci` and installs the Playwright browser. If you set `NPM_REGISTRY_URL` first (`$env:NPM_REGISTRY_URL = "<your registry>"`) the script runs `npm config set registry` with it. Afterwards the folder `node_modules` exists; without it `tsc` and `playwright` are "not recognized".
2. **Build and check:** `npm run build`, then `npm run doctor` (it does what the tests will do and says OK or FAIL per step with the fix; `npm run doctor -- --conformance` checks the bridge itself).
3. **Configure.** Non-secret settings in `.env.qa` (it is committed): `SAP_GUI_MODE`, `SAP_GUI_CONNECTION_NAME`, `SAP_CLIENT`, `SAP_USER`, `SAP_LANGUAGE` - in SAP, **System > Status** shows client, user and language; the connection name is the entry in SAP Logon. The password only in the git-ignored `.env.qa.local`:
   ```powershell
   Copy-Item .env.qa.local.example .env.qa.local
   # edit it:  SAP_PASSWORD="my#pass word"      <- double quotes: an unquoted # cuts the password
   ```
   Every variable is explained in `.env.example`. **Log on by hand with exactly these values before the first run** - see [Credentials and lock-out protection](#credentials-and-lock-out-protection).
4. **Choose how the test gets SAP** - it decides where you start recording:

   | | `SAP_GUI_MODE=open` | `SAP_GUI_MODE=attach` |
   |---|---|---|
   | SAP at the start of a test | the framework opens `SAP_GUI_CONNECTION_NAME`; you are at the **logon screen** | the SAP Logon window you already have open and logged on |
   | Start the recording at | **the logon screen** - the recording contains the logon | **SAP Easy Access**, already logged on |
   | The converter writes | `async ({ sap })` (it types the logon itself) | `async ({ loggedInSap: sap })` |
   | Switch | `$env:SAP_GUI_MODE = "open"` | `$env:SAP_GUI_MODE = "attach"`; `Remove-Item Env:SAP_GUI_MODE` returns to the file's value |

   `sap` only opens the connection, so a recording made **while logged on** would start on the logon screen in open mode and fail to find the command field. The converter therefore chooses the fixture by looking for logon steps in the recording (`--fixture auto`): with none it writes `loggedInSap`, which logs on first when SAP shows the logon screen and does nothing when you are already in. Either recording therefore runs in either mode.
5. **Record.** In SAP GUI press **Alt+F12 > Script Recording and Playback** to open the **Record and Playback** dialog.
   - **Save To:** a **local, non-synced folder** such as `C:\Temp\sap` - not OneDrive, WorkDocs or another synced folder, which hold the file open while they upload it.
   - **File name:** a **new name every time**. Saving over a name that SAP GUI or a sync client still holds open fails with `The process cannot access the file because it is being used by another process`.
   - **Encoding:** *Unicode*, *UTF-8* and *ANSI* are all read by the converter.
   - Start the recording, do the flow, stop it. In open mode start at the logon screen; in attach mode start from Easy Access.
6. **Copy it into `recordings\`** (`Copy-Item C:\Temp\sap\my_recording.vbs recordings\`). The recording contains the password you typed in clear text: do not commit the `.vbs`.
7. **Convert** - with the assertion you want:
   ```powershell
   npm run convert -- --expect-text "Address" --expect-status "has been saved"
   # one file, all options spelled out (backslashes are fine for node):
   node dist/cli/convertVbs.js recordings\my_recording.vbs --out tests/sapgui --test-import ./support/sapTest --expect-import ./support/sapTest --expect-text "Address" --strict
   ```
   `npx sap-vbs-to-playwright` does not exist inside this repo - the `sap-*` commands are installed into projects that depend on the package. `npm run convert` reads every file in `recordings\`; arguments after `--` are appended.
8. **Edit** `tests\sapgui\my_recording.spec.ts`: `CONSTANTS` (what the recording typed) and `LOCATORS` (every control id) are at the top; the header lists what the converter could not convert. If you passed no `--expect-*`, replace the `TODO(converter)` guard at the end by a check - `import`ed `expect` is the SAP-aware one, so `await expect(sap.getByText('Address').first()).toExist();` works.
9. **Run one test.** Use **forward slashes**; a backslash path after `playwright test` is treated as a regular expression and gives `No tests found`. Or select by title:
   ```powershell
   npx playwright test tests/sapgui/my_recording.spec.ts
   npx playwright test -g "recorded: my_recording"
   ```
10. **Report:** `npx playwright show-report` opens `playwright-report\index.html`. A failed test has `sap-steps` (the journal), `sap-status-bar`, `sap-screenshot`, and an assertion on a missing control lists what *is* on the screen.

If the logon fails: **stop and fix the credentials before running again.** SAP counts every wrong logon.

### Where it goes wrong - the exact messages

| You see | Cause | Do this |
|---|---|---|
| `'tsc' is not recognized as an internal or external command` (no `node_modules` folder) | the install did not run or failed part-way | `.\scripts\setup.bat` (`--local` without a registry) and read its first error |
| `Cannot find module '...\dist\cli\doctor.js'` | the TypeScript was never compiled | `npm run build` first (`npm run doctor`, `npm run convert` use `dist\`) |
| `Illegal characters in path` mentioning `*.tgz` (`npm run clean`, `create-package`) | the old clean script handed the pattern `*.tgz` to Windows; fixed with `rimraf --glob` | use the current version of the repo |
| `javac <options> <source files>` (the usage text) building `bridge/jacob` | `javac --release` needs **JDK 9 or later** and the first `javac` on `PATH` is JDK 8 | install JDK 9+, set `JAVA_HOME`, put `%JAVA_HOME%\bin` ahead of the old Java on `PATH` (VS Code: `"terminal.integrated.env.windows": { "JAVA_HOME": "C:\\Program Files\\Java\\jdk-17", "PATH": "C:\\Program Files\\Java\\jdk-17\\bin;${env:PATH}" }`, then open a new terminal); `javac -version` must say 9 or higher |
| `The process cannot access the file because it is being used by another process` saving a recording | a synced folder, or SAP GUI / a sync client still holds a file of that name | save to `C:\Temp\sap`, new file name each time |
| `No tests found` | a Windows path with backslashes | forward slashes, or `-g "recorded: my_recording"` |
| `still on the logon screen ... Name or password is incorrect (repeat logon)` | wrong user, client or password; an unquoted `#` in the password; or a locked user | the message lists what to check; fix it, log on by hand once, then run again |
| `logon NOT attempted - it would have repeated a logon that SAP has just rejected` | the lock-out protection (below) | change the credentials, or delete `.sap-state\logon-failed.json`, or wait |
| `TypeError: expect(...).toExist is not a function` / `Property 'toExist' does not exist on type` | `expect` imported from `@playwright/test` | `import { expect } from './support/sapTest'` - or let the converter write `import { sapExpect as expect } from ...` (it always does) |
| `'sap-vbs-to-playwright' is not recognized` | the `npx sap-*` names exist only in projects that depend on this package | `npm run convert` / `node dist\cli\convertVbs.js` |

## 4. Configuration

Settings come from `.env.<name>` (committed, **no secrets**), overridden by `.env.<name>.local` (git-ignored, for secrets; template `.env.qa.local.example`), overridden by real environment variables (CI; PowerShell `$env:NAME = "value"`). Pick the file with `ENV=qa` (the default is `qa`). A value with `#`, `$` or spaces goes in double quotes (`SAP_PASSWORD="my#pass word"`) - an unquoted `#` starts a comment and silently cuts the value.

**This table lists the SAP settings; [`.env.example`](../.env.example) is the exhaustive reference** - every variable the repo reads (including the `REMOTE_*`, Java/JACOB, Playwright and logging ones), each with what it is for, valid values, default, whether it is required, whether it is a secret, and where to find the value in SAP GUI. The README has the same list as the [Configuration reference](../README.md#configuration-reference) table; `tests/gui/envDocs.spec.ts` fails when either drifts from the code.

| Variable | Meaning | Default |
|---|---|---|
| `SAP_GUI_MODE` | `open` = open `SAP_GUI_CONNECTION_NAME` itself; `attach` = use a SAP Logon window you already have open | `attach` |
| `SAP_GUI_CONNECTION_NAME` | the SAP Logon entry, exactly as listed (e.g. `QA1 - ERP Quality`) | |
| `SAP_CLIENT`, `SAP_USER`, `SAP_LANGUAGE` | logon screen values | |
| `SAP_PASSWORD` | **only in `.env.<name>.local` or a masked CI variable** | |
| `SAP_GUI_CONNECTION_INDEX` / `SAP_GUI_SESSION_INDEX` | which open connection/session, for `attach` | `0` / `0` |
| `SAP_GUI_CONNECTION_STRING` | open a system by connection string instead of a SAP Logon entry (`open` mode) | |
| `SAP_GUI_TIMEOUT_MS` | longest any single step waits | `30000` |
| `SAP_GUI_ROUNDTRIP_WAIT_MS` | after an action that should reach the server, how long to wait for the server's answer (round-trip counter / screen change) before asking whether SAP is idle; also the quiet period for actions that never reach it. `0` = the old "idle twice" check. Raise it on a slow link | `250` |
| `SAP_GUI_TRANSPORT` | `powershell` (default), `java` (the Java/JACOB helper in `bridge/jacob`, with `SAP_GUI_BRIDGE_JAR`, `SAP_GUI_JACOB_JAR`, `SAP_GUI_JACOB_DLL`, `SAP_GUI_JAVA`) or `remote` (the PowerShell bridge on a remote desktop host - see [SAP GUI on a remote desktop host](#sap-gui-on-a-remote-desktop-host); `SAP_GUI_REMOTE_BRIDGE_FILE` optional) | `powershell` |
| `SAP_USER_POOL` | comma list of users leased one per worker (open mode); `SAP_PASSWORD_<USER>` per user; `SAP_GUI_POOL_TIMEOUT_MS`, `SAP_GUI_POOL_DIR` | |
| `SAP_GUI_FALLBACKS` | `report` / `fail` / `off` - what to do when a locator fallback is used | `report` |
| `SAP_GUI_CLEANUP` | `off` keeps the data tests created | on |
| `SAP_GUI_CLEANUP_FAILURE` / `SAP_GUI_CLEANUP_TIMEOUT_MS` | `warn` = a failed cleanup is only recorded (default `fail`: the test fails and names what is left in SAP); longest one cleanup may run before it is asked to stop | `fail` / `60000` |
| `SAP_GUI_HOME_FAILURE` | `warn` = run the test even if the session could not be returned to the start screen (default `fail`) | `fail` |
| `SAP_GUI_INSIGHTS` / `SAP_GUI_INSIGHTS_DIR` | `off` disables recording of transactions and timings | on |
| `SAP_GUI_REUSE` | `worker` = one session per worker, reset between tests; `test` = a fresh connection per test | `worker` |
| `SAP_GUI_EVIDENCE` | `off` / `failure` (screenshot + journal on failure) / `steps` (also after every screen change) | `failure` |
| `SAP_GUI_EVIDENCE_DIR` | where screenshots are written before they are attached (and then deleted) | `test-results/sap-evidence` |
| `SAP_MULTIPLE_LOGON` | `continue` or `fail` when SAP says the user is already logged on | `continue` |
| `SAP_LOGON_FAILURE_COOLDOWN_MIN` | after SAP rejects a logon, the same client + user + password is not typed into SAP again for this many minutes (`0` = off) - see [Credentials and lock-out protection](#credentials-and-lock-out-protection) | `15` |
| `SAP_GUI_LOGON_MARKER_DIR` | folder of the marker that remembers the rejected logon (not under `test-results`: Playwright empties that every run) | `.sap-state` |
| `SAP_GUI_LOGON_PATH` | `saplogon.exe`, started in `open` mode if SAP Logon isn't running | `C:\Program Files (x86)\SAP\FrontEnd\SAPgui\saplogon.exe` |
| `SAP_GUI_POWERSHELL` | path to `powershell.exe`; a 32-bit SAP GUI needs `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe` | `powershell.exe` |
| `SAP_GUI_POWERSHELL_SCRIPT_DIR` | folder with an approved (typically signed) `sap-gui-bridge.ps1` (`npm run doctor -- --print-bridge \| Out-File -Encoding ascii sap-gui-bridge.ps1`, then sign it): it is run as it is and `-ExecutionPolicy Bypass` is NOT passed. A copy that differs from this version's script is refused. Without it the bridge runs from a temp file with `-ExecutionPolicy Bypass` for that one process | |
| `SAP_GUI_SIMULATOR` | `true` = use the built-in fake SAP (any OS) | `false` |
| `SAP_SAMPLE_TCODE` | transaction used by sample test 02 | `SU3` |
| `SAP_RUN_TEMPLATES` | `true` = run the `...TEMPLATE` tests against real SAP | `false` |

**Attach or open?** `attach` is the safe default on a shared system: it never creates or closes anyone's session, but a human has to have SAP Logon open and logged on. `open` is what a scheduled or CI run needs: it starts at the logon screen and `loggedInSap` logs on.

## 5. Writing tests

Start from `tests/sapgui/`: `01_connect_and_login` (smallest), `02_open_transaction`, `03_create_sales_order.TEMPLATE` (a whole flow) with its page objects in `pages/`.

**The rule of thumb: a test says *what* happens; a page object knows *where* (the ids); the framework handles *when* (waiting).**

**`sap` or `loggedInSap`?** Both are the worker's one session; they differ in where it starts. `sap` is the connection as it is: with `SAP_GUI_MODE=open` the **logon screen** (the fixture to use when the test itself types the logon, as a recording of the logon does). `loggedInSap` logs on first when SAP shows the logon screen (`SAP_USER`, `SAP_PASSWORD`, `SAP_CLIENT`, `SAP_LANGUAGE`) and leaves an already logged-on session alone - use it for hand-written tests and for recordings made inside SAP. Both come from the package's `sapGuiTest`; `tests/sapgui/support/sapTest.ts` simply re-exports it, and you extend it there with your own fixtures.

```ts
import { expect, test } from './support/sapTest';
import { EasyAccessPage } from './pages/EasyAccessPage';
import { CreateOrderInitialPage } from './pages/SalesOrderPages';

test('creates a standard sales order @sapgui', async ({ loggedInSap: sap }) => {
  await new EasyAccessPage(sap).open('VA01');
  const initial = await new CreateOrderInitialPage(sap).waitUntilDisplayed();
  const order = await initial.enter({ type: 'OR', salesOrg: '1000', channel: '10', division: '00' });

  await order.customer.fill('1000');                       // found by its label, "Sold-To Party"
  await order.addItem(0, { material: 'TG11', quantity: '5' });
  await sap.evidence('order filled in');                   // screenshot into the test report
  await order.save.click();                                // found by tooltip, "Save"

  await expect(sap).toHaveStatusMessage(/has been saved/i, { type: 'S' });   // retries until true
});
```

### Finding controls (locators)

| You write | Finds |
|---|---|
| `sap.locator('wnd[0]/usr/txtRSYST-BNAME')` | by technical id - what the recorder gives you |
| `sap.getByLabel('Sold-To Party')` | the input field next to that label |
| `sap.getByTooltip('Save')` | by tooltip (toolbar buttons) |
| `sap.getByText('Details')` | by text (buttons, tabs, menu entries) |
| `sap.getByType('GuiButton')` | by SAP class; add `{ name }` to narrow |
| `loc.locator('txtX[3,0]')` | a control inside another |
| `.first()` `.last()` `.nth(i)` | choose on purpose when several match |

Locators are **strict**: if more than one control matches, the action fails and lists them. Text matching is case-insensitive "contains"; pass `{ exact: true }` for the whole text. Ids are always the safest starting point; use label/tooltip/text where an id is unstable or readability matters (labels depend on SAP language and customising).

### Acting - chosen by what the control is

| Call | On a... | Does |
|---|---|---|
| `click()` | button | press |
| | tab, menu entry, radio button | select |
| | checkbox | toggle |
| | text field, drop-down | focus |
| `fill(value)` | text/password field | set the text (passwords are masked in logs) |
| | drop-down | choose the option (an invalid one fails and says so) |
| | checkbox / radio | tick (`'X'`, `'true'`) |
| `check()` `uncheck()` `setChecked(b)` | checkbox | idempotent |
| `text()` `value()` `tooltip()` `options()` `isChecked()` `isEditable()` `exists()` `count()` | any | read |
| `press()` `focus()` `sendKey(n)` `get(p)` `set(p, v)` `call(m, ...)` | any | the raw members, when you need them |

`fill()` refuses a read-only field with a message instead of typing into nothing. `fill(value, { checkMaxLength: true })` refuses text longer than the field allows **and reads the field back afterwards**: if SAP kept nothing or cut the value short (it does so without any error) the call fails naming what the field holds. SAP reformatting a value (upper case, leading zeros) is accepted, and a password field is never read back.

### Checking - assertions that wait

```ts
await expect(sap.getByLabel('Order Number')).toHaveText('4711');     // toContainText, toExist, toBeEditable, toBeChecked
await expect(sap).toHaveStatusMessage(/saved/i, { type: 'S' });      // S success  E error  W warning  I info  A abort
await expect(sap).toHaveTitle(/Create Standard Order/);
await expect(sap).toHaveNoStatusError();                              // no error (E) or abort (A) - after SAP has answered
```

They re-check until they hold or the timeout (default 5 s, `{ timeout }` to change) - SAP changes after a server round trip, so a one-shot read right after an action is a race. Everything from Playwright's `expect` works too (`expect.soft`, `.not`, ...). Import `expect` from the SAP module (`import { expect } from './support/sapTest'`, or `sapExpect`): Playwright's own `expect` has no `toExist`.

**When the control is not on the screen the message says what is.** `toExist`, `toHaveText`, `toContainText`, `toBeEditable` and `toBeChecked` append, after the usual `Expected` / `Received`:

```
On the screen now (wnd[0]): title "Customer: Overview", status bar "Enter a customer" [W], texts (6): "Addresses" (wnd[0]/usr/lblADDR), "General Data" (wnd[0]/usr/tabsT/tabpGEN), tooltip "Save (Ctrl+S)" (wnd[0]/tbar[0]/btn[11]), ...
Closest to "Address": "Addresses" (wnd[0]/usr/lblADDR)
A pop-up is in front (wnd[1], title "System Message") - the control may be behind it, or the flow took a different path. On the pop-up: texts (2): ...
```

It lists up to 25 labels, buttons, tabs, menu entries, check and radio buttons and group boxes with their ids (a toolbar button with no text shows its tooltip), then the controls closest to what you asked for - contained in it, or a typo or plural away - and the pop-up(s) in front. The walk has a time budget, the block a size limit, and it is built from the session's own `children` / `info` operations, so it works on every transport. **Passwords are never shown**, and neither is the value of any input field - only text a user reads. The same listing is appended to the message of an action (`click`, `fill`, ...) on a locator that matches nothing. Plain `getByText('Address')` matches any text that *contains* "Address" (case-insensitive); `{ exact: true }` wants the whole text.

`.not.toHaveStatusMessage(/./, { type: 'E' })` passes the moment the status bar is not an error - including on the old screen before SAP has answered. `toHaveNoStatusError()` (the BDD step *the status bar does not show an error*) first waits, bounded, for evidence that SAP has answered the last action - a status message of type S, I or W, or the screen / title / round-trip counter having moved - then checks for E **and** A, and fails if nothing at all is observed (an empty status bar on an unchanged screen proves nothing). `{ requireOutcome: false }` / the step *... does not show an error right now* checks the status bar as it is.

### Pop-ups you do not want in every test

```ts
sap.onPopup('system message', { title: /System Message/ }, (s) => s.press('wnd[1]/tbar[0]/btn[0]'));
```

Before each step, if a modal window is in front and a handler matches its title, the handler runs. A step aimed at the pop-up (`wnd[1]/...`) is never intercepted; `{ times: 1 }` handles it once; the call returns a function that removes the handler. Handlers are cleared between tests. Put ones every test needs in `tests/sapgui/support/sapTest.ts`.

### Grids, trees, table controls

```ts
const grid = sap.grid('wnd[0]/usr/cntlGRID1/shellcont/shell');
await grid.findRow('MATNR', 'TG11');   await grid.cell(0, 'MAKTX');   await grid.rows(['MATNR', 'MAKTX']);
await grid.selectRows(0, 2);           await grid.doubleClickCell(1, 'MATNR');
await sap.tree('wnd[0]/usr/cntlTREE/shellcont/shell').doubleClickNode('000012');
await sap.table('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG').cell('txtRV45A-KWMENG', 3, 0).fill('5');
```

### Session lifecycle: reuse, reset, evidence, journal

- **One SAP connection per worker**, reused by its tests. Before each test the session is health-checked (reconnected if SAP went away), modal windows are cancelled, and it returns to the start screen (`/n`). `SAP_GUI_REUSE=test` gives every test a fresh connection.
- A connection the framework **opened** is ended (`/nex`) when the worker finishes; one you **attached** to is never touched.
- **Evidence:** `await sap.evidence('label')` attaches a screenshot to the report. `SAP_GUI_EVIDENCE=steps` also captures after every screen-changing step; `off` disables failure diagnostics.
- **On failure** the report gets `sap-steps` (the step journal: what ran, how long, which step failed and why), `sap-status-bar`, and `sap-screenshot`.

### Credentials and lock-out protection

The password is looked up as `SAP_PASSWORD` in this order: real environment variable (CI: use a masked variable) -> `.env.<name>.local` -> a Windows-DPAPI-protected file. Create the last with `npm run secret -- set SAP_PASSWORD` (prompts, hidden): it can be opened only by the same Windows user on the same machine. Nothing stores a key beside a password. See `ARCHITECTURE.md` decision 10. A password with `#`, `$` or spaces must be in double quotes in the `.env` file (`SAP_PASSWORD="my#pass word"`); inside double quotes `\n` is read as a line break, so use single quotes for a password that contains a backslash.

**A wrong logon is counted by SAP, and a few of them lock the user.** A failed run is routinely started again - a CI retry, the next test of the same worker, a person pressing run once more - and each repetition is another wrong logon. So:

- **The failure says what to check.** The message of a logon that stays on the logon screen keeps SAP's own status text (`Name or password is incorrect (repeat logon)`) and adds: check `SAP_USER`, `SAP_CLIENT` and `SAP_PASSWORD` against what works in SAP Logon (a variable exported in your shell wins over the file); special characters need double quotes in the `.env` file; the user may be locked or its password expired (SU01); and the warning that repeated wrong logons **lock the SAP user** - do not run again until it is fixed.
- **It also stops the repeat.** After a logon that failed with *name or password incorrect* or *user is locked* (English and German texts), `logon()` writes a marker, `.sap-state/logon-failed.json`: client, user, a **salted fingerprint** of the password (never the password), SAP's status text and the time. For `SAP_LOGON_FAILURE_COOLDOWN_MIN` minutes (default **15**, `0` = off) a logon with the same client + user + password is refused *without typing anything into SAP*: `logon NOT attempted - it would have repeated a logon that SAP has just rejected ...`. That covers `loggedInSap`, `ensureLoggedIn`, CI retries and re-runs. A pop-up after logon (password expired, already logged on) does not arm it.
- **How to go on:** fix the credentials - a changed password, user or client does not match the marker, so the next run goes through at once (and a successful logon deletes the marker); or delete `.sap-state\logon-failed.json` once you know the password was reset or the user unlocked; or wait out the cooldown.
- The marker is **not** under `test-results`: Playwright empties that folder when a run starts, which would remove the marker exactly when the next run needs it. It lives in `SAP_GUI_LOGON_MARKER_DIR` (default `.sap-state`, git-ignored). A CI job starts from a clean checkout, so it protects retries inside the job; to stop re-runs across pipelines point `SAP_GUI_LOGON_MARKER_DIR` at a folder you cache between jobs.

### Finding ids

- **Record** with SAP GUI's *Script Recording and Playback* (Alt+F12 menu), save the `.vbs`, and either copy the ids or convert the whole thing (next section).
- **Inspect the live screen:** `npm run doctor -- --dump` lists every control with id and type; `npm run doctor -- --dump "wnd[1]"` does a pop-up.

## 5b. Advanced capabilities

Each of these is opt-in and tested against the simulator; none has been run against a real SAP GUI yet (see section 9).

### Know where SAP is, and what your tests cover
The session reads SAP's own session info after every screen change, so every journal line, failure and report says **which transaction, program and screen** SAP was on (`system FAKE, client 100 ... transaction VA01, screen 4001, program SAPMV45A`). Each test also appends its steps to `test-results/sap-insights/`; then:

```bash
node dist/cli/insights.js report --expected VA01,VA02,FB60   # transactions covered (and the expected ones nobody touched), slowest steps, SAP's own response times
node dist/cli/insights.js baseline                            # save this run's step timings from a known-good run
node dist/cli/insights.js check --baseline sap-baseline.json  # exit 1 if a step kind got clearly slower
```
The comparison is deliberately conservative (a change must be large in percent **and** milliseconds, with enough samples), so it tells you where to look; it is not a load test. `SAP_GUI_INSIGHTS=off` disables recording.

### Survive an id change, visibly
```ts
readonly customer = this.sap.locator('wnd[0]/usr/ctxtKUAGV-KUNNR').orElse(this.sap.getByLabel('Sold-To Party'));
```
If the id is gone but the label is there, the test continues **and the drift is reported** (attached to the test, listed in the insights report, with the id to put in the page object). The primary id gets a grace period first, so a slow screen is not mistaken for a changed id; an ambiguous fallback is never used. `SAP_GUI_FALLBACKS=fail` turns drift into a failure naming the new id (for a nightly drift check); `off` ignores fallbacks.

### Catch a screen change before a dozen tests fail
```ts
await expect(sap).toMatchScreenContract('va01-overview');   // compares with contracts/va01-overview.contract.json
```
```bash
npm run contracts -- capture va01-overview   # on the right screen, once; review and COMMIT the file
npm run contracts -- diff old.json new.json  # no SAP needed
```
A contract records the ids, types and fixed captions of a screen - never field values; table-cell positions are ignored. A control that disappeared or changed type fails, with where it probably moved; additions and caption changes pass unless `strict`. Update a baseline on purpose with `SAP_GUI_UPDATE_CONTRACTS=true` - on a workstation: when `CI` is set the update is **refused** (it would accept whatever screen SAP shows as the new baseline).

### Create data, and always clean it up
```ts
const orderNo = await sapData.captureFromStatusBar('SalesOrder', /Order (\d+) has been saved/, { cleanup: (s) => cancelOrder(s, orderNo) });
const customer = sapData.unique('CUST');   // time + counter + worker index + random: never collides with an earlier attempt or another worker
```
Cleanups run after the test - pass or fail, after every retry, newest first, one at a time on the session: a cleanup that runs out of time gets an abort signal (`(sap, { signal }) => ...`) and is awaited for a short grace period before the next one starts; if it never stops, the remaining cleanups are not attempted and are reported as failed. **A cleanup that fails, or an object recorded without one, fails the test** (and is a test annotation `sap-cleanup-failed`) - set `SAP_GUI_CLEANUP_FAILURE=warn` to only record it. `npm run data -- orphans` lists whatever could not be cleaned (exit 1); `sap-gui-data list --fail-on-orphans` does the same for the full list, `--require-data` exits 2 when no data directory exists (the SAP tests did not run), and a damaged list is exit 2 - so the command can gate a pipeline. `SAP_GUI_CLEANUP=off` keeps everything for inspection (those objects show as orphans).

### Run workers in parallel without "already logged on"
`SAP_USER_POOL=U1,U2,U3` (with `SAP_GUI_MODE=open`): each worker leases a distinct user (exclusive across processes on one machine, with a heartbeat and recovery from crashed runs) and `logon()` uses its own `SAP_PASSWORD_<USER>` or the shared `SAP_PASSWORD`. A file lock cannot coordinate several CI machines using the same users; give each machine its own users.

### SAP GUI on a remote desktop host

> **NOT VERIFIED on a real RDP host with real SAP GUI:** it was tested only against the utils stand-in agent and this repo's stand-in bridge. The Windows pieces (the PowerShell agent, `mstsc`, the real bridge on the host) have never run here; see [Verified / NOT verified](#9-what-has-and-has-not-been-verified).

**The picture - three hops.** Your laptop is only a window onto an AWS WorkSpace. The WorkSpace is the test machine: it runs Playwright and the browser that drives the UI app. SAP GUI is installed only on a remote Windows desktop host, reachable from the WorkSpace by RDP (port 3389) and nothing else. The utils remote client on the WorkSpace opens that RDP session and exchanges request files with an agent running inside it; the agent starts the SAP bridge there, because SAP GUI scripting only sees the **interactive** desktop session.

```
laptop  --(WorkSpaces display)-->  AWS WorkSpace: Playwright + browser (UI steps)
                                          |  SAP_GUI_TRANSPORT=remote: RemoteTransport -> RemoteHost client
                                          '--(nested RDP, drive-mailbox)-->  RDP host: agent -> PowerShell bridge -> SAP GUI
```

**Settings** (`.env.<name>`; secrets only in `.env.<name>.local`):

| Key | Meaning |
|---|---|
| `SAP_GUI_TRANSPORT=remote` | run the bridge on the remote host (attach mode; the session on the host is already logged on) |
| `REMOTE_ENABLED=true`, `REMOTE_RDP_HOST`, `REMOTE_RDP_USER`, `REMOTE_RDP_PASSWORD`, `REMOTE_ALLOW` (must include `sap`), `REMOTE_AGENT_START`, timeouts ... | the remote host itself - every key is in `../referenced-automation-utils/docs/REMOTE_DESKTOP.md` |
| `SAP_GUI_REMOTE_BRIDGE_FILE` | optional: path **on the remote host** of an approved/signed bridge script, run instead of the script text this package sends |
| `SAP_GUI_CONNECTION_INDEX`, `SAP_GUI_SESSION_INDEX`, `SAP_GUI_TIMEOUT_MS` ... | unchanged; they apply to SAP on the host |

Always one worker: there is one interactive desktop and the agent answers one request at a time. `playwright.config.ts` sets `workers: 1` for the remote transport (also with `SAP_GUI_MODE=open`), and the `sap` fixture refuses more than one worker.

**One test, UI steps and SAP steps.** The `sap` fixture and the ui package's `page` fixture live in the same `test`:

```ts
import { sapGuiTest as test } from '@automation/referenced-automation-sap';

test('order created in the UI shows up in SAP', async ({ page, sap }) => {
  await page.goto('/orders/new');                       // local: browser on the WorkSpace
  await page.getByRole('button', { name: 'Submit' }).click();
  const number = await page.getByTestId('order-number').innerText();
  await sap.setText('wnd[0]/tbar[0]/okcd', '/nVA03');   // remote: SAP GUI on the RDP host
  await sap.sendVKey(0);
  await sap.setText('wnd[0]/usr/ctxtVBAK-VBELN', number);
});
```

**Lifecycle.** The first test that needs SAP connects the remote host (opening the RDP session unless it is already up), starts the bridge there and attaches; `SAP_GUI_REUSE=worker` keeps that bridge for the worker's tests. When a test fails because the bridge or agent is gone, the health check notices (`ping` fails) and the next test reconnects through a fresh host. At the end of the worker the bridge process is stopped and this worker's use of the remote host is released (the last process out closes the session, per the utils rules). `npm run doctor -- --conformance` does the same for one run and prints which transport it ran.

**Requirements.** The RDP session on the host must stay **connected and unlocked** while tests run (a locked or disconnected session cannot be scripted; minimising the window is fine), and the tests must be started from an interactive logged-in desktop on the WorkSpace (`mstsc` needs one). Keep the WorkSpace session connected too.

**Troubleshooting.**

| You see | Likely cause | Do this |
|---|---|---|
| `SAP_GUI_TRANSPORT=remote needs the remote desktop host: set REMOTE_ENABLED=true` | the REMOTE_* settings are missing | set them (utils `docs/REMOTE_DESKTOP.md`); run `automation-remote doctor` |
| `... refused to start the SAP GUI bridge ... REMOTE_ALLOW must include "sap"` | `REMOTE_ALLOW` lacks `sap` | `REMOTE_ALLOW=http,db,sap` (do not add `exec` unless you need it) |
| `the remote desktop host's agent stopped answering` (`SESSION_LOST`) | the RDP window was closed, the session locked/disconnected/logged off, or the agent crashed | keep the session connected and unlocked; check the host's session time limits and `agent/agent.log` in the mailbox folder; the next test reconnects |
| `no reply to "..." within 60000ms ... the remote bridge was stopped` | SAP GUI shows a dialog that blocks scripting, or the agent is busy | look at the host's screen; later calls fail at once by design |
| `... did not become ready` | PowerShell is blocked on the host, or the session is not interactive | `automation-remote check`; try `SAP_GUI_REMOTE_BRIDGE_FILE` with an approved copy |
| `SAP_GUI_TRANSPORT=remote with 2 workers` | `--workers` / `WORKERS` above 1 | run with one worker |
| attaches but nothing is found | SAP Logon on the host is not open/logged on in the interactive session | log on in the RDP session first (attach mode) |

### Gherkin features (`playwright-bdd` 9.2.1)

The same SAP can be driven from business-readable features. The vocabulary is in the package (`registerSapSteps`), so every project says it the same way; the sample features in `features/` run against the simulator.

```gherkin
Scenario: The order number SAP reports can be used later
  Given I am logged on to SAP
  When I open transaction "VA01"
  And I enter "OR" in the field labelled "Order Type"
  And I enter "BDD-{{random:alnum(6)}}" in the field labelled "Customer Reference"
  And I click the toolbar button "Save"
  And I remember the number from the status bar matching "Order (\d+)" as "order"
  Then the status bar shows "Order {{order}} has been saved"
```

```ts
// features/steps/steps.ts
const { Given, When, Then } = createBdd(test);       // test = mergeTests(bddTest, sapGuiTest), see features/steps/fixtures.ts
registerDataSteps({ Given, Then });                   // from the UI package: variables, random data, dates, env
registerSapSteps({ Given, When, Then });
```

Every string in a step understands `{{placeholders}}` (`{{random:alnum(6)}}`, `{{date:+7d}}`, `{{env:X}}`, `{{uuid}}`, a saved value). A value remembered from the status bar is stored as `{{order}}` too, so in a project that also has the UI and API step libraries (see `referenced-automation-ui-api`) the next step can call an API or check a web page with it. `npm run test:bdd` runs only the features (not the ones tagged `@live`, which need the network). Steps that only this repo needs - the logon steps (`features/steps/logon.ts`) and the shopping cart steps (`features/steps/fiori.ts`) - live next to the shared ones in `features/steps/`; the README lists which behaviours are scenarios and which plain specs remain. Against a real SAP, delete the `sapGuiTransport` override in `features/steps/fixtures.ts` and set `SAP_GUI_MODE` / the `.env` files as for any other SAP test.

## 6. Converting recordings

```bash
cp my_recording.vbs recordings/
npm run convert              # -> tests/sapgui/my_recording.spec.ts
```

Review the generated header. It lists everything that needs a human. Add the assertion on the command line - `npm run convert -- --expect-text "Address" --expect-title "Standard Order" --expect-status "has been saved"` (any combination; `--expect-text` is repeatable) - or by hand afterwards.

| Option | Writes |
|---|---|
| `--expect-text <text>` (repeatable) | `await expect(sap.getByText('<text>').first()).toExist();` |
| `--expect-title <regex>` | `await expect(sap).toHaveTitle(/<regex>/i);` |
| `--expect-status <regex>` | `await expect(sap).toHaveStatusMessage(/<regex>/i);` |
| `--expect-import <module>` | where `sapExpect` (imported as `expect`) comes from. It is **always imported** - flat, page-object and data-driven tests alike - so an assertion added by hand works; without an assertion option the import is kept used by a `void expect;` line to delete once you add the check |
| `--fixture sap\|loggedInSap\|auto` | `async ({ sap })` or `async ({ loggedInSap: sap })`. `auto` (default): `sap` when the recording contains the logon (typing into the client / user / password / language fields, or into a password field before anything was typed inside SAP), `loggedInSap` when it does not - a recording made while logged on has no logon screen to start from |

Any of the three assertion options satisfies the "no assertion" guard and `--strict`. `--fixture loggedInSap` on a recording that logs on itself is reported as something to fix.

| Recorded | Result |
|---|---|
| `.text = ...`, `.press`, `.select`, `.setFocus`, `.sendVKey n`, `.selected = true`, `With` blocks, element variables, table-cell ids, chained access (`.columns.elementAt(1).width = 18`) | converted; the recorder's ids are kept unchanged |
| `WScript.Sleep n` | dropped (the session waits properly) |
| the connect-to-SAP preamble | dropped (the fixture attaches/opens) |
| typed passwords | **never copied** - replaced with `env.get('SAP_PASSWORD')`; `--param <id-regex>=<ENV_VAR>` does the same for any other field |
| `If` / `For` / `Do` / `Select Case` / `MsgBox` | **not guessed**: left as `// TODO(manual, vbs:N)` with the original line, everything inside the block held back. `--strict` exits non-zero so CI cannot miss it |
| a variable inside a chained path (`getAbsoluteRow(i)`) | TODO |

**Change a value or an id in one place.** A converted test starts with two objects and its steps only refer to them:

```ts
const CONSTANTS = {                        // what the recording typed; secrets and settings are environment getters
  inputs: {
    get logonPassword() { return env.get('SAP_PASSWORD'); },
    get logonUser() { return env.get('SAP_USER', 'TESTUSER'); },
    vbakAuart: 'OR',  vbakVkorg: '1000',  transaction: 'VA01',
  },
};
const LOCATORS = {                         // every control id, named once
  logonUser: 'wnd[0]/usr/txtRSYST-BNAME',
  vbakAuart: 'wnd[0]/usr/ctxtVBAK-AUART',
  toolbarButton11: 'wnd[0]/tbar[0]/btn[11]',
};
await sap.setText(LOCATORS.vbakAuart, CONSTANTS.inputs.vbakAuart);
```

Another order type: change `inputs.vbakAuart`. A screen was customised and the id moved: fix `LOCATORS.vbakAuart` once. The same value typed into the same control is one entry; a different value is another (`vbakAuart2`). With `--page-objects` both objects are exported from the top of `pages/<Name>Pages.ts` and the page classes are built from them; `--inline` writes ids and values in the steps instead.

**More than a flat script:**
- `npm run convert:pages` (`--page-objects`) cuts the recording into **screens** at every server round trip: one page class per screen with named properties, a shared base for the command field, toolbar and status bar, table-control helpers, and a test that waits for each page. Names are mechanical (`Screen1`, `vbakAuart`) - rename them to business terms.
- `npm run convert:data` (`--data`, implies page objects) turns every literal typed in the recording into a column of `<name>.data.csv` and runs **one test per row**; the first row holds what was recorded. User, client, password and language still come from the environment, never the CSV; a missing column fails with its name.
- `--out` is a folder unless it ends in `.ts`. See `tests/gui/generated/` for a committed example that a test keeps in step with the converter.

**A recording contains the password you typed, in clear text.** The converter keeps it out of the spec, but do not commit the `.vbs` file itself if it has one.

## 7. Troubleshooting

| You see | Likely cause | Do this |
|---|---|---|
| Test **skipped**: "needs Windows with SAP GUI installed" | not running on Windows | run on the Windows machine; `npm run try:simulator` to practise anywhere |
| `SAP Logon is not running, so there is no SAP GUI scripting engine` | `attach` mode and SAP Logon is closed | open SAP Logon and log on; or use `SAP_GUI_MODE=open` |
| `scripting engine did not appear within 60 seconds` | scripting disabled in the client | section 3, step 1 |
| `SAP_GUI_LOGON_PATH does not exist` | SAP GUI installed elsewhere | set `SAP_GUI_LOGON_PATH` |
| bridge does not start / script blocked | PowerShell execution policy on the machine | `SAP_GUI_POWERSHELL`, or ask IT to allow the printed bridge script (`--print-bridge`) |
| attaches but every step fails with COM errors | 32-bit SAP GUI with 64-bit PowerShell | set `SAP_GUI_POWERSHELL` to the SysWOW64 `powershell.exe` |
| a pop-up asks "a script is trying to attach..." and the run hangs | notify options still ticked | section 3, step 1 |
| `SAP_USER and SAP_PASSWORD must both be set` | credentials not configured | put them in `.env.<name>.local`, export them, or `npm run secret -- set SAP_PASSWORD` |
| `... is ambiguous: N controls match (...)` | a label/text/tooltip locator matches several controls | narrow it (`type`, `exact`, a more specific label) or `.first()` on purpose |
| `no control matched label "..."` | wrong label/language, or the screen is not the one you think | `npm run doctor -- --dump`; labels follow the SAP logon language |
| steps fail because a pop-up is in front | an unexpected modal window | `sap.onPopup(...)` once; see the `sap-steps` attachment to find which step first failed |
| `could not unprotect ... .dpapi` | the secret file was made by another Windows user or on another machine | run `npm run secret -- set SAP_PASSWORD` as the user that runs the tests |
| `still on the logon screen after sending Enter. SAP's status bar says: "Name or password is incorrect (repeat logon)"` | wrong credentials/client, a `#` in the password that was not in double quotes, or a locked user | the message lists what to check; **do not re-run until fixed** - repeated wrong logons lock the user ([lock-out protection](#credentials-and-lock-out-protection)) |
| `logon NOT attempted - it would have repeated a logon that SAP has just rejected` | the same client + user + password was rejected less than `SAP_LOGON_FAILURE_COOLDOWN_MIN` minutes ago | change the credentials (clears it at once), delete `.sap-state/logon-failed.json` if you fixed it in SAP, or wait |
| `On the screen now (wnd[0]): ...` at the end of a failed assertion | the control is not on the screen: this is the listing of what is | compare the ids and the `Closest to ...` line with what you asked for; a pop-up in front is named too |
| `TypeError: expect(...).toExist is not a function` | `expect` came from `@playwright/test` | import the SAP one: `import { expect } from './support/sapTest'` |
| `SAP showed a pop-up after logon` | already logged on elsewhere, or password expired | `npm run doctor -- --dump "wnd[1]"` while it shows; handle it in your base test |
| `"wnd[0]/usr/..." not found after 30000ms. Nearest id that does exist ...` | wrong id, or the flow took a different path (an unexpected pop-up or screen) | read the "contains:" list and the status bar text in the message; `--dump` the screen; re-record |
| a converted test starts on the logon screen and cannot find `wnd[0]/tbar[0]/okcd` | it was recorded while logged on but uses `{ sap }` | regenerate (`--fixture auto` picks `loggedInSap`) or change the argument to `{ loggedInSap: sap }` |
| a converted recording works once, then fails | it depends on data the first run changed | make the test create or choose its own data |
| `TODO(manual ...)` in a generated spec | the recording had logic | write that part by hand with `sap.*` |

On any failure the report attaches the status bar text and a screenshot of the SAP window.

## 8. Running in CI

- **The framework's own tests** (`npm run test:framework`) need no SAP and run on the normal Linux job - they use the simulator.
- **Real SAP tests** need a Windows runner with SAP GUI and a logon session. `.gitlab-ci.yml` has a manual `sapgui` job as a template; read its comment first (placeholder runner tag, shell, tarballs in `../shared-packages`, masked `SAP_PASSWORD`). Use `SAP_GUI_MODE=open` there.
- Run `npm run convert` (it passes `--strict`) in a pipeline if you want unconverted logic to fail the build rather than slip through.

## 9. What has and has not been verified

**Reported from a real machine** (by the person who ran it, not by this repository's tests): the Java/JACOB bridge passed its 15 conformance checks (`npm run conformance`) on one real Windows machine with SAP GUI, and a real logon, a transaction and a recording were exercised by hand there. Nothing else is claimed: other SAP GUI releases, the PowerShell bridge on other machines and the remote-desktop path are still unverified.

Verified, on macOS without SAP: the parser and generator (including a realistic VA01 recording), the session's waiting and error messages against a simulator with screen-change latency, the logon helper's failure paths, password handling (not in specs, not in logs), the CLI, screen inspection, the sample tests against the simulator, and that the bridge script is ASCII-only and its only `Start-Process` is the SAP Logon launch.

**Not verified until run on Windows with SAP GUI:** the PowerShell bridge itself, **the whole remote-desktop path (`SAP_GUI_TRANSPORT=remote`: tested only against the utils stand-in agent and the stand-in bridge - never on a real RDP host, agent or SAP GUI; in particular that the real agent hands over the bridge's ready line when sent a blank line, which the transport relies on)**, SAP Logon auto-start, COM behaviour on your SAP release, and that any particular recording replays on your system. Run `npm run doctor` first, then one real recording, and treat anything the doctor or a failure message does not explain as a bug to report.

## 10. Limits

- One session per test; a recording that opens a second session (`createSession`) needs hand work.
- Dialogs outside SAP's own windows (file pickers, Windows security prompts) are not reachable by SAP GUI Scripting.
- SAP GUI for HTML / WebGUI and Fiori are browser apps - use the Playwright/Fiori half of this repo for those.
- The simulator knows only the screens it is given. It proves the framework, not that your recording matches your SAP.
