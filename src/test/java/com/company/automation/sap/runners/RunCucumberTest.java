package com.company.automation.sap.runners;

import org.junit.platform.suite.api.IncludeEngines;
import org.junit.platform.suite.api.SelectClasspathResource;
import org.junit.platform.suite.api.Suite;

/**
 * Full regression entry point: {@code mvn test} (via the Surefire include
 * pattern {@code **}{@code /Run*.java}) discovers this class and runs every
 * {@code .feature} file under {@code src/test/resources/features}, subject
 * to the tag filter configured in {@code pom.xml}'s {@code cucumber.filter.tags}
 * property - {@code not @gui} by default, so the classic SAP GUI Scripting
 * demo never runs unattended (see README "CI/CD" and "Classic SAP GUI
 * Scripting setup"). Pass {@code -Dcucumber.filter.tags=@gui} explicitly on
 * a properly set-up Windows machine to run just the {@code @gui} scenario.
 *
 * <p>Glue path, plugin list and reporting are configured once in
 * {@code junit-platform.properties} - notice the glue path here is
 * {@code com.company.automation.sap.hooks}, <b>not</b>
 * {@code com.company.automation.hooks} (referenced-automation-ui's own,
 * untagged {@code Hooks} class) - see {@code FioriHooks}'s Javadoc for why.
 */
@Suite
@IncludeEngines("cucumber")
@SelectClasspathResource("features")
public class RunCucumberTest {
}
