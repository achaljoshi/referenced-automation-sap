# referenced-automation-sap

SAP Fiori/UI5 automation on Playwright, reusing [`referenced-automation-ui`](../referenced-automation-ui)'s `BasePage` wholesale - same `Page`, same logged actions, same everything. This repo adds exactly two things generic web automation doesn't need for a UI5 app.

> Classic SAP GUI Scripting (JACOB/COM, Windows-only) is out of scope here by design - see the note at the bottom for why.

## `FioriPage`

```ts
import { FioriPage } from '@automation/referenced-automation-sap';

class MyFioriPage extends FioriPage {
  async clickAddToCart() {
    await this.click(this.byControlId('addToCartBtn'));
    await this.waitForUI5Ready();
  }
}
```

| Method | Why UI5 needs it |
|---|---|
| `byControlId(logicalId)` | UI5 renders a control's DOM id as an auto-generated view/component path **plus** the developer-assigned logical id you gave it in the view - e.g. a button with `id="addToCartBtn"` inside a view UI5 auto-names `container-cart---welcomeView` renders as `id="container-cart---welcomeView--addToCartBtn"`. Matching the logical id as a suffix (`[id$="addToCartBtn"]`) survives that auto-generated prefix changing between app reloads/versions, which a full/exact id match never would. |
| `waitForUI5Ready()` | UI5 shows a busy indicator while fetching data/re-rendering; interacting before it clears is a common source of flaky UI5 test automation. Waits for every busy-indicator element to disappear, then for network idle. |

Where a control has a proper ARIA role/label - most standard `sap.m` controls do - prefer Playwright's own `page.getByRole()`/`getByLabel()` over `byControlId`; they're more resilient. `byControlId` is for the custom/compound controls that don't expose one. `tests/support/FioriCartPage.ts` shows both used side by side against a real app.

## Quick start

```bash
./scripts/setup.sh      # npm ci + playwright install --with-deps chromium (scripts/setup.bat on Windows)
npm test
```

## Verifying this repo's own tests

Two things are tested, deliberately kept separate:

1. **`tests/fioriPage.spec.ts`** - `byControlId`/`waitForUI5Ready` against a small local fixture (`tests/support/fioriStyleFixture.html`) that mimics UI5's id-prefixing convention. Deterministic, no network dependency, no flake risk.
2. **`tests/fioriCart.spec.ts`** - a real integration test against SAP's own publicly hosted [Shopping Cart SAPUI5 demo kit app](https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html) (credential-free, officially SAP-maintained - not a random third party). Every selector in `tests/support/FioriCartPage.ts` was confirmed against a live render before being written, not guessed from documentation. Its "Promoted Items" panel rotates contents between loads, so the test asserts the shape of the cart total, not one hardcoded value.

## Environments

Same `.env.<name>` + `ENV=<name>` pattern as the rest of this family (see `referenced-automation-utils`'s README). `playwright.config.ts` reads `BASE_URL`/`HEADLESS` from the active env file.

## Distributing this package

```bash
./scripts/create-package.sh   # writes ../shared-packages/referenced-automation-sap-<version>.tgz
```

## IDE setup

Same as the other repos in this family: VS Code prompts for recommended extensions on open; IntelliJ/WebStorm ships ESLint/Prettier wired in plus an `npm: test` run configuration.

## A note on classic SAP GUI Scripting

The previous (Java) version of this repo also covered classic SAP GUI Scripting via JACOB (a Java-COM bridge, Windows-only at runtime) for teams still running native SAP GUI transactions rather than Fiori/UI5. Playwright drives browsers, not Win32 COM objects, so there is no equivalent here - this repo is Fiori/UI5-only going forward. A team that still needs classic SAP GUI automation needs a separate, COM-capable tool for that half; it does not compose with this framework family the way Fiori/UI5 (which *is* browser automation) does.
