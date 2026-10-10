@sapgui @smoke
Feature: Sales orders in SAP
  As a sales administrator
  I want to create sales orders in SAP
  So that customers' orders are recorded

  Background:
    Given I am logged on to SAP

  Scenario: Create a standard sales order
    Given I make up a unique value starting with "BDD" as "reference"
    When I open transaction "VA01"
    And I enter "OR" in the field labelled "Order Type"
    And I enter "1000" in the field labelled "Sales Organization"
    And I enter "10" in the field labelled "Distribution Channel"
    And I enter "00" in the field labelled "Division"
    And I press Enter
    And I enter "1000" in the field labelled "Sold-To Party"
    And I enter "{{reference}}" in the field labelled "Customer Reference"
    Then the field labelled "Customer Reference" contains "{{reference}}"
    When I click the toolbar button "Save"
    Then the status bar shows a success message containing "has been saved"
    And the saved sales order is registered for cleanup as "order"
    And the status bar does not show an error

  Scenario: The order number SAP reports can be used in a later step
    When I open transaction "VA01"
    And I enter "OR" in the field labelled "Order Type"
    And I press Enter
    And I enter "1000" in the field labelled "Sold-To Party"
    And I click the toolbar button "Save"
    Then the saved sales order is registered for cleanup as "order"
    When I open transaction "VA02"
    And I enter the remembered "order" in the field labelled "Order"
    And I press Enter
    Then the screen title contains "Change Standard Order"

  Scenario: Entering nothing keeps you on the initial screen
    When I open transaction "VA01"
    And I press Enter
    Then the screen title contains "Initial Screen"

  Scenario Outline: Orders can be created for different sales organisations
    When I open transaction "VA01"
    And I enter "OR" in the field labelled "Order Type"
    And I enter "<salesOrg>" in the field labelled "Sales Organization"
    And I press Enter
    And I enter "<customer>" in the field labelled "Sold-To Party"
    And I click the toolbar button "Save"
    Then the status bar shows a success message containing "has been saved"
    And the saved sales order is registered for cleanup as "order"

    Examples:
      | salesOrg | customer |
      | 1000     | 1000     |
      | 2000     | 2000     |
