@fiori
Feature: SAPUI5 Shopping Cart demo (Fiori/UI5 via Playwright)
  As a Fiori/UI5 end user
  I want the Shopping Cart demo app to load correctly
  So that I know this repo's Playwright-based Fiori automation is wired up correctly

  This targets a public, credential-free SAPUI5 demo app maintained by SAP
  (https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html) -
  no real SAP backend, Fiori Launchpad, or credentials are needed to run it,
  which is why it is safe to execute unattended in CI (see README "Sample
  test suite").

  @smoke
  Scenario: The demo app loads and renders its product list
    Given I open the SAPUI5 Shopping Cart demo app
    Then the Shopping Cart app should load
    And at least one product should be listed
