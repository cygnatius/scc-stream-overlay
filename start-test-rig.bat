@echo off
rem ============================================================
rem  SCC Broadcast Overlay — DEV TEST RIG (not for broadcasts)
rem  Starts the overlay server AND the fake DGT LiveChess feed
rem  (tools\fake-livechess.js) in two windows, so the whole
rem  pipeline runs with no venue hardware.
rem
rem  Drive the fake board from a browser or curl:
rem    http://127.0.0.1:1982/_advance   play the next scripted move
rem    http://127.0.0.1:1982/_back      take the last move back
rem    http://127.0.0.1:1982/_reset     back to the start position
rem    http://127.0.0.1:1982/_mode?m=agree|clkless|diverge|ambiguous|off
rem
rem  Close both windows to stop everything.
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

start "SCC overlay server" cmd /k node server.js
start "FAKE LiveChess (dev)" cmd /k node tools\fake-livechess.js

echo.
echo   Two windows opened:
echo     Display:  http://127.0.0.1:8420/display.html
echo     Admin:    http://127.0.0.1:8420/admin.html
echo     Fake DGT: http://127.0.0.1:1982/_state
echo.
echo   This window can be closed.
pause
