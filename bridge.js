#!/usr/bin/env node
// 小智 MCP 接入点 bridge —— 喜马拉雅「原声故事/有声书」版
//
// 与 xiaozhi-netease-mcp 完全相同的部署范式：
//   bridge 主动外连小智 WSS 接入点（出向长连接，容器无需公网入站）
//   工具返回 audio_url，由设备端 self.music.play_song 播放原声
//
// 音源差异：喜马拉雅免费曲给的是 M4A(audio/mp4)，而设备固件是 MP3 通路。
//   因此默认走「云端转码代理」：audio_url 指向本容器 health.js 的 /track/<id>，
//   由 ffmpeg 转成 16kHz 单声道 MP3 再推给设备（仍是喜马拉雅原声，非 TTS）。
//   若设备确认识别 AAC，可设 XIMALAYA_STREAM_MODE=direct 直接返回 CDN M4A 直链。
//
// 接入点地址只从环境变量读取，绝不写入 stdout/stderr 或日志文件。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

// ---- 音源层（纯 ESM，无第三方依赖，动态 import 以兼容 CommonJS 主程序）----
let xmly = null;
const xmlyReady = import('./lib/xmly.mjs')
  .then((m) => { xmly = m; return m; })
  .catch((e) => { console.error('[xmly] 音源层加载失败:', e.message); throw e; });

// ---- 配置 ----
const PRIVATE_DIR = path.join(os.homedir(), '.config', 'xiaozhi-ximalaya-mcp');
const PROTOCOL_VERSION = '2024-11-05';
const STATUS_FILE = process.env.BRIDGE_STATUS_FILE || '/tmp/bridge-status.json';
const LOG_FILE = process.env.BRIDGE_LOG_FILE || '/tmp/bridge.log';
const PUBLIC_BASE = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// 【设备栈溢出修复 → 已升级为 https 优先】早期第三方音乐固件的播放任务 pthread
// 栈仅约 3KB，对 https:// 地址做 mbedTLS 握手即栈溢出重启（实测崩溃任务名 pthread），
// 当时靠 XIMALAYA_AUDIO_BASE_URL 指向「设备可明文 http 访问」的转码代理前缀
// （如本机 cpolar 隧道 http://xxx.cpolar.cn）规避 TLS 握手。
// 现固件侧已把播放线程栈提升到 10240B，可稳定完成 TLS 握手；因此 proxy 模式
// 改为优先使用 Render 自带 https 端点（PUBLIC_BASE，形如 https://xxx.onrender.com），
// 设备直连稳定 https 地址，彻底不再依赖易变且会失效的 cpolar 域名。
// XIMALAYA_AUDIO_BASE_URL 现仅作「本机部署、无 PUBLIC_BASE」时的明文 http 回退，
// 留空则行为不变（向后兼容）。
const AUDIO_BASE_ENV = String(process.env.XIMALAYA_AUDIO_BASE_URL || '').trim().replace(/\/+$/, '');
// 本机部署 + cpolar 场景：音频公网地址写在本地文件，运行时动态读取。
// cpolar 免费版地址会变，改文件即可，无需重启 bridge / 重新部署。
const AUDIO_BASE_FILE = process.env.XIMALAYA_AUDIO_BASE_FILE
  || path.join(__dirname, 'audio_base.txt');
