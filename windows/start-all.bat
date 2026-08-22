@echo off
REM IG Feed Watcher - start everything (web app + watcher)
REM Opens two windows: the web app and the watcher. Keep both open.
setlocal
cd /d "%~dp0"

echo Starting the web app and the watcher in separate windows...
start "IG Watcher - Web Explorer" cmd /k ""%~dp0start-explorer.bat""
start "IG Watcher - Watcher" cmd /k ""%~dp0start-watcher.bat""
endlocal
