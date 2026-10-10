@sapgui @regression
Feature: Test data that is unique and fresh

  Scenario: A customer reference made up for this run is entered and read back
    Given I am logged on to SAP
    And I set the variable "reference" to "BDD-{{random:alnum(6)}}"
    When I open transaction "VA01"
    And I enter "OR" in the field labelled "Order Type"
    And I press Enter
    And I enter "1000" in the field labelled "Sold-To Party"
    And I enter "{{reference}}" in the field labelled "Customer Reference"
    Then the field labelled "Customer Reference" contains "{{reference}}"
    And the variable "reference" matches "BDD-[A-Za-z0-9]{6}"

  Scenario: A remembered order number is also a {{placeholder}} for later steps
    Given I am logged on to SAP
    When I open transaction "VA01"
    And I enter "OR" in the field labelled "Order Type"
    And I press Enter
    And I enter "1000" in the field labelled "Sold-To Party"
    And I click the toolbar button "Save"
    And I remember the number from the status bar matching "Order (\d+)" as "order"
    Then the variable "order" matches "\d+"
    And the status bar shows "Order {{order}}"