// 本机 health.js 回环地址（预转码用，不经公网）
const LOCAL_HEALTH = (process.env.XIMALAYA_LOCAL_HEALTH || 'http://127.0.0.1:8899').replace(/\/+$/, '');
function getAudioBase() {
  try {
    const fromFile = fs.readFileSync(AUDIO_BASE_FILE, 'utf8').trim().replace(/\/+$/, '');
    if (/^http:\/\//i.test(fromFile)) return fromFile;
  } catch { /* 文件不存在则用环境变量 */ }
  return AUDIO_BASE_ENV;
}
// 【A/B 诊断】设置后 play_story 跳过搜索/解析/转码，直接把该地址交给设备。
// 用途：用已知可播放的明文 http MP3 验证「HTTPS TLS 握手爆栈」假设。
// 只接受 http:// 明文地址；https 地址无法用于本诊断。
const DIAG_URL = String(process.env.XIMALAYA_DIAGNOSTIC_URL || '').trim();
// auto：bridge 每次调用现取一条新鲜的网易云明文 http 直链（解决直链 20 分钟时效问题）。
// 用户只需填 XIMALAYA_DIAGNOSTIC_URL=auto，无需手动找链接。
const DIAG_AUTO = /^(auto|1)$/i.test(DIAG_URL);
const NCM_DIAG_API = 'https://netease-cloud-music-api-one-pied.vercel.app';
const NCM_DIAG_TRACK_ID = '1375668619'; // 已验证：免费、可播、明文 http
// 兜底直链（仅当公共 API 临时不可用时使用；带时效，可能过期）
const NCM_DIAG_FALLBACK = 'http://m7.music.126.net/20261124200832/7918e5712485ef6e4d3ba825c23747c0/ymusic/535a/005f/520c/d01116b76a7568e6cc5bef132bf62ec0.mp3?vuutv=CwIsYCYnzr5ByTZaw78QSsRrWDC5uuNmxsWD2SQ+QnU9rDRhlGXch+QAIjCl/RSQEPKKFJqDBxPkVHrEPVzJREyVP6toTWme03/VrJORJYg=';
let ncmDiagUrl = '';
let ncmDiagAt = 0;
const STREAM_MODE = String(resolveSetting('stream_mode', 'XIMALAYA_STREAM_MODE', 'proxy')).toLowerCase();
// 可选喜马拉雅 Cookie（登录态解锁已购/VIP）。敏感信息，仅从环境变量读取，不落盘。
const COOKIE = String(resolveSetting('cookie', 'XIMALAYA_COOKIE', '') || '');

// 缓存（直链 3 分钟、搜索 60 秒，减少请求以降低 CDN 出口 IP 403 风险）
const URL_CACHE_MS = 180_000;
const SEARCH_CACHE_MS = 60_000;
const cache = new Map();

let stopped = false;

// ---- 日志（脱敏：任何 wss 接入点片段都不落盘）----
function redact(s) {
  return String(s).replace(/wss:\/\/[^\s"']+/g, 'wss://<hidden>').replace(/token=[^\s"']+/g, 'token=<hidden>');
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const safe = redact(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, safe + '\n');
  } catch { /* 日志失败不影响主流程 */ }
  console.log(safe);
}

// 配置优先级：环境变量 > 私有 config.json > 默认值
function resolveSetting(configKeys, envNames, fallback) {
  const keys = Array.isArray(configKeys) ? configKeys : [configKeys];
  const envs = Array.isArray(envNames) ? envNames : [envNames];
  for (const envName of envs) {
    const v = process.env[envName];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PRIVATE_DIR, 'config.json'), 'utf8'));
    for (const k of keys) if (cfg && cfg[k] !== undefined && cfg[k] !== null && String(cfg[k]).trim() !== '') return cfg[k];
  } catch { /* 未配置 */ }
  return fallback;
}

function readEndpoints() {
  const env = (process.env.XIAOZHI_MCP_ENDPOINTS || process.env.XIAOZHI_MCP_ENDPOINT || '').trim();
  if (env) return env.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const list = [];
  // 本机部署：优先读项目根目录 endpoint.txt（用户只需把 wss 地址粘进去）。
  // 顺序：项目根目录 > 私有配置目录，兼容原有部署方式。
  const files = [
    path.join(__dirname, 'endpoint.txt'),
    path.join(PRIVATE_DIR, 'endpoint.txt'),
    path.join(PRIVATE_DIR, 'endpoint_axi.txt'),
  ];
  for (const f of files) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split(/[\n,]+/).map((s) => s.trim());
      for (const line of lines) {
        if ((line.startsWith('wss://') || line.startsWith('ws://')) && !list.includes(line)) list.push(line);
      }
    } catch { /* 文件不存在 */ }
  }
  return list;
}

