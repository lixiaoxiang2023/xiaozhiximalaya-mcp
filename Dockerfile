FROM node:20-slim

ENV NODE_ENV=production \
    XIMALAYA_STREAM_MODE=proxy \
    XIMALAYA_TRANSCODE_SR=24000 \
    XIMALAYA_TRANSCODE_BR=48

# ffmpeg 负责把喜马拉雅 M4A 转成设备可播的 16k 单声道 MP3。
# 用 --no-install-recommends 控制镜像体积。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm install --omit=dev --no-audit --no-fund ws@^8.18.0

COPY bridge.js health.js start.sh ./
COPY lib/ ./lib/
RUN chmod +x start.sh

# 平台健康检查端口；音频流也走这个端口的 /track/:id
EXPOSE 10000

CMD ["sh", "start.sh"]
