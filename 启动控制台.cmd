@echo off
rem ============================================================
rem  SnowLuma x AstrBot Console - source-mode launcher
rem  (kept ASCII-only on purpose: cmd.exe reads .cmd files in the
rem   OEM codepage, so non-ASCII comments break the script on
rem   systems using a different codepage)
rem ============================================================
rem Clear ELECTRON_RUN_AS_NODE: some terminal environments preset it,
rem which makes Electron run as plain Node and fail with
rem "app.getPath is not defined". A GUI launch avoids any console window.
set ELECTRON_RUN_AS_NODE=

cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] First run: installing dependencies ^(electron, yauzl^)...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install --no-audit --no-fund || goto :fail
)

echo [2/2] Starting SnowLuma x AstrBot Console...
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:fail
echo.
echo Dependency installation failed. Check the network, then run: npm install
pause
exit /b 1
