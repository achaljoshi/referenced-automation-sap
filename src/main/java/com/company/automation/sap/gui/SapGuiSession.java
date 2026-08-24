package com.company.automation.sap.gui;

import com.company.automation.sap.exceptions.SapGuiException;
import com.jacob.activeX.ActiveXComponent;
import com.jacob.com.Dispatch;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Thin, easy-to-use wrapper around one classic SAP GUI Scripting
 * {@code GuiSession} COM object. Every method takes the same technical ID
 * you'd get from the SAP GUI Scripting recorder (Ctrl+drag "record" in SAP
 * GUI, or the id shown by hovering an element with scripting tracking on) -
 * e.g. {@code "wnd[0]/usr/txtRSYST-BNAME"} - and resolves it fresh via
 * {@code FindById} on every call, the same "no cached stale handles"
 * philosophy {@code referenced-automation-ui}'s {@code BasePage} uses for
 * Playwright locators.
 *
 * <p>Obtained from {@link SapGuiSessionFactory}, never constructed directly.
 */
public final class SapGuiSession {

    private static final Logger LOG = LoggerFactory.getLogger(SapGuiSession.class);

    private final ActiveXComponent session;

    SapGuiSession(ActiveXComponent session) {
        this.session = session;
    }

    /** Resolves a technical SAP GUI id (e.g. {@code "wnd[0]/usr/txtRSYST-BNAME"}) to its live COM object. */
    public ActiveXComponent findById(String id) {
        try {
            return new ActiveXComponent(session.invoke("FindById", id).toDispatch());
        } catch (Exception e) {
            throw new SapGuiException("SAP GUI element not found: '" + id + "'", e);
        }
    }

    public boolean exists(String id) {
        try {
            findById(id);
            return true;
        } catch (SapGuiException e) {
            return false;
        }
    }

    public void setText(String id, String value) {
        LOG.debug("SAP GUI setText '{}' -> {}", value, id);
        findById(id).setProperty("text", value);
    }

    public String getText(String id) {
        String value = findById(id).getProperty("text").toString();
        LOG.debug("SAP GUI getText {} <- '{}'", id, value);
        return value;
    }

    /** Presses a button - {@code GuiButton}, {@code GuiToolbarControl} entries, etc. */
    public void press(String id) {
        LOG.debug("SAP GUI press -> {}", id);
        Dispatch.call(findById(id), "press");
    }

    /** Selects an element - a {@code GuiTab}, {@code GuiRadioButton}, or a row/cell. */
    public void select(String id) {
        LOG.debug("SAP GUI select -> {}", id);
        Dispatch.call(findById(id), "select");
    }

    public void setCheckBox(String id, boolean checked) {
        LOG.debug("SAP GUI setCheckBox({}) -> {}", checked, id);
        findById(id).setProperty("selected", checked);
    }

    public boolean isChecked(String id) {
        return findById(id).getProperty("selected").toString().equalsIgnoreCase("true");
    }

    /** Sets a {@code GuiComboBox}'s selected value (the underlying key, not necessarily the displayed text). */
    public void setComboBoxValue(String id, String value) {
        LOG.debug("SAP GUI setComboBoxValue '{}' -> {}", value, id);
        findById(id).setProperty("value", value);
    }

    public void setFocus(String id) {
        findById(id).invoke("setFocus");
    }

    /** Sends a virtual key to the whole session - 0 = Enter, 3 = F3/Back, 11 = F11/Save, 12 = F12/Cancel, etc. */
    public void sendVKey(int vKey) {
        LOG.debug("SAP GUI sendVKey({})", vKey);
        session.invoke("sendVKey", vKey);
    }

    public void sendVKey(String id, int vKey) {
        LOG.debug("SAP GUI sendVKey({}) -> {}", vKey, id);
        findById(id).invoke("sendVKey", vKey);
    }

    /** Convenience for the extremely common "type a t-code into the OK-code field and press Enter" pattern. */
    public void startTransaction(String tcode) {
        LOG.info("SAP GUI startTransaction: /n{}", tcode);
        setText("wnd[0]/tbar[0]/okcd", "/n" + tcode);
        sendVKey(0);
    }

    public String statusBarText() {
        return exists("wnd[0]/sbar") ? getText("wnd[0]/sbar") : "";
    }

    /**
     * Best-effort close of the main window ({@code wnd[0]}) - NOT called automatically by
     * {@code com.company.automation.sap.hooks.SapGuiHooks} unless {@code sap.gui.close.session.after.test=true}.
     * Closing a shared/interactive SAP session programmatically is a real risk (it can log a real
     * person out); this framework only does it when explicitly opted into.
     */
    public void close() {
        try {
            Dispatch.call(findById("wnd[0]"), "close");
        } catch (Exception e) {
            LOG.warn("Could not close SAP GUI window wnd[0]: {}", e.getMessage());
        }
    }

    /** Escape hatch for anything this wrapper doesn't cover yet - the underlying {@code GuiSession} COM object. */
    public ActiveXComponent raw() {
        return session;
    }
}
