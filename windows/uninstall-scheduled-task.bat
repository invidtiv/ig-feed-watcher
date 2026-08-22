@echo off
REM IG Feed Watcher — remove the automatic 5-minute watcher
setlocal
title IG Feed Watcher - Remove automatic watcher
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-scheduled-task.ps1"
echo.
pause
endlocal
