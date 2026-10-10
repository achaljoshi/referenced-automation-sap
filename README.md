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

`setup.sh`/`setup.bat` run `npm ci`. They first run `npm config set registry "$NPM_REGISTRY_URL"` when that variable is set, so every package - the `@automation/*` ones too (`referenced-automation-utils`, `referenced-automation-ui`), each **by the version in `package.json`** - is fetched from your organisation's npm registry. If those packages are not published there yet, or you want to try a change you have not published, run `./scripts/setup.sh --local` (`scripts\setup.bat --local` on Windows): it builds the sibling repos this one depends on - they must be checked out next to this one - into `../shared-packages` and installs those instead, without touching `package.json` or the lockfile. See [Publishing a package](#publishing-a-package-to-the-registry-jfrog-artifactory) and [Using a package without a registry](#using-a-package-without-a-registry-local-generation).

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

## Publishing a package to the registry (JFrog Artifactory)

The other repos install `@automation/referenced-automation-sap` **by version** from your organisation's npm registry, so each new version has to be published there. In order:

1. **Know the registry URL.** It is the npm registry URL of your Artifactory - the one in your `~/.npmrc` and in the `NPM_REGISTRY_URL` CI/CD variable. This repo never hard-codes it; ask your platform team if you do not have it.
2. **Be allowed to publish.** Publishing needs an npm identity with deploy permission on that repository. How you authenticate npm against your Artifactory is your organisation's own procedure and is not covered here - the scripts in this repo never log in for you.
3. **Choose the version and record it.** A version can be published only once:
   ```bash
   npm version patch --no-git-tag-version      # or minor / major - changes package.json only
   ```
   Add the change to `CHANGELOG.md` and commit both.
4. **Point the scripts at the registry** (once per terminal):
   ```bash
   export NPM_REGISTRY_URL="<your registry URL>"        # Windows cmd: set NPM_REGISTRY_URL=<your registry URL>
   ```
5. **Publish** - a dry run first:
   ```bash
   ./scripts/publish-package.sh --dry-run     # builds the package and lists what would be uploaded
   ./scripts/publish-package.sh               # uploads it            (Windows: scripts\publish-package.bat)
   ```
   The script runs `npm config set registry "$NPM_REGISTRY_URL"`, builds with `create-package.sh` (clean, build, `npm pack`) and runs `npm publish <the .tgz> --registry "$NPM_REGISTRY_URL"`.
6. **Check it arrived:** `npm view @automation/referenced-automation-sap versions --registry "$NPM_REGISTRY_URL"` lists the new version.

**Without the script.** `./scripts/create-package.sh` leaves `../shared-packages/automation-referenced-automation-sap-<version>.tgz`, the exact file `npm publish` uploads. Publish that file yourself (`npm publish ../shared-packages/<file>.tgz --registry "$NPM_REGISTRY_URL"`), or deploy the `.tgz` into the npm repository through the Artifactory web UI (the repository's **Deploy** action - Artifactory takes the package name and version from the tarball; check with your platform team how your repository is set up), or hand it to whoever manages the repository.

**Order matters.** Publish what a package depends on first: `utils` -> `api` and `ui` -> `sap` -> the consuming repos.

## Upgrading a package: change one version

This repo lists the `@automation/*` packages it uses in `package.json` with a version range, like any other dependency:

```jsonc
"dependencies": {
  "@automation/referenced-automation-utils": "^1.0.0",
  "@automation/referenced-automation-ui": "^1.0.0"
}
```

To take a newer version, **change that number** (say `"^1.3.0"`), run `npm install`, run the tests and commit `package.json` and `package-lock.json`. npm downloads the new version from the registry in `NPM_REGISTRY_URL`; nothing is built, copied or placed by hand.

- `^1.3.0` accepts any `1.x` from 1.3.0 up (what `npm update` moves to); write `1.3.0` to pin exactly.
- `npm ci` (CI, `setup.sh`) installs exactly what the lockfile records, so a version only changes when someone commits a change.
- The lockfile in this repo records the version of each `@automation/*` package but not where it came from. The first `npm install` against the real registry adds that (`resolved` and `integrity`); commit the result.
- A package that is itself depended on (`utils`, `api`, `ui`, `sap`) must be published again before its consumers can ask for the new version - see [Publishing a package](#publishing-a-package-to-the-registry-jfrog-artifactory) in that repo.

## First rollout: publish, then install from the registry

To see the whole chain work from the registry (no `--local`): set `NPM_REGISTRY_URL`, publish `utils`, `api`, `ui`, `sap` **in that order** (`./scripts/publish-package.sh --dry-run`, then without `--dry-run`, in each repo; the first publish uses the current version, 1.0.0), confirm with `npm view @automation/referenced-automation-<name> versions --registry "$NPM_REGISTRY_URL"`, then in a consumer run `rm -rf node_modules && ./scripts/setup.sh` and check `npm ls @automation/referenced-automation-utils` and the `resolved` address in `package-lock.json`. The full walkthrough is [section 4.3 of the cross-repo guide](https://github.com/achaljoshi/referenced-automation-utils/blob/master/CROSS_REPO_GUIDE.md#43-first-rollout-publish-everything-then-install-from-the-registry).

## Using a package without a registry (local generation)

Use this when the packages are not in a registry yet, or you want to try a change before publishing it. Nothing in `package.json` or the lockfile changes.

**Automatic - when the repos are checked out next to each other:**

```bash
./scripts/setup.sh --local          # Windows: scripts\setup.bat --local
```

It builds the sibling repos this one depends on (`referenced-automation-utils`, `referenced-automation-ui`) with their own `scripts/create-package.sh --local`, keeps the `.tgz` files in `../shared-packages` and installs them.

**Manual - generating a tarball and placing it yourself** (for example when the consuming repo is on another machine):

1. Generate a tarball of each package this repo needs, in that package's own repo (`--local` builds what it depends on in turn, without needing the registry):
   ```bash
   (cd ../referenced-automation-utils && ./scripts/create-package.sh --local)
   (cd ../referenced-automation-ui && ./scripts/create-package.sh --local)
   ```
   Each file is named `automation-<package>-<version>.tgz` after the version in that repo's `package.json` and lands in `../shared-packages`.
2. Leave the files in `../shared-packages`, or copy them into the consuming repo (any folder works, for example `libs/` - keep it out of git).
3. Install them, all in one command (change the folder if you copied the files elsewhere):
   ```bash
   npm install --no-save ../shared-packages/automation-referenced-automation-utils-<version>.tgz ../shared-packages/automation-referenced-automation-ui-<version>.tgz
   ```
   `--no-save` keeps `package.json` and the lockfile unchanged. Run it again after every `npm ci`, because `npm ci` removes what is not in the lockfile. When you rebuild a tarball with the same version, run the command again to pick up the new contents.
4. Build and test as usual (`npm run build`, `npm test`).

When you are done experimenting, run `npm ci` to go back to what the registry provides.

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
