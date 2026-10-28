@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo Install compatible Node.js first. See the server deployment guide.
  exit /b 1
)
if not defined WORKSPACE_DATA_DIRECTORY (
  echo Set WORKSPACE_DATA_DIRECTORY to your persistent data directory.
  exit /b 1
)
if not defined WORKSPACE_BOOTSTRAP_TOKEN (
  echo Set WORKSPACE_BOOTSTRAP_TOKEN to a fixed owner credential.
  exit /b 1
)
if not defined WORKSPACE_HOST set "WORKSPACE_HOST=127.0.0.1"
if not defined WORKSPACE_PORT set "WORKSPACE_PORT=43127"
node "%~dp0..\..\..\apps\server\dist\composition\main.js"
exit /b %errorlevel%
