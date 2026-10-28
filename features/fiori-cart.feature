@regression @live
Feature: Shopping cart in a SAPUI5 app
  As a shopper
  I want the cart to show what I am going to pay
  So that I can check the total before I order

  # Runs against SAP's public demo kit app (ui5.sap.com), so it needs network access: tagged @live, which `npm run test:bdd`
  # leaves out (the CI pipeline cannot rely on that host being reachable).
  Scenario: Adding a promoted item updates the cart total
    Given I open the SAPUI5 shopping cart demo
    Then the shopping cart app has loaded
    When I add the first promoted item to the cart
    And I open the cart
    Then the cart total is shown as an amount in EUR
