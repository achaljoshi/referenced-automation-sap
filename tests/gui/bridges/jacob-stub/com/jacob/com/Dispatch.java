package com.jacob.com;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Stand-in for JACOB's Dispatch, backed by a tiny in-memory SAP GUI object model: a logon screen with a main window,
 * a user area with fields, a command field and a status bar, plus the scripting engine / connection / session objects
 * above it. It exists only so the bridge helper's own logic (protocol, chained access, find, error mapping) can be
 * compiled and exercised without SAP. It is NOT the real library and says nothing about real COM behaviour.
 */
public class Dispatch {
    /** A node of the model. */
    static final class Obj {
        final String kind;
        final Map<String, Object> props = new LinkedHashMap<String, Object>();
        final List<Obj> kids = new ArrayList<Obj>();

        Obj(String kind) {
            this.kind = kind;
        }
    }

    final Obj obj;

    Dispatch(Obj obj) {
        this.obj = obj;
    }

    /** Like JACOB: `new ActiveXComponent(progId)` creates the COM object by its program id. */
    protected Dispatch(String progId) {
        if (!"SapROTWr.SapROTWrapper".equals(progId)) throw new ComFailException("Invalid class string: " + progId);
        this.obj = ROT;
    }

    // ---- the model ----------------------------------------------------------------------------------------------
    private static final String PREFIX = "/app/con[0]/ses[0]/";
    private static final Map<String, Obj> CONTROLS = new LinkedHashMap<String, Obj>();
    private static final Obj ROT = new Obj("rot");
    private static final Obj ENTRY = new Obj("entry");
    private static final Obj ENGINE = new Obj("engine");
    private static final Obj CONNECTION = new Obj("connection");
    private static final Obj SESSION = new Obj("session");

    static {
        SESSION.props.put("busy", Boolean.FALSE);
        Obj info = new Obj("info");
        info.props.put("systemname", "STUB");
        info.props.put("client", "100");
        info.props.put("user", "TESTUSER");
        info.props.put("language", "EN");
        info.props.put("transaction", "");
        info.props.put("program", "SAPMSYST");
        info.props.put("screennumber", "0100");
        info.props.put("responsetime", Integer.valueOf(12));
        info.props.put("roundtrips", Integer.valueOf(3));
        SESSION.props.put("info", info);
        control("wnd[0]", "GuiMainWindow", "Stub SAP", null);
        control("wnd[0]/usr", "GuiUserArea", "", null);
        control("wnd[0]/usr/txtRSYST-BNAME", "GuiTextField", "", "User");
        control("wnd[0]/usr/pwdRSYST-BCODE", "GuiPasswordField", "", "Password");
        control("wnd[0]/tbar[0]/okcd", "GuiOkCodeField", "", null);
        control("wnd[0]/sbar", "GuiStatusbar", "", null);
    }

    private static void control(String id, String type, String text, String leftLabel) {
        Obj o = new Obj("control");
        o.props.put("id", PREFIX + id);
        o.props.put("type", type);
        o.props.put("name", id.substring(id.lastIndexOf('/') + 1));
        o.props.put("text", text);
        o.props.put("tooltip", "");
        if (leftLabel != null) {
            Obj label = new Obj("control");
            label.props.put("text", leftLabel);
            o.props.put("leftlabel", label);
        }
        CONTROLS.put(id, o);
    }

    private static List<Obj> childrenOf(String id) {
        List<String> names = new ArrayList<String>();
        String prefix = id + "/";
        for (String key : CONTROLS.keySet()) {
            if (key.startsWith(prefix)) {
                String rest = key.substring(prefix.length());
                String child = prefix + (rest.indexOf('/') < 0 ? rest : rest.substring(0, rest.indexOf('/')));
                if (!names.contains(child)) names.add(child);
            }
        }
        List<Obj> out = new ArrayList<Obj>();
        for (String name : names) {
            Obj o = CONTROLS.get(name);
            if (o == null) { // an intermediate container like tbar[0]
                o = new Obj("control");
                o.props.put("id", PREFIX + name);
                o.props.put("type", "GuiContainer");
                o.props.put("name", name.substring(name.lastIndexOf('/') + 1));
                o.props.put("text", "");
                o.props.put("tooltip", "");
                CONTROLS.put(name, o);
            }
            out.add(o);
        }
        return out;
    }

    private static Obj collection(final List<Obj> items) {
        Obj c = new Obj("collection");
        c.kids.addAll(items);
        c.props.put("count", Integer.valueOf(items.size()));
        return c;
    }

    static Obj rot() {
        return ROT;
    }

    // ---- the API the bridge helper uses -------------------------------------------------------------------------
    public static Variant call(Dispatch d, String name, Object... args) {
        String n = name.toLowerCase();
        switch (d.obj.kind) {
            case "rot":
                if (n.equals("getrotentry")) return new Variant(new Dispatch(ENTRY));
                break;
            case "entry":
                if (n.equals("getscriptingengine")) return new Variant(new Dispatch(ENGINE));
                break;
            case "engine":
                if (n.equals("children") || n.equals("openconnection") || n.equals("openconnectionbyconnectionstring")) return new Variant(new Dispatch(CONNECTION));
                break;
            case "connection":
                if (n.equals("children")) return new Variant(new Dispatch(SESSION));
                break;
            case "session":
                if (n.equals("findbyid")) {
                    String id = String.valueOf(args[0]);
                    // A dead connection: the HRESULT says so (RPC_E_DISCONNECTED), not the message.
                    if (id.endsWith("txtDEAD")) throw new ComFailException("Der Server ist nicht verfuegbar.", 0x80010108);
                    Obj found = CONTROLS.get(id);
                    // SAP GUI localises this message: the bridge must not depend on the English wording.
                    if (found == null) throw new ComFailException("Das Steuerelement konnte mit der ID nicht gefunden werden.");
                    return new Variant(new Dispatch(found));
                }
                if (n.equals("startransaction") || n.equals("starttransaction")) return new Variant(null);
                break;
            case "collection":
                if (n.equals("elementat")) return new Variant(new Dispatch(d.obj.kids.get(((Number) args[0]).intValue())));
                break;
            case "control":
                if (n.equals("sendvkey") || n.equals("press") || n.equals("select") || n.equals("setfocus") || n.equals("maximize")) return new Variant(null);
                if (n.equals("children")) {
                    String id = String.valueOf(d.obj.props.get("id")).substring(PREFIX.length());
                    return new Variant(new Dispatch(collection(childrenOf(id))));
                }
                break;
            default:
        }
        return get(d, name); // like JACOB's Method|Get dispatch: a name that is a property reads it
    }

    public static Variant get(Dispatch d, String name) {
        String n = name.toLowerCase();
        if (d.obj.kind.equals("control") && n.equals("children")) {
            String id = String.valueOf(d.obj.props.get("id")).substring(PREFIX.length());
            return new Variant(new Dispatch(collection(childrenOf(id))));
        }
        if (d.obj.kind.equals("control") && n.equals("changeable")) return new Variant(Boolean.TRUE);
        if (d.obj.props.containsKey(n)) {
            Object v = d.obj.props.get(n);
            return new Variant(v instanceof Obj ? new Dispatch((Obj) v) : v);
        }
        throw new ComFailException("Unknown name. (DISP_E_UNKNOWNNAME) " + name);
    }

    public static void put(Dispatch d, String name, Object value) {
        if (!d.obj.props.containsKey(name.toLowerCase()) && !d.obj.kind.equals("control")) throw new ComFailException("Unknown name. " + name);
        d.obj.props.put(name.toLowerCase(), value);
    }
}
