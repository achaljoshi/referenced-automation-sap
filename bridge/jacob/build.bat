@echo off
rem Builds sap-bridge.jar from SapBridge.java + Json.java against your existing JACOB jar.
rem   build.bat C:\path\to\jacob-1.18.jar            ->  sap-bridge.jar
if "%~1"=="" (echo usage: build.bat ^<path to jacob.jar^> & exit /b 2)
cd /d "%~dp0"
if exist out rmdir /s /q out
mkdir out
javac --release 8 -encoding UTF-8 -cp "%~1" -d out src\*.java || exit /b 1
jar cf sap-bridge.jar -C out . || exit /b 1
echo built %CD%\sap-bridge.jar
