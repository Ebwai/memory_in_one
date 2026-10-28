@echo off
setlocal
node "%~dp0..\..\..\scripts\archive-cli.mjs" %*
exit /b %errorlevel%
