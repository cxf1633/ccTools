@echo off
pushd "%~dp0"
node ".\bin\run.js" %*
popd
pause
