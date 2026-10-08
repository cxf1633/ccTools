@echo off
pushd "%~dp0"
node ".\bin\run.js" --framework-language %*
popd
pause
