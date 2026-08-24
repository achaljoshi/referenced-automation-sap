package com.company.automation.sap.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/**
 * Configuration for the classic SAP GUI Scripting side of this framework.
 * Deliberately loads its own uniquely-named resource - {@code sap/sap-gui.properties} -
 * rather than reusing {@code config/config.properties} (which
 * {@code referenced-automation-ui}'s {@code ConfigReader}, a compile
 * dependency of this repo, already owns). Two dependencies on the same
 * classpath shipping a resource at the *same* path is a real, easy-to-hit
 * problem - whichever jar's copy the classloader happens to find first
 * silently wins - so every framework in this family that adds its own
 * config keys picks its own resource path instead of overloading a shared
 * one. The Fiori/UI5 side of this repo has no such problem: it reuses
 * {@code com.company.automation.config.ConfigReader} (from
 * {@code referenced-automation-ui}) completely unmodified, keys and all.
 */
public final class SapGuiConfig {

    private static final Logger LOG = LoggerFactory.getLogger(SapGuiConfig.class);
    private static final Properties PROPERTIES = new Properties();

    static {
        load("sap/sap-gui.properties");
    }

    private SapGuiConfig() {
    }

    private static void load(String classpathResource) {
        try (InputStream in = Thread.currentThread().getContextClassLoader().getResourceAsStream(classpathResource)) {
            if (in == null) {
                LOG.debug("Config resource '{}' not found on classpath - using built-in defaults.", classpathResource);
                return;
            }
            PROPERTIES.load(in);
        } catch (IOException e) {
            LOG.warn("Failed to load config resource '{}': {}", classpathResource, e.getMessage());
        }
    }

    private static String get(String key, String defaultValue) {
        String systemProperty = System.getProperty(key);
        if (systemProperty != null && !systemProperty.isBlank()) {
            return systemProperty;
        }
        String envVar = System.getenv(key.toUpperCase().replace('.', '_'));
        if (envVar != null && !envVar.isBlank()) {
            return envVar;
        }
        String fileValue = PROPERTIES.getProperty(key);
        return fileValue != null ? fileValue : defaultValue;
    }

    private static boolean getBoolean(String key, boolean defaultValue) {
        String value = get(key, null);
        return value == null || value.isBlank() ? defaultValue : Boolean.parseBoolean(value.trim());
    }

    private static int getInt(String key, int defaultValue) {
        String value = get(key, null);
        return value == null || value.isBlank() ? defaultValue : Integer.parseInt(value.trim());
    }

    /** True (default) = attach to an already-open SAP Logon connection/session; false = open a new named connection. */
    public static boolean attachToExistingSession() {
        return getBoolean("sap.gui.attach.existing", true);
    }

    public static int connectionIndex() {
        return getInt("sap.gui.connection.index", 0);
    }

    public static int sessionIndex() {
        return getInt("sap.gui.session.index", 0);
    }

    /** Only used when {@link #attachToExistingSession()} is false. */
    public static String connectionName() {
        return get("sap.gui.connection.name", "");
    }

    /**
     * When true, {@code SapGuiHooks} calls {@code SapGuiSession.close()} after every {@code @gui}
     * scenario. Off by default - see {@link com.company.automation.sap.gui.SapGuiSession#close()}'s
     * Javadoc for why closing a shared/interactive session is not automated unless opted into.
     */
    public static boolean closeSessionAfterTest() {
        return getBoolean("sap.gui.close.session.after.test", false);
    }
}
