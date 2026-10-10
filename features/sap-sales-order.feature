@sapgui @smoke
Feature: Sales orders in SAP
  As a sales administrator
  I want to create sales orders in SAP
  So that customers' orders are recorded

  Background:
    Given I am logged on to SAP

  Scenario: Create a standard sales order
    When I open transaction "VA01"
    And I enter "OR" in the field labelled "Order Type"
    And I enter "1000" in the field labelled "Sales Organization"
    And I enter "10" in the field labelled "Distribution Channel"
    And I enter "00" in the field labelled "Division"
    And I press Enter
    And I enter "1000" in the field labelled "Sold-To Party"
    And I enter "BDD-ORDER" in the field labelled "Customer Reference"
    Then the field labelled "Customer Reference" contains "BDD-ORDER"
    When I click the toolbar button "Save"
    Then the status bar shows a success message containing "has been saved"
    And the status bar does not show an error

  Scenario: The order number SAP reports can be used in a later step
    When I open transaction "VA01"
    And I enter "OR" in the field labelled "Order Type"
    And I press Enter
    And I enter "1000" in the field labelled "Sold-To Party"
    And I click the toolbar button "Save"
    And I remember the number from the status bar matching "Order (\d+)" as "order"
    And I go back
    Then the screen title contains "Create"

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

    Examples:
      | salesOrg | customer |
      | 1000     | 1000     |
      | 2000     | 2000     |
