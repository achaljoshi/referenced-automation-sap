# referenced-automation-sap

SAP automation on Playwright, in two halves that share one test runner, one logger and one report:

- **Fiori / UI5** (browser) - reuses [`referenced-automation-ui`](../referenced-automation-ui)'s `actions` wholesale, plus two helpers a UI5 app needs (`byControlId`, `waitForUI5Ready`). See [Fiori helpers](#fiori-helpers).
- **Classic SAP GUI** (the Windows desktop client) - takes the `.vbs` files the SAP GUI Scripting recorder produces and converts them into Playwright tests that wait for SAP by themselves. See [Classic SAP GUI: recordings to Playwright](#classic-sap-gui-recordings-to-playwright).

## Fiori helpers

```ts
import { actions } from '@automation/referenced-automation-ui';
import { byControlId, waitForUI5Ready } from '@automation/referenced-automation-sap';
import type { Page } from '@playwright/test';

async function clickAddToCart(page: Page) {
  await actions.click(byControlId(page, 'addToCartBtn'));
  await waitForUI5Ready(page);
}
```

| Function | Why UI5 needs it |
|---|---|
| `byControlId(page, logicalId)` | UI5 renders a control's DOM id as an auto-generated view/component path **plus** the developer-assigned logical id you gave it in the view - e.g. a button with `id="addToCartBtn"` inside a view UI5 auto-names `container-cart---welcomeView` renders as `id="container-cart---welcomeView--addToCartBtn"`. Matching the logical id as a suffix (`[id$="addToCartBtn"]`) survives that auto-generated prefix changing between app reloads/versions, which a full/exact id match never would. |
| `waitForUI5Ready(page)` | UI5 shows a busy indicator while fetching data/re-rendering; interacting before it clears is a common source of flaky UI5 test automation. Waits for every busy-indicator element to disappear, then for network idle. |

Where a control has a proper ARIA role/label - most standard `sap.m` controls do - prefer Playwright's own `page.getByRole()`/`getByLabel()` over `byControlId`; they're more resilient. `byControlId` is for the custom/compound controls that don't expose one. `tests/support/FioriCartPage.ts` shows both used side by side against a real app, composed into a page object factory function the same way `referenced-automation-ui`'s own page objects are - see that repo's README for the pattern.

## Quick start

```bash
./scripts/setup.sh      # npm ci + playwright install --with-deps chromium (scripts/setup.bat on Windows)
npm test
```

`setup.sh`/`setup.bat` work from a completely fresh clone of the whole repo family, in any order: this repo depends on `referenced-automation-utils` and `referenced-automation-ui`, so setup builds whichever of their tarballs don't already exist in `../shared-packages` automatically, from `../referenced-automation-utils` and `../referenced-automation-ui` in that order (cloning nothing on its own - those sibling repos must already be checked out next to this one).

## Verifying this repo's own tests

Two things are tested, deliberately kept separate:

1. **`tests/fioriPage.spec.ts`** - `byControlId`/`waitForUI5Ready` against a small local fixture (`tests/support/fioriStyleFixture.html`) that mimics UI5's id-prefixing convention. Deterministic, no network dependency, no flake risk.
2. **`tests/fioriCart.spec.ts`** - a real integration test against SAP's own publicly hosted [Shopping Cart SAPUI5 demo kit app](https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html) (credential-free, officially SAP-maintained - not a random third party). Every selector in `tests/support/FioriCartPage.ts` was confirmed against a live render before being written, not guessed from documentation. Its "Promoted Items" panel rotates contents between loads, so the test asserts the shape of the cart total, not one hardcoded value.

## Environments

Same `.env.<name>` + `ENV=<name>` pattern as the rest of this family (see `referenced-automation-utils`'s README). `playwright.config.ts` reads `BASE_URL`/`HEADLESS` from the active env file.

## Allure reporting

Every test run writes raw results to `allure-results/` via the `allure-playwright` reporter (pure JS/TS, no extra runtime needed). Turning those into the viewable HTML report needs a JRE on `PATH` (Allure's report generator is a Java tool) - that's why it's a separate step, not part of `npm test` itself:

```bash
npm test               # also writes allure-results/
npm run allure:report  # generates allure-report/ and opens it in a browser
```

## Distributing this package

```bash
./scripts/create-package.sh   # writes ../shared-packages/referenced-automation-sap-<version>.tgz
```

## IDE setup

Same as the other repos in this family: VS Code prompts for recommended extensions on open; IntelliJ/WebStorm ships ESLint/Prettier wired in plus an `npm: test` run configuration.

## Classic SAP GUI: recordings to Playwright

SAP GUI's built-in **Script Recording and Playback** writes a VBScript of what you clicked and typed, addressing every control by its technical id (`wnd[0]/usr/txtRSYST-BNAME`). The old Java framework drove those same ids through JACOB. This does the same through a small PowerShell bridge, and converts the recording for you:

```
 recording.vbs --sap-vbs-to-playwright--> recording.spec.ts --playwright test--> SapGuiSession --PowerShell/COM--> SAP GUI
```

> The full guide - how it works, configuration, troubleshooting table, CI, limits - is in [`docs/SAP_GUI_GUIDE.md`](docs/SAP_GUI_GUIDE.md). Design decisions and trade-offs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Advanced capabilities (insights, drift-reporting fallbacks, screen contracts, data cleanup, user pool, Java/JACOB transport, page-object and data-driven conversion): [guide section 5b](docs/SAP_GUI_GUIDE.md#5b-advanced-capabilities). Coming from the Java/JACOB framework: [`docs/MIGRATION_FROM_JAVA.md`](docs/MIGRATION_FROM_JAVA.md).

### Getting started with SAP GUI (first time, from zero)

**What library opens SAP GUI? None you need to install or learn.** SAP GUI itself has a built-in automation interface (SAP GUI Scripting, a Windows COM API - the same thing the old Java framework drove through JACOB). This repo talks to it through a small PowerShell bridge that ships inside it, and Playwright is only the *test runner* (reporting, retries, parallelism, `expect`). You write plain TypeScript with a `sap` object.

**Try it right now, with no SAP and on any OS** - a built-in fake SAP runs the three sample tests so you can see what they do:

```bash
npm install
npm run build
npm run try:simulator            # runs tests/sapgui/*.spec.ts against the fake SAP
```

**Then point the same tests at your real SAP** (needs a Windows machine with SAP GUI installed):

1. **Enable scripting, once.** SAP GUI > Options > Accessibility & Scripting > Scripting: tick *Enable scripting*, and **untick** both "Notify when a script attaches..." / "...opens a connection" (those pop-ups stall a run). Your SAP Basis team must also allow it on the server (`sapgui/user_scripting = TRUE`).
2. **Say where SAP is.** Edit `.env.qa` (or `dev`/`stage`): set `SAP_GUI_CONNECTION_NAME` to the entry exactly as it appears in SAP Logon (e.g. `QA1 - ERP Quality`), `SAP_CLIENT`, `SAP_USER`. Then create **`.env.qa.local`** (git ignores it) containing only the secret: `SAP_PASSWORD=your-password`. `SAP_GUI_MODE=open` makes the test open that connection itself (and start SAP Logon if it isn't running); `attach` instead uses a SAP Logon window you already have open and logged in.
3. **Check the machine:** `npm run build && npm run doctor`. It does what the tests will do (opens the connection in `open` mode, or attaches in `attach` mode) and each line says OK or FAIL and what to fix.
4. **Run the first test:** `npm run test:sapgui -- 01_` - it logs on and checks it landed on SAP Easy Access. If it passes, the connection, credentials and scripting setup are all correct. Run `ENV=dev npm run test:sapgui` to use `.env.dev` instead.
5. **Run the rest:** `npm run test:sapgui` (`02_open_transaction` opens the transaction in `SAP_SAMPLE_TCODE`; `03_...TEMPLATE` stays skipped until you adapt it - see below).

**The three sample tests** (`tests/sapgui/`) are the pattern to copy:

| File | Shows |
|---|---|
| `01_connect_and_login.spec.ts` | the smallest test: the `loggedInSap` fixture logs on for you; read a window title; check a control exists |
| `02_open_transaction.spec.ts` | `startTransaction`, reading the status bar (`E` = error), configuring a test from `.env` |
| `03_create_sales_order.TEMPLATE.spec.ts` + `pages/` | a business flow written with page objects: ids in one place, label/tooltip locators, table-control cells, a pop-up handler, evidence, a retrying status-bar assertion |

**How to write your own test** - copy a sample and use these (every call waits for SAP by itself; never add a sleep):

```ts
import { expect, test } from './support/sapTest';

test('my flow @sapgui', async ({ loggedInSap: sap }) => {
  await sap.startTransaction('VA03');                              // like typing /nVA03 + Enter
  await sap.getByLabel('Order').fill('4711');                      // find a field by the label you see
  await sap.sendVKey(0);                                           // Enter   (3 Back, 8 Execute, 11 Save, 12 Cancel)
  await sap.getByTooltip('Display').click();                       // click picks press / select / toggle by control type
  await expect(sap).toHaveStatusMessage(/saved/i, { type: 'S' });  // assertions retry until true
  await sap.evidence('order displayed');                           // screenshot into the report
});
```

Put the ids in a page object (`tests/sapgui/pages/`) once you have more than a couple - a lint warning reminds you. The full list of locators, actions, assertions, grids/trees and pop-up handlers is in [`docs/SAP_GUI_GUIDE.md`](docs/SAP_GUI_GUIDE.md#5-writing-tests).

**Finding the ids** (the `wnd[0]/usr/...` strings) - two ways, no guessing:
- **Record it:** with SAP GUI's own *Script Recording and Playback* (in the **Alt+F12** menu), record yourself doing the flow, save the `.vbs`, drop it in `recordings/` and run `npm run convert` (below). You get a finished test.
- **Look at the screen:** open the screen in SAP, then `npm run doctor -- --dump` prints every control on it with its id and type (`npm run doctor -- --dump "wnd[1]"` for a pop-up). Copy the id into `sap.setText(...)`.

### Convert a recording

```bash
npm run build
cp ~/Documents/SAP/SAP\ GUI/my_recording.vbs recordings/
npm run convert                                   # recordings/*.vbs -> tests/sapgui/*.spec.ts
# or one file, with options:
npx sap-vbs-to-playwright recordings/my_recording.vbs --out tests/sapgui --strict
```

What a converted line looks like - the recorder's ids are used **unchanged**:

```vbs
session.findById("wnd[0]/usr/txtRSYST-BNAME").text = "JDOE"
session.findById("wnd[0]").sendVKey 0
session.findById("wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG").columns.elementAt(1).width = 18
```
```ts
await sap.setText('wnd[0]/usr/txtRSYST-BNAME', env.get('SAP_USER', 'JDOE')); // vbs:1
await sap.sendVKey(0); // vbs:2
await sap.set('wnd[0]/usr/tblSAPMV45ATCTRL_U_ERF_AUFTRAG', 'columns.elementAt(1).width', 18); // vbs:3
```

See [`examples/va01_create_order.vbs`](examples/va01_create_order.vbs) and the spec generated from it, [`tests/gui/va01_create_order.spec.ts`](tests/gui/va01_create_order.spec.ts).

Options: `--out`, `--test-import <module>` (your own base test, to add project fixtures), `--param <id-regex>=<ENV_VAR>` (read a field from the environment), `--tag`, `--keep-session-prefix`, `--no-line-comments`, `--strict` (exit 1 if anything needs a human - use it in CI).

### Why the converted test doesn't fail the way a raw recording does

A recording has **no waits**: it works when you record it (you were slow), and fails when it runs at machine speed because the next screen isn't there yet. `SapGuiSession` fixes that in one place instead of in every script:

- before every step it waits for SAP to be idle **and** for the element to exist;
- after a step that triggers a server round trip (`press`, `sendVKey`, `startTransaction`, ...) it waits for SAP to settle;
- a "not found" while the screen is mid-change is retried until the timeout, not failed;
- `WScript.Sleep` lines are dropped - a fixed sleep is too short on a slow day and too slow on every other;
- a real failure tells you what **is** on the screen (nearest id that exists, what it contains, the status bar text) so the recording can be repaired without opening SAP;
- every step is logged like the rest of the framework (worker + correlation id, timings), **passwords masked**.

`tests/gui/session.spec.ts` proves this against a simulated SAP that models screen-change latency, and includes a *negative control*: the same steps without the session fail.

### What is converted, and what is not

| Recorded | Result |
|---|---|
| `findById(...).text = "x"`, `.press`, `.select`, `.setFocus`, `.sendVKey n`, `.selected = true` | converted |
| `With ... End With`, `Set btn = findById(...)`, `_` continuations, `""` escapes | converted |
| chained access: `.columns.elementAt(1).width`, `.getAbsoluteRow(3).selected = true`, `.verticalScrollbar.position` | converted (literal arguments only) |
| `x = findById(...).text` | converted to `let x = await sap.get(...)` |
| `WScript.Sleep n` | dropped (see above) |
| the recorder's connect-to-SAP preamble | dropped - the fixture attaches the session |
| typed passwords | **never copied** - replaced by `env.get('SAP_PASSWORD')` |
| `If` / `For` / `Do` / `Select Case` / `Sub` / `MsgBox` | **not guessed**: emitted as a `// TODO(manual, vbs:N)` with the original line, and listed in the spec's header. Everything inside a block is held back too, so nothing runs unconditionally that was conditional |
| a variable inside a chained path (`getAbsoluteRow(i)`) | flagged as TODO |

A recording is straight-line by nature, so most are converted completely. `--strict` makes CI fail rather than let a TODO slip through.

### Setting up a Windows machine

SAP GUI Scripting is a Windows COM API: **tests that drive real SAP must run on a Windows machine with SAP GUI installed**. Anywhere else they are *skipped* (the report says why) - never silently passed.

1. SAP GUI > Options > Accessibility & Scripting > Scripting: tick **Enable scripting**; **untick** "Notify when a script attaches to running GUI" and "Notify when a script opens a connection" (those pop-ups block an unattended run).
2. The SAP server must allow it: profile parameter `sapgui/user_scripting = TRUE` (your SAP Basis team).
3. Open SAP Logon and log on to the system (the default mode *attaches* to what is already open - it never creates or closes anyone's session). To have the test open the connection and start at the logon screen instead: `SAP_GUI_MODE=open` and `SAP_GUI_CONNECTION_NAME="<SAP Logon entry>"`.
4. Check the machine: `npm run build && npm run doctor`. It tells you which of the above is wrong. `npx sap-gui-doctor --print-bridge` prints the exact PowerShell the framework runs, for whoever must approve it on a managed desktop (it only does what a recorded script does; no network, no installs, no registry or file changes).
5. `npm run test:sapgui`

| Variable | Meaning | Default |
|---|---|---|
| `SAP_GUI_MODE` | `attach` or `open` | `attach` |
| `SAP_GUI_CONNECTION_NAME` | SAP Logon entry, for `open` | |
| `SAP_GUI_CONNECTION_INDEX` / `SAP_GUI_SESSION_INDEX` | which open connection / session, for `attach` | `0` / `0` |
| `SAP_GUI_TIMEOUT_MS` | longest any one step waits | `30000` |
| `SAP_GUI_LOGON_PATH` | `saplogon.exe`, started by `open` mode if SAP Logon isn't running | `C:\Program Files (x86)\SAP\FrontEnd\SAPgui\saplogon.exe` |
| `SAP_GUI_SIMULATOR` | `true` = use the built-in fake SAP (what `npm run try:simulator` sets) | `false` |
| `SAP_SAMPLE_TCODE` | transaction used by sample test 02 | `SU3` |
| `SAP_RUN_TEMPLATES` | `true` = also run the `...TEMPLATE` tests against a real SAP | `false` |
| `SAP_GUI_POWERSHELL` | path to `powershell.exe` (a 32-bit SAP GUI needs `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`) | `powershell.exe` |
| `SAP_USER`, `SAP_PASSWORD`, `SAP_CLIENT`, `SAP_LANGUAGE` | read by converted logon steps - put them in `.env.<name>` (not committed) or CI variables | |

### Try it without SAP

`FakeSapGui` / `createSampleSapSystem()` is an in-memory SAP with a logon -> VA01 -> save flow. `tests/gui/sapFakeTest.ts` wires it into a `test`, so a conversion can be executed on any machine:

```bash
npx sap-vbs-to-playwright examples/va01_create_order.vbs --out tests/gui --test-import ./sapFakeTest
npm run test:framework
```

It only knows the screens it is given - it proves the converter and the waiting, **not** that a recording matches your real system.

### What has and has not been verified

Verified here (macOS, no SAP): every layer above the transport - parser/generator (including a realistic VA01 recording), the session's waiting, retries and error messages, locators, type-driven actions, retrying assertions, pop-up handlers, journal/evidence, session reuse, secrets handling, the CLI - against a simulator with screen-change latency, with negative controls showing the same steps fail without the framework. The bridge script is checked to be ASCII-only with no network/file/registry calls (its only `Start-Process` is the SAP Logon launch).

**Not verified until it runs on a Windows machine with SAP GUI**: the PowerShell bridge itself (it could not be executed without Windows PowerShell and SAP GUI), COM behaviour on your SAP release, and that a particular recording replays against your system. Run `npm run doctor` first, then convert and run one real recording - and report anything the doctor or the failure message does not explain, because that is the part that was written from the documented COM API rather than observed.

Known limits: one session per test (a recording that opens a second session via `createSession` needs hand work); GUI dialogs outside SAP's own windows (file pickers, Windows security prompts) are not scriptable by SAP GUI Scripting; SAP GUI for HTML / WebGUI is a browser app - use the Fiori/Playwright half for that.
