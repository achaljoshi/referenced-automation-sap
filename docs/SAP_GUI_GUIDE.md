# SAP GUI automation guide

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
| `SAP_GUI_TIMEOUT_MS` | longest any single step waits | `30000` |
| `SAP_GUI_LOGON_PATH` | `saplogon.exe`, started in `open` mode if SAP Logon isn't running | `C:\Program Files (x86)\SAP\FrontEnd\SAPgui\saplogon.exe` |
| `SAP_GUI_POWERSHELL` | path to `powershell.exe`; a 32-bit SAP GUI needs `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe` | `powershell.exe` |
| `SAP_GUI_SIMULATOR` | `true` = use the built-in fake SAP (any OS) | `false` |
| `SAP_SAMPLE_TCODE` | transaction used by sample test 02 | `SU3` |
| `SAP_RUN_TEMPLATES` | `true` = run the `...TEMPLATE` tests against real SAP | `false` |

**Attach or open?** `attach` is the safe default on a shared system: it never creates or closes anyone's session, but a human has to have SAP Logon open and logged on. `open` is what a scheduled or CI run needs: it starts at the logon screen and `loggedInSap` logs on.

## 5. Writing tests

Start from `tests/sapgui/`: `01_connect_and_login` (smallest), `02_open_transaction`, `03_create_sales_order.TEMPLATE` plus `support/salesOrder.ts` (a business flow wrapped in functions).

```ts
import { expect, test } from './support/sapTest';

test('display a sales order @sapgui', async ({ loggedInSap: sap }) => {
  await sap.startTransaction('VA03');
  await sap.setText('wnd[0]/usr/ctxtVBAK-VBELN', '4711');
  await sap.sendVKey(0);                     // 0 Enter, 3 Back, 8 Execute, 11 Save, 12 Cancel
  expect(await sap.statusBarText()).not.toMatch(/does not exist/i);
});
```

| Call | Does |
|---|---|
| `setText(id, value)` / `getText(id)` | type into / read a field |
| `press(id)` / `select(id)` / `setFocus(id)` | click a button / pick a tab or menu entry / focus |
| `setSelected(id, bool)` | tick a checkbox or radio button |
| `sendVKey(n)` | a virtual key to the main window |
| `startTransaction(tcode)` | like typing `/n<tcode>` + Enter |
| `statusBarText()` | the message at the bottom of the screen |
| `exists(id)` | is the control on this screen right now (does not wait) |
| `get(id, prop)` / `set(id, prop, value)` | any property; `prop` may reach through objects: `'columns.elementAt(1).width'` |
| `call(id, method, ...args)` | any method of the SAP GUI Scripting API |
| `logon(sap)` / `ensureLoggedIn(sap)` | the standard logon screen from `SAP_*` variables |

Keep ids in functions (like `support/salesOrder.ts`), not scattered through tests: when SAP changes a screen you fix one place. **Do not add sleeps** - the session already waits.

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
| `SAP_USER and SAP_PASSWORD must both be set` | credentials not configured | put them in `.env.<name>.local` |
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
