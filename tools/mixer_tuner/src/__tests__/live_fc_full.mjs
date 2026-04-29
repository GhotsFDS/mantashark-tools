// 真 FC 全量同步测试 — 用 Tuner 真代码 (DEFAULT_PARAMS + SYNC_SKIP_RE) 拉所有 86 个
import WebSocket from 'ws';
import { DEFAULT_PARAMS, SYNC_SKIP_RE, quantize, paramRange } from '../lib/defaults.ts';

const SYNC_KEYS = Object.keys(DEFAULT_PARAMS).filter(k => !SYNC_SKIP_RE.test(k));
console.log(`SYNC_KEYS = ${SYNC_KEYS.length} (跳 ${Object.keys(DEFAULT_PARAMS).length - SYNC_KEYS.length} 个)`);

const ws = new WebSocket('ws://127.0.0.1:8765');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const send = obj => ws.send(JSON.stringify(obj));

let gotHB = false;
const raw = {};
ws.on('message', d => {
  const m = JSON.parse(d.toString());
  if (m.type === 'heartbeat') gotHB = true;
  if (m.type === 'param' && SYNC_KEYS.includes(m.name)) raw[m.name] = m.value;
});

await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
const t0 = Date.now();
while (!gotHB && Date.now() - t0 < 8000) await sleep(200);
if (!gotHB) { console.log('FAIL: no heartbeat'); process.exit(1); }

console.log('\n=== Pull 全量 ===');
for (const k of SYNC_KEYS) { send({ type:'param_read', name: k }); await sleep(50); }

const wt0 = Date.now();
while (Object.keys(raw).length < SYNC_KEYS.length && Date.now() - wt0 < 30000) await sleep(100);

const got = Object.keys(raw).length;
const missing = SYNC_KEYS.filter(k => !(k in raw));
console.log(`收到 ${got}/${SYNC_KEYS.length}, 缺 ${missing.length}`);
if (missing.length) console.log(`缺失: ${missing.join(', ')}`);

// 量化对齐验
let alignFail = 0;
for (const k of SYNC_KEYS) {
  if (!(k in raw)) continue;
  const q = quantize(k, raw[k]);
  const step = paramRange(k).step ?? 0.01;
  if (Math.abs(Math.round(q / step) * step - q) > 1e-6) {
    alignFail++;
    console.log(`⚠ ALIGN ${k}: raw=${raw[k]} q=${q} step=${step}`);
  }
}
console.log(`量化对齐: ${got - alignFail}/${got}`);

ws.close();
process.exit(missing.length === 0 && alignFail === 0 ? 0 : (missing.length ? 2 : 3));
