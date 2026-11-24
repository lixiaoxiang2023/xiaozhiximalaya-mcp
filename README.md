# xiaozhi-ximalaya-mcp

让小智 AI 播放**喜马拉雅原声故事/有声书**的 MCP 服务。部署范式与你的 `xiaozhi-netease-mcp` 一致：bridge 主动外连小智控制台的 MCP 接入点，设备端调用 `self.music.play_song` 播放原声（**非 TTS 朗读**）。

## 能力

- 三个工具：`play_story`（直接播放）、`search_stories`（搜索候选）、`story_catalog`（分类目录）
- 自动从搜索结果优先挑**免费 + 完结**的专辑，避开会员内容
- 支持指定 `album_id` / `track_id` / `episode` 精确播放某一集
- **M4A→MP3 转码**：喜马拉雅给的是 M4A/AAC，设备固件只吃 MP3，默认在容器内用 ffmpeg 转成 16k 单声道 MP3（内容是原声，只是换编码）
- 内置 `/health`、`/diag`、`/logs` 远程诊断，单容器自保活

## 目录结构

```
bridge.js              MCP over WSS 主进程：工具注册、提示词工程、预转码触发
health.js              健康检查 + /track/:id 转码代理（M4A→MP3，206/Range）+ /diag
lib/xmly.mjs           喜马拉雅音源层（来自 dsh-ximalaya，MIT，零第三方依赖）
lib/LICENSE.ximalaya   音源层许可证
start.sh               单容器启动脚本
Dockerfile             node:20-slim + ffmpeg
render.yaml            Render 免费层 Blueprint
package.json
.env.example           环境变量样例（敏感值只进平台环境变量）
DEPLOY.md              完整部署手册
.github/workflows/keepalive.yml   防休眠定时任务
```

## 快速本地验证

```bash
npm install
npm run check                    # 语法检查
npm run diag                     # 实测搜索（应返回若干免费专辑）
```

端到端需要小智接入点 + 公网地址，见 DEPLOY.md。

## 与网易云版的关系

- **相同**：WSS 外连、MCP JSON-RPC 协议、工具提示词工程（播完静默防掐断）、单容器双进程、Render 部署、health/keepalive。
- **不同**：音源层从 npm 的 `NeteaseCloudMusicApi` 换成本仓库的 `lib/xmly.mjs`；多了 ffmpeg 转码环节（因为喜马拉雅给 M4A）。

## 合规

仅限个人家庭自听。音源走非官方接口，版权归喜马拉雅及权利方，禁止商业/公开传播/二次分发；登录 Cookie 风控风险自担。详见 DEPLOY.md 第八节与 `lib/LICENSE.ximalaya`。
# xiaozhiximalaya-mcp
