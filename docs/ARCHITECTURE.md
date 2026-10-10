# SAP GUI automation: architecture

This document is for the people who have to approve how we script classic SAP GUI: what the layers are, why each decision was made, what the alternatives were, what it costs, and what has and has not been verified. Test authors should read [`SAP_GUI_GUIDE.md`](SAP_GUI_GUIDE.md) first; this one explains why it is built the way it is.

## 1. What problem this solves

SAP GUI has one automation interface: **SAP GUI Scripting**, a Windows COM API that addresses every control by a technical id (`wnd[0]/usr/txtRSYST-BNAME`). SAP's own *Script Recording and Playback* writes VBScript against it. The existing Java framework drives the same API through JACOB. We need the same capability inside the Playwright/TypeScript framework family, so SAP, web UI and API tests share one runner, one logger, one report, one CI model.

The hard parts are not "call the COM API". They are:

1. **Timing.** SAP screens change after a server round trip. A recording has no waits, so it fails at machine speed. Fixed sleeps are the usual patch and the usual source of flaky suites.
2. **Maintainability.** Technical ids scattered through scripts mean a screen change breaks many tests.
3. **Unexpected state.** Pop-ups, locked sessions, a session that died overnight.
4. **Secrets.** A test account's password has to live somewhere.
5. **Diagnosability.** "findById failed" tells nobody anything at 2am in CI.

## 2. Layers

```
  Tests (*.spec.ts)                    say WHAT happens; no ids, no sleeps
     |
  Page objects (pages/*.ts)            one class per screen; the technical ids live here, once
     |
  Locators & controls                  sap.getByLabel(...).fill()  /  sap.grid(...)  /  sap.tree(...)
  (SapLocator, SapGrid, SapTree,       the action is chosen by the control's TYPE, like Playwright's
   SapTable, SapPage)                  Locator; assertions retry like Playwright's web-first ones
     |
  SapGuiSession                        waits for SAP idle + element; after a round trip waits for
                                       the server's answer (RoundTrips / screen change), then for idle;
                                       retries transient not-found; pop-up handlers; step journal;
                                       evidence; health check / home / logoff; redaction
     |
  Transport (SapGuiTransport)          ONE small interface: request(command) -> reply
     |-- PowerShellTransport           production: PowerShell process, JSON lines, COM
     |-- JavaTransport                 alternative: Java/JACOB helper (bridge/jacob), same line protocol
     |-- FakeSapGui                    simulator: framework tests and a no-SAP trial run
     '-- (not built) remote agent on a dedicated desktop
     |
  SAP GUI Scripting API (COM)          provided by SAP GUI itself
```

Each layer depends only on the one below it. The **transport** is the only part that knows how SAP is reached; everything above it is unit-testable with the simulator, which is why the framework's own tests (more than 300; `npm run test:framework` prints the current count) run on any machine without SAP.

## 3. Design decisions

