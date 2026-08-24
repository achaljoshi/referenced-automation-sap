package com.company.automation.sap.exceptions;

/**
 * Unchecked exception for classic SAP GUI Scripting failures (native library
 * not loaded, no running SAP Logon session found, element not found via
 * {@code FindById}, etc.) so they are clearly distinguishable from
 * Playwright's own exceptions (used by the Fiori/UI5 side of this
 * framework) or plain assertion failures in reports and logs.
 */
public class SapGuiException extends RuntimeException {

    public SapGuiException(String message) {
        super(message);
    }

    public SapGuiException(String message, Throwable cause) {
        super(message, cause);
    }
}
