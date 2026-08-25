@echo off
REM ============================================================================
REM One-shot local setup - works from a completely fresh clone of the whole
REM repo family, in any order: builds whichever sibling packages this repo
REM depends on (from a sibling checkout, cloning nothing on its own) before
REM `npm ci`, since npm ci fails otherwise if e.g. referenced-automation-utils
REM hasn't been packaged into ..\shared-packages yet. Also installs the
REM browser binaries Playwright needs (Chromium) plus its OS-level deps -
REM nothing to install manually, no system browser required.
REM
REM Usage: scripts\setup.bat
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set "SHARED_PACKAGES_DIR=..\shared-packages"

echo == Ensuring dependency packages exist in %SHARED_PACKAGES_DIR% ==========
call :ensure_package referenced-automation-utils
if errorlevel 1 exit /b 1
call :ensure_package referenced-automation-ui
if errorlevel 1 exit /b 1

echo.
echo == Installing dependencies ==========================================
call npm ci
if errorlevel 1 exit /b 1

if "%PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD%"=="1" (
  echo.
  echo == Skipping Playwright browser download ^(PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1^) ==
  echo Set BROWSER to a system-installed browser channel instead, e.g.:
  echo   set BROWSER=msedge ^&^& npm test   ^(or BROWSER=chrome^)
) else (
  echo.
  echo == Installing Playwright browsers ====================================
  call npx playwright install --with-deps chromium
  if errorlevel 1 exit /b 1
)

echo.
echo Setup complete. Try: npm test
endlocal
exit /b 0

:ensure_package
set "REPO_NAME=%~1"
set "FOUND="
for %%F in ("%SHARED_PACKAGES_DIR%\automation-%REPO_NAME%-*.tgz") do set "FOUND=%%F"
if defined FOUND (
  echo == %REPO_NAME%: already packaged ==
  exit /b 0
)
set "REPO_DIR=..\%REPO_NAME%"
if not exist "%REPO_DIR%" (
  echo ERROR: %REPO_NAME% is not packaged and not checked out at %REPO_DIR%. 1>&2
  echo Clone it as a sibling of this repo first: 1>&2
  echo   git clone https://github.com/achaljoshi/%REPO_NAME%.git %REPO_DIR% 1>&2
  exit /b 1
)
echo == Building %REPO_NAME% (dependency) ==
pushd "%REPO_DIR%"
REM %REPO_DIR% is a sibling of this repo at the same depth, so the relative
REM path to the shared packages folder is unchanged after pushd.
call scripts\create-package.bat "%SHARED_PACKAGES_DIR%"
set "BUILD_RESULT=%ERRORLEVEL%"
popd
exit /b %BUILD_RESULT%
