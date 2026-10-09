# Java / JACOB bridge

An alternative to the PowerShell bridge, for machines where PowerShell is restricted but the existing Java/JACOB framework already runs. It is a small Java program that speaks the **same line protocol** as the PowerShell bridge (one JSON command per line on stdin, one JSON reply per line on stdout), so nothing above the transport - tests, page objects, fixtures - changes. It uses the JACOB jar and DLL you already have.

## Build

You need a JDK (8 or later) and the JACOB jar your Java framework uses.

```bash
cd bridge/jacob
./build.sh /path/to/jacob-1.18.jar           # Windows: build.bat C:\path\to\jacob-1.18.jar
```

This produces `bridge/jacob/sap-bridge.jar` (compiled for Java 8, so any later runtime works).

## Use

Tell the framework which bridge to use, in `.env.<name>` (these are not secrets):

```
SAP_GUI_TRANSPORT=java
SAP_GUI_BRIDGE_JAR=C:\path\to\referenced-automation-sap\bridge\jacob\sap-bridge.jar
SAP_GUI_JACOB_JAR=C:\path\to\jacob-1.18.jar
SAP_GUI_JACOB_DLL=C:\path\to\jacob-1.18-x64.dll    # the FULL path, in the bitness of your Java (x86 or x64)
# SAP_GUI_JAVA=C:\Program Files\Java\jdk-17\bin\java.exe   (default: java from PATH)
```

`SAP_GUI_JACOB_DLL` is what the existing framework passes as `jacob.dll.path`. Use the `x64` DLL with a 64-bit Java and the `x86` DLL with a 32-bit Java.

Then check it the same way as the PowerShell bridge:

```bash
npm run build
npm run doctor -- --conformance          # --write also types into the command field and reads it back
```

`--conformance` runs a fixed set of checks (ping, busy, exists, info, chained access, children, find, context, the NOT_FOUND vs ERROR codes the retry logic depends on, round-trip latency). A transport that passes is fit to run the tests on that machine and SAP release.

## What is and is not verified

Verified (in this repository's tests): the helper compiles for Java 8, and when run against **stand-in JACOB classes** (a tiny in-memory SAP model under `tests/gui/bridges/jacob-stub`) it speaks the protocol correctly, handles chained access, find, UTF-8 text, 32-bit number conversion and error codes, and passes the same conformance suite as the simulator and the stand-in process bridge.

**Not verified until it runs on a Windows machine with SAP GUI and the real JACOB:** the actual COM calls (the helper uses `Dispatch.call/get/put` the way the existing framework's `SAPDriver` and `SAPElement` do, but it has not been exercised against a real SAP system), the new `find` / `info` / `context` operations and `OpenConnectionByConnectionString` on your SAP GUI release, and SAP Logon auto-start. Run `npm run doctor -- --conformance` first.

## What it deliberately does not do

It does not kill processes (the existing framework's `wmic ... terminate`), sleep, or store credentials. Starting SAP Logon happens only if SAP Logon is not already running and `SAP_GUI_LOGON_PATH` points at it.
