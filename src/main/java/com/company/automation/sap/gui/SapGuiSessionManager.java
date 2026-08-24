package com.company.automation.sap.gui;

import com.company.automation.sap.exceptions.SapGuiException;

/**
 * Thread-safe holder for the {@link SapGuiSession} of the currently executing
 * {@code @gui}-tagged scenario. Backed by a {@link ThreadLocal} for the same
 * reason {@code referenced-automation-ui}'s {@code PlaywrightManager} and
 * {@code referenced-automation-api}'s {@code ApiContextManager} are - so
 * parallel Cucumber execution never leaks a session across threads.
 */
public final class SapGuiSessionManager {

    private static final ThreadLocal<SapGuiSession> SESSION_THREAD_LOCAL = new ThreadLocal<>();

    private SapGuiSessionManager() {
    }

    public static void setSession(SapGuiSession session) {
        SESSION_THREAD_LOCAL.set(session);
    }

    public static SapGuiSession getSession() {
        SapGuiSession session = SESSION_THREAD_LOCAL.get();
        if (session == null) {
            throw new SapGuiException(
                    "No SapGuiSession bound to the current thread. Make sure "
                            + "com.company.automation.sap.hooks.SapGuiHooks is on the Cucumber glue path "
                            + "and the scenario is tagged @gui.");
        }
        return session;
    }

    public static boolean hasSession() {
        return SESSION_THREAD_LOCAL.get() != null;
    }

    public static void clear() {
        SESSION_THREAD_LOCAL.remove();
    }
}
