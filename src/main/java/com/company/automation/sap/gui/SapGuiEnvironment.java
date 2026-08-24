package com.company.automation.sap.gui;

import com.company.automation.sap.exceptions.SapGuiException;
import com.jacob.com.ComThread;
import com.jacob.com.LibraryLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Bootstraps the JACOB (Java-COM Bridge) native layer that classic SAP GUI
 * Scripting runs on. This is the one part of the referenced-automation-*
 * family that genuinely cannot be "zero manual configuration": JACOB is a
 * JNI bridge to a native Windows DLL, and there is no cross-platform way to
 * auto-provision that - it must be present on the machine running these
 * tests.
 *
 * <p><b>One-time setup required on the Windows machine that will run
 * {@code @gui}-tagged scenarios</b> (see README "Classic SAP GUI Scripting
 * setup" for the full explanation):
 * <ol>
 *     <li>SAP GUI for Windows must be installed, with "Scripting" enabled
 *         in SAP Logon options (and scripting allowed server-side).</li>
 *     <li>Download the {@code jacob-1.18-x64.dll} (or {@code -x86}, matching
 *         your JVM's bitness - most modern JVMs are 64-bit) from the same
 *         JACOB release this framework depends on.</li>
 *     <li>Point the JVM at it with {@code -Djacob.dll.path=C:\path\to\jacob-1.18-x64.dll},
 *         or place it on {@code -Djava.library.path}.</li>
 * </ol>
 *
 * <p>Every other feature in this repository (Fiori/UI5 via Playwright,
 * reporting, logging, CI, IntelliJ setup) has none of these constraints.
 */
public final class SapGuiEnvironment {

    private static final Logger LOG = LoggerFactory.getLogger(SapGuiEnvironment.class);
    private static volatile boolean nativeLibraryLoaded = false;

    private SapGuiEnvironment() {
    }

    /** Idempotent - safe to call once per JVM or once per thread, whichever is more convenient for the caller. */
    public static synchronized void ensureNativeLibraryLoaded() {
        if (nativeLibraryLoaded) {
            return;
        }
        try {
            LibraryLoader.loadJacobLibrary();
            nativeLibraryLoaded = true;
            LOG.info("JACOB native library loaded successfully.");
        } catch (UnsatisfiedLinkError e) {
            throw new SapGuiException(
                    "Failed to load the JACOB native library. Classic SAP GUI Scripting requires the "
                            + "matching jacob-<version>-x64.dll (or -x86) to be discoverable - set "
                            + "-Djacob.dll.path=<absolute path to the dll> or place it on -Djava.library.path. "
                            + "See SapGuiEnvironment's class Javadoc / README 'Classic SAP GUI Scripting setup'.", e);
        }
    }

    /**
     * Initialises this thread as a COM single-threaded apartment. Must be called once per thread
     * before any {@code ActiveXComponent}/{@code Dispatch} call on that thread, and paired with
     * {@link #releaseThread()} when the thread is done with SAP GUI Scripting.
     */
    public static void initThread() {
        ensureNativeLibraryLoaded();
        ComThread.InitSTA();
    }

    /** Releases the COM apartment initialised by {@link #initThread()}. Safe to call even if init failed partway. */
    public static void releaseThread() {
        try {
            ComThread.Release();
        } catch (Exception e) {
            LOG.warn("Error while releasing the COM thread: {}", e.getMessage());
        }
    }
}
