@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 喜马拉雅 MCP - 本机服务总控

echo ============================================
echo   喜马拉雅 MCP 本机部署 - 一键启动
echo ============================================
echo.
echo 启动前请确认（见《本机部署-傻瓜指引.md》）：
echo   1. endpoint.txt 已填入小智 MCP 接入点 wss 地址
echo   2. cpolar 已安装并创建了指向本机 8899 的 http 隧道
echo   3. audio_base.txt 已由 cpolar 同步脚本生成
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

echo.
echo 将打开 3 个窗口：
echo   [1] health.js      - 明文音频代理 (8899)
echo   [2] cpolar 同步     - 自动更新公网地址
echo   [3] bridge.js      - 连小智 WSS
echo.
echo 保持全部窗口开启。关闭窗口即停止对应服务。
echo ============================================
echo.

start "喜马拉雅-音频代理" cmd /k "node health.js"
start "喜马拉雅-cpolar地址同步" cmd /k "node sync-cpolar.js --watch"
start "喜马拉雅-MCP bridge" cmd /k "node bridge.js"

echo 三个服务已在独立窗口启动。此窗口可以关闭。
pause