| # | Decision | Why | Alternatives considered | Cost / trade-off |
|---|---|---|---|---|
| 1 | **Playwright Test is the host runner**, even though no browser is involved for SAP GUI | One runner, config, tags, retries, sharding, reporters (HTML, Allure, JUnit), logger and CI for web, API and SAP. Mixed flows (Fiori + GUI, API + GUI) are one test | A separate JUnit/TestNG suite | Playwright is not designed for desktop apps; we only use its runner, fixtures and `expect`, never its browser |
| 2 | **Transport seam** (`SapGuiTransport`) | The COM mechanism is the riskiest, most environment-dependent part. Isolating it lets us swap it (PowerShell, the existing JACOB DLL via a small Java helper, a remote agent on a dedicated desktop) without touching a test | Calling COM directly from the session | One more interface to maintain; commands are plain data (a feature: they can be logged and replayed) |
| 3 | **PowerShell bridge** as the default transport | Present on every Windows machine; no native module, no DLL, no compiler; the entire script is one reviewable file of about 270 lines (`npx sap-gui-doctor --print-bridge`). It does exactly what a recorded VBScript does and nothing else | JACOB (works today, but needs Java + a native DLL matching bitness); Node COM modules (`winax`: native build toolchain); `cscript` + VBScript (no JSON, no process reuse) | Depends on PowerShell not being blocked by policy and on COM being available to it. **This is the main thing to verify on the target machine** - see section 7 |
| 4 | **Ids first, semantic locators second** | Recordings use technical ids, so ids are the zero-effort path and never go away. `getByLabel/getByTooltip/getByText/getByType` are available for ids that are unstable or for readability | Only ids (brittle); only labels (labels are language- and customising-dependent) | Two ways to find a control; the guide says when to use which |
| 5 | **Action chosen by control type** (`click`, `fill`) | Testers say what they mean; the type-to-method mapping (press / select / toggle / setText / combo value) lives in one place instead of being re-learned per script. Mirrors what the Java `selectButton` does with a switch on type, generalised | Exposing only raw `press/select/setText` | An unknown type fails with a message that says what to do instead - never a guess |
| 6 | **Strict locators** | A locator matching several controls fails and lists them (as Playwright does), instead of silently picking the first | "First match wins" | Slightly more typing (`.first()`) to be explicit |
| 7 | **No sleeps anywhere; waiting is the session's job** | Every step waits for SAP idle and for the element; steps that cause a round trip wait for the server's answer to reach the GUI (SAP's round-trip counter moves, or the screen/title/window count changes - `Busy=false` alone is also what SAP reports between the request leaving and the GUI noticing it waits) and then for idle, with a bounded quiet period (`roundTripWaitMs`, default 250 ms) for actions that never reach the server; assertions retry. ESLint errors on `waitForTimeout` and `'networkidle'`, and warns about raw ids in specs | Per-step `sleep(n)`; explicit waits in each test | Waiting costs a few cheap COM calls per step, plus up to the quiet period for an action that does not reach the server. Verified only against the simulator and stand-in bridges that can delay their answer; how long a real SAP GUI/link needs is unmeasured - raise `SAP_GUI_ROUNDTRIP_WAIT_MS` on a slow link |
| 8 | **One SAP session per worker, reused, reset between tests** | Logging on per test is slow and burdens the SAP system. The session is health-checked before reuse, returned to the start screen (`/n`, modal windows cancelled) and its per-test state cleared. `SAP_GUI_REUSE=test` gives isolation when a flow needs the logon screen | A global singleton (shared mutable state, not parallel-safe); a new session per test | State could leak between tests in ways `/n` does not clear (e.g. uncommitted data in a locked object). The reset is deliberate and visible (`home` in the step journal) |
| 9 | **Pop-up handlers** (`sap.onPopup`) | "Information" boxes, license notices and system messages are environmental, not part of a test. One declaration beats `if (popup)` in every flow. Modelled on Playwright's `addLocatorHandler` | Try/catch around steps | A broad handler can hide a pop-up a test should care about; handlers are explicit, scoped to a test, matchable by title, and a step aimed at the pop-up is never intercepted |
| 10 | **Secrets via providers; no key next to the ciphertext** | Environment/CI variables first (masked in CI); locally Windows DPAPI (`sap-gui-secret`), which can only be decrypted by the same Windows user on the same machine. The password is never logged, never in a generated spec, never on a command line | Reversible encryption with the key beside it (anyone with the file has the password); plaintext in a properties file | DPAPI is Windows-only and per user/machine - fine for test machines, not a team-wide shared store. CI uses masked variables or the organisation's secrets manager |
| 11 | **The converter never guesses** | A recording is straight-line code and converts completely. Anything with logic (`If`, loops) is emitted as a `TODO` with the original line and held back; `--strict` fails CI on it. Passwords typed during recording are replaced by an environment read | Best-effort translation of control flow | A recording with logic needs a human, by design |
| 12 | **Simulator included** | The framework's behaviour (waiting, retries, pop-ups, assertions, conversion, fixtures) is tested without SAP, including negative controls that show the same steps *fail* without the framework. New joiners can run the sample tests on any laptop | Testing only against a real SAP | The simulator proves the framework, **not** that a recording matches a particular SAP system or release |
| 13 | **Diagnostics by default** | Every step is logged (worker, correlation id, duration, secrets masked) and kept in a per-test journal; on failure the report gets the journal, the status bar text and a screenshot; `sap.evidence(label)` adds screenshots on demand | Logging only | Screenshots need SAP to still be responsive; capturing never throws, so it cannot mask the real failure |
| 14 | **Typed errors with context** | `SapGuiElementNotFoundError` carries the nearest existing id, what it contains and the status bar text; locator errors name the criteria and how to inspect the screen | Bare COM errors | - |
| 15 | **A second transport behind the same protocol (Java/JACOB), and one conformance suite** | If PowerShell or COM-from-PowerShell is restricted, the existing JACOB setup can sit behind the same line protocol with no test changing (`SAP_GUI_TRANSPORT=java`). `sap-gui-doctor --conformance` runs the same checks against any transport on the target machine, including the NOT_FOUND-vs-ERROR codes the retry logic depends on | Wrapping JACOB inside a Java helper; leaving one transport untested | The helper is verified against stand-in JACOB classes only; real COM behaviour is unproven |
| 16 | **Locator fallbacks are explicit and reported, never silent** | Self-healing that hides drift lets page objects rot; here a fallback after a grace period keeps the run going **and** records the new id (attachment, insights report), with `fail` and `off` modes | Silent self-healing; no fallback | A fallback can mask a real regression if drift reports are ignored: review them |
| 17 | **Screen contracts as committed baselines** | A release or customising change is one reviewed diff ("control X is gone, probably moved to Y") instead of a dozen confusing failures | Letting every test discover it | Baselines must be captured from the right screen and updated on purpose |
| 18 | **A data registry with guaranteed cleanup, and a user pool** | Retries and re-runs must not leave data behind or collide; parallel workers must not share a SAP user | Hoping tests clean up; one shared user | Pool coordination is per machine (file locks); cleanup is only as good as the cleanup function you write |

## 4. Quality attributes

**Reliability.** Waiting is structural, not scripted. Transient "not found" during a screen change is retried until the timeout; an unrecoverable one is reported with the screen's actual contents. "Not found" is decided by what failed (the `FindById` call itself failing on a live connection), not by the English wording of SAP GUI's message. A dead COM connection (RPC server unavailable, object disconnected, ...) is its own error code, `SESSION_LOST`, and fails the step at once instead of being retried or read as "no such control"; `healthCheck` also detects it and the connection is re-established. A bridge that stops answering is killed after the first timeout and every pending and later request fails immediately, instead of costing one timeout per remaining call; a closed pipe (EPIPE) is handled the same way.

**Security.** The bridge has no network access, installs nothing and writes no files except a screenshot SAP is asked to take (written under `test-results/sap-evidence`, attached to the report and deleted straight afterwards, so a screenshot of a business screen does not linger in a shared temp folder). It is started with `-ExecutionPolicy Bypass` for that one process, which sidesteps a policy a managed desktop may set on purpose: where that is not acceptable, put an approved, signed copy of the script in a folder and set `SAP_GUI_POWERSHELL_SCRIPT_DIR` - that exact script is then run and the machine's policy is left alone; the only program it can start is SAP Logon, from a configured path, and only when SAP Logon is not already running (a unit test pins this). Credentials never appear in source, specs, logs or process command lines. The framework never kills processes (the existing Java code uses `wmic ... terminate` on matching processes; on a shared desktop that is dangerous, so it is deliberately not carried over - use a dedicated runner and `SAP_GUI_MODE=open`). Recordings contain typed passwords in clear text: the converter keeps them out of generated code, but the `.vbs` itself must not be committed; the repository ignores `.secrets/` and `.env.*.local`. The converter recognises secrets by *name and flow* - password, PIN, OTP and token fields, variables with such names, and variables that end up in such a field - and replaces them (and redacts literals it copies into comments); a secret typed into an innocuously named field is not recognised, so review generated files and run `automation-scan-secrets` before committing.

**Observability.** One logger shared with the web and API frameworks: `[w2] [cid:ad9e928b] [sap-gui] set text ... ok (104ms)`; no ANSI in CI. The correlation id lets a failing test be followed across SAP GUI, API calls and the API gateway's logs.

**Maintainability.** Ids live in page objects (a lint warning flags raw ids in specs). A screen change is fixed in one file. Controls with long method chains (grids, trees, table controls) have named helpers over the same COM members the recorder uses.

**Testability and portability.** Everything above the transport runs on any OS. The real transport is Windows-only by nature; tests that need it are *skipped with a reason* elsewhere, never silently passed.

**Performance.** Idle detection is a handful of cheap COM calls per step (an extra `progress` read before and after a server-bound action); session reuse removes per-test logon; nothing sleeps.

**Parallelism.** No global mutable state: a worker owns its connection - but `SAP_GUI_MODE=attach` uses the one session someone already has open, so two workers would drive the same SAP window and interleave keystrokes. `playwright.config.ts` therefore sets `workers: 1` and `fullyParallel: false` whenever attach mode can reach a real SAP (an env `WORKERS` is ignored, with a log line saying so), and the `sap` fixture independently **refuses** attach mode when Playwright is running more than one worker. Parallel workers are fine, and honoured, where each owns its SAP: the simulator, a custom transport, or `SAP_GUI_MODE=open` (a connection per worker, users from `SAP_USER_POOL`); real parallelism beyond that is across machines (Playwright sharding).

## 5. How it compares with the existing Java framework

| Concern | Existing Java framework (as reviewed) | This framework |
|---|---|---|
| Reach SAP | JACOB + `SapROTWr.SapROTWrapper`; 32/64-bit DLL chosen at runtime | PowerShell bridge over the same COM API; bitness via `SAP_GUI_POWERSHELL`; transport is swappable (a JACOB helper can be a transport) |
| Locators | Technical id; by text, by tooltip, by left/right label | Same ids unchanged, plus `getByText/Tooltip/Label/Type`, strict, chainable |
| Actions | `enterText`, `invoke("press")`, type-switch in `selectButton` | `fill`, `click`, `check`, `press` - chosen by control type |
| Waiting | `Thread.sleep(10000)`, 500 ms polling loops, per-call `wait.until` | none in tests; idle + existence wait on every step; retrying assertions |
| Assertions | `SoftAssertions` collecting strings | Playwright `expect` + SAP matchers (`toHaveText`, `toHaveStatusMessage`, ...), `expect.soft` |
| Unexpected pop-ups | handled ad hoc in tests | declared once with `onPopup` |
| Session lifecycle | static singleton, `SAPActive`/`LoggedIn` flags, `isSessionAlive` | per-worker connection, health-checked, reset between tests, closed on teardown only if we opened it |
| Credentials | AES-encrypted password with the key stored in the same properties file; account name hardcoded | env/CI masked variables or per-user DPAPI file; nothing stored beside a key |
| Start SAP GUI | `wmic` terminate + `cmd /C start` with per-environment arguments, `sleep(10000)` | start SAP Logon only if not running; connect by name or connection string; no process killing |
| Paths | `D:\Programs\SAP\...`, `E:\Users\<id>\workspace\...` hardcoded | configuration (`SAP_GUI_LOGON_PATH`, env files); nothing machine-specific in code |
| Errors | `SAPException extends Error`; exceptions swallowed in places | `AdapterError` with `cause`; context in the message. Errors are deliberately ignored only where a failure must not mask another (capturing evidence and the status bar after a failure, releasing the bridge, a cleanup's `home()`, health probes) - those sites use `.catch(() => undefined)` and are listed by `grep`; everything on the path of a test step propagates |
| Evidence | Word/Excel files rewritten per step, hardcoded locations | screenshots attached to the test report (`sap.evidence`), journal on failure; no extra files to manage |
| Logging | `System.out` | shared structured logger, secrets masked, CI-safe |
| Recording to test | paste ids into Java by hand | `npm run convert` produces a test; logic is flagged, never guessed |
| Running without SAP | not possible | simulator: framework tests and the sample tests run anywhere |

What this framework does **not** replace: a Word-document evidence export (screenshots live in the Playwright/Allure report instead - say if a `.docx` is a requirement and it can be added on top of `evidence()`), and the project's own page objects and data objects, which must be ported (the mapping is in [`MIGRATION_FROM_JAVA.md`](MIGRATION_FROM_JAVA.md)).

## 6. Extending it

- **A new control helper** (a control type the recordings use heavily): a small class over `sap.get/set/call` like `SapGrid` in `src/gui/controls.ts`, a factory on the session, a test against the simulator using a screen with `methods`.
- **A new assertion**: add to `src/gui/matchers.ts`; use `until(...)` so it retries.
- **A different way to reach SAP**: implement `SapGuiTransport` (`request(command)`, `close()`); the commands are plain data. A Java helper wrapping the existing JACOB code is the natural second implementation if PowerShell is restricted.
- **A cross-cutting behaviour** (a pop-up every test should survive, a custom fixture): `tests/sapgui/support/sapTest.ts`.

## 7. What has and has not been verified

**Verified** (on macOS, no SAP; the PowerShell bridge's SOURCE is checked as text only - the classification logic that matters is executed in the Java helper's tests, never in PowerShell): all layers above the transport - including both transports' line protocol (a stand-in process for PowerShell's side, the Java helper compiled and run against stand-in JACOB classes) and the conformance suite, which also fails correctly on deliberately broken transports - against a simulator that models screen-change latency, late-appearing controls, drop-downs, pop-ups, the command field and logon failures - including negative controls that show a raw, un-waited sequence failing. The bridge script's contents are checked (ASCII-only; the only `Start-Process` is the SAP Logon launch; no network, registry or file writes; balanced syntax).

**Not verified until it runs on Windows with SAP GUI:**
- the PowerShell bridge itself, and COM behaviour on the target SAP GUI release (the new `find` / `info` operations and `OpenConnectionByConnectionString` were written from the documented API and have not been exercised);
- SAP Logon auto-start;
- that PowerShell and COM are permitted on the target machines (the decision that matters most; the fallback is a JACOB-based transport behind the same interface);
- DPAPI storage (needs Windows);
- that any particular recording replays against the target system.

`npm run doctor` is the first thing to run on a target machine; it reports each of these in order.
