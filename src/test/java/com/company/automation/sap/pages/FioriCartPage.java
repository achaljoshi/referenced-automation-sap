package com.company.automation.sap.pages;

import com.company.automation.base.BasePage;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.options.LoadState;

/**
 * Page object for the public SAPUI5 "Shopping Cart" demo app
 * (https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html),
 * used here purely as a credential-free, no-real-backend-needed sample for
 * this repo's {@code @fiori} scenarios - extends {@code referenced-automation-ui}'s
 * {@link BasePage} exactly like a page object in the ui repo itself would.
 *
 * <p><b>A note on the selectors below</b>: this is a client-side-rendered
 * SAPUI5 single-page app, so (unlike the static SauceDemo HTML used in
 * referenced-automation-ui's own sample suite) its DOM is not visible to a
 * plain HTTP fetch and could not be captured for offline verification the
 * same way the rest of this framework family's selectors were. The classes
 * used here ({@code .sapMTitle}, {@code .sapMListItem}, {@code .sapMBtn}) are
 * genuine, documented SAPUI5 control CSS classes (sap.m.Title, sap.m.List
 * item, sap.m.Button respectively) rather than app-specific generated IDs,
 * chosen because framework-level classes are far less likely to change than
 * auto-generated element IDs - but they have not been confirmed against a
 * live render of this exact demo app. If a UI5 version bump on sap.github.io
 * shifts them, regenerate with: {@code npx playwright codegen
 * https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html}
 */
public class FioriCartPage extends BasePage {

    private static final String LIST_ITEMS = ".sapMListItem";
    private static final String PAGE_TITLE_TEXT = ".sapMTitle";

    public FioriCartPage(Page page) {
        super(page);
    }

    public FioriCartPage open(String url) {
        navigateTo(url);
        page.waitForLoadState(LoadState.NETWORKIDLE);
        return this;
    }

    /** The browser tab title - confirmed to be "Shopping Cart" for this demo app. */
    public boolean isLoaded() {
        return "Shopping Cart".equals(title());
    }

    public int productCount() {
        return page.locator(LIST_ITEMS).count();
    }

    public boolean hasVisibleTitle() {
        return isDisplayed(PAGE_TITLE_TEXT);
    }
}
