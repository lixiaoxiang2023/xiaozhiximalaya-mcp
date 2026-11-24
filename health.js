// 免费 PaaS 要求绑定平台注入端口并响应健康检查；同时承载两个关键能力：
//   1) /track/:id  —— 核心：把喜马拉雅 M4A 转码成设备可播的 MP3（原声，非 TTS）
//   2) /health /diag /logs —— 容器里唯一的远程诊断窗口
//
// 转码沿用 xiaozhi-netease-mcp 已验证的策略：返回地址前先整首转码落盘，
// 设备拿到的永远是「定长 Content-Length + 支持 Range(206)」的完整文件——
// 设备固件对 chunked（无 Content-Length）处理不稳，拉几十 KB 就断。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BUILD = 'v1-ximalaya-mp3';
const port = Number(process.env.PORT || 10000);
const startedAt = Date.now();
const STATUS_FILE = process.env.BRIDGE_STATUS_FILE || '/tmp/bridge-status.json';
const LOG_FILE = process.env.BRIDGE_LOG_FILE || '/tmp/bridge.log';

// ---- 音源层（ESM 动态 import）----
let xmly = null;
const xmlyReady = import('./lib/xmly.mjs').then((m) => { xmly = m; return m; });

// ---- 转码配置 ----
const STREAM_MODE = String(process.env.XIMALAYA_STREAM_MODE || 'proxy').toLowerCase();
const COOKIE = String(process.env.XIMALAYA_COOKIE || '').trim();
const TRANSCODE_SR = (() => {
  const n = Number(process.env.XIMALAYA_TRANSCODE_SR || 24000);
  return [8000, 16000, 24000, 32000, 44100, 48000].includes(n) ? n : 24000;
})();
const TRANSCODE_BR = (() => {
  const n = Number(process.env.XIMALAYA_TRANSCODE_BR || 48);
  return Number.isFinite(n) && n >= 16 && n <= 128 ? Math.round(n) : 48;
})();
const MEDIA_CACHE_DIR = process.env.XIMALAYA_CACHE_DIR || path.join(os.tmpdir(), 'xiaozhi-ximalaya-media');
const PREFETCH_WAIT_MS = 8000;   // 返回地址前等整首转码完成的最长时间
const MEDIA_CACHE_LIMIT = 600 * 1024 * 1024; // 缓存上限
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
// 不带 www.ximalaya.com 的 Referer（实测会 403）；仅普通 UA
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const mediaJobs = new Map(); // trackId -> { file, proc, done, error, attempt, currentUrl }

