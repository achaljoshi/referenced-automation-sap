import com.jacob.activeX.ActiveXComponent;
import com.jacob.com.ComFailException;
import com.jacob.com.ComThread;
import com.jacob.com.Dispatch;
import com.jacob.com.Variant;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The SAP GUI bridge, JACOB edition: the same line protocol as the PowerShell bridge (bridgeScript.ts) - one JSON
 * command per line on stdin, one JSON reply per line on stdout - so the framework can use either without any test
 * changing. Use this one where PowerShell is restricted but the existing Java/JACOB framework already runs.
 *
 *   java -Djacob.dll.path=&lt;folder with jacob-x.y-x64.dll&gt; -cp sap-bridge.jar;jacob.jar SapBridge
 *
 * What it does is exactly what a recorded VBScript does: find a control by id, read or write a property, call a
 * method. It opens no network connection and writes no files. All COM calls happen on the main thread (STA).
 * Java 8 compatible.
 */
public final class SapBridge {
    private static PrintStream protocol;
    private static Dispatch session;

    /** HRESULTs that mean the COM connection to SAP GUI is gone (retrying cannot help): RPC server unavailable (0x800706BA), RPC call failed (0x800706BE, 0x800706BF), object disconnected (0x80010108), server died (0x80010007, 0x80010012), object not connected (0x800401FD). */
    private static final int[] DEAD_HRESULTS = {0x800706BA, 0x800706BE, 0x800706BF, 0x80010108, 0x80010007, 0x80010012, 0x800401FD};

    /** FindById itself failed (and the connection is alive): there is no such control, whatever language SAP GUI words its message in. */
    private static final class NotFound extends RuntimeException {
        NotFound(String message) {
            super(message);
        }
    }

