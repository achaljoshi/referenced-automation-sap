# Changelog

## Unreleased

### Added
- **Classic SAP GUI framework**: `sap-vbs-to-playwright` (recording -> flat spec, or `--page-objects`, or `--data` for CSV-driven tests), `SapGuiSession` (waits for SAP, retries, journal, evidence, pop-up handlers, health/home/logoff), Playwright-style locators (`getByLabel/Tooltip/Text/Type`, `orElse` fallbacks reported as drift), type-driven `click()`/`fill()`, retrying assertions, grid/tree/table helpers, `SapPage`, screen contracts (`toMatchScreenContract`, `sap-gui-contracts`), the `sapData` registry with guaranteed cleanup, a user pool for parallel workers, secret providers (env, Windows DPAPI), `sap-gui-insights` (transaction coverage, response-time baseline), `sap-gui-doctor` (incl. `--conformance`), reusable BDD steps (`registerSapSteps`).
- Two transports behind one line protocol: PowerShell (default) and Java/JACOB (`SAP_GUI_TRANSPORT=java`, `bridge/jacob`).
- A built-in SAP simulator, stand-in bridges, and 280+ tests with negative controls.
- Docs: `docs/ARCHITECTURE.md`, `docs/SAP_GUI_GUIDE.md`, `docs/MIGRATION_FROM_JAVA.md`.

### Changed
- **Playwright 1.64.0** (was 1.62.1): the `@playwright/test` / `playwright-core` floor is `^1.64.0` and the peer range is `>=1.64.0 <2.0.0` where the package declares one; run `npx playwright install chromium` after upgrading.
- Fiori `waitForUI5Ready` uses no fixed waits; shared Playwright config; lint rules (no hard waits; a warning for raw ids in specs).

### Not verified
- **The PowerShell bridge and the Java/JACOB helper against a real SAP GUI** (they are tested against a simulator and stand-in classes), SAP Logon auto-start, DPAPI storage, the `find`/`info`/`context` operations and `OpenConnectionByConnectionString` on a real SAP GUI release.
- The Windows `sapgui` CI job (a template; the runner tag is a placeholder).