function hlog(...args) {
  const line = `[${new Date().toISOString()}] [media] ` + args.join(' ');
  const safe = line.replace(/wss:\/\/[^\s"']+/g, 'wss://<hidden>').replace(/token=[^\s"']+/g, 'token=<hidden>');
  try { fs.appendFileSync(LOG_FILE, safe + '\n'); } catch { /* ignore */ }
  console.log(safe);
}

function mediaFile(trackId) { return path.join(MEDIA_CACHE_DIR, `${String(trackId)}.mp3`); }

function cleanupMediaCache() {
  try {
    const files = fs.readdirSync(MEDIA_CACHE_DIR)
      .map((f) => ({ f, p: path.join(MEDIA_CACHE_DIR, f) }))
      .filter((x) => x.f.endsWith('.mp3'))
      .map((x) => ({ ...x, size: fs.statSync(x.p).size, mtime: fs.statSync(x.p).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((s, x) => s + x.size, 0);
    for (const x of files) {
      if (total <= MEDIA_CACHE_LIMIT) break;
      try { fs.rmSync(x.p, { force: true }); total -= x.size; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// 拿到可播放的 CDN 源 URL；失败时回退到备用码率 straight
async function sourceUrl(trackId, retry = 0) {
  await xmlyReady;
  const r = await xmly.resolvePlay(trackId, COOKIE || undefined);
  let url = r.url;
  if (retry > 0 && !/\.mp3($|\?)/i.test(url)) {
    try {
      const tj = await xmly.trackJson(trackId);
      url = tj.play_path_32 || tj.play_path || url;
    } catch { /* 保留原 url */ }
  }
  return { url, title: r.title || '', source: r.source, quality: r.quality };
}

// ffmpeg 转码（M4A/AAC -> 单声道 MP3），换源重试
function startTranscode(trackId) {
  const id = String(trackId);
  const existing = mediaJobs.get(id);
  if (existing && !existing.error) return existing;

  const file = mediaFile(id);
  const job = { file, proc: null, done: false, error: null, attempt: 0, currentUrl: '' };
  mediaJobs.set(id, job);

  try {
    fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 8192) {
      job.done = true;
      return job;
    }
  } catch { /* ignore */ }

  const tmp = `${file}.part`;
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }

  const spawnOnce = (url) => {
    job.currentUrl = url;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-user_agent', UA,
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', url,
      '-vn', '-ac', '1', '-ar', String(TRANSCODE_SR),
      '-c:a', 'libmp3lame', '-b:a', `${TRANSCODE_BR}k`,
      '-flush_packets', '1', '-f', 'mp3', '-y', tmp,
    ];
    let proc;
    try { proc = spawn(FFMPEG_BIN, args, { windowsHide: true }); }
    catch (e) { job.error = e; hlog(id, 'ffmpeg 启动失败:', e.message); return null; }
    job.proc = proc;
    proc.stderr.on('data', (b) => {
      const s = String(b).trim();
      if (s) hlog(id, 'ffmpeg:', s.slice(0, 200));
    });
    proc.on('error', (e) => { job.error = e; hlog(id, 'ffmpeg 错误:', e.message); });
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          fs.rmSync(file, { force: true });
          fs.renameSync(tmp, file);
          job.done = true;
        } catch (e) { job.error = e; }
        hlog(id, `转码完成 ${job.done ? Math.round(fs.statSync(file).size / 1024) + 'KB' : '失败'}`);
        cleanupMediaCache();
        return;
      }
      if (code === null) return; // 被主动终止
      const MAX_RETRY = 1;
      if (job.attempt < MAX_RETRY) {
        job.attempt += 1;
        hlog(id, `ffmpeg 退出码 ${code}，换备用码率重试第 ${job.attempt} 次`);
        sourceUrl(id, job.attempt).then((fresh) => spawnOnce(fresh.url))
          .catch((e) => { job.error = e; hlog(id, '换源失败:', e.message); });
        return;
      }
      job.error = new Error(`ffmpeg 退出码 ${code}`);
      hlog(id, '转码最终失败:', code);
    });
    return proc;
  };

  sourceUrl(trackId).then((r) => {
    hlog(id, `开始转码 ${id}（${r.quality || 'auto'}，${r.source || '?'}）→ ${TRANSCODE_SR}Hz 单声道 ${TRANSCODE_BR}kbps MP3`);
    spawnOnce(r.url);
  }).catch((e) => { job.error = e; hlog(id, '解析播放地址失败:', e.message); });

  return job;
}

async function waitPrefetch(job) {
  const deadline = Date.now() + PREFETCH_WAIT_MS;
  while (Date.now() < deadline) {
    if (job.done) return true;
    if (job.error) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !job.error; // 超时不一定失败，让设备先连上等数据
}

// 推完整文件：定长 + Range，设备可断点续传
function serveFile(res, job, trackId, start) {
  if (!fs.existsSync(job.file)) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('音频转码失败，请稍后重试');
    return;
  }
  const size = fs.statSync(job.file).size;
  const from = Math.min(Math.max(start, 0), size);
  const head = {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Connection': 'close',
  };
  if (from > 0) {
    res.writeHead(206, { ...head, 'Content-Length': String(size - from), 'Content-Range': `bytes ${from}-${size - 1}/${size}` });
    hlog(trackId, `断点续传：从 ${Math.round(from / 1024)}KB 继续`);
  } else {
    res.writeHead(200, { ...head, 'Content-Length': String(size) });
  }
  const rs = fs.createReadStream(job.file, { start: from, highWaterMark: 8 * 1024 });
  rs.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  rs.pipe(res);
}

function parseRange(req, total) {
  const h = req.headers && req.headers.range;
  if (!h) return 0;
  const m = /bytes=(\d+)-/i.exec(h);
  if (!m) return 0;
  return Math.min(Number(m[1]) || 0, Math.max(0, total - 1));
}

function readBridgeStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return null; }
}

