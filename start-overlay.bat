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

rem The RabbitConnect board feed rides along in its own minimized window. It is
rem only used when admin's manual host override points at 127.0.0.1:1983, and
rem if one is already running this second copy just exits.
start "SCC RabbitConnect board feed" /min cmd /c "node tools\rabbit-feed.js"

node server.js

rem If the server exits (port in use, crash), keep the window open
rem so the message above can be read.
echo.
pause
