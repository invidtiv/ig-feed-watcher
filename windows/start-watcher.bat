@echo off
REM IG Feed Watcher - Watcher (checks Instagram for new posts)
REM Runs in continuous mode: checks every 5 minutes. Keep this window open.
REM Optional argument: start-watcher.bat 15  - checks every 15 minutes.
setlocal
title IG Feed Watcher - Watcher
cd /d "%~dp0.."

REM Prefer a bundled portable node.exe (installer model); fall back to PATH.
set "NODE_EXE=%~dp0..\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 if not exist "%NODE_EXE%" (
  echo Node.js not found. Run install.bat first.
  pause
  exit /b 1
)

if "%~1"=="" (
  echo Starting watcher in continuous mode - checks every 5 minutes.
  echo Keep this window open. Close it to stop checking.
  "%NODE_EXE%" watcher.js --loop 5
) else (
  echo Starting watcher in continuous mode - checks every %~1 minutes.
  echo Keep this window open. Close it to stop checking.
  "%NODE_EXE%" watcher.js --loop %~1
)

echo.
echo Watcher stopped.
pause
endlocal
