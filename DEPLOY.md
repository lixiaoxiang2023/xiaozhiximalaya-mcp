# 部署到免费云平台（照网易云音乐那套）

这套服务的部署方式与你的 `xiaozhi-netease-mcp` **完全一致**：单容器两个进程，bridge 主动外连小智接入点（出向 WebSocket，无需公网 IP），部署到 Render 免费层后电脑可以关机，设备照常放故事。

## 与网易云版的两个关键差异

| 项 | 网易云版 | 喜马拉雅版 | 原因 |
|---|---|---|---|
| 音源 | NeteaseCloudMusicApi（独立进程，内部 3377） | `lib/xmly.mjs`（纯函数库，被两个进程直接 import） | xmly.js 零依赖、无原生模块，不需要独立 HTTP 进程 |
| 音频格式 | 网易云 CDN 直接给 MP3，设备直连 | 喜马拉雅给 **M4A/AAC**，默认在容器内用 ffmpeg 转成 **16k 单声道 MP3** | 你的设备固件是 MP3 通路（见网易云 bridge.js:44-47），放不了 M4A |

**转码的是编码格式，不是内容**——播的仍是喜马拉雅原始录音（原声），不是 TTS 机器朗读。

```
小智平台 (api.xiaozhi.me)
      ▲  bridge 主动外连（出向 WSS，不需要公网 IP）
      │
[ 单个 Render 容器 ]
  bridge.js ──WSS──► 小智    health.js(0.0.0.0:10000)
      │ import              ├─ /health 健康检查
      └─ lib/xmly.mjs        ├─ /diag   远程诊断
            └─ 喜马拉雅接口   └─ /track/:id  ffmpeg M4A→MP3（206/Range）
                                    ▲
   设备 self.music.play_song(song=https://服务域名/track/<id>) ──GET──┘
```

## 一、准备两个值

**1. 小智 MCP 接入点地址（必填）**

从 xiaozhi.me 控制台 → 智能体 → 角色配置 → MCP 接入点 获取（`wss://api.xiaozhi.me/mcp/?token=...`）。填到环境变量 `XIAOZHI_MCP_ENDPOINTS`。

> ⚠️ 这是访问凭据。只填到 Render 的环境变量（Secret），**不要写进仓库、不要贴聊天**。你之前贴到对话里的那个 token 建议去控制台撤销重建。

**2. 喜马拉雅 Cookie（可选）**

免费故事无需登录，留空即可。想播已购/VIP 内容才需要扫码登录后的 Cookie（关键字段 `1&_token=`）。填 `XIMALAYA_COOKIE`。同样只进环境变量。

## 二、代码仓库

本目录就是一个完整工程。部署前推到你的 **public** GitHub 仓库（public 的好处：Actions 分钟数免费、Render 可直接用 Public Git repository 部署、无需授权 GitHub App）。仓库里没有任何凭据（`.gitignore` 已排除 `config.json`、`endpoint*.txt`、`.env`、`*.log`）。

## 三、在 Render 创建

1. render.com → **New** → **Web Service**
2. 选 **Public Git repository**，填你的仓库地址
3. Runtime 选 **Docker**，Region 选 **Singapore**，Plan 选 **Free**
4. Advanced → 环境变量：

| Key | Value | 说明 |
|---|---|---|
| `XIMALAYA_STREAM_MODE` | `proxy` | 默认，云端转 M4A→MP3；别改成 direct，除非设备确认识别 AAC |
| `XIMALAYA_TRANSCODE_SR` | `24000` | 输出采样率，与设备匹配 |
| `XIMALAYA_TRANSCODE_BR` | `48` | 输出码率 kbps |
| `XIAOZHI_MCP_ENDPOINTS` | 你的 wss 接入点 | 必填，敏感 |
| `XIMALAYA_COOKIE` | 可留空 | 可选，敏感 |

5. Health Check Path 填 `/health`，Create Web Service

首次构建约 3~6 分钟（要 apt 装 ffmpeg）。

> Render 会自动注入 `RENDER_EXTERNAL_URL`，bridge 和 health.js 据此生成 `/track/:id` 的公网地址——**不用手填**。

