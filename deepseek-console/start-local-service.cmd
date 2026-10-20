@echo off
chcp 65001 >nul
setlocal
title 学习通 DeepSeek 本地服务
cd /d "%~dp0"
if errorlevel 1 (
  echo 无法进入脚本目录：%~dp0
  goto :failed
)

if not exist "deepseek-local.mjs" (
  echo 缺少 deepseek-local.mjs，请先完整解压整个项目目录再运行。
  goto :failed
)
if not exist "deepseek-request.mjs" (
  echo 缺少 deepseek-request.mjs，请先完整解压整个项目目录再运行。
  goto :failed
)
if not exist "xuexitong-console.js" (
  echo 缺少 xuexitong-console.js，请先在项目根目录执行：node scripts\build.mjs
  goto :failed
)

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" (
  set "NODE_EXE="
  for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
)
if not defined NODE_EXE (
  echo 未找到 Node.js，请先安装 Node.js（https://nodejs.org）后重试。
  goto :failed
)

rem 访问 api.deepseek.com 需要代理时：优先沿用系统已有的 HTTPS_PROXY；
rem 否则探测本机 127.0.0.1:7897（Clash/Mihomo 默认端口），可用就自动启用。
if defined HTTPS_PROXY goto :proxy_ready
if defined https_proxy goto :proxy_ready
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $r = $c.BeginConnect('127.0.0.1', 7897, $null, $null); if ($r.AsyncWaitHandle.WaitOne(400) -and $c.Connected) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 goto :proxy_ready
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"
echo 检测到本机代理 127.0.0.1:7897，将用于访问 DeepSeek。
:proxy_ready
set "NODE_USE_ENV_PROXY=1"

echo 正在启动 DeepSeek 本地服务……
"%NODE_EXE%" "deepseek-local.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo 本地服务已退出（代码 %EXIT_CODE%）。
echo 如果上方有报错，请把报错原文发出来。
pause
exit /b %EXIT_CODE%

:failed
echo.
echo 启动失败，请把上方提示原文发出来。
pause
exit /b 1
