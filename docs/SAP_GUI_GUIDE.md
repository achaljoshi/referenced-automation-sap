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
- **The bridge** (`src/gui/bridgeScript.ts`) is a short PowerShell script that does exactly what a recorded VBScript does: find a control by id, read/write a property, call a method. `npx sap-gui-doctor --print-bridge` prints it, for anyone who has to approve a script before it runs on a managed desktop. It makes no network calls and installs nothing; the one program it can start is SAP Logon, from a path you configure.
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
5. **Check:** `npm run doctor`. It does what the tests will do and prints OK/FAIL per step with the fix.

## 4. Configuration

Settings come from `.env.<name>` (committed, **no secrets**), overridden by `.env.<name>.local` (git-ignored, for secrets), overridden by real environment variables (CI). Pick the file with `ENV=qa` (the default is `qa`).

| Variable | Meaning | Default |
|---|---|---|
| `SAP_GUI_MODE` | `open` = open `SAP_GUI_CONNECTION_NAME` itself; `attach` = use a SAP Logon window you already have open | `attach` |
| `SAP_GUI_CONNECTION_NAME` | the SAP Logon entry, exactly as listed (e.g. `QA1 - ERP Quality`) | |
| `SAP_CLIENT`, `SAP_USER`, `SAP_LANGUAGE` | logon screen values | |
| `SAP_PASSWORD` | **only in `.env.<name>.local` or a masked CI variable** | |
| `SAP_GUI_CONNECTION_INDEX` / `SAP_GUI_SESSION_INDEX` | which open connection/session, for `attach` | `0` / `0` |
| `SAP_GUI_CONNECTION_STRING` | open a system by connection string instead of a SAP Logon entry (`open` mode) | |
| `SAP_GUI_TIMEOUT_MS` | longest any single step waits | `30000` |
| `SAP_GUI_REUSE` | `worker` = one session per worker, reset between tests; `test` = a fresh connection per test | `worker` |
| `SAP_GUI_EVIDENCE` | `off` / `failure` (screenshot + journal on failure) / `steps` (also after every screen change) | `failure` |
| `SAP_MULTIPLE_LOGON` | `continue` or `fail` when SAP says the user is already logged on | `continue` |
| `SAP_GUI_LOGON_PATH` | `saplogon.exe`, started in `open` mode if SAP Logon isn't running | `C:\Program Files (x86)\SAP\FrontEnd\SAPgui\saplogon.exe` |
| `SAP_GUI_POWERSHELL` | path to `powershell.exe`; a 32-bit SAP GUI needs `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe` | `powershell.exe` |
| `SAP_GUI_SIMULATOR` | `true` = use the built-in fake SAP (any OS) | `false` |
| `SAP_SAMPLE_TCODE` | transaction used by sample test 02 | `SU3` |
| `SAP_RUN_TEMPLATES` | `true` = run the `...TEMPLATE` tests against real SAP | `false` |

**Attach or open?** `attach` is the safe default on a shared system: it never creates or closes anyone's session, but a human has to have SAP Logon open and logged on. `open` is what a scheduled or CI run needs: it starts at the logon screen and `loggedInSap` logs on.

## 5. Writing tests

Start from `tests/sapgui/`: `01_connect_and_login` (smallest), `02_open_transaction`, `03_create_sales_order.TEMPLATE` (a whole flow) with its page objects in `pages/`.

**The rule of thumb: a test says *what* happens; a page object knows *where* (the ids); the framework handles *when* (waiting).**

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

`fill()` refuses a read-only field with a message instead of typing into nothing. `fill(value, { checkMaxLength: true })` refuses text longer than the field allows.

### Checking - assertions that wait

```ts
await expect(sap.getByLabel('Order Number')).toHaveText('4711');     // toContainText, toExist, toBeEditable, toBeChecked
await expect(sap).toHaveStatusMessage(/saved/i, { type: 'S' });      // S success  E error  W warning  I info  A abort
await expect(sap).toHaveTitle(/Create Standard Order/);
await expect(sap).not.toHaveStatusMessage(/./, { type: 'E' });       // no error message
```

They re-check until they hold or the timeout (default 5 s, `{ timeout }` to change) - SAP changes after a server round trip, so a one-shot read right after an action is a race. Everything from Playwright's `expect` works too (`expect.soft`, `.not`, ...).

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

### Credentials

The password is looked up as `SAP_PASSWORD` in this order: real environment variable (CI: use a masked variable) -> `.env.<name>.local` -> a Windows-DPAPI-protected file. Create the last with `npx sap-gui-secret set SAP_PASSWORD` (prompts, hidden): it can be opened only by the same Windows user on the same machine. Nothing stores a key beside a password. See `ARCHITECTURE.md` decision 10.

### Finding ids