    public static void main(String[] args) throws Exception {
        // Only protocol lines may reach stdout: anything a library prints goes to stderr instead.
        protocol = new PrintStream(System.out, true, "UTF-8");
        System.setOut(System.err);

        ComThread.InitSTA();
        try {
            reply(0, true, "ready", null, null);
            BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
            String line;
            while ((line = in.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                int rid = 0;
                try {
                    Map<String, Object> cmd = asMap(Json.parse(line));
                    rid = ((Number) cmd.get("rid")).intValue();
                    String op = (String) cmd.get("op");
                    if ("quit".equals(op)) {
                        reply(rid, true, null, null, null);
                        break;
                    }
                    reply(rid, true, handle(op, cmd), null, null);
                } catch (Throwable t) {
                    String message = message(t);
                    reply(rid, false, null, message, code(t, message));
                }
            }
        } finally {
            ComThread.Release();
        }
    }

    // ------------------------------------------------------------------ operations

    private static Object handle(String op, Map<String, Object> cmd) {
        switch (op) {
            case "ping":
                return "pong";
            case "attach": {
                Dispatch engine = scriptingEngine(null);
                Dispatch connection = Dispatch.call(engine, "Children", intArg(cmd.get("connectionIndex"))).toDispatch();
                session = Dispatch.call(connection, "Children", intArg(cmd.get("sessionIndex"))).toDispatch();
                return null;
            }
            case "open": {
                Dispatch engine = scriptingEngine((String) cmd.get("logonPath"));
                String connectionString = (String) cmd.get("connectionString");
                Dispatch connection = connectionString != null && !connectionString.isEmpty()
                        ? Dispatch.call(engine, "OpenConnectionByConnectionString", connectionString).toDispatch()
                        : Dispatch.call(engine, "OpenConnection", (String) cmd.get("connectionName")).toDispatch();
                session = Dispatch.call(connection, "Children", 0).toDispatch();
                return null;
            }
            case "busy":
                return Boolean.valueOf(Dispatch.get(session, "Busy").getBoolean());
            case "progress":
                return progress();
            case "exists":
                try {
                    return Boolean.valueOf(find((String) cmd.get("id")) != null);
                } catch (Throwable t) {
                    if (isDead(t)) throw (RuntimeException) t; // a dead connection is not "the control is absent"
                    return Boolean.FALSE;
                }
            case "get": {
                Dispatch target = resolve(find((String) cmd.get("id")), list(cmd.get("via")));
                return convert(Dispatch.get(target, (String) cmd.get("prop")));
            }
            case "set": {
                Dispatch target = resolve(find((String) cmd.get("id")), list(cmd.get("via")));
                Dispatch.put(target, (String) cmd.get("prop"), comValue(cmd.get("value")));
                return null;
            }
            case "call": {
                Dispatch target = resolve(find((String) cmd.get("id")), list(cmd.get("via")));
                return convert(Dispatch.call(target, (String) cmd.get("method"), comArgs(list(cmd.get("args")))));
            }
            case "children":
                return children(find((String) cmd.get("id")));
            case "find":
                return findControls(asMap(cmd.get("criteria")));
            case "info":
                return info(find((String) cmd.get("id")));
            case "context":
                return context();
            default:
                throw new IllegalArgumentException("Unknown op " + op);
        }
    }

    private static Dispatch find(String id) {
        if (id == null || id.isEmpty()) return session;
        try {
            return Dispatch.call(session, "FindById", id).toDispatch();
        } catch (ComFailException e) {
            if (isDead(e)) throw e;
            throw new NotFound(message(e));
        }
    }

    /** Classified by what failed (a dead connection by HRESULT, a missing control by FindById failing), not by SAP GUI's localised wording; the English text is only a fallback for failures that did not come through find(). */
    private static String code(Throwable t, String message) {
        if (isDead(t)) return "SESSION_LOST";
        if (t instanceof NotFound) return "NOT_FOUND";
        return message.contains("could not be found") ? "NOT_FOUND" : "ERROR";
    }

    private static boolean isDead(Throwable t) {
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof ComFailException) {
                int h = ((ComFailException) c).getHResult();
                for (int dead : DEAD_HRESULTS) {
                    if (h == dead) return true;
                }
            }
            if (c.getCause() == c) break;
        }
        return false;
    }

    /** Steps through objects the way a recorded line does: .columns.elementAt(1).width. VBScript does not tell properties from methods apart, and neither does Dispatch.call. */
    private static Dispatch resolve(Dispatch target, List<Object> via) {
        Dispatch current = target;
        for (Object link : via) {
            Map<String, Object> l = asMap(link);
            current = Dispatch.call(current, (String) l.get("member"), comArgs(list(l.get("args")))).toDispatch();
        }
        return current;
    }

    private static Object children(Dispatch parent) {
        List<Object> out = new ArrayList<Object>();
        Dispatch kids = Dispatch.get(parent, "Children").toDispatch();
        int count = Dispatch.get(kids, "Count").getInt();
        for (int i = 0; i < count; i++) {
            Dispatch kid = Dispatch.call(kids, "ElementAt", i).toDispatch();
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            m.put("id", prop(kid, "Id"));
            m.put("type", prop(kid, "Type"));
            m.put("name", prop(kid, "Name"));
            m.put("text", prop(kid, "Text"));
            out.add(m);
        }
        return out;
    }

    private static Object info(Dispatch target) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("type", prop(target, "Type"));
        m.put("name", prop(target, "Name"));
        m.put("text", prop(target, "Text"));
        m.put("tooltip", prop(target, "Tooltip"));
        Object changeable = readOrNull(target, "Changeable");
        m.put("changeable", Boolean.valueOf(!Boolean.FALSE.equals(changeable)));
        return m;
    }

    /** A cheap "has the server answered yet?" reading: the round-trip counter plus what is on screen. */
    private static Object progress() {
        Dispatch info = Dispatch.get(session, "Info").toDispatch();
        int windows = 1;
        for (int n = 1; n <= 4; n++) {
            boolean present = false;
            try {
                present = find("wnd[" + n + "]") != null;
            } catch (Throwable t) {
                if (isDead(t)) throw (RuntimeException) t;
            }
            if (!present) break;
            windows = n + 1;
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("roundTrips", readOrNull(info, "RoundTrips"));
        m.put("transaction", prop(info, "Transaction"));
        m.put("program", prop(info, "Program"));
        m.put("screen", prop(info, "ScreenNumber"));
        m.put("title", prop(find("wnd[0]"), "Text"));
        m.put("windows", Integer.valueOf(windows));
        return m;
    }

    private static Object context() {
        Dispatch info = Dispatch.get(session, "Info").toDispatch();
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("system", prop(info, "SystemName"));
        m.put("client", prop(info, "Client"));
        m.put("user", prop(info, "User"));
        m.put("language", prop(info, "Language"));
        m.put("transaction", prop(info, "Transaction"));
        m.put("program", prop(info, "Program"));
        m.put("screen", prop(info, "ScreenNumber"));
        m.put("responseMs", readOrNull(info, "ResponseTime"));
        m.put("roundTrips", readOrNull(info, "RoundTrips"));
        return m;
    }

    // ------------------------------------------------------------------ find by criteria

    private static int visited;

    private static Object findControls(Map<String, Object> c) {
        List<Object> results = new ArrayList<Object>();
        visited = 0;
        search(find((String) c.get("root")), c, results, 0);
        return results;
    }

    private static void search(Dispatch node, Map<String, Object> c, List<Object> results, int depth) {
        if (depth > 14 || visited > 3000) return;
        Dispatch kids;
        int count;
        try {
            kids = Dispatch.get(node, "Children").toDispatch();
            count = Dispatch.get(kids, "Count").getInt();
        } catch (Throwable t) {
            return; // a leaf control has no Children
        }
        for (int i = 0; i < count; i++) {
            visited++;
            Dispatch kid = Dispatch.call(kids, "ElementAt", i).toDispatch();
            if (matches(kid, c)) results.add(prop(kid, "Id"));
            search(kid, c, results, depth + 1);
        }
    }

    private static boolean matches(Dispatch kid, Map<String, Object> c) {
        boolean exact = Boolean.TRUE.equals(c.get("exact"));
        if (c.get("type") != null && !String.valueOf(c.get("type")).equals(prop(kid, "Type"))) return false;
        if (c.get("name") != null && !String.valueOf(c.get("name")).equals(prop(kid, "Name"))) return false;
        if (c.get("text") != null && !textMatches(prop(kid, "Text"), (String) c.get("text"), exact)) return false;
        if (c.get("tooltip") != null && !textMatches(prop(kid, "Tooltip"), (String) c.get("tooltip"), exact)) return false;
        if (c.get("label") != null) {
            String label = (String) c.get("label");
            String left = labelText(kid, "LeftLabel");
            String right = labelText(kid, "RightLabel");
            boolean ok = (left != null && textMatches(left, label, exact)) || (right != null && textMatches(right, label, exact));
            if (!ok) return false;
        }
        return true;
    }

    private static boolean textMatches(String actual, String expected, boolean exact) {
        String a = actual == null ? "" : actual.trim();
        String e = expected.trim();
        return exact ? a.equalsIgnoreCase(e) : a.toLowerCase().contains(e.toLowerCase());
    }

    private static String labelText(Dispatch kid, String labelProperty) {
        try {
            Dispatch label = Dispatch.get(kid, labelProperty).toDispatch();
            return prop(label, "Text");
        } catch (Throwable t) {
            return null;
        }
    }

    // ------------------------------------------------------------------ connecting

    /** The scripting engine of a running SAP Logon; if none is running and a path was given, starts SAP Logon and waits for it. */
    private static Dispatch scriptingEngine(String logonPath) {
        Dispatch engine = tryEngine();
        if (engine != null) return engine;
        if (logonPath == null || logonPath.isEmpty()) {
            throw new IllegalStateException("SAP Logon is not running, so there is no SAP GUI scripting engine to attach to. Start SAP Logon, or set SAP_GUI_LOGON_PATH so it can be started for you.");
        }
        if (!new java.io.File(logonPath).exists()) {
            throw new IllegalStateException("SAP Logon is not running and SAP_GUI_LOGON_PATH does not exist: " + logonPath);
        }
        try {
            new ProcessBuilder(logonPath).start();
            long deadline = System.currentTimeMillis() + 60000;
            while (System.currentTimeMillis() < deadline) {
                Thread.sleep(500);
                engine = tryEngine();
                if (engine != null) return engine;
            }
        } catch (java.io.IOException e) {
            throw new IllegalStateException("could not start SAP Logon: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        throw new IllegalStateException("Started SAP Logon but its scripting engine did not appear within 60 seconds. Is scripting enabled (SAP GUI Options > Accessibility and Scripting > Scripting)?");
    }

    private static Dispatch tryEngine() {
        try {
            Dispatch rot = new ActiveXComponent("SapROTWr.SapROTWrapper");
            Dispatch entry = Dispatch.call(rot, "GetROTEntry", "SAPGUI").toDispatch();
            return Dispatch.call(entry, "GetScriptingEngine").toDispatch();
        } catch (Throwable t) {
            return null;
        }
    }

    // ------------------------------------------------------------------ conversions and plumbing

    private static String prop(Dispatch d, String name) {
        Object v = readOrNull(d, name);
        return v == null ? "" : String.valueOf(v);
    }

    private static Object readOrNull(Dispatch d, String name) {
        try {
            return convert(Dispatch.get(d, name));
        } catch (Throwable t) {
            if (isDead(t)) throw (RuntimeException) t; // an absent property reads as null; a dead connection does not
            return null;
        }
    }

    /** A COM result as a JSON value: strings, numbers and booleans as themselves, objects as their text. */
    private static Object convert(Variant v) {
        if (v == null) return null;
        Object o = v.toJavaObject();
        if (o == null || o instanceof String || o instanceof Boolean || o instanceof Integer || o instanceof Long) return o;
        if (o instanceof Double || o instanceof Float || o instanceof Short) return o instanceof Short ? Integer.valueOf(((Short) o).intValue()) : o;
        return String.valueOf(o);
    }

    private static Object[] comArgs(List<Object> args) {
        Object[] out = new Object[args.size()];
        for (int i = 0; i < out.length; i++) out[i] = comValue(args.get(i));
        return out;
    }

    /** SAP's COM layer rejects 64-bit integers: send whole numbers that fit as 32-bit. */
    private static Object comValue(Object v) {
        if (v instanceof Long) {
            long l = ((Long) v).longValue();
            if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) return Integer.valueOf((int) l);
        }
        if (v instanceof Double) {
            double d = ((Double) v).doubleValue();
            if (d == Math.floor(d) && Math.abs(d) <= Integer.MAX_VALUE) return Integer.valueOf((int) d);
        }
        return v;
    }

    private static int intArg(Object o) {
        return o instanceof Number ? ((Number) o).intValue() : 0;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object o) {
        return (Map<String, Object>) o;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> list(Object o) {
        return o == null ? new ArrayList<Object>() : (List<Object>) o;
    }

    private static String message(Throwable t) {
        String m = t.getMessage();
        if (m == null || m.isEmpty()) m = t.getClass().getSimpleName();
        return t instanceof ComFailException ? m : (t.getClass().getSimpleName() + ": " + m).replaceFirst("^(IllegalStateException|IllegalArgumentException): ", "");
    }

    private static void reply(int rid, boolean ok, Object value, String error, String code) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("rid", Integer.valueOf(rid));
        m.put("ok", Boolean.valueOf(ok));
        if (ok) m.put("value", value);
        else {
            m.put("error", error);
            m.put("code", code);
        }
        protocol.println(Json.write(m));
        protocol.flush();
    }
}
