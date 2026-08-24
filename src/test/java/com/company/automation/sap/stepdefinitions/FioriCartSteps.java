package com.company.automation.sap.stepdefinitions;

import com.company.automation.driver.PlaywrightManager;
import com.company.automation.sap.pages.FioriCartPage;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import org.junit.jupiter.api.Assertions;

/**
 * Step definitions for fiori-cart.feature. Gets its {@code Page} from
 * {@link PlaywrightManager}, which {@code FioriHooks} (scoped to the
 * {@code @fiori} tag, on this repo's glue path) has already created for this
 * scenario - the exact same pattern referenced-automation-ui's own
 * {@code LoginSteps} uses with its untagged {@code Hooks}.
 */
public class FioriCartSteps {

    private FioriCartPage cartPage;

    @Given("I open the SAPUI5 Shopping Cart demo app")
    public void i_open_the_shopping_cart_demo_app() {
        cartPage = new FioriCartPage(PlaywrightManager.getPage())
                .open("https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html");
    }

    @Then("the Shopping Cart app should load")
    public void the_app_should_load() {
        Assertions.assertTrue(cartPage.isLoaded(), "Expected the demo app's page title to be 'Shopping Cart'");
    }

    @Then("at least one product should be listed")
    public void at_least_one_product_should_be_listed() {
        Assertions.assertTrue(cartPage.productCount() > 0, "Expected at least one SAPUI5 list item to render");
    }
}
