@echo off
chcp 65001 >nul
setlocal
title Xuexitong DeepSeek service - install autostart
cd /d "%~dp0"
if not exist "autostart.mjs" (
  echo [ERROR] autostart.mjs not found. Please extract the whole project folder first.
  goto :failed
)
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE="
if not defined NODE_EXE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Install Node.js 20+ from https://nodejs.org and retry.
  goto :failed
)
"%NODE_EXE%" "autostart.mjs" install
echo.
echo Done. The local service will start automatically after you log in to Windows.
pause
exit /b 0

:failed
echo.
echo Failed. Please copy the message above.
pause
exit /b 1