## 四、必须做的一步：保活

Render 免费层 15 分钟无入站请求就休眠。两道保险：

1. **容器自保活**（已内置）：health.js 每 5 分钟请求自己的公网 `/health`（靠 `RENDER_EXTERNAL_URL`），自动生效。
2. **GitHub 定时任务**：把 `.github/workflows/keepalive.yml` 里的仓库变量 `HEALTH_URL` 设为 `https://你的服务名.onrender.com/health`（Settings → Secrets and variables → Actions → Variables），手动 Run 一次确认 200。

## 五、验证顺序

1. **Render 日志**应依次出现：
   ```
   [boot] ffmpeg 就绪: ffmpeg version ...
   [boot] 健康检查 + 音频代理端口 10000
   [boot] 启动 MCP bridge（模式 proxy）
   [boot] 音源层就绪
   [agent] agent#1 已连接
   ```
2. 浏览器打开 `https://服务名.onrender.com/health`，`agents` 应为 `connected`，`bridge_running: true`。
3. 打开 `/diag?kw=三体`，应看到 `search_count>0`、`play.urlHost=aod.cos.tx.xmcdn.com`、`isMp3:false`（源是 M4A，正常）。
4. **小智控制台** → 智能体 → MCP 接入点刷新工具列表，应见 `play_story` / `search_stories` / `story_catalog`。
5. 对设备说「**播放三体**」。判定通过：设备播报后开始播放有声内容，且之后保持静默（大模型不再插话）。
6. 若无声：先开 `/logs` 看 `[media]` 行——转码是否成功、ffmpeg 是否报错。

## 六、排错

| 现象 | 原因 / 处理 |
|---|---|
| 日志 `没有有效的接入点地址` | `XIAOZHI_MCP_ENDPOINTS` 没填或不是 wss:// 开头 |
| `[agent] 握手被拒: HTTP 400` | 该接入点已被别处占用（本机 bridge 没停）或 token 已失效 |
| 反复 `已断开，3 秒后重连` | token 失效，回控制台重新生成接入点 |
| 控制台工具列表为空 | bridge 没连上，先看日志有无 `已连接` |
| 设备说播放失败 / 无声 | 看 `/logs` 的 `[media]` 行；确认 ffmpeg 转码成功、返回的是 `/track/` 地址 |
| 搜到但都是会员专辑 | 正常，免费内容有限；可在 `.env` 配 `XIMALAYA_COOKIE` 解锁已购 |
| 播放频繁后 CDN 403 | 喜马拉雅 CDN 有出口 IP 限流，减少连续切歌 / 重试，等几分钟再试 |

最快排查：浏览器开 `https://服务名.onrender.com/diag?kw=三体`，能同时看到搜索、取列表、取直链三段结果。

## 七、换成别的平台

Dockerfile 通用，下列平台直接选 Docker 部署，环境变量同上：

| 平台 | 免费额度 | 注意 |
|---|---|---|
| Render | 750 小时/月 | 会休眠，需保活（已内置） |
| Fly.io | 按用量 | 需绑卡 |
| Zeabur / Sealos | 小额免费 | **国内访问较快，更推荐**（喜马拉雅 CDN 对境外 IP 有限流） |
| 腾讯云 / 阿里云轻量 | 按量 | 国内出口 IP，最稳 |

> 通信专家实测：喜马拉雅 CDN 对高频请求会触发**出口 IP 级 403**。国内机房 IP 比境外更稳，若 Render 频繁 403，建议迁到国内平台。

## 八、合规边界（务必知悉）

音源层 `lib/xmly.mjs` 来自开源项目 `jerryqx/dsh-ximalaya`（MIT），其上游声明：

> 通过非官方接口访问喜马拉雅内容，版权归喜马拉雅及权利方所有。仅供个人学习、技术研究、日常试听，严禁商业用途、公开传播、二次分发或盈利。扫码登录的账号风控、封禁风险自担。

请仅用于**个人家庭自听**：不要公开分享服务地址、不要多人共用扫码账号、不要分发音频。这与上游边界一致。MIT 只覆盖代码，不覆盖喜马拉雅的内容版权。
