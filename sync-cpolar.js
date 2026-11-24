#!/usr/bin/env node
// cpolar 地址自动同步：从 cpolar 本地 API 读取当前 http 公网地址，
// 写入 audio_base.txt 供 bridge 运行时读取。地址变化后无需重启 bridge。
//
// cpolar 基于 ngrok 内核，本地 API 通常在 http://127.0.0.1:4040/api/tunnels
// 返回 tunnels[]，每项 public_url 含 http:// 与 https:// 地址。
// 本脚本只取 http://（明文），因为设备对 https 做 TLS 握手会栈溢出。
//
// 用法：
//   node sync-cpolar.js            # 同步一次
//   node sync-cpolar.js --watch    # 每 60 秒检查一次，常驻
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const API = process.env.CPOLAR_API || 'http://127.0.0.1:4040/api/tunnels';
const OUT = process.env.XIMALAYA_AUDIO_BASE_FILE || path.join(__dirname, 'audio_base.txt');
const INTERVAL_MS = Number(process.env.CPOLAR_SYNC_INTERVAL_MS || 60000);
const WATCH = process.argv.includes('--watch');

function log(...a) { console.log(`[${new Date().toLocaleTimeString('zh-CN')}]`, ...a); }

async function syncOnce() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(API, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`API 返回 ${r.status}`);
    const j = await r.json();
    const tunnels = Array.isArray(j.tunnels) ? j.tunnels : [];
    // 只挑 http:// 的公网地址（设备必须走明文）
    const urls = [];
    for (const tun of tunnels) {
      if (tun.public_url && /^http:\/\//i.test(tun.public_url)) urls.push(tun.public_url);
    }
    if (!urls.length) {
      log('未发现 http:// 隧道地址（cpolar 是否在运行？隧道协议是否为 http？）');
      return false;
    }
    // 若有多条，优先选指向 8899 的；否则取第一条
    let chosen = urls[0];
    const hit8899 = urls.find((u) => /:8899\b/.test(u));
    if (hit8899) chosen = hit8899;
    const base = chosen.replace(/\/+$/, '');
    const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim() : '';
    if (prev === base) {
      log('地址未变化:', base);
      return true;
    }
    fs.writeFileSync(OUT, base + '\n', 'utf8');
    log('✓ 已更新 audio_base.txt =', base);
    return true;
  } catch (e) {
    log('同步失败:', e.message, '（API:', API + '）');
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
