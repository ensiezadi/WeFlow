@echo off
setlocal
cd /d "%~dp0"
if exist "release-local\win-unpacked\WeFlow.exe" (
  start "" "release-local\win-unpacked\WeFlow.exe" "--show" "--snapshot-root" "%~dp0local-diary-archive\snapshots"
  exit /b 0
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron runtime is missing. Install project dependencies first.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  echo Application build is missing. Build the project first.
  pause
  exit /b 1
)
if not exist "dist-electron\bootstrap.cjs" (
  echo Electron main build is missing. Build the project first.
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=
start "" "node_modules\electron\dist\electron.exe" "." "--show"
