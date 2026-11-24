@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 喜马拉雅 MCP - 本机服务总控

echo ============================================
echo   喜马拉雅 MCP 本机部署 - 一键启动
echo ============================================
echo.

REM ---- 关键：不设 XIMALAYA_DIAGNOSTIC_URL，关闭诊断，恢复真实喜马拉雅故事播放 ----
set XIMALAYA_DIAGNOSTIC_URL=
set XIMALAYA_STREAM_MODE=proxy
set PORT=8899
set FFMPEG_PATH=C:\Users\Administrator\WorkBuddy\2026-11-18-21-33-13\tools\ffmpeg\ffmpeg.exe
set XIMALAYA_LOCAL_HEALTH=http://127.0.0.1:8899

echo [检查] ffmpeg ...
if not exist "%FFMPEG_PATH%" (
  echo [错误] 找不到 ffmpeg: %FFMPEG_PATH%
  pause
  exit /b 1
)
echo [OK] ffmpeg 就绪

echo [检查] endpoint.txt ...
if not exist "endpoint.txt" (
  echo [错误] 缺少 endpoint.txt，请先把小智 MCP 接入点 wss 地址粘进去
  pause
  exit /b 1
)
echo [OK] endpoint.txt 存在

echo [检查] cpolar ...
set CPOLAR_EXE=C:\Program Files\cpolar\cpolar.exe
if not exist "%CPOLAR_EXE%" (
  echo [错误] 找不到 cpolar: %CPOLAR_EXE%
  pause
  exit /b 1
)
echo [OK] cpolar 就绪

echo.
echo 将打开 3 个窗口：
echo   [1] health.js      - 明文音频代理 (8899)
echo   [2] cpolar 隧道     - 公网 http 地址（输出写入 cpolar-out.txt）
echo   [3] bridge.js      - 连小智 WSS + 地址自动同步
echo.
echo 保持全部窗口开启。关闭窗口即停止对应服务。
echo ============================================
echo.

REM [1] 音频代理
start "喜马拉雅-音频代理" cmd /k "node health.js"

REM [2] cpolar 纯 http 隧道，输出重定向到文件供同步脚本读取；-proto http 避免设备 https TLS 崩溃
start "喜马拉雅-cpolar隧道" cmd /k ""%CPOLAR_EXE%" http 8899 -proto http -region cn -log stdout -inspect-addr false > cpolar-out.txt 2>&1"

REM [3] 地址同步(常驻) + bridge：先等隧道起来再同步一次，然后启动 bridge
start "喜马拉雅-MCP bridge" cmd /k "node sync-cpolar.js --watch & node bridge.js"

echo 三个服务已在独立窗口启动。此窗口可以关闭。
echo 首次启动约需 10 秒建立隧道，bridge 窗口出现 [agent] agent#1 已连接 即成功。
pause
