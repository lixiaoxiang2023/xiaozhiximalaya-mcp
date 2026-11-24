#!/usr/bin/env node
// cpolar 地址自动同步：从 cpolar 客户端的输出日志里读取当前明文 http 公网地址，
// 写入 audio_base.txt 供 bridge 运行时动态读取。地址变化后无需重启 bridge。
//
// 为什么读日志而不是 API：
//   cpolar 3.x 的本地 inspect/dashboard（4040/9200）不提供 ngrok 风格的
//   /api/tunnels JSON；唯一稳定来源是启动时的
//   `Tunnel established at http://xxxx.r2.cpolar.cn` 日志行。
//   因此启动脚本用 `cpolar ... > cpolar-out.txt 2>&1` 把输出重定向到文件，
//   本脚本 grep 该文件即可。
//   只取 http://（明文）——设备对 https 做 TLS 握手会栈溢出崩溃。
//
// 用法：
//   node sync-cpolar.js            # 同步一次
//   node sync-cpolar.js --watch    # 每 30 秒检查一次，常驻
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOG = process.env.CPOLAR_LOG_FILE || path.join(__dirname, 'cpolar-out.txt');
const OUT = process.env.XIMALAYA_AUDIO_BASE_FILE || path.join(__dirname, 'audio_base.txt');
const INTERVAL_MS = Number(process.env.CPOLAR_SYNC_INTERVAL_MS || 30000);
const WATCH = process.argv.includes('--watch');

function log(...a) { console.log(`[${new Date().toLocaleTimeString('zh-CN')}]`, ...a); }

// 从日志文本里提取所有明文 http 公网地址，取最后一个（最新建立的隧道）。
function extractPublicHttp(text) {
  const re = /Tunnel established at (http:\/\/[^\s"']+)/gi;
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  // 兼容不同版本措辞：直接出现的 http://xxx.cpolar.cn
  if (!last) {
    const re2 = /(http:\/\/[a-z0-9-]+\.r\d+\.cpolar\.(?:cn|com))/gi;
    while ((m = re2.exec(text)) !== null) last = m[1];
  }
  return last ? last.replace(/\/+$/, '') : null;
}

function syncOnce() {
  try {
    if (!fs.existsSync(LOG)) {
      log(`未找到 cpolar 日志 ${LOG}（启动脚本应把 cpolar 输出重定向到该文件）`);
      return false;
    }
    const base = extractPublicHttp(fs.readFileSync(LOG, 'utf8'));
    if (!base) {
      log('日志里还没有明文 http 地址（隧道可能正在建立，稍后重试）');
      return false;
    }
    if (!/^http:\/\//i.test(base)) {
      log('提取到的不是明文 http 地址，忽略:', base);
      return false;
    }
    const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim() : '';
    if (prev === base) {
      log('地址未变化:', base);
      return true;
    }
    fs.writeFileSync(OUT, base + '\n', 'utf8');
    log('✓ 已更新 audio_base.txt =', base);
    return true;
  } catch (e) {
    log('同步失败:', e.message, '（日志:', LOG + '）');
    return false;
  }
}

(async () => {
  await syncOnce();
  if (WATCH) {
    log(`常驻模式：每 ${INTERVAL_MS / 1000} 秒检查一次地址变化`);
    setInterval(syncOnce, INTERVAL_MS);
  }
})();
