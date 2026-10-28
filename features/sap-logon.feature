@sapgui @smoke
Feature: Logging on to SAP
  As a tester
  I want a clear answer when I log on
  So that a wrong or missing password is obvious and never hangs the run

  Background:
    Given SAP is showing the logon screen

  Scenario: A valid user logs on and reaches SAP Easy Access
    When I log on with:
      | client   | 100                    |
      | user     | {{env:SAP_USER}}       |
      | password | {{env:SAP_PASSWORD}}   |
      | language | EN                     |
    Then the command field is available
    And the screen title is "SAP Easy Access"

  Scenario: A wrong password is refused on the logon screen, with SAP's own message
    When I try to log on with:
      | client   | 100                    |
      | user     | {{env:SAP_USER}}       |
      | password | nope                   |
      | language | EN                     |
    Then the logon is refused with a message matching "still on the logon screen.*Name or password is incorrect"

  Scenario: A wrong password is a visible outcome, not a hang
    When I enter "100" in the field labelled "Client"
    And I enter "{{env:SAP_USER}}" in the field labelled "User"
    And I enter "wrong" in the field labelled "Password"
    And I press Enter
    Then the status bar shows "incorrect"

  Scenario: Missing credentials are refused before SAP is touched, and say where to put them
    When I try to log on with:
      | user     |  |
      | password |  |
    Then the logon is refused with a message matching "SAP_USER and SAP_PASSWORD must both be set.*\.env\.\w+\.local"
    And the logon screen is showing

  Scenario: The password is not in the failure message
    When I try to log on with:
      | client   | 100                    |
      | user     | {{env:SAP_USER}}       |
      | password | hunter2-secret         |
      | language | EN                     |
    Then the logon message does not contain "hunter2-secret"

  Scenario: Being logged on already, a second request to log on leaves SAP alone
    When I make sure I am logged on with:
      | client   | 100                    |
      | user     | {{env:SAP_USER}}       |
      | password | {{env:SAP_PASSWORD}}   |
      | language | EN                     |
    Then the screen title is "SAP Easy Access"
    When I make sure I am logged on with:
      | user     | ignored                |
      | password | ignored                |
    Then the screen title is "SAP Easy Access"

  Scenario: Logging off returns to the logon screen
    When I log on with:
      | client   | 100                    |
      | user     | {{env:SAP_USER}}       |
      | password | {{env:SAP_PASSWORD}}   |
      | language | EN                     |
    Then the screen title is "SAP Easy Access"
    When I log off
    Then the logon screen is showing
