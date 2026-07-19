@echo off
rem ============================================================
rem  SCC Broadcast Overlay — double-click launcher
rem  Starts the local server and reports the two URLs.
rem  Leave the window open while streaming; Ctrl+C or close to stop.
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this machine.
  echo   Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

node server.js

rem If the server exits (port in use, crash), keep the window open
rem so the message above can be read.
echo.
pause
