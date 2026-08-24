package com.company.automation.sap.gui;

import com.company.automation.sap.exceptions.SapGuiException;
import com.jacob.activeX.ActiveXComponent;
import com.jacob.com.Dispatch;
import com.jacob.com.Variant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Locates the SAP GUI Scripting engine via the Windows Running Object Table
 * (ROT) and either attaches to an already-open, interactive SAP Logon
 * connection/session or opens a brand new one - the same bootstrap sequence
 * every classic SAP GUI Scripting tool uses (VBScript, the SAP-provided
 * recorder, and this framework alike):
 *
 * <pre>
 * SapROTWr.SapROTWrapper -&gt; GetROTEntry("SAPGUI") -&gt; GetScriptingEngine
 *   -&gt; GuiApplication -&gt; Connections/OpenConnection -&gt; GuiConnection -&gt; Children(0) -&gt; GuiSession
 * </pre>
 *
 * <p>{@link SapGuiEnvironment#initThread()} must have been called on the
 * current thread before any method here - {@code SapGuiHooks} does this
 * automatically for {@code @gui}-tagged scenarios.
 */
public final class SapGuiSessionFactory {

    private static final Logger LOG = LoggerFactory.getLogger(SapGuiSessionFactory.class);
    private static final String ROT_WRAPPER_PROG_ID = "SapROTWr.SapROTWrapper";

    private SapGuiSessionFactory() {
    }

    private static ActiveXComponent scriptingEngine() {
        ActiveXComponent rotWrapper = new ActiveXComponent(ROT_WRAPPER_PROG_ID);
        Dispatch rotEntry = rotWrapper.invoke("GetROTEntry", "SAPGUI").toDispatch();
        if (rotEntry == null) {
            throw new SapGuiException(
                    "No running SAP Logon process was found via the Running Object Table. "
                            + "Make sure SAP Logon is open, at least one connection exists, and "
                            + "Scripting is enabled (SAP Logon Options > Accessibility & Scripting).");
        }
        Variant scriptingEngineVariant = Dispatch.call(rotEntry, "GetScriptingEngine");
        return new ActiveXComponent(scriptingEngineVariant.toDispatch());
    }

    /**
     * Attaches to an already-open SAP Logon connection/session - the recommended default for a
     * shared/interactive SAP system, since it never risks creating (or closing) a real user's session.
     *
     * @param connectionIndex 0-based index into {@code GuiApplication.Connections} - almost always {@code 0}
     *                        when only one SAP connection is open, which is the typical CI/desktop setup.
     * @param sessionIndex    0-based index into that connection's {@code Children} - almost always {@code 0}.
     */
    public static SapGuiSession attachToRunningSession(int connectionIndex, int sessionIndex) {
        LOG.info("Attaching to running SAP GUI connection[{}] / session[{}]", connectionIndex, sessionIndex);
        ActiveXComponent guiApplication = scriptingEngine();
        ActiveXComponent connection = new ActiveXComponent(
                guiApplication.invoke("Children", connectionIndex).toDispatch());
        ActiveXComponent session = new ActiveXComponent(
                connection.invoke("Children", sessionIndex).toDispatch());
        return new SapGuiSession(session);
    }

    /**
     * Opens a brand new connection by name (as configured in SAP Logon, e.g. {@code "QR1 - Retail"}) and
     * returns its first session. Prefer {@link #attachToRunningSession(int, int)} for a shared/interactive
     * system; use this when the test itself is responsible for the whole connection lifecycle (e.g. a
     * dedicated CI-only SAP system where opening/closing connections programmatically is safe).
     */
    public static SapGuiSession openConnection(String connectionName) {
        LOG.info("Opening SAP GUI connection '{}'", connectionName);
        ActiveXComponent guiApplication = scriptingEngine();
        ActiveXComponent connection = new ActiveXComponent(
                guiApplication.invoke("OpenConnection", connectionName).toDispatch());
        ActiveXComponent session = new ActiveXComponent(connection.invoke("Children", 0).toDispatch());
        return new SapGuiSession(session);
    }
}
