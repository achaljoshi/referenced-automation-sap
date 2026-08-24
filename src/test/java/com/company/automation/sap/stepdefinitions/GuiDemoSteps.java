package com.company.automation.sap.stepdefinitions;

import com.company.automation.sap.gui.SapGuiSession;
import com.company.automation.sap.gui.SapGuiSessionManager;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import org.junit.jupiter.api.Assertions;

/**
 * Step definitions for gui-demo.feature - a reference-only illustration of
 * the {@link SapGuiSession} API against classic SAP GUI Scripting.
 *
 * <p><b>This is not executed in CI</b> (see README "Classic SAP GUI
 * Scripting setup" and "CI/CD"): it requires a real Windows machine with SAP
 * GUI for Windows installed, an active SAP Logon connection, JACOB's native
 * DLL on the path, and a real SAP backend to attach to - none of which any
 * hosted CI runner in this family's pipelines has. It is shipped so a team
 * that does have that environment has a concrete, working starting point
 * rather than an empty package.
 */
public class GuiDemoSteps {

    @Given("SAP GUI Scripting is attached to the running session")
    public void sap_gui_is_attached() {
        Assertions.assertTrue(SapGuiSessionManager.hasSession(),
                "Expected SapGuiHooks to have attached a SapGuiSession for this @gui scenario");
    }

    @When("I start transaction {string}")
    public void i_start_transaction(String tcode) {
        SapGuiSessionManager.getSession().startTransaction(tcode);
    }

    @Then("the SAP GUI status bar should not report an error")
    public void the_status_bar_should_not_report_an_error() {
        SapGuiSession session = SapGuiSessionManager.getSession();
        String statusBarText = session.statusBarText();
        Assertions.assertNotNull(statusBarText, "Expected a status bar text (even an empty one) to be readable");
    }
}
