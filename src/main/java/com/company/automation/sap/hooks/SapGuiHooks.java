package com.company.automation.sap.hooks;

import com.company.automation.sap.config.SapGuiConfig;
import com.company.automation.sap.gui.SapGuiEnvironment;
import com.company.automation.sap.gui.SapGuiSession;
import com.company.automation.sap.gui.SapGuiSessionFactory;
import com.company.automation.sap.gui.SapGuiSessionManager;
import io.cucumber.java.After;
import io.cucumber.java.Before;
import io.cucumber.java.Scenario;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Cucumber hooks for classic SAP GUI Scripting scenarios, scoped to the
 * {@code @gui} tag only - so a mixed suite that also has {@code @fiori}
 * (Playwright/browser) scenarios never pays the cost of (or risks) touching
 * SAP GUI for a scenario that doesn't need it, and vice versa (see
 * {@code FioriHooks}, scoped to {@code @fiori}).
 *
 * <p>Add this package to your Cucumber {@code glue} path and tag every
 * classic SAP GUI scenario {@code @gui}:
 *
 * <pre>{@code
 * @Suite
 * @IncludeEngines("cucumber")
 * @SelectClasspathResource("features")
 * @ConfigurationParameter(key = GLUE_PROPERTY_NAME,
 *         value = "com.company.automation.sap.hooks,com.mycompany.myproject.stepdefinitions")
 * public class RunCucumberTest { }
 * }</pre>
 */
public class SapGuiHooks {

    private static final Logger LOG = LoggerFactory.getLogger(SapGuiHooks.class);

    @Before(value = "@gui", order = 0)
    public void setUp(Scenario scenario) {
        LOG.info("Provisioning SAP GUI session for scenario: {}", scenario.getName());
        SapGuiEnvironment.initThread();

        SapGuiSession session = SapGuiConfig.attachToExistingSession()
                ? SapGuiSessionFactory.attachToRunningSession(SapGuiConfig.connectionIndex(), SapGuiConfig.sessionIndex())
                : SapGuiSessionFactory.openConnection(SapGuiConfig.connectionName());

        SapGuiSessionManager.setSession(session);
    }

    @After(value = "@gui", order = 0)
    public void tearDown(Scenario scenario) {
        try {
            if (SapGuiSessionManager.hasSession()) {
                SapGuiSession session = SapGuiSessionManager.getSession();
                if (scenario.isFailed()) {
                    scenario.attach(session.statusBarText(), "text/plain", "SAP GUI status bar at failure");
                }
                if (SapGuiConfig.closeSessionAfterTest()) {
                    session.close();
                }
            }
        } finally {
            LOG.info("Releasing SAP GUI session for scenario: {} [{}]", scenario.getName(), scenario.getStatus());
            SapGuiSessionManager.clear();
            SapGuiEnvironment.releaseThread();
        }
    }
}