- **Record** with SAP GUI's *Script Recording and Playback* (Alt+F12 menu), save the `.vbs`, and either copy the ids or convert the whole thing (next section).
- **Inspect the live screen:** `npm run doctor -- --dump` lists every control with id and type; `npm run doctor -- --dump "wnd[1]"` does a pop-up.

## 6. Converting recordings

```bash
cp my_recording.vbs recordings/
npm run convert              # -> tests/sapgui/my_recording.spec.ts
```

Review the generated header. It lists everything that needs a human.

| Recorded | Result |
|---|---|
| `.text = ...`, `.press`, `.select`, `.setFocus`, `.sendVKey n`, `.selected = true`, `With` blocks, element variables, table-cell ids, chained access (`.columns.elementAt(1).width = 18`) | converted; the recorder's ids are kept unchanged |
| `WScript.Sleep n` | dropped (the session waits properly) |
| the connect-to-SAP preamble | dropped (the fixture attaches/opens) |
| typed passwords | **never copied** - replaced with `env.get('SAP_PASSWORD')`; `--param <id-regex>=<ENV_VAR>` does the same for any other field |
| `If` / `For` / `Do` / `Select Case` / `MsgBox` | **not guessed**: left as `// TODO(manual, vbs:N)` with the original line, everything inside the block held back. `--strict` exits non-zero so CI cannot miss it |
| a variable inside a chained path (`getAbsoluteRow(i)`) | TODO |

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
| `SAP_USER and SAP_PASSWORD must both be set` | credentials not configured | put them in `.env.<name>.local`, export them, or `npx sap-gui-secret set SAP_PASSWORD` |
| `... is ambiguous: N controls match (...)` | a label/text/tooltip locator matches several controls | narrow it (`type`, `exact`, a more specific label) or `.first()` on purpose |
| `no control matched label "..."` | wrong label/language, or the screen is not the one you think | `npm run doctor -- --dump`; labels follow the SAP logon language |
| steps fail because a pop-up is in front | an unexpected modal window | `sap.onPopup(...)` once; see the `sap-steps` attachment to find which step first failed |
| `could not unprotect ... .dpapi` | the secret file was made by another Windows user or on another machine | run `npx sap-gui-secret set SAP_PASSWORD` as the user that runs the tests |
| `still on the logon screen ... Status bar: "Name or password is incorrect"` | wrong credentials/client | fix them; watch for locking the user after repeated failures |
| `SAP showed a pop-up after logon` | already logged on elsewhere, or password expired | `npm run doctor -- --dump "wnd[1]"` while it shows; handle it in your base test |
| `"wnd[0]/usr/..." not found after 30000ms. Nearest id that does exist ...` | wrong id, or the flow took a different path (an unexpected pop-up or screen) | read the "contains:" list and the status bar text in the message; `--dump` the screen; re-record |
| a converted recording works once, then fails | it depends on data the first run changed | make the test create or choose its own data |
| `TODO(manual ...)` in a generated spec | the recording had logic | write that part by hand with `sap.*` |

On any failure the report attaches the status bar text and a screenshot of the SAP window.

## 8. Running in CI

- **The framework's own tests** (`npm run test:framework`) need no SAP and run on the normal Linux job - they use the simulator.
- **Real SAP tests** need a Windows runner with SAP GUI and a logon session. `.gitlab-ci.yml` has a manual `sapgui` job as a template; read its comment first (placeholder runner tag, shell, tarballs in `../shared-packages`, masked `SAP_PASSWORD`). Use `SAP_GUI_MODE=open` there.
- Run `npm run convert -- --strict`-style conversions in a pipeline if you want unconverted logic to fail the build rather than slip through.

## 9. What has and has not been verified

Verified, on macOS without SAP: the parser and generator (including a realistic VA01 recording), the session's waiting and error messages against a simulator with screen-change latency, the logon helper's failure paths, password handling (not in specs, not in logs), the CLI, screen inspection, the sample tests against the simulator, and that the bridge script is ASCII-only and its only `Start-Process` is the SAP Logon launch.

**Not verified until run on Windows with SAP GUI:** the PowerShell bridge itself, SAP Logon auto-start, COM behaviour on your SAP release, and that any particular recording replays on your system. Run `npm run doctor` first, then one real recording, and treat anything the doctor or a failure message does not explain as a bug to report.

## 10. Limits

- One session per test; a recording that opens a second session (`createSession`) needs hand work.
- Dialogs outside SAP's own windows (file pickers, Windows security prompts) are not reachable by SAP GUI Scripting.
- SAP GUI for HTML / WebGUI and Fiori are browser apps - use the Playwright/Fiori half of this repo for those.
- The simulator knows only the screens it is given. It proves the framework, not that your recording matches your SAP.
