@echo off
REM ============================================================================
REM One-shot local setup: installs dependencies AND the browser binaries
REM Playwright needs (Chromium/Firefox/WebKit) plus their OS-level deps -
REM nothing to install manually, no system browser required.
REM
REM Usage: scripts\setup.bat
REM ============================================================================
setlocal
cd /d "%~dp0\.."

echo == Installing dependencies ==========================================
call npm ci
if errorlevel 1 exit /b 1

echo.
echo == Installing Playwright browsers ====================================
call npx playwright install --with-deps
if errorlevel 1 exit /b 1

echo.
echo Setup complete. Try: npm test
endlocal