function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const p = Promise.resolve().then(loader).then((value) => {
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }).catch((err) => { cache.delete(key); throw err; });
  cache.set(key, { value: p, expires: now + ttlMs });
  return p;
}

// ---- 音源封装 ----
async function searchAlbumsSafe(kw, rows = 8) {
  await xmlyReady;
  return cached(`s:${kw}:${rows}`, SEARCH_CACHE_MS, () => xmly.searchAlbums(kw, 1, rows));
}

async function tracksSafe(albumId, page = 1) {
  await xmlyReady;
  return cached(`t:${albumId}:${page}`, SEARCH_CACHE_MS, () => xmly.albumTracks(albumId, page, 30));
}

async function resolveSafe(trackId) {
  await xmlyReady;
  return cached(`u:${trackId}`, URL_CACHE_MS, () => xmly.resolvePlay(trackId, COOKIE || undefined));
}

// 把解析到的播放地址转成给设备的 audio_url。
// proxy（默认）：指向本容器 /track/<id>，由 health.js 转码成 MP3（设备可播）。
// direct：直接给 CDN 的 M4A 直链（仅当设备确认识别 AAC 时用）。
// 把任意 CDN 直链强制转成明文 http（喜马拉雅 aod.cos.tx.xmcdn.com 实测明文可用且不跳转）
function plainHttp(url) {
  return String(url || '').replace(/^https:\/\//i, 'http://');
}

function toAudioUrl(trackId, resolvedUrl) {
  // direct 模式：保持原行为不变——运行时明文 http 前缀优先（本机文件 > 环境变量），
  // 命中则用 <audioBase>/track/<id>；否则强制明文 http 的 CDN 直链（避免握手）。
  // direct 分支不读 PUBLIC_BASE，纯本机/诊断用途。
  if (STREAM_MODE === 'direct') {
    const audioBase = getAudioBase();
    if (audioBase) {
      if (!/^http:\/\//i.test(audioBase)) {
        log('[audio] 警告：音频公网地址不是 http:// 明文地址，无法规避设备 TLS 栈溢出:', audioBase);
      } else {
        return `${audioBase}/track/${trackId}`;
      }
    }
    return plainHttp(resolvedUrl);
  }

  // proxy 模式（默认）：优先 Render 自带 https 端点。固件播放线程栈已提升到
  // 10240B，可完成 mbedTLS 握手，设备直连稳定 https 地址，不再依赖 cpolar 隧道。
  // 这样即使部署环境的 XIMALAYA_AUDIO_BASE_URL 仍是旧 cpolar 值（已 404）也不受影响。
  if (PUBLIC_BASE) return `${PUBLIC_BASE}/track/${trackId}`;

  // 无 PUBLIC_BASE（本机部署场景）：才回退到明文 http 前缀（本机文件 > 环境变量）
  const audioBase = getAudioBase();
  if (audioBase) {
    if (!/^http:\/\//i.test(audioBase)) {
      log('[audio] 警告：音频公网地址不是 http:// 明文地址，无法规避设备 TLS 栈溢出:', audioBase);
    } else {
      return `${audioBase}/track/${trackId}`;
    }
  }
  // 无任何公网/本地前缀：退回明文直链（需设备能直连容器）
  return plainHttp(resolvedUrl);
}

// 返回 audio_url 前先触发 health.js 预转码。设备拉流超时约 2s，
// 若等它来拉才开始 ffmpeg（冷启动数秒）必然失败——这正是网易云版踩过的坑。
async function prefetchTrack(trackId) {
  if (STREAM_MODE !== 'proxy') return;
  // 预转码必须打本机 health.js 回环地址：本机部署时不经 cpolar 公网绕行，
  // 更快也更稳（cpolar 免费版 1Mbps 且随机地址，绕公网预取易超时）。
  const base = PUBLIC_BASE && !fs.existsSync(AUDIO_BASE_FILE)
    ? PUBLIC_BASE
    : LOCAL_HEALTH;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(`${base}/prefetch/${trackId}`, { signal: ctrl.signal });
    clearTimeout(t);
    log('[prefetch]', trackId, r.status);
  } catch (e) {
    log('[prefetch] 预转码未成功（设备拉流时会再试）:', e.message);
  }
}

