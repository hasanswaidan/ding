@echo off
title Ding - phone pager (keep this window open)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed on this computer.
  echo Opening the download page. Install the LTS version, then double-click "Start Ding" again.
  start "" https://nodejs.org/en/download
  echo.
  pause
  exit /b
)
node start.js
echo.
pause
