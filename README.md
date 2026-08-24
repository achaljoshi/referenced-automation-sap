# Referenced Automation SAP Framework

An enterprise reference automation framework for **SAP**, covering both
automation styles a typical SAP QA org needs in **one repo**: SAP
Fiori/UI5 via **Playwright** (reusing `referenced-automation-ui`'s
browser/context lifecycle, page object base class, reporting and logging
wholesale) and classic **SAP GUI Scripting** via **JACOB** (Java-COM
Bridge, Windows-only at runtime). Cucumber + Java + Maven, published to
Nexus and imported as a Maven dependency like any other library - not
cloned and copy-pasted per project.

## Table of contents

- [Why this repo depends on referenced-automation-ui](#why-this-repo-depends-on-referenced-automation-ui)
- [Why one repo, two automation styles](#why-one-repo-two-automation-styles)
- [What's included](#whats-included)
- [Project layout](#project-layout)
- [Quick start - Fiori/UI5 side](#quick-start---fiorius5-side)
- [Classic SAP GUI Scripting setup](#classic-sap-gui-scripting-setup)
- [Using this as a dependency in another project](#using-this-as-a-dependency-in-another-project)
- [Configuration](#configuration)
- [Safety: attach by default, never auto-close](#safety-attach-by-default-never-auto-close)
- [Reporting & logging](#reporting--logging)
- [Retry logic](#retry-logic)
- [CI/CD](#cicd)
- [Publishing to Nexus](#publishing-to-nexus)
- [IntelliJ IDEA setup](#intellij-idea-setup)
- [Extending the framework](#extending-the-framework)
- [A note on verification](#a-note-on-verification)

## Why this repo depends on referenced-automation-ui

`referenced-automation-api` was deliberately built **independent** of
`referenced-automation-ui` (see that repo's README) so a team that only
needs REST API testing never pulls in a browser dependency. This repo makes
the opposite call for its Fiori/UI5 half, and on purpose: Fiori/UI5
automation *is* browser automation. It needs exactly the same Playwright
`Browser`/`BrowserContext`/`Page` lifecycle, the same `BasePage` contract,
the same `WaitUtils`/`ScreenshotUtils`, the same `ConfigReader` keys
(`browser`, `headless`, `viewport.width`, `trace.enabled`, ...), and the
same Extent/Allure/Log4j2 reporting stack that `referenced-automation-ui`
already ships and this framework family expects every browser-based repo to
produce. Depending on it and reusing those classes directly means:

- Zero duplicated framework code for the Fiori/UI5 side - see `FioriHooks`,
  which calls `com.company.automation.driver.PlaywrightFactory` and
  `PlaywrightManager` directly rather than reimplementing them.
- One upgrade path: a Playwright version bump, a new `ConfigReader` key, a
  reporting fix - land it once in `referenced-automation-ui`, bump this
  repo's `ui.version` property, done.
- Page objects for Fiori/UI5 screens extend the exact same
  `com.company.automation.base.BasePage` a `referenced-automation-ui`
  consumer would - see `FioriCartPage` below.

`referenced-automation-utils` (test data, JSON/YAML, crypto, generic config
loading) is a dependency here for the same reason every repo in this family
depends on it: it is pure, framework-agnostic commons with no coupling to
either Selenium, Playwright, or SAP.

## Why one repo, two automation styles

Classic SAP GUI Scripting (JACOB) and Fiori/UI5 (Playwright) are
technically unrelated - one drives a native Win32 COM object model, the
other drives a browser - but from an SAP QA team's perspective they are the
*same testing problem* wearing two different UIs, often for the exact same
business process mid-migration from GUI transactions to Fiori apps. Keeping
both in one repo means one Maven coordinate, one CI pipeline, one README,
and one place for a tester who knows one style to discover the other,
instead of two frameworks a team has to independently track and version.

The two styles are kept from interfering with each other via **Cucumber's
tag-scoped hooks**:

| Tag      | Hook class     | Lifecycle                                                          |
|----------|-----------------|---------------------------------------------------------------------|
| `@fiori` | `FioriHooks`    | Playwright `Browser`/`BrowserContext`/`Page` per scenario           |
| `@gui`   | `SapGuiHooks`   | Attach-or-open a `SapGuiSession` (JACOB/COM) per scenario           |

A `@fiori` scenario never touches JACOB; a `@gui` scenario never launches a
browser. Both hook classes live in `com.company.automation.sap.hooks` -
**not** `com.company.automation.hooks` (referenced-automation-ui's own
untagged `Hooks`), which would launch a Playwright browser for every
scenario including pure `@gui` ones. See `FioriHooks`'s Javadoc for the
full rationale.

## What's included

**Fiori/UI5 side** (`@fiori`):
- `FioriHooks` - Playwright browser/context/page lifecycle scoped to `@fiori`
- Reused unmodified from `referenced-automation-ui`: `BasePage`,
  `PlaywrightFactory`/`PlaywrightManager`, `WaitUtils`, `ScreenshotUtils`,
  `ConfigReader`, `StepLoggerPlugin`, Extent/Allure/Log4j2 configuration

**Classic SAP GUI Scripting side** (`@gui`):
- `SapGuiEnvironment` - one-time native library load + COM apartment thread init/release
- `SapGuiSession` - typed wrapper over `FindById`/`press`/`select`/text get-set/checkbox/combo/`sendVKey`/`startTransaction`/`statusBarText`
- `SapGuiSessionFactory` - attach to an already-open connection/session (default) or open a new named one
- `SapGuiSessionManager` - `ThreadLocal` session holder, mirroring `PlaywrightManager`/`ApiContextManager`
- `SapGuiHooks` - session lifecycle scoped to `@gui`
- `SapGuiConfig` - its own `sap/sap-gui.properties` (see "Configuration")

**Sample suite** (`src/test`, not shipped in the published jar):
- `fiori-cart.feature` / `FioriCartPage` / `FioriCartSteps` - runs against a
  public SAPUI5 "Shopping Cart" demo app, no real backend needed, safe for CI
- `gui-demo.feature` / `GuiDemoSteps` - a reference-only classic SAP GUI
  Scripting flow (opens transaction `SU3`), **not** run in CI - see below

Standard framework-family plumbing: retry-via-rerun-file, GitLab CI +
GitHub Actions, IntelliJ zero-config run configurations, `mvnw`/`mvnw.cmd`.

## Project layout

```
referenced-automation-sap/
├── pom.xml
├── src/main/java/com/company/automation/sap/
│   ├── config/SapGuiConfig.java
│   ├── exceptions/SapGuiException.java
│   ├── gui/SapGuiEnvironment.java
│   ├── gui/SapGuiSession.java
│   ├── gui/SapGuiSessionFactory.java
│   ├── gui/SapGuiSessionManager.java
│   └── hooks/{FioriHooks,SapGuiHooks}.java
├── src/main/resources/sap/sap-gui.properties
└── src/test/                      (sample suite - not shipped in the jar)
    ├── java/com/company/automation/sap/
    │   ├── pages/FioriCartPage.java
    │   ├── stepdefinitions/{FioriCartSteps,GuiDemoSteps}.java
    │   └── runners/{RunCucumberTest,RunSmokeTest}.java
    └── resources/
        ├── features/{fiori-cart,gui-demo}.feature
        └── junit-platform.properties
```

## Quick start - Fiori/UI5 side

```bash
git clone <this-repo>
cd referenced-automation-sap
./mvnw exec:java@install-playwright-browsers   # one-time, downloads Chromium
./mvnw test                                     # runs @fiori scenarios only (pom default: not @gui)
```

Same Playwright browser-install mechanism as `referenced-automation-ui` -
see that repo's README "Installing browsers" for the full explanation of
why there is no separate driver binary to manage.

## Classic SAP GUI Scripting setup

This is the one part of this framework family that only runs on **Windows**,
and only with real SAP software installed - there is no way around that,
JACOB is a bridge to a native Win32 COM object model that does not exist on
Linux/macOS or without SAP GUI installed. To run the `@gui` scenario:

1. Install **SAP GUI for Windows** and enable scripting: SAP Logon ->
   Options -> Accessibility & Scripting -> Scripting -> check "Enable
   scripting" (and, on the backend side, `RZ11` -> `sapgui/user_scripting` = `TRUE`,
   which a Basis admin usually needs to set).
2. Open SAP Logon, open a connection, log in - leave the session open. By
   default this framework **attaches** to that already-open session; it
   never opens a fresh connection unless you set
   `sap.gui.attach.existing=false` (see "Configuration").
3. Download JACOB's native DLL matching your JVM's bitness (almost always
   64-bit: `jacob-1.18-x64.dll`) from the
   [`com.hynnet:jacob:1.18`](https://mvnrepository.com/artifact/com.hynnet/jacob/1.18)
   distribution and place it anywhere on disk.
4. Point the JVM at it and run just the `@gui` scenario:
   ```bash
   ./mvnw test -Dcucumber.filter.tags=@gui -Djacob.dll.path="C:\path\to\jacob-1.18-x64.dll"
   ```
   (`jacob.dll.path` is the exact system property name JACOB's own
   `LibraryLoader` checks first - verified against JACOB's published source,
   see "A note on verification".)

None of this is possible in this repo's own CI (hosted Linux runners) or in
most teams' CI in general, which is why `@gui` is excluded by default (pom
property `cucumber.filter.tags=not @gui`, reinforced in
`junit-platform.properties`'s glue and in `RunSmokeTest`'s explicit filter -
see that class's Javadoc). A team with a suitably equipped, always-on
Windows machine can wire up a self-hosted GitLab Runner or GitHub Actions
self-hosted runner tagged e.g. `sap-gui`, dedicated to just that one job -
this repo does not attempt to fabricate a CI job for it, since a job that
can never actually execute would be worse than no job at all.

## Using this as a dependency in another project

```xml
<dependency>
    <groupId>com.company.automation</groupId>
    <artifactId>referenced-automation-sap</artifactId>
    <version>1.0.0-SNAPSHOT</version>
</dependency>
```

This transitively brings in `referenced-automation-ui` (Playwright, Cucumber,
Extent, Allure, Log4j2, `slf4j-api`) and `referenced-automation-utils`, so a
consuming project does not redeclare any of those directly (same rule as
`referenced-automation-sap`'s own `pom.xml` - see the comment there).

```java
@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
@ConfigurationParameter(key = GLUE_PROPERTY_NAME,
        value = "com.company.automation.sap.hooks,com.mycompany.myproject.stepdefinitions")
public class RunCucumberTest { }
```

Tag every Fiori/UI5 scenario `@fiori` and every classic SAP GUI Scripting
scenario `@gui` - the two hook classes on that glue path only fire for their
own tag.

## Configuration

Fiori/UI5 side: reuses `referenced-automation-ui`'s
`com.company.automation.config.ConfigReader` and its `config/config.properties`
keys (`browser`, `headless`, `viewport.width`/`height`, `trace.enabled`,
`base.url`, etc.) completely unmodified - see that repo's README
"Configuration" for the full key reference.

Classic SAP GUI Scripting side: its own `sap/sap-gui.properties`, read by
`com.company.automation.sap.config.SapGuiConfig`. Deliberately **not**
`config/config.properties` - two dependency jars shipping a resource at the
identical classpath path is a real, easy-to-hit problem (whichever the
classloader finds first silently wins), so this framework family gives
every additional config surface its own unique resource path instead of
overloading a shared one.

| Key                                    | Default | Meaning                                                             |
|-----------------------------------------|---------|----------------------------------------------------------------------|
| `sap.gui.attach.existing`               | `true`  | Attach to an already-open connection/session (recommended) vs. open a new one |
| `sap.gui.connection.index`              | `0`     | Only used when attaching                                             |
| `sap.gui.session.index`                 | `0`     | Only used when attaching                                             |
| `sap.gui.connection.name`               | ``      | Only used when `attach.existing=false` - must match SAP Logon's `saplogon.ini` |
| `sap.gui.close.session.after.test`      | `false` | Whether `SapGuiHooks` closes the session after every `@gui` scenario  |

Same three-tier override rules as the rest of this family: `-D` system
property > OS env var (upper-cased, dots -> underscores) > properties file.

## Safety: attach by default, never auto-close

Classic SAP GUI sessions are frequently shared, interactive, and expensive
to re-establish (SSO, 2FA, VPN-gated backends). This framework defaults to
the least destructive possible behaviour:

- **Attaches** to an already-open session rather than opening a new
  connection, unless explicitly configured otherwise.
- **Never closes** that session automatically after a test
  (`sap.gui.close.session.after.test=false` by default) - `SapGuiSession.close()`'s
  Javadoc spells out why this is opt-in, not automatic teardown behaviour.

A team that wants fully automated, disposable sessions (e.g. a dedicated CI
service account) can opt into both `attach.existing=false` (open a fresh
named connection) and `close.session.after.test=true` - but that is a
deliberate choice a consuming project makes, not this framework's default.

## Reporting & logging

Identical mechanism to `referenced-automation-ui` (Extent Spark HTML report
under `target/extent-report`, Allure results under `target/allure-results`,
console + `logs/automation.log` via Log4j2, `StepLoggerPlugin` for
per-step logging) - all reused from that dependency unmodified. On a `@gui`
failure, `SapGuiHooks` attaches the SAP GUI status bar text to the scenario
as a `text/plain` attachment (there is no screenshot equivalent for a native
COM session the way there is for a Playwright `Page`).

## Retry logic

Same rerun-file pattern as the rest of this framework family (see
`referenced-automation-ui`'s README for the full explanation) - applies to
`@fiori` scenarios in CI. `@gui` is excluded from automated CI runs
entirely, so it is never subject to automated retry either; run it manually
via `scripts/retry-failed.sh -Dcucumber.filter.tags=@gui` on a properly
equipped Windows machine if you want the same retry behaviour there.

## CI/CD

`.gitlab-ci.yml` / `.github/workflows/ci.yml` both:

1. Clone and `mvn install` **both** `referenced-automation-utils` and
   `referenced-automation-ui` from source (temporary bring-up workaround,
   same pattern as `referenced-automation-api`'s CI - delete once both are
   published to Nexus).
2. Install Playwright's Chromium binary (same `exec:java@install-playwright-browsers`
   step as `referenced-automation-ui`).
3. Run the suite with `-Dcucumber.filter.tags="not @gui"` explicitly (belt
   and braces on top of the `pom.xml` default), retry failures once via the
   rerun file, publish Cucumber/Extent/Allure artifacts and an Allure Pages
   site, and deploy to Nexus on `main`/tags.

`@gui` is not run by any job in either pipeline - see "Classic SAP GUI
Scripting setup" above for why, and for how a team with the right hardware
can wire up a dedicated self-hosted runner for it outside of what ships here.

## Publishing to Nexus

Same as every repo in this family:

```bash
./mvnw -s settings.xml deploy
```

`distributionManagement` in `pom.xml` points at `${env.NEXUS_RELEASE_URL}` /
`${env.NEXUS_SNAPSHOT_URL}`; see `settings.xml.sample` for the credentials
shape CI generates on the fly from protected secrets.

## IntelliJ IDEA setup

Open the folder - IntelliJ IDEA Ultimate detects the Maven project and its
Cucumber/Gherkin plugin needs automatically (`.idea/externalDependencies.xml`).
Pre-built run configurations (`.idea/runConfigurations/`):

- **Maven: install-playwright-browsers** - one-time browser download
- **Maven: clean test** - full `not @gui` suite
- **Regression (RunCucumberTest)** / **Smoke (RunSmokeTest)** - JUnit
  configurations for the same
- **GUI Demo (manual, Windows + SAP GUI only)** - runs just the `@gui`
  scenario; only meaningful after completing "Classic SAP GUI Scripting
  setup" above, and its `-Djacob.dll.path` placeholder needs editing to a
  real path first

IntelliJ IDEA Community Edition does not support Cucumber/Gherkin at all
(no syntax highlighting, no step navigation) - Ultimate is required for
this repo's `.feature` files, same as the rest of this framework family.

## Extending the framework

- New Fiori/UI5 page object? Extend `referenced-automation-ui`'s `BasePage`
  exactly like `FioriCartPage` does - no new base class needed here.
- New classic SAP GUI screen/transaction? Use `SapGuiSessionManager.getSession()`
  and its `findById`/`press`/`select`/`setText`/`getText`/`setCheckBox`/
  `setComboBoxValue`/`sendVKey`/`startTransaction` methods, or drop to
  `SapGuiSession.raw()` for anything not yet wrapped.
- Need a GuiComponent-specific interaction `SapGuiSession` doesn't wrap yet?
  `raw()` returns the underlying `ActiveXComponent` for the session itself;
  `findById(id).raw()` (once exposed the same way on the element wrapper)
  is the intended escape hatch for one-off `Dispatch.call`/`getProperty`/
  `setProperty` calls without waiting on a framework change.

## A note on verification

This sandbox cannot reach Maven Central (`mvn`/`mvnw` fail with HTTP 403 on
every attempt) and therefore cannot compile or execute anything in this
repo, including its `@fiori` sample scenario. Every non-trivial API call was
instead verified by reading real, current upstream source rather than from
memory:

- **JACOB** (`com.hynnet:jacob:1.18`): `ComThread.InitSTA()`/`Release()`,
  `LibraryLoader.loadJacobLibrary()` and its exact `jacob.dll.path` system
  property name, `ActiveXComponent`'s constructor and class hierarchy
  (`ActiveXComponent extends Dispatch extends JacobObject`), `Dispatch.call(Dispatch, String, Object...)`,
  and `Variant.toDispatch()` were all confirmed against JACOB's published
  source and javadoc.io class hierarchy pages.
- **The SAP GUI Scripting bootstrap sequence** (ROT wrapper ->
  `GetROTEntry("SAPGUI")` -> `GetScriptingEngine` -> `GuiApplication` ->
  `Children` -> `GuiConnection` -> `Children` -> `GuiSession` -> `FindById`)
  was cross-checked against a real, published reference implementation
  (`PoojaGugu/SAP-GuiClient-Automation` on GitHub) rather than written from
  general recollection of SAP GUI Scripting's object model.
- **Playwright Java** (`com.microsoft.playwright:playwright:1.62.0`) usage
  on the Fiori/UI5 side is identical to `referenced-automation-ui`'s own,
  already-verified usage (`BasePage`, `PlaywrightFactory`, `PlaywrightManager`
  are that repo's actual classes, not reimplementations) - see that repo's
  README "A note on verification" for how those were checked against
  Playwright's own cloned source.
- **The `fiori-cart.feature` sample's selectors** are the one exception
  worth calling out explicitly: the target app is a client-side-rendered
  SAPUI5 single-page app, so its DOM (unlike SauceDemo's static HTML) is not
  visible to a plain HTTP fetch and could not be captured for offline
  verification the same way every other selector in this framework family
  was. `.sapMTitle`/`.sapMListItem` are genuine, documented SAPUI5 framework
  CSS classes rather than invented ones, but they have not been confirmed
  against a live render of this exact demo app - see `FioriCartPage`'s
  Javadoc for how to regenerate them with `npx playwright codegen` if a UI5
  version bump shifts them. The one assertion in that scenario not subject
  to this caveat - the browser tab title being exactly "Shopping Cart" - was
  independently confirmed by fetching the live page.

As with every repo in this family: review before relying on it in
production, and please report anything that turns out to be wrong.
