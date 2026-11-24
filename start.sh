#!/bin/sh
# 单容器起两个进程：
#   1) health.js  —— 监听平台注入的 $PORT，响应 /health + 提供 /track 转码代理
#   2) bridge.js  —— 主进程，主动外连小智 MCP 接入点
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PUBLIC_PORT="${PORT:-10000}"

cd "${APP_DIR}"

# 校验 ffmpeg 是否可用（proxy 模式下必需）
if [ "${XIMALAYA_STREAM_MODE:-proxy}" = "proxy" ]; then
  if command -v ffmpeg >/dev/null 2>&1; then
    echo "[boot] ffmpeg 就绪: $(ffmpeg -version 2>&1 | head -1)"
  else
    echo "[boot] 警告：未找到 ffmpeg，proxy 转码模式将无法工作（可改用 direct 模式）"
  fi
fi

echo "[boot] 健康检查 + 音频代理端口 ${PUBLIC_PORT}"
node health.js &
HEALTH_PID=$!

echo "[boot] 启动 MCP bridge（模式 ${XIMALAYA_STREAM_MODE:-proxy}）"
exec node bridge.js