// /diag 在容器内直接跑音源层（不依赖额外端口）
async function runDiag(kw) {
  await xmlyReady;
  const out = { build: BUILD, mode: STREAM_MODE, mode_note: STREAM_MODE === 'proxy' ? 'M4A→MP3 转码代理' : 'M4A 直连', cookie: Boolean(COOKIE), sr: TRANSCODE_SR, br: TRANSCODE_BR };
  try {
    const r = await xmly.searchAlbums(kw, 1, 3);
    out.search_count = r.albums.length;
    out.first = r.albums[0] ? { id: r.albums[0].id, title: r.albums[0].title, isPaid: r.albums[0].isPaid } : null;
    if (!r.albums.length) { out.hint = '搜索为空：可能是出口 IP 被限流'; return out; }
    const t = await xmly.albumTracks(r.albums[0].id, 1, 10);
    out.track_count = (t.tracks || []).length;
    if (!t.tracks.length) { out.hint = '曲目列表为空：专辑已下架或接口变更'; return out; }
    const tid = t.tracks[0].trackId || t.tracks[0].id;
    const p = await xmly.resolvePlay(tid, COOKIE || undefined);
    out.play = { trackId: tid, urlHost: (() => { try { return new URL(p.url).host; } catch { return null; } })(), source: p.source, quality: p.quality, title: p.title, isMp3: /\.mp3($|\?)/i.test(p.url) };
    out.hint = /\.m4a/i.test(p.url) ? '源为 M4A：proxy 模式会转码成 MP3；direct 模式需设备支持 AAC' : '源为 MP3';
  } catch (e) {
    out.diag_error = String(e && e.message || e);
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  const send = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj, null, 2));
  };

  // 预转码：bridge 在返回 audio_url 前调用，确保设备拉流时文件已就绪
  if (/^\/prefetch\/\d+$/.test(u.pathname)) {
    const id = u.pathname.split('/')[2];
    try {
      const job = startTranscode(id);
      const ready = await waitPrefetch(job);
      send({ ok: ready, trackId: id, done: job.done, error: job.error ? String(job.error.message || job.error) : null });
    } catch (e) { send({ ok: false, error: String(e && e.message || e) }, 500); }
    return;
  }

  // 音频流：设备 self.music.play_song(song=audio_url) 实际拉取的端点
  if (/^\/track\/\d+$/.test(u.pathname)) {
    if (STREAM_MODE === 'direct') {
      // direct 模式：302 到 CDN M4A 直链（仅设备支持 AAC 时可用）
      try {
        const id = u.pathname.split('/')[2];
        const r = await sourceUrl(id);
        res.writeHead(302, { Location: r.url, 'Cache-Control': 'no-store' });
        res.end();
      } catch (e) { res.writeHead(502); res.end('解析直链失败'); }
      return;
    }
    const id = u.pathname.split('/')[2];
    const job = startTranscode(id);
    const ready = await waitPrefetch(job);
    if (!ready && job.error) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('转码失败：' + job.error.message); return; }
    if (!fs.existsSync(job.file)) {
      // 转码仍在进行但已有部分数据：先等一小段，避免设备拿到空响应
      await new Promise((r) => setTimeout(r, 1500));
    }
    serveFile(res, job, id, parseRange(req, fs.existsSync(job.file) ? fs.statSync(job.file).size : 0));
    return;
  }

  if (u.pathname === '/logs') {
    const n = Math.min(Math.max(Number(u.searchParams.get('n')) || 120, 1), 500);
    try {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-n)
        .map((l) => l.replace(/wss:\/\/[^\s"']+/g, 'wss://<hidden>'));
      send({ build: BUILD, lines });
    } catch (e) { send({ build: BUILD, error: '读不到日志: ' + (e && e.message) }); }
    return;
  }

  if (u.pathname === '/diag') {
    try { send(await runDiag(u.searchParams.get('kw') || '三体')); }
    catch (e) { send({ build: BUILD, diag_error: String(e && e.message || e) }); }
    return;
  }

  const bridge = readBridgeStatus();
  send({
    ok: true, build: BUILD, service: 'xiaozhi-ximalaya-mcp', mode: STREAM_MODE,
    endpoints: (process.env.XIAOZHI_MCP_ENDPOINTS || '').split(',').filter(Boolean).length,
    uptime_sec: Math.round((Date.now() - startedAt) / 1000),
    bridge_running: Boolean(bridge), bridge_pid: bridge ? bridge.pid : null,
    agents: bridge ? bridge.agents : null,
    diag: '/diag?kw=三体',
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[health] listening 0.0.0.0:${port}, build=${BUILD}, mode=${STREAM_MODE}`);
  startSelfPing();
});

// 自保活：容器定时请求自己公网 /health，抵消 Render 免费层 15 分钟休眠
function startSelfPing() {
  const base = String(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').trim();
  if (!base) { console.log('[keepalive] 未设 RENDER_EXTERNAL_URL，跳过自保活'); return; }
  const period = Number(process.env.SELF_PING_MS) > 30000 ? Number(process.env.SELF_PING_MS) : 5 * 60 * 1000;
  const target = `${base.replace(/\/+$/, '')}/health?self=1`;
  let fails = 0;
  console.log(`[keepalive] 每 ${Math.round(period / 1000)}s 自检`);
  const tick = async () => {
    try {
      const r = await fetch(target, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (fails) console.log('[keepalive] 恢复正常');
      fails = 0;
    } catch (e) { fails += 1; if (fails === 1 || fails % 6 === 0) console.log(`[keepalive] 自检失败 ${fails}: ${e && e.message}`); }
  };
  setInterval(tick, period).unref();
  setTimeout(tick, 30000).unref();
}
