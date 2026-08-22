@echo off
REM IG Feed Watcher — install the automatic 5-minute watcher
REM After this, Windows runs the watcher by itself. No window needs to stay open.
setlocal
title IG Feed Watcher - Install automatic watcher
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-scheduled-task.ps1"
if errorlevel 1 (
  echo.
  echo  Something went wrong. Run install.bat first, then try again.
) else (
  echo  Done! The watcher is now scheduled.
  echo  You can still use start-explorer.bat to view the web app.
)
echo.
pause
endlocal
