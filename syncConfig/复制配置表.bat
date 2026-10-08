@echo off
setlocal
chcp 65001 >nul

node "%~dp0sync-language.js"
set "SYNC_EXIT_CODE=%ERRORLEVEL%"

pause >nul

exit /b %SYNC_EXIT_CODE%
