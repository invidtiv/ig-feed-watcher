@echo off
REM IG Feed Watcher - Web Explorer (the app you look at in the browser)
REM Keep this window open while you want the web app running.
setlocal
title IG Feed Watcher - Web Explorer
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Run install.bat first.
  pause
  exit /b 1
)

echo Starting the web app...
echo Open http://localhost:4180 in your browser (opening automatically)...
start "" http://localhost:4180
node server.js
echo.
echo The web app stopped. Close this window or press a key.
pause
endlocal