// 从搜索结果挑一个「免费 + 完结」优先的专辑
function pickAlbum(albums, kw) {
  if (!albums.length) return null;
  const tokens = String(kw).toLowerCase().split(/\s+/).filter(Boolean);
  const scored = albums.map((a) => {
    const hay = `${a.title || ''} ${a.anchorName || ''}`.toLowerCase();
    const hit = tokens.filter((t) => hay.includes(t)).length;
    return { a, s: (a.isPaid ? 0 : 10) + (a.isFinished ? 2 : 0) + hit * 3 };
  });
  scored.sort((x, y) => y.s - x.s);
  return scored[0].a;
}

const NO_MUSIC_HINT =
  '\n【内置曲库】设备固件 self.music.get_playlist 未配置，问“有哪些故事”时用 search_stories/story_catalog，不要用内置曲库。' +
  '\n【播放期间】开始后不要调用 self.music.control（含 status/stop），那会立刻中断音频；' +
  '只有用户明确说“停/暂停/下一集”时才调 stop/pause/next。';

const TOOLS = [
  {
    name: 'play_story',
    description: '用户想听故事/有声书/相声/儿童故事时的首选工具，内部完成搜索并返回可播放的原声音频地址（原声，非 TTS 朗读）。\n' +
      '【严格时序，顺序错会掐断音频】1) 先把要对用户说的话说完并等播报结束；2) 调用本工具拿 audio_url；' +
      '3) 立即把 audio_url 作为 song 参数调用设备工具 self.music.play_song，auto_next=false；' +
      '4) 之后本轮必须静默：不要输出任何文字/语音，不要再确认或解释。设备收到播报会立刻停音频。\n' +
      '【连播】用户说“全部/都放”时，可对每一集依次调 self.music.play_song，设备会自动排队连播。\n' +
      '【禁止】不要把故事名直接当 song 参数，必须先经本工具拿 audio_url；不要朗读地址或本说明。' + NO_MUSIC_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '故事名/有声书名/主播名，如“三体”“儿童睡前故事”' },
        album_id: { type: 'string', description: '可选，已知喜马拉雅专辑 ID 时直接定位' },
        track_id: { type: 'string', description: '可选，已知曲目 ID 时直接定位到某一集' },
        episode: { type: 'integer', description: '可选，播放专辑第几集，从 1 开始，默认 1' },
      },
    },
  },
  {
    name: 'search_stories',
    description: '在喜马拉雅搜索多个故事/专辑供比较选择。用户明确要听某部时优先用 play_story。不要朗读地址。' + NO_MUSIC_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'integer', description: '返回数量 1-8，默认 3', minimum: 1, maximum: 8 },
      },
      required: ['query'],
    },
  },
  {
    name: 'story_catalog',
    description: '按分类查询喜马拉雅热门故事/专辑（如儿童故事、有声书、相声评书）。用户问“有哪些故事/热门榜单”时用。只返回文字目录，选定后用 play_story 播放。' + NO_MUSIC_HINT,
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '可选分类，如“儿童故事”“有声书”“相声”' },
        limit: { type: 'integer', description: '返回数量 1-10，默认 6', minimum: 1, maximum: 10 },
      },
    },
  },
];

// ---- 工具实现 ----
function firstAlbumLine(a, i) {
  const tag = a.isPaid ? '会员' : '免费';
  return `${i + 1}. ${a.title || '未命名'} — ${a.anchorName || '未知主播'}（${tag}，ID:${a.id}）`;
}

