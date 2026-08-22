@echo off
REM ===========================================================================
REM  IG Feed Watcher - Windows Setup (run ONCE)
REM  Installs dependencies, creates folders and config, and tells you the
REM  next steps. No technical knowledge required - just follow the messages.
REM ===========================================================================
setlocal
title IG Feed Watcher - Setup
cd /d "%~dp0.."

echo.
echo  ============================================================
echo    IG Feed Watcher - Windows Setup
echo  ============================================================
echo.

REM -- 1. Check Node.js --------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [1/4] Node.js is NOT installed.
  echo         Opening the Node.js download page in your browser...
  echo.
  echo  After installing, the "Next" button may say "Install" - accept all
  echo  default options. Then come back here and run this file again.
  start "" https://nodejs.org/en/download
  echo.
  echo  Press any key to close this window...
  pause >nul
  exit /b 1
)

echo  [1/4] Node.js found:
for /f "delims=" %%v in ('node --version') do echo         %%v

echo  [2/4] Installing dependencies...
echo         First run downloads Chromium (~170 MB) - this can take a few
echo         minutes. Do not close this window.
call npm install
if errorlevel 1 (
  echo.
  echo  X npm install failed. Check the red message above, then run this
  echo     file again.
  pause
  exit /b 1
)

echo  [3/4] Creating folders...
if not exist logs        mkdir logs
if not exist screenshots mkdir screenshots
if not exist uploads     mkdir uploads

echo  [4/4] Checking configuration...
if not exist .env.config (
  copy .env.example .env.config >nul
  echo         Created .env.config from the template.
)

echo.
echo  ============================================================
echo   OK Setup complete!
echo  ============================================================
echo.
echo   Next steps:
echo    1. Double-click  start-explorer.bat   - opens the web app at
echo       http://localhost:4180  - add your Instagram cookies there
echo       (step-by-step: see COOKIES-GUIDE.md).
echo    2. Double-click  start-watcher.bat    - starts checking Instagram.
echo       Or run  install-scheduled-task.bat  once, and Windows will start
echo       the watcher every 5 minutes automatically (even after reboot).
echo.
pause
endlocal
