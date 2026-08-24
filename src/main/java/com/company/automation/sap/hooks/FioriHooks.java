package com.company.automation.sap.hooks;

import com.company.automation.driver.PlaywrightFactory;
import com.company.automation.driver.PlaywrightManager;
import com.company.automation.utils.ScreenshotUtils;
import com.microsoft.playwright.Browser;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;
import io.cucumber.java.After;
import io.cucumber.java.Before;
import io.cucumber.java.Scenario;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Cucumber hooks for Fiori/UI5 (browser-based) scenarios, scoped to the
 * {@code @fiori} tag only (see {@code SapGuiHooks}, scoped to {@code @gui},
 * for the classic SAP GUI side of this repo's mixed suite).
 *
 * <p>Deliberately does <b>not</b> reuse {@code referenced-automation-ui}'s
 * own {@code Hooks} class directly - that class's {@code @Before}/
 * {@code @After} methods are untagged, so wiring it into this repo's glue
 * path would launch a browser for every scenario, including pure
 * {@code @gui} ones that never touch Playwright. Instead this class calls
 * the same underlying {@code PlaywrightFactory}/{@code PlaywrightManager}
 * that {@code Hooks} uses - reusing the framework's actual browser/context
 * lifecycle logic, just with the {@code @fiori} tag scope this mixed repo
 * needs and {@code referenced-automation-ui} alone does not.
 */
public class FioriHooks {

    private static final Logger LOG = LoggerFactory.getLogger(FioriHooks.class);

    @Before(value = "@fiori", order = 0)
    public void setUp(Scenario scenario) {
        LOG.info("Provisioning Playwright browser for Fiori scenario: {}", scenario.getName());
        Playwright playwright = PlaywrightFactory.createPlaywright();
        Browser browser = PlaywrightFactory.createBrowser(playwright);
        BrowserContext context = PlaywrightFactory.createContext(browser);
        Page page = context.newPage();

        PlaywrightManager.setPlaywright(playwright);
        PlaywrightManager.setBrowser(browser);
        PlaywrightManager.setContext(context);
        PlaywrightManager.setPage(page);
    }

    @After(value = "@fiori", order = 0)
    public void tearDown(Scenario scenario) {
        try {
            if (scenario.isFailed() && PlaywrightManager.hasPage()) {
                byte[] screenshot = ScreenshotUtils.capture(PlaywrightManager.getPage(), scenario.getName());
                if (screenshot.length > 0) {
                    scenario.attach(screenshot, "image/png", "Failure screenshot: " + scenario.getName());
                }
            }
        } finally {
            LOG.info("Closing Playwright resources for Fiori scenario: {} [{}]", scenario.getName(), scenario.getStatus());
            PlaywrightManager.quit();
        }
    }
}
