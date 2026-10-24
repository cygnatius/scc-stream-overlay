@echo off
rem ============================================================
rem  SCC Broadcast Overlay — RabbitConnect board feed
rem  Run this when you stream with RabbitConnect open. It reads the
rem  board and clocks RabbitConnect is showing and passes them to
rem  the overlay, so both work at once. RabbitConnect must be open
rem  and NOT minimized. Leave this window open while streaming.
rem  (start-overlay.bat starts this for you.)
rem  In admin: Board - manual host override - 127.0.0.1:1983
rem ============================================================
cd /d "%~dp0"
title SCC RabbitConnect board feed

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this machine.
  echo   Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

node tools\rabbit-feed.js

rem If the feed exits (port in use, crash), keep the window open
rem so the message above can be read.
echo.
pause
