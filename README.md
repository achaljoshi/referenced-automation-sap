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

`npm run test:smoke` and `npm run test:framework` generate the Gherkin features first (`bddgen`) and end with `scripts/min-executed.js`: the run **fails when fewer tests executed than expected** and prints how many were skipped and why (for example `skipped 8x: needs a JDK` - without a JDK `tests/gui/javaBridge.spec.ts` exercises nothing, and the run would otherwise look green). Parallelism: attach mode drives one SAP window, so `playwright.config.ts` runs one worker there (see [Parallel workers](#parallel-workers)).

Two things are tested, deliberately kept separate:

1. **`tests/fioriPage.spec.ts`** - `byControlId`/`waitForUI5Ready` against a small local fixture (`tests/support/fioriStyleFixture.html`) that mimics UI5's id-prefixing convention. Deterministic, no network dependency, no flake risk.
2. **`tests/fioriCart.spec.ts`** - a real integration test against SAP's own publicly hosted [Shopping Cart SAPUI5 demo kit app](https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html) (credential-free, officially SAP-maintained - not a random third party). Every selector in `tests/support/FioriCartPage.ts` was confirmed against a live render before being written, not guessed from documentation. Its "Promoted Items" panel rotates contents between loads, so the test asserts the shape of the cart total, not one hardcoded value.

## Environments

Same `.env.<name>` + `ENV=<name>` pattern as the rest of this family (see `referenced-automation-utils`'s README). `playwright.config.ts` reads `BASE_URL`/`HEADLESS` from the active env file.

## Configuration reference

Every environment variable this repo reads, in the order of [`.env.example`](.env.example) - which is the full reference: for each variable it says what it is for, valid values, the default, whether it is required, whether it is a secret and where to find the value in SAP GUI. `tests/gui/envDocs.spec.ts` fails when this table, `.env.example` and the code disagree.

Settings are looked up in this order (the first one found wins): a real environment variable (PowerShell: `$env:NAME = "value"`, undo with `Remove-Item Env:NAME`) -> `.env.<ENV>.local` (git-ignored, **secrets**; template: [`.env.qa.local.example`](.env.qa.local.example)) -> `.env.<ENV>` (committed, no secrets) -> `.env`. `ENV` picks the files (default `qa`). A value with `#`, `$` or spaces must be in double quotes (`SAP_PASSWORD="my#pass word"`): an unquoted `#` starts a comment and cuts the password. The logger variables (`LOG_*`) are read from the real environment only.

| Name | Purpose | Default | Required | Secret |
|---|---|---|---|---|
| `ENV` | Which `.env.<ENV>` file (and `.env.<ENV>.local`) is loaded. | qa | No | no |
| `SAP_GUI_MODE` | How the test gets its SAP GUI session. | attach | No | no |
| `SAP_GUI_CONNECTION_NAME` | The SAP Logon entry to open (mode=open). | (none) | YES with SAP_GUI_MODE=open, unless SAP_GUI_CONNECTION_STRING is set. | no |
| `SAP_CLIENT` | The client (Mandant) typed on the logon screen. | (none: the logon screen keeps the system's default client) | Recommended - without it you log on to whatever the system suggests | no |
| `SAP_USER` | The SAP user the tests log on as (loggedInSap / logon()). | (none) | YES whenever a test logs on (SAP_GUI_MODE=open, or attach on the logon screen) | no |
| `SAP_PASSWORD` | The password of SAP_USER. | (none) | YES whenever a test logs on. | **yes** |
| `SAP_LANGUAGE` | The logon language (field "Language" on the logon screen). | (none: the user's default language) | No | no |
| `SAP_MULTIPLE_LOGON` | What to do when SAP shows "user already logged on elsewhere" (the multiple-logon pop-up) after a correct logon. | continue | No | no |
| `SAP_LOGON_FAILURE_COOLDOWN_MIN` | Minutes during which the same client + user + password is not typed into SAP again after SAP rejected it (CI retries and re-runs would otherwise lock the user). A changed password, user or client clears it; 0 = off. | 15 | No | no |
| `SAP_GUI_LOGON_MARKER_DIR` | Folder of the logon-failure marker (client, user, salted fingerprint of the rejected password, time - never the password). Not under test-results: Playwright empties that folder every run. | .sap-state | No | no |
| `SAP_GUI_CONNECTION_INDEX` | Attach mode: which open SAP Logon connection to use (0 = the first). | 0 | No (only in attach mode) | no |
| `SAP_GUI_SESSION_INDEX` | Attach mode: which session (window) of that connection (0 = the first). | 0 | No (only in attach mode) | no |
| `SAP_GUI_CONNECTION_STRING` | Open a system by connection string instead of a SAP Logon entry (mode=open). | (none) | No | no |
| `SAP_GUI_TIMEOUT_MS` | The longest any ONE step waits (for a control to appear, for SAP to become idle). | 30000 | No | no |
| `SAP_GUI_ROUNDTRIP_WAIT_MS` | How long to wait for SAP's answer after an action that should reach the server (raise on a slow link; 0 = old behaviour). | 250 | No | no |
| `SAP_GUI_REUSE` | How often a worker connects to SAP. | worker | No | no |
| `SAP_GUI_HOME_FAILURE` | What to do when the session cannot be returned to the start screen before a test. | fail | No | no |
| `SAP_GUI_FALLBACKS` | What to do when a locator's usual id is gone but its fallback (.orElse(...)) finds the control ("locator drift"). | report | No | no |
| `SAP_GUI_INSIGHTS` | Record transactions and step timings for `npm run insights`. | on | No | no |
| `SAP_GUI_INSIGHTS_DIR` | Where the insights files are written. | test-results/sap-insights | No | no |
| `SAP_GUI_CONTRACTS_DIR` | Where screen contracts (baselines of a screen's control ids) are read from and written to. | contracts | No | no |
| `SAP_GUI_UPDATE_CONTRACTS` | Write the screen contract baselines instead of comparing with them. | false | No | no |
| `SAP_GUI_EVIDENCE` | Which screenshots and step journals are attached to the report. | failure | No | no |
| `SAP_GUI_EVIDENCE_DIR` | Where screenshots are written before they are attached to the report (and then deleted). | test-results/sap-evidence | No | no |
| `SAP_GUI_CLEANUP` | Whether the data a test created in SAP (sapData.record / captureFromStatusBar) is cleaned up afterwards. | on | No | no |
| `SAP_GUI_CLEANUP_FAILURE` | What happens when a cleanup fails or an object was recorded without one. | fail | No | no |
| `SAP_GUI_CLEANUP_TIMEOUT_MS` | The longest one cleanup may run before it is asked to stop. | 60000 | No | no |
| `SAP_GUI_DATA_DIR` | Where the list of created objects (what `npm run data` reads) is written. | test-results/sap-data | No | no |
| `SAP_USER_POOL` | The users the workers lease, one per worker. | (none: every worker uses SAP_USER) | No | no |
| `SAP_PASSWORD_<USER>` | The password of one pooled user (replace `<USER>` with the user name in upper case, e.g. `SAP_PASSWORD_QAUSER1`). | the shared `SAP_PASSWORD` | Only if the pooled users have different passwords | **yes** |
| `SAP_GUI_POOL_SCOPE` | Users are leased exclusively per scope; two runs that use the same SAP system must share the scope. | SAP_GUI_CONNECTION_NAME, or "default" | No | no |
| `SAP_GUI_POOL_DIR` | The folder of the lease files (a file lock that works across processes on ONE machine). | sap-user-pool in the OS temp folder | No | no |
| `SAP_GUI_POOL_TIMEOUT_MS` | How long a worker waits for a free user before it fails. | 120000 | No | no |
| `SAP_GUI_TRANSPORT` | Which bridge talks to SAP GUI. | powershell | No | no |
| `SAP_GUI_POWERSHELL` | The PowerShell that runs the bridge. | powershell.exe | No | no |
| `SAP_GUI_POWERSHELL_SCRIPT_DIR` | A folder with an approved (typically signed) copy of the bridge script, run as it is without -ExecutionPolicy Bypass. | (none: the bridge runs from a temp file with -ExecutionPolicy Bypass for that one process) | No | no |
| `SAP_GUI_LOGON_PATH` | saplogon.exe, started in open mode when SAP Logon is not running yet. | `C:\Program Files (x86)\SAP\FrontEnd\SAPgui\saplogon.exe` | No | no |
| `SAP_GUI_JAVA` | The java executable that runs the helper. | java from PATH | No | no |
| `SAP_GUI_BRIDGE_JAR` | The helper you built: bridge/jacob/sap-bridge.jar. | (none) | YES with SAP_GUI_TRANSPORT=java | no |
| `SAP_GUI_JACOB_JAR` | The JACOB library (the BINARY jar, not the -sources jar). | (none) | YES with SAP_GUI_TRANSPORT=java | no |
| `SAP_GUI_JACOB_DLL` | The JACOB DLL in the bitness of your Java (x64 DLL with 64-bit Java, x86 DLL with 32-bit Java): what the old framework passed as jacob.dll.path. | (none) | YES with SAP_GUI_TRANSPORT=java | no |
| `SAP_GUI_REMOTE_BRIDGE_FILE` | A bridge script that is already ON THE REMOTE HOST (an approved or signed copy), run instead of the text this package sends. | (none) | No | no |
| `REMOTE_ENABLED` | Switches the remote desktop host on. | false | YES with SAP_GUI_TRANSPORT=remote | no |
| `REMOTE_RDP_HOST` | The RDP host that has SAP GUI. | (none) | YES with REMOTE_ENABLED=true | no |
| `REMOTE_RDP_PORT` | The RDP port. | 3389 | No | no |
| `REMOTE_RDP_USER` | The Windows user for the RDP login (`DOMAIN\user` is accepted). | (none) | YES with REMOTE_AGENT_START=alternate-shell (the default) | no |
| `REMOTE_RDP_DOMAIN` | The Windows domain of the RDP user (alternative to writing `DOMAIN\user`). | (none) | No | no |
| `REMOTE_RDP_PASSWORD` | The password of the RDP user. | (none) | YES with REMOTE_AGENT_START=alternate-shell | **yes** |
| `REMOTE_SHARE_DIR` | The folder on the test machine through which request and reply files travel (the drive-mailbox). | .remote-mailbox in the working directory (git-ignored) | No | no |
| `REMOTE_DRIVE_LETTER` | The drive letter under which that folder appears inside the RDP session (`\\tsclient\R`). | R | No | no |
| `REMOTE_AGENT_START` | How the agent is started inside the RDP session. | alternate-shell | No | no |
| `REMOTE_ALLOW` | What the agent may be asked to do on the host. | http,db,sap | No | no |
| `REMOTE_CONNECT_TIMEOUT_MS` | How long to wait for the RDP session and the agent to come up. | 180000 | No | no |
| `REMOTE_REQUEST_TIMEOUT_MS` | How long one request to the agent may take before the bridge is stopped. | 60000 | No | no |
| `REMOTE_POLL_MS` | How often the mailbox folder is looked at. | 200 | No | no |
| `REMOTE_HEARTBEAT_MS` | How often the agent writes its heartbeat. | 2000 | No | no |
| `REMOTE_HEARTBEAT_STALE_MS` | How old a heartbeat may get before the agent counts as dead (at least twice REMOTE_HEARTBEAT_MS). | 10000 | No | no |
| `REMOTE_RDP_WIDTH` | Width of the RDP window (REMOTE_RDP_HEIGHT is its height). | 1280 x 800 | No | no |
| `REMOTE_RDP_HEIGHT` | Height of the RDP window. | 800 | No | no |
| `REMOTE_RDP_KEEP_OPEN` | Leave the RDP window open after the run. | false | No | no |
| `REMOTE_LOGOFF` | Log the remote user off at the end of the run. | false | No | no |
| `REMOTE_DB_PROVIDER` | Database provider for steps that run SQL on the host. | (none) | No | no |
| `REMOTE_DB_CONNECTION_STRING` | Connection string for SQL on the host. | (none) | No | **yes** |
| `SAP_GUI_SIMULATOR` | Run against the built-in fake SAP instead of a real one, on any OS (what `npm run try:simulator` sets). | false | No | no |
| `SAP_SAMPLE_TCODE` | The transaction tests/sapgui/02_open_transaction.spec.ts opens. | SU3 | No | no |
| `SAP_RUN_TEMPLATES` | Also run the sample tests marked TEMPLATE / EXAMPLE (03_create_sales_order, 04_example_every_feature) against a REAL SAP. | false | No | no |
| `WORKERS` | How many Playwright workers run in parallel. | Playwright's own (half the CPUs); 1 in attach mode | No | no |
| `RETRIES` | How often a failed test is retried. | 0 locally, 2 in CI (when CI is set) | No | no |
| `TEST_TIMEOUT_MS` | The longest one whole test may run. | 60000 | No | no |
| `EXPECT_TIMEOUT_MS` | The wait of Playwright's own expect (the SAP assertions wait 5 seconds unless you pass { timeout }). | 10000 | No | no |
| `ACTION_TIMEOUT_MS` | The wait of one browser action (Fiori half only). | 15000 | No | no |
| `NAVIGATION_TIMEOUT_MS` | The wait of one browser navigation (Fiori half only). | 30000 | No | no |
| `GLOBAL_TIMEOUT_MS` | The longest the whole run may take (0 = no limit). | 0 | No | no |
| `MAX_FAILURES` | Stop the run after this many failed tests (0 = never). | 0 | No | no |
| `BASE_URL` | The Fiori launchpad of the system under test (Fiori half only; the SAP GUI tests do not use it). | (none) | Only for Fiori tests | no |
| `HEADLESS` | Show the browser window (Fiori half only). | true | No | no |
| `BROWSER` | The browser (Fiori half only). | chromium | No | no |
| `DEVICE` | Emulate a Playwright device (overrides BROWSER). | (none) | No | no |
| `SLOW_MO_MS` | Slow every browser action down (debugging). | 0 | No | no |
| `IGNORE_HTTPS_ERRORS` | Accept invalid HTTPS certificates (Fiori half only). | false | No | no |
| `LOCALE` | The browser's locale (Fiori half only). | (none: the browser's) | No | no |
| `TIMEZONE_ID` | The browser's time zone (Fiori half only). | (none: the machine's) | No | no |
| `COLOR_SCHEME` | The browser's colour scheme (Fiori half only). | (none) | No | no |
| `VIEWPORT_WIDTH` | Width of the browser window (Fiori half only; VIEWPORT_HEIGHT is its height). | 1280 | No | no |
| `VIEWPORT_HEIGHT` | Height of the browser window (Fiori half only). | 800 | No | no |
| `TEST_ID_ATTRIBUTE` | The attribute getByTestId() reads (Fiori half only). | data-testid | No | no |
| `LOG_LEVEL` | How much the logger prints. | info | No | no |
| `LOG_TO_FILE` | Write the log to a file as well (real environment only, like LOG_LEVEL). | true | No | no |
| `LOG_FILE` | The log file (real environment only). | logs/automation.log | No | no |
| `LOG_FILE_PER_WORKER` | One log file per Playwright worker instead of one shared file (real environment only). | false | No | no |
| `CI` | Marks a CI run: more retries, no .only, and screen contracts cannot be rewritten. | (unset) | No | no |
| `MIN_EXECUTED` | Fails the end of `npm run test:smoke` / `test:framework` (scripts/min-executed.js) when fewer tests executed than this. | 1 (the npm scripts pass --min themselves) | No | no |
| `NPM_REGISTRY_URL` | Setup scripts: the npm registry that serves the @automation/* packages (the scripts run `npm config set registry` with it). | (unset: npm keeps the registry it is configured with) | Only if the packages come from your organisation's registry | no |
| `USE_LOCAL_PACKAGES` | Setup scripts: install the @automation/* packages from locally built tarballs (same as --local). | (unset) | No | no |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | Setup scripts: skip downloading the Playwright browser (the SAP GUI tests do not need one). | (unset: the browser is downloaded) | No | no |
| `TEST_WORKER_INDEX` | The number of the worker Playwright is running this test in. | set by the runner | No | no |
| `TEST_PARALLEL_INDEX` | The parallel slot of the worker. | set by the runner | No | no |
| `SAP_PIN` | A PIN that a recorded flow types into a PIN field. | (none) | Only for recordings that type a PIN | **yes** |
| `SAP_OTP` | A one-time code that a recorded flow types into an OTP field. | (none) | Only for recordings that type a one-time code | **yes** |
| `SAP_TOKEN` | A token that a recorded flow types into a token field. | (none) | Only for recordings that type a token | **yes** |
| `SAP_SECRET` | Any other secret a recorded flow types into a field called "secret". | (none) | Only for such recordings | **yes** |
| `SAP_API_KEY` | An API key a recorded flow types into an "api key" field. | (none) | Only for such recordings | **yes** |

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

**The sample tests** (`tests/sapgui/`) are the pattern to copy:

| File | Shows |
|---|---|
| `01_connect_and_login.spec.ts` | the smallest test: the `loggedInSap` fixture logs on for you; read a window title; check a control exists |
| `02_open_transaction.spec.ts` | `startTransaction`, reading the status bar (`E` = error), configuring a test from `.env` |
| `03_create_sales_order.TEMPLATE.spec.ts` + `pages/` | a business flow written with page objects: ids in one place, label/tooltip locators, table-control cells, a pop-up handler, evidence, a retrying status-bar assertion |
| `04_example_every_feature.spec.ts` | a heavily commented example of every feature: `loggedInSap`, `getByLabel` / `getByText` / `getByTooltip`, a locator by id, `setText`, `press`, `sendVKey`, the status bar, `toExist` with its "on the screen now" diagnostics, evidence, cleanup registration, and which `.env` setting each part relies on. Runs on the simulator (`npm run try:simulator -- 04_`); skipped on a real SAP unless `SAP_RUN_TEMPLATES=true` |

**Which fixture?** `sap` is the connection as it is: with `SAP_GUI_MODE=open` the **logon screen**. `loggedInSap` is the same session, logged on first when SAP shows the logon screen and left alone when you are already in (it is part of the package's own `sapGuiTest`, so a generated test can use it). Tests you write by hand almost always want `loggedInSap`; a recording of the logon wants `sap`.

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

### Windows first run (PowerShell, from zero to your first test)

For a Windows machine with SAP GUI (an AWS WorkSpace, a laptop) and VS Code. Commands are PowerShell: run them in the VS Code terminal (**Terminal > New Terminal**, the shell must say `PowerShell`). The longer explanations and the table of error messages are in [`docs/SAP_GUI_GUIDE.md`](docs/SAP_GUI_GUIDE.md#3b-windows-first-run-powershell).

In PowerShell an environment variable is set with `$env:NAME = "value"` and removed with `Remove-Item Env:NAME`; `set NAME=value` (cmd.exe) does nothing there. Inside this repo the tools run through npm or `node dist/cli/<name>.js` - the `npx sap-*` names exist only in projects that depend on this package.

1. **Install** (once). Node 18+ (`node -v`) and SAP GUI with scripting enabled ([setup](#setting-up-a-windows-machine)). In the repo folder:
   ```powershell
   .\scripts\setup.bat            # npm ci + the Playwright browser; add --local when the sibling repos are checked out next to this one
   ```
   `'tsc' is not recognized` later means this step did not run (no `node_modules` folder). Note that `setup.bat` runs `npm config set registry` when `NPM_REGISTRY_URL` is set.
2. **Build and check the machine:**
   ```powershell
   npm run build
   npm run doctor
   ```
3. **Say where SAP is.** Edit `.env.qa`: `SAP_GUI_MODE`, `SAP_GUI_CONNECTION_NAME` (the SAP Logon entry), `SAP_CLIENT`, `SAP_USER`, `SAP_LANGUAGE` (System > Status in SAP shows client, user and language). Put the password only in the git-ignored secrets file:
   ```powershell
   Copy-Item .env.qa.local.example .env.qa.local     # then edit it: SAP_PASSWORD="your password"  (double quotes!)
   ```
   **Log on by hand with exactly these values first.** A wrong password counts towards SAP's lock limit; after a rejected logon the framework refuses to repeat the same logon for `SAP_LOGON_FAILURE_COOLDOWN_MIN` minutes (15) - see [the lock-out protection](docs/SAP_GUI_GUIDE.md#credentials-and-lock-out-protection).
4. **Pick the mode** - it decides where you start recording:

   | | `SAP_GUI_MODE=open` | `SAP_GUI_MODE=attach` |
   |---|---|---|
   | Who has SAP open | the test opens `SAP_GUI_CONNECTION_NAME` itself and starts at the **logon screen** | you have SAP Logon open and are logged on |
   | Start recording at | **the logon screen** (the recording then contains the logon) | **SAP Easy Access**, already logged on |
   | Generated test uses | `{ sap }` - it types the logon itself | `{ loggedInSap: sap }` - logs on only if SAP shows the logon screen |
   | Switch in PowerShell | `$env:SAP_GUI_MODE = "open"` | `$env:SAP_GUI_MODE = "attach"` (undo: `Remove-Item Env:SAP_GUI_MODE`) |

   The converter picks the fixture by looking for logon steps in the recording (`--fixture sap|loggedInSap|auto`), so a recording made while logged on works in both modes. With `loggedInSap` in open mode the fixture does the logon.
5. **Record.** In SAP GUI press **Alt+F12 > Script Recording and Playback**. In the **Record and Playback** dialog: *Save To* a **local, non-synced folder** such as `C:\Temp\sap` (not OneDrive, WorkDocs or another synced folder), a **new file name every time**, *Encoding* Unicode, UTF-8 or ANSI - all three are read. Start the recording, do the flow, stop it. (Reusing a file name or saving into a synced folder gives `The process cannot access the file because it is being used by another process`.)
6. **Copy it into `recordings/`** and convert it - with the assertion you want, so the test can fail:
   ```powershell
   Copy-Item C:\Temp\sap\my_recording.vbs recordings\
   npm run convert -- --expect-text "Address" --expect-status "has been saved"
   # or one file, spelled out:
   node dist/cli/convertVbs.js recordings\my_recording.vbs --out tests/sapgui --test-import ./support/sapTest --expect-import ./support/sapTest --expect-text "Address" --strict
   ```
   `--expect-text <text>` (repeatable) checks that a text is on the screen at the end, `--expect-title <regex>` the window title, `--expect-status <regex>` the status bar; use any combination. See [Convert a recording](#convert-a-recording).
7. **Edit** `tests/sapgui/my_recording.spec.ts`: the values the recording typed are in `CONSTANTS`, every control id in `LOCATORS` at the top of the file; the header lists anything the converter could not convert. If you did not pass an `--expect-*` option, replace the `TODO(converter)` guard at the end with a real check, e.g. `await expect(sap.getByText('Address').first()).toExist();` (`expect` is imported for you - from this package, not from `@playwright/test`, which has no `toExist`).
8. **Run ONE test.** Use forward slashes - a Windows backslash path gives `No tests found` - or select by title with `-g`:
   ```powershell
   npx playwright test tests/sapgui/my_recording.spec.ts
   npx playwright test -g "recorded: my_recording"
   ```
   `npm run test:sapgui` runs every `@sapgui` test.
9. **Look at the report:** `npx playwright show-report` opens it (`playwright-report/index.html`). A failed test has the step journal (`sap-steps`), the status bar text, a screenshot, and the message says what is on the screen when a control is missing.

If the logon fails, **do not run again** until the credentials are fixed: SAP locks the user after a few wrong logons.

**Windows troubleshooting** (the exact messages; more in the [guide](docs/SAP_GUI_GUIDE.md#7-troubleshooting)):

| You see | Cause | Do this |
|---|---|---|
| `'tsc' is not recognized as an internal or external command` (and there is no `node_modules` folder) | the install did not run or failed | `.\scripts\setup.bat` (`.\scripts\setup.bat --local` without a registry), read its first error |
| `Cannot find module '...\dist\cli\doctor.js'` | the project was not built | `npm run build` first |
| `Illegal characters in path` for `*.tgz` (from `npm run clean`, `create-package`) | the old clean script passed the pattern `*.tgz` to the OS; fixed (`rimraf --glob`) | update to the current version of the repo |
| `javac <options> <source files>` (the usage text) when building `bridge/jacob` | `javac --release` needs **JDK 9 or later**; the `javac` found first on `PATH` is JDK 8 | install JDK 9+, set `JAVA_HOME` and put its `bin` ahead of the old Java on `PATH`; in VS Code set `terminal.integrated.env.windows`; `javac -version` must say 9 or higher (details: [`bridge/jacob/README.md`](bridge/jacob/README.md)) |
| `The process cannot access the file because it is being used by another process` when saving a recording | the target is in a synced folder, or SAP GUI still holds a file of that name | save to a local folder such as `C:\Temp\sap`, with a new file name each time |
| `No tests found` | a Windows path with backslashes after `playwright test` | `npx playwright test tests/sapgui/my.spec.ts` (forward slashes) or `-g "recorded: my"` |
| `error TS5108: Option 'moduleResolution=node10' has been removed` in `tsconfig.json` (VS Code or a machine with TypeScript 7) | TypeScript 7 removed `moduleResolution: "node"`; it has nothing to do with the Node.js version | `tsconfig.json` now uses `"module": "node16"` and `"moduleResolution": "node16"` (same compiled output): `git pull`, or change those two lines by hand |
| `Name or password is incorrect (repeat logon)` | wrong `SAP_USER` / `SAP_CLIENT` / `SAP_PASSWORD`, an unquoted `#` in the password, or a locked user | fix them in `.env.<ENV>.local` (password in double quotes), log on by hand once; do not re-run first |
| `logon NOT attempted - it would have repeated a logon that SAP has just rejected` | the lock-out protection: the same credentials failed less than `SAP_LOGON_FAILURE_COOLDOWN_MIN` minutes ago | change the credentials (clears it), or delete `.sap-state\logon-failed.json`, or wait |
| `TypeError: expect(...).toExist is not a function` / `Property 'toExist' does not exist` | `expect` was imported from `@playwright/test` | import it from the SAP module: `import { expect } from './support/sapTest'` (generated tests import `sapExpect as expect` for you) |
| `'sap-vbs-to-playwright' is not recognized` | the `npx sap-*` names exist only in projects that depend on this package | `npm run convert` or `node dist/cli/convertVbs.js` |

### Convert a recording

> **Inside this repo, run the tools as `node dist/cli/<name>.js` or through the npm scripts** (`npm run convert`, `npm run doctor`, `npm run secret`, `npm run insights`, `npm run data`, `npm run contracts`; pass arguments after `--`). The `npx sap-vbs-to-playwright` / `npx sap-gui-...` names are installed into a project that *depends on* this package, not into this repo itself, so `npx` finds nothing here ("is not recognized as an internal or external command").

The recording can be saved in any encoding the Record and Playback dialog offers (UTF-16 "Unicode", UTF-8 or ANSI); the converter detects it.

```bash
npm run build
cp ~/Documents/SAP/SAP\ GUI/my_recording.vbs recordings/
npm run convert                                   # recordings/*.vbs -> tests/sapgui/*.spec.ts (already runs with --strict)
# or one file, with options:
node dist/cli/convertVbs.js recordings/my_recording.vbs --out tests/sapgui --test-import ./support/sapTest --strict --expect-status "has been saved"
```

**A converted test has no assertion** - a recording only performs actions, so left alone it would pass whenever SAP does not throw. Give it one or more of:

- `--expect-text <text>` (repeatable): at the end this text must be on the screen (a label, button, tab...) - written as `await expect(sap.getByText('<text>').first()).toExist();`
- `--expect-title <regex>`: the main window's title must match - `await expect(sap).toHaveTitle(/<regex>/i);`
- `--expect-status <regex>`: the status bar must match - `await expect(sap).toHaveStatusMessage(/<regex>/i);`

Any combination works. Without one of them the file says so in its header, ends with a `// TODO(converter): no assertion` and a guard that **fails the test** until you replace it with a check of the business result (`--allow-no-assertion` leaves the guard out, for spikes). `--strict` accepts any of the three as the assertion. `npm run convert`, `convert:pages` and `convert:data` pass `--strict`, which exits 1 when something could not be converted (control flow, unsupported lines); the note that a password was replaced by an environment read does not count against it.

**`expect` is always imported.** Every generated test (flat, page-object and data-driven) starts with `import { sapExpect as expect } from ...` (`--expect-import`, default this package), so `await expect(sap.getByText('Address')).toExist()` typed by hand works - Playwright's own `expect` has no `toExist`. In a test without an assertion the import is kept "used" by a `void expect;` line that you delete when you add the check.

**Which session fixture?** `--fixture sap|loggedInSap|auto` (default `auto`). A recording made **while logged on** (it starts with the command field, no logon screen) would start on the logon screen with `sap` in `SAP_GUI_MODE=open` and fail to find the command field - so `auto` writes `async ({ loggedInSap: sap })` for a recording without logon steps and `async ({ sap })` for one that contains them (typing into the client / user / password / language fields of the logon screen, or into a password field before anything else was typed in SAP). `--fixture` overrides the guess; `--fixture loggedInSap` on a recording that logs on itself is reported as something to fix (it fails `--strict`).

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

Options: `--out`, `--test-import <module>` (your own base test, to add project fixtures), `--param <id-regex>=<ENV_VAR>` (read a field from the environment), `--tag`, `--keep-session-prefix`, `--no-line-comments`, `--expect-text <text>` (repeatable), `--expect-title <regex>`, `--expect-status <regex>`, `--expect-import <module>`, `--fixture sap|loggedInSap|auto`, `--allow-no-assertion`, `--strict` (exit 1 if anything needs a human - use it in CI). Inside this repo the npm scripts already pass `--test-import ./support/sapTest --expect-import ./support/sapTest`; add options after `--`: `npm run convert -- --expect-text "Address"`.

### Why the converted test doesn't fail the way a raw recording does

A recording has **no waits**: it works when you record it (you were slow), and fails when it runs at machine speed because the next screen isn't there yet. `SapGuiSession` fixes that in one place instead of in every script:

- before every step it waits for SAP to be idle **and** for the element to exist;
- after a step that triggers a server round trip (`press`, `sendVKey`, `startTransaction`, ...) it waits for the server's **answer** to reach the GUI - SAP's round-trip counter moving, or the screen/title/window count changing - and only then for SAP to be idle (`Busy=false` is also what SAP reports in the instant before the GUI notices the request; on a slow link that used to mean acting on the previous screen). An action that never reaches the server (a tab switch) costs a bounded quiet period, `SAP_GUI_ROUNDTRIP_WAIT_MS` (default 250; `0` restores the old check - raise it on a slow link). This is tested against the simulator and stand-in bridges that delay their answer; it has not been measured on a real SAP GUI;
- a "not found" while the screen is mid-change is retried until the timeout, not failed;
- `WScript.Sleep` lines are dropped - a fixed sleep is too short on a slow day and too slow on every other;
- a real failure tells you what **is** on the screen (nearest id that exists, what it contains, the status bar text) so the recording can be repaired without opening SAP. An assertion on a control that is not there (`toExist`, `toHaveText`, `toContainText`, `toBeEditable`, `toBeChecked`) does the same: it appends `On the screen now (wnd[0]): title ..., status bar ..., texts (N): ...` - up to 25 labels, buttons, tabs and menu entries with their ids, the closest matches to what you asked for (`Closest to "Address": "Addresses" (wnd[0]/usr/lblADDR)`), and the pop-up (`wnd[1]`) when one is in front. Passwords and the values of input fields are never listed;
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
| typed passwords, PINs, one-time codes, tokens | replaced by environment reads (`SAP_PASSWORD`, `SAP_PIN`, `SAP_OTP`, `SAP_TOKEN`): by the field's name, by a variable with such a name (`password = "..."`), and by a variable that later flows into such a field (`pw = "..."` ... `.text = pw`); literals copied into `TODO` comments are redacted when the line looks secret. A secret typed into an innocuously named field cannot be recognised - review the output and run `npm run security` before committing |
| `If` / `For` / `Do` / `Select Case` / `Sub` / `MsgBox` | **not guessed**: emitted as a `// TODO(manual, vbs:N)` with the original line, and listed in the spec's header. Everything inside a block is held back too, so nothing runs unconditionally that was conditional |
| a `With` on something the converter cannot resolve | the `With` and **every statement inside it** are `TODO`s - a leading `.text = ...` is never read against the session |
| a variable inside a chained path (`getAbsoluteRow(i)`) | flagged as TODO |

A recording is straight-line by nature, so most are converted completely. `--strict` makes CI fail rather than let a TODO slip through.

### Parallel workers

`SAP_GUI_MODE=attach` uses the one SAP session you already have open, so two workers would type into the same window. `playwright.config.ts` sets `workers: 1` and `fullyParallel: false` whenever attach mode can reach a real SAP (the environment's `WORKERS` is ignored, with a log line saying so), and the `sap` fixture refuses attach mode if Playwright runs more than one worker anyway (`--workers=4` on the command line). Parallel workers are honoured where each one owns its SAP: the simulator (`SAP_GUI_SIMULATOR=true`), a custom transport, or `SAP_GUI_MODE=open` (a connection per worker; give each its own user with `SAP_USER_POOL`). Note that the committed `.env.dev` / `.env.qa` say `open`, `.env.example` says `attach`.

### Setting up a Windows machine

SAP GUI Scripting is a Windows COM API: **tests that drive real SAP must run on a Windows machine with SAP GUI installed**. Anywhere else they are *skipped* (the report says why) - never silently passed.

1. SAP GUI > Options > Accessibility & Scripting > Scripting: tick **Enable scripting**; **untick** "Notify when a script attaches to running GUI" and "Notify when a script opens a connection" (those pop-ups block an unattended run).
2. The SAP server must allow it: profile parameter `sapgui/user_scripting = TRUE` (your SAP Basis team).
3. Open SAP Logon and log on to the system (the default mode *attaches* to what is already open - it never creates or closes anyone's session). To have the test open the connection and start at the logon screen instead: `SAP_GUI_MODE=open` and `SAP_GUI_CONNECTION_NAME="<SAP Logon entry>"`.
4. Check the machine: `npm run build && npm run doctor`. It tells you which of the above is wrong. `npm run doctor -- --print-bridge` prints the exact PowerShell the framework runs, for whoever must approve it on a managed desktop (it only does what a recorded script does; no network, no installs, no registry or file changes).
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
| `SAP_GUI_TRANSPORT` | `powershell` (default), `java`, or `remote` (the bridge runs on a remote desktop host, see below) | `powershell` |
| `SAP_GUI_POWERSHELL` | path to `powershell.exe` (a 32-bit SAP GUI needs `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`) | `powershell.exe` |
| `SAP_USER`, `SAP_PASSWORD`, `SAP_CLIENT`, `SAP_LANGUAGE` | read by converted logon steps and the `loggedInSap` fixture - `SAP_PASSWORD` only in `.env.<name>.local` (git-ignored) or a masked CI variable | |
| `SAP_LOGON_FAILURE_COOLDOWN_MIN` | minutes during which the same client + user + password is not typed into SAP again after SAP rejected it (`0` = off) | `15` |

The complete list - every variable, with valid values, defaults and where to find the value in SAP GUI - is in [`.env.example`](.env.example) and the [Configuration reference](#configuration-reference).

### SAP GUI on a remote desktop host

When SAP GUI is installed only on a remote Windows desktop host that you reach by RDP, set `SAP_GUI_TRANSPORT=remote`: the PowerShell bridge then runs on that host (inside the logged-in RDP session, the only place SAP GUI scripting can see) through the remote agent of `@automation/referenced-automation-utils`, while the UI steps of the same test keep running in the browser on the test machine. It is attach mode with exactly one worker; the RDP session must stay connected and unlocked. Setup, the `REMOTE_*` keys, a mixed UI + SAP test and troubleshooting: [`docs/SAP_GUI_GUIDE.md`](docs/SAP_GUI_GUIDE.md#sap-gui-on-a-remote-desktop-host).

> **NOT VERIFIED on a real RDP host with real SAP GUI:** it was tested only against the utils stand-in agent and this repo's stand-in bridge. Treat the first run on the real host as the verification (`automation-remote check`, then `npm run doctor -- --conformance`).

### Try it without SAP

`FakeSapGui` / `createSampleSapSystem()` is an in-memory SAP with a logon -> VA01 -> save flow. `tests/gui/sapFakeTest.ts` wires it into a `test`, so a conversion can be executed on any machine:

```bash
node dist/cli/convertVbs.js examples/va01_create_order.vbs --out tests/gui --test-import ./sapFakeTest --expect-status "has been saved" --expect-import ../../src   # a recording made while logged on: examples/va01_logged_on.vbs
npm run test:framework
```

It only knows the screens it is given - it proves the converter and the waiting, **not** that a recording matches your real system.

### What has and has not been verified

Verified here (macOS, no SAP): every layer above the transport - parser/generator (including a realistic VA01 recording), the session's waiting, retries and error messages, locators, type-driven actions, retrying assertions, pop-up handlers, journal/evidence, session reuse, secrets handling, the CLI - against a simulator with screen-change latency, with negative controls showing the same steps fail without the framework. The bridge script is checked to be ASCII-only with no network/file/registry calls (its only `Start-Process` is the SAP Logon launch). "Control not found", "connection dead" and "bridge hung/closed" are classified and recovered from by code that is executed in the Java helper's tests and in the process-transport tests; the same classification in the PowerShell script is only checked as text.

**Reported from a real machine** (by the person who ran it, not by this repository's tests): the Java/JACOB bridge passed its 15 conformance checks (`npm run conformance`) on one real Windows machine with SAP GUI, and a real logon, a transaction and a recording were exercised by hand there. Nothing more is claimed.

**Not verified until it runs on a Windows machine with SAP GUI**: the PowerShell bridge itself (it could not be executed without Windows PowerShell and SAP GUI), COM behaviour on your SAP release, and that a particular recording replays against your system. Run `npm run doctor` first, then convert and run one real recording - and report anything the doctor or the failure message does not explain, because that is the part that was written from the documented COM API rather than observed.

Known limits: one session per test (a recording that opens a second session via `createSession` needs hand work); GUI dialogs outside SAP's own windows (file pickers, Windows security prompts) are not scriptable by SAP GUI Scripting; SAP GUI for HTML / WebGUI is a browser app - use the Fiori/Playwright half for that.
