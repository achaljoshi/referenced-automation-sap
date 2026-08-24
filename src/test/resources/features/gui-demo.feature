@gui
Feature: Classic SAP GUI Scripting demo (reference implementation only)
  As a classic SAP GUI end user
  I want a working example of this repo's JACOB-based SAP GUI Scripting API
  So that I have a concrete starting point instead of an empty package

  IMPORTANT - this feature is NOT run in CI and is excluded by default from
  every `mvn test` invocation in this repo (see pom.xml's
  cucumber.filter.tags=not @gui and README "Classic SAP GUI Scripting
  setup"). It requires: a Windows machine, SAP GUI for Windows installed and
  scripting-enabled, JACOB's native DLL available via -Djacob.dll.path, an
  active SAP Logon connection with a session already open, and a real SAP
  backend. SU3 (Own Data) is used below because it exists, is harmless to
  open, and requires no specific authorizations beyond standard end-user
  access on virtually every SAP system - this is illustrative wiring, not a
  business-process test.

  @gui
  Scenario: Open the Own Data (SU3) transaction and read the status bar
    Given SAP GUI Scripting is attached to the running session
    When I start transaction "SU3"
    Then the SAP GUI status bar should not report an error
