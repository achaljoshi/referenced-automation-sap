# Java / JACOB bridge

An alternative to the PowerShell bridge, for machines where PowerShell is restricted but the existing Java/JACOB framework already runs. It is a small Java program that speaks the **same line protocol** as the PowerShell bridge (one JSON command per line on stdin, one JSON reply per line on stdout), so nothing above the transport - tests, page objects, fixtures - changes. It uses the JACOB jar and DLL you already have.

## Build

You need:

- **a JDK 9 or later** (`javac` and `jar` on `PATH`). The build uses `javac --release 8`, and `--release` does not exist before JDK 9: on JDK 8 `javac` only prints its usage text (`javac <options> <source files>`). `javac -version` must say 9 or higher. The *result* targets Java 8, so a Java 8 or newer **runtime** is enough to run it.
- the JACOB **binary** jar your Java framework uses (for example `jacob-1.18.jar`) - **not** the `-sources` jar (`jacob-1.18-sources.jar` contains no classes to compile against).

```bash
cd bridge/jacob
./build.sh /path/to/jacob-1.18.jar           # Windows PowerShell: .\build.bat C:\path\to\jacob-1.18.jar
```

This produces `bridge/jacob/sap-bridge.jar`.

**If an older Java is found first** (`javac -version` says `1.8...`): install a JDK 9+ and put it ahead on the path for the terminal you build in -

```powershell
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
javac -version        # javac 17.x
```

- or permanently for VS Code's terminals, in `settings.json` (then open a **new** terminal):

```json
"terminal.integrated.env.windows": {
  "JAVA_HOME": "C:\\Program Files\\Java\\jdk-17",
  "PATH": "C:\\Program Files\\Java\\jdk-17\\bin;${env:PATH}"
}
```

## Use

Tell the framework which bridge to use, in `.env.<name>` (these are not secrets; every key is also explained in `.env.example`):

```
SAP_GUI_TRANSPORT=java
SAP_GUI_BRIDGE_JAR=C:\path\to\referenced-automation-sap\bridge\jacob\sap-bridge.jar
SAP_GUI_JACOB_JAR=C:\path\to\jacob-1.18.jar
SAP_GUI_JACOB_DLL=C:\path\to\jacob-1.18-x64.dll    # the FULL path, in the bitness of your Java (x86 or x64)
# SAP_GUI_JAVA=C:\Program Files\Java\jdk-17\bin\java.exe   (default: java from PATH)
```

| Key | What it is |
|---|---|
| `SAP_GUI_BRIDGE_JAR` | the `sap-bridge.jar` you just built |
| `SAP_GUI_JACOB_JAR` | the JACOB **binary** jar (not `-sources`) |
| `SAP_GUI_JACOB_DLL` | the JACOB DLL, **full path** - what the existing framework passes as `jacob.dll.path` |
| `SAP_GUI_JAVA` | the `java.exe` to run it with (default `java` from `PATH`) |

**DLL bitness must match the Java, not Windows:** the `x64` DLL with a 64-bit Java, the `x86` DLL with a 32-bit Java (`java -version` says `64-Bit Server VM` for 64-bit). A mismatch typically fails at start with an `UnsatisfiedLinkError` such as `Can't load IA 32-bit .dll on a AMD 64-bit platform`. If that Java is not the first on `PATH`, set `SAP_GUI_JAVA`. In PowerShell, `Test-Path` each of the three paths before the first run; a missing one is reported by name (`the JACOB DLL (SAP_GUI_JACOB_DLL) was not found`).

Then check it the same way as the PowerShell bridge:

```bash
npm run build
npm run doctor -- --conformance          # --write also types into the command field and reads it back
```

`--conformance` runs a fixed set of checks (ping, busy, exists, info, chained access, children, find, context, the NOT_FOUND vs ERROR codes the retry logic depends on, round-trip latency). A transport that passes is fit to run the tests on that machine and SAP release.

## What is and is not verified

Reported from a real machine: the helper **passed all 15 conformance checks** (`npm run conformance`) there - that is all that is claimed (not which SAP release, not other machines). A real logon, a transaction and a recording were also exercised by hand on that machine.

Verified (in this repository's tests): the helper compiles for Java 8, and when run against **stand-in JACOB classes** (a tiny in-memory SAP model under `tests/gui/bridges/jacob-stub`) it speaks the protocol correctly, handles chained access, find, UTF-8 text, 32-bit number conversion and error codes, and passes the same conformance suite as the simulator and the stand-in process bridge.

**Not verified beyond that:** other machines and SAP GUI releases than the one above, `OpenConnectionByConnectionString`, and SAP Logon auto-start. Run `npm run doctor -- --conformance` first on every new machine.

## What it deliberately does not do

It does not kill processes (the existing framework's `wmic ... terminate`), sleep, or store credentials. Starting SAP Logon happens only if SAP Logon is not already running and `SAP_GUI_LOGON_PATH` points at it.

## Error codes

The helper answers a failure with a code the framework acts on: `NOT_FOUND` when `FindById` itself fails on a live connection (whatever language SAP GUI words the message in - the English text is only a last-resort fallback), `SESSION_LOST` when the COM connection is dead (an RPC / "disconnected" HRESULT read with `ComFailException.getHResult()`; `exists` and the optional property reads do not turn it into `false` / `null`), and `ERROR` for everything else. The classification runs against the stand-in JACOB classes in the framework's tests, whose `ComFailException` is a test double: that the real JACOB library reports these HRESULTs this way is **not verified**.