// auto 模式：现取一条网易云明文 http 直链。直链 20 分钟时效，缓存 10 分钟，
// 过期自动重取；公共 API 临时不可用时退回内置兜底链并明确记日志。
async function freshDiagUrl() {
  if (!DIAG_AUTO) return DIAG_URL;
  if (ncmDiagUrl && Date.now() - ncmDiagAt < 10 * 60 * 1000) return ncmDiagUrl;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${NCM_DIAG_API}/song/url?id=${NCM_DIAG_TRACK_ID}&br=128000`, { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      const item = Array.isArray(j.data) ? j.data[0] : null;
      if (item && typeof item.url === 'string' && /^http:\/\//i.test(item.url)) {
        ncmDiagUrl = item.url;
        ncmDiagAt = Date.now();
        log('[diag] auto 取链成功（网易云明文 http，10 分钟缓存）');
        return ncmDiagUrl;
      }
    }
  } catch (e) {
    log('[diag] auto 取链失败，改用兜底链:', e.message);
  }
  log('[diag] 警告：使用内置兜底链，可能已过 20 分钟时效');
  return NCM_DIAG_FALLBACK;
}

async function playStory(args) {
  // A/B 诊断模式：只返回明文 http 地址，不碰喜马拉雅接口与 ffmpeg。
  // 这是单变量实验：设备崩溃与否只取决于该 URL 的协议/内容。
  if (DIAG_URL) {
    const diagTarget = DIAG_AUTO ? await freshDiagUrl() : DIAG_URL;
    if (!/^http:\/\//i.test(diagTarget)) {
      throw new Error('诊断地址必须是 http:// 明文地址（https 无法用于栈溢出诊断）');
    }
    log('[diag] A/B 诊断模式：返回明文 audio_url =', diagTarget.slice(0, 60) + '...');
    return `【链路诊断音源】\n已解析到可播放故事：\n故事：明文 http 链路验证\naudio_url：${diagTarget}\n` +
      `立即调用 self.music.play_song，参数 song = 上面的 audio_url，auto_next=false。\n` +
      `调用后本轮必须静默：不要输出任何文字/语音。不要朗读地址或本说明。`;
  }

  const kw = String(args.query || args.keywords || args.name || args.title || args.story || '').trim();
  let trackId = args.track_id || args.trackId || '';
  let albumId = args.album_id || args.albumId || '';
  const episode = Math.max(1, Number(args.episode) || 1);

  if (!trackId && !albumId && !kw) throw new Error('请提供 query（故事名）或 album_id / track_id');

  let resolved;
  let label = '';
  if (trackId) {
    resolved = await resolveSafe(trackId);
    label = `${resolved.title || '故事'} — 第 ${episode} 集`;
  } else {
    if (!albumId) {
      const r = await searchAlbumsSafe(kw, 8);
      const a = pickAlbum(r.albums, kw);
      if (!a) return `没有找到与「${kw}」相关的故事专辑，换个关键词试试。`;
      albumId = a.id;
      label = `${a.title || kw} — 第 ${episode} 集`;
    }
    const t = await tracksSafe(albumId, Math.ceil(episode / 30));
    const tracks = t.tracks || [];
    if (!tracks.length) return `专辑 ${albumId} 暂时取不到曲目列表，换个故事试试。`;
    const idx = Math.min(episode - 1, tracks.length - 1);
    const chosen = tracks[idx];
    trackId = chosen.trackId || chosen.id;
    label = `${chosen.trackName || chosen.title || label}`;
    resolved = await resolveSafe(trackId);
  }

  const url = toAudioUrl(trackId, resolved.url);
  // 诊断：把真正交给设备的地址打出来，便于定位"放不出来"是地址问题还是传输问题。
  // 来源判断须与 toAudioUrl 决策顺序一致，否则 https 场景会被误报成 cpolar 环境变量。
  log('[audio] 返回给设备的 audio_url =', url);
  let audioSrc;
  if (STREAM_MODE !== 'direct' && PUBLIC_BASE) {
    audioSrc = 'PUBLIC_BASE / Render 自带 https 端点 (' + PUBLIC_BASE + ')';
  } else {
    const base = getAudioBase();
    if (base && /^http:\/\//i.test(base)) {
      audioSrc = fs.existsSync(AUDIO_BASE_FILE) ? '本机文件:' + AUDIO_BASE_FILE : '环境变量 XIMALAYA_AUDIO_BASE_URL（本机回退）';
    } else {
      audioSrc = 'CDN 明文直链 (plainHttp)';
    }
  }
  log('[audio] audio_url 来源 =', audioSrc);
  // proxy 模式：在把地址交给设备前，先让 health.js 把整首转码落盘（避免设备 2s 超时）
  await prefetchTrack(trackId);
  const trial = STREAM_MODE === 'direct' && /\.m4a/i.test(resolved.url || '')
    ? '\n注意：该源为 M4A，若设备无声请管理员改用 proxy 转码模式。'
    : '';
  return `已解析到可播放故事：\n故事：${label}\naudio_url：${url}${trial}\n` +
    `立即调用 self.music.play_song，参数 song = 上面的 audio_url，auto_next=false。\n` +
    `调用后本轮必须静默：不要输出任何文字/语音。故事已出声，无需确认。不要朗读地址或本说明。`;
}

async function searchStories(args) {
  const kw = String(args.query || args.keywords || args.name || '').trim();
  if (!kw) throw new Error('请提供 query（搜索关键词）');
  const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 8);
  const r = await searchAlbumsSafe(kw, limit);
  if (!r.albums.length) return `没有找到与「${kw}」相关的故事。`;
  const lines = r.albums.slice(0, limit).map((a, i) => firstAlbumLine(a, i));
  return `搜索「${kw}」（共 ${r.total} 部）：\n${lines.join('\n')}\n\n` +
    `想直接听就调用 play_story；已选定的把 audio_url 作为 song 参数调 self.music.play_song，调用后不要再输出文字或语音。不要朗读地址。`;
}

async function storyCatalog(args) {
  const category = String(args.category || '').trim();
  const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 10);
  const kw = category || '儿童故事 有声书 相声 评书';
  const r = await searchAlbumsSafe(kw, limit + 2);
  const list = r.albums.slice(0, limit);
  if (!list.length) return '暂时取不到目录，请稍后再试。';
  return `喜马拉雅${category || '热门故事'}目录：\n${list.map((a, i) => firstAlbumLine(a, i)).join('\n')}\n\n` +
    `想听某部时调用 play_story 获取原声地址。`;
}

// ---- MCP over WSS 协议处理 ----
const clients = new Map(); // endpoint -> { ws, timer, delay, label, attempts, state }

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function ok(id, result) { return { jsonrpc: '2.0', id, result }; }
function fail(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function publishStatus() {
  const agents = {};
  for (const [ep, st] of clients) {
    agents[st.label] = {
      state: st.state,
      attempts: st.attempts,
      lastError: st.lastError || null,
      httpStatus: st.httpStatus || null,
    };
  }
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ pid: process.pid, ts: Date.now(), agents }));
  } catch { /* 忽略 */ }
}

async function handleMessage(ws, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  const id = msg.id;
  const method = msg.method;
  // 只记录方法名，绝不记录参数或 endpoint（参数里可能有故事名，也可能被误塞 token）
  log('[rpc]', method);

  try {
    if (method === 'initialize') {
      send(ws, ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'xiaozhi-ximalaya-mcp', version: '1.0.0' },
        capabilities: { tools: {} },
      }));
      return;
    }
    if (method === 'ping' || method === 'notifications/initialized') {
      if (id !== undefined) send(ws, ok(id, {}));
      return;
    }
    if (method === 'tools/list') {
      send(ws, ok(id, { tools: TOOLS }));
      return;
    }
    if (method === 'tools/call') {
      const params = msg.params || {};
      const name = params.name;
      const args = params.arguments || {};
      let textOut;
      if (name === 'play_story') textOut = await playStory(args);
      else if (name === 'search_stories') textOut = await searchStories(args);
      else if (name === 'story_catalog') textOut = await storyCatalog(args);
      else textOut = `未知工具：${name}。可用工具：play_story / search_stories / story_catalog。`;
      send(ws, ok(id, { content: [{ type: 'text', text: textOut }] }));
      return;
    }
    if (method === 'resources/list') {
      send(ws, ok(id, { resources: [] }));
      return;
    }
    if (id !== undefined) send(ws, fail(id, -32601, 'Method not found: ' + method));
  } catch (e) {
    log('[error]', method, e && e.message);
    if (id !== undefined) send(ws, fail(id, -32000, String(e && e.message || e)));
    else send(ws, ok(id, { content: [{ type: 'text', text: '处理失败：' + (e && e.message || e) }] }));
  }
}

function connect(endpoint, label) {
  let state = clients.get(endpoint);
  if (!state) {
    state = { ws: null, timer: null, delay: 1000, label, attempts: 0, state: 'connecting', lastError: null, httpStatus: null };
    clients.set(endpoint, state);
  }
  state.attempts += 1;
  publishStatus();

  let ws;
  try {
    ws = new WebSocket(endpoint, { handshakeTimeout: 15000 });
  } catch (e) {
    state.lastError = e.message;
    scheduleReconnect(endpoint, state);
    return;
  }
  state.ws = ws;

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);
  heartbeat.unref();

  ws.on('open', () => {
    state.delay = 1000;
    state.state = 'connected';
    state.lastError = null;
    state.httpStatus = null;
    log(`[agent] ${label} 已连接`);
    publishStatus();
  });
  ws.on('message', (data) => handleMessage(ws, String(data)));
  ws.on('error', (e) => {
    state.lastError = e.message;
    log(`[agent] ${label} 错误: ${e.message}`);
  });
  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    state.state = 'reconnecting';
    state.lastError = `关闭码 ${code}${reason ? ' ' + String(reason).slice(0, 80) : ''}`;
    log(`[agent] ${label} 已断开，${state.lastError}`);
    publishStatus();
    if (!stopped) scheduleReconnect(endpoint, state);
  });
  ws.on('unexpected-response', (_req, res) => {
    state.httpStatus = res.statusCode;
    state.state = 'rejected';
    state.lastError = `HTTP ${res.statusCode}`;
    log(`[agent] ${label} 握手被拒: HTTP ${res.statusCode}`);
    publishStatus();
  });
}

function scheduleReconnect(endpoint, state) {
  if (state.timer) clearTimeout(state.timer);
  const d = state.delay;
  state.delay = Math.min(Math.round(state.delay * 1.7), 30000);
  state.timer = setTimeout(() => connect(endpoint, state.label), d);
  if (state.timer.unref) state.timer.unref();
}

function main() {
  log(`[boot] 喜马拉雅 MCP bridge 启动，模式=${STREAM_MODE}，音源=${COOKIE ? '登录态+匿名' : '匿名免费'}，公网=${PUBLIC_BASE || '未设置'}`);
  log(`[boot] 音频前缀 XIMALAYA_AUDIO_BASE_URL=${AUDIO_BASE_ENV || '未设置'}，诊断开关 XIMALAYA_DIAGNOSTIC_URL=${DIAG_URL || '未设置'}`);
  if (DIAG_URL) log(`[boot] A/B 诊断模式已启用(${DIAG_AUTO ? 'auto 自动取链' : '固定地址'})：play_story 只返回明文 http 地址，不访问喜马拉雅、不转码`);
  if (!PUBLIC_BASE && STREAM_MODE === 'proxy') {
    log('[boot] 警告：未设置 RENDER_EXTERNAL_URL，proxy 模式返回的 audio_url 可能是 CDN M4A 直链');
  }
  xmlyReady.then(() => log('[boot] 音源层就绪')).catch(() => {});
  const eps = readEndpoints();
  if (!eps.length) {
    log('[boot] 没有有效的接入点地址：请设置 XIAOZHI_MCP_ENDPOINTS（wss:// 开头）');
    publishStatus();
    return;
  }
  eps.forEach((ep, i) => connect(ep, `agent#${i + 1}`));
}

process.on('SIGTERM', () => { stopped = true; process.exit(0); });
process.on('SIGINT', () => { stopped = true; process.exit(0); });

main();
