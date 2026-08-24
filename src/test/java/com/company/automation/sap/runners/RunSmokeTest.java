package com.company.automation.sap.runners;

import org.junit.platform.suite.api.ConfigurationParameter;
import org.junit.platform.suite.api.IncludeEngines;
import org.junit.platform.suite.api.SelectClasspathResource;
import org.junit.platform.suite.api.Suite;

import static io.cucumber.junit.platform.engine.Constants.FILTER_TAGS_PROPERTY_NAME;

/**
 * Fast, tag-filtered entry point for pre-merge / pipeline gating: runs only
 * {@code @smoke} scenarios.
 *
 * <p>The {@code and not @gui} half of the filter below is a deliberate
 * belt-and-braces guard: an explicit {@code @ConfigurationParameter} on this
 * class takes precedence over the pom-level {@code cucumber.filter.tags}
 * system property (JUnit Platform resolves configuration parameters in that
 * order), so without it a future scenario mistakenly tagged both
 * {@code @smoke} and {@code @gui} would bypass the "never run @gui
 * unattended" default this repo relies on everywhere else.
 */
@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
@ConfigurationParameter(key = FILTER_TAGS_PROPERTY_NAME, value = "@smoke and not @gui")
public class RunSmokeTest {
}
