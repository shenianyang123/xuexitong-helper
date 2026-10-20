@echo off
chcp 65001 >nul
setlocal
title Xuexitong DeepSeek local service
cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot enter script directory: %~dp0
  goto :failed
)

rem This file is intentionally ASCII-only: cmd.exe mis-parses multi-byte text when
rem the code page changes mid-file. Chinese messages are printed by Node instead.

if not exist "deepseek-local.mjs" (
  echo [ERROR] deepseek-local.mjs not found. Please extract the whole project folder first.
  goto :failed
)
if not exist "deepseek-request.mjs" (
  echo [ERROR] deepseek-request.mjs not found. Please extract the whole project folder first.
  goto :failed
)
if not exist "xuexitong-console.js" (
  echo [ERROR] xuexitong-console.js not found. Run "node scripts\build.mjs" in the project root.
  goto :failed
)

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE="
if not defined NODE_EXE for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE (
  echo [ERROR] Node.js not found. Install Node.js 20+ from https://nodejs.org and retry.
  goto :failed
)

rem Keep an existing HTTPS_PROXY; otherwise probe local 127.0.0.1:7897 (Clash/Mihomo default).
if defined HTTPS_PROXY goto :proxy_ready
if defined https_proxy goto :proxy_ready
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $r = $c.BeginConnect('127.0.0.1', 7897, $null, $null); if ($r.AsyncWaitHandle.WaitOne(400) -and $c.Connected) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 goto :proxy_ready
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"
echo [info] Local proxy 127.0.0.1:7897 detected, will be used for the DeepSeek API.
:proxy_ready
set "NODE_USE_ENV_PROXY=1"

echo Starting local service ... (the messages below are printed by Node.js)
"%NODE_EXE%" "deepseek-local.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Local service exited with code %EXIT_CODE%.
echo If there is an error above, please copy the whole error message.
pause
exit /b %EXIT_CODE%

:failed
echo.
echo Failed to start. Please copy the message above.
pause
exit /b 1
