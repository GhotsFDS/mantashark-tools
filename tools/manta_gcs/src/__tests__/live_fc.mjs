// 真 FC 端到端 — 用 Tuner 真 TypeScript 代码 (不是 Python 复刻)
// 走 ws 端口 → mavbridge → FC, 复用 src/lib/defaults.ts 的 quantize 函数,
// 验证: pull 50/50 + 量化输出对齐 step + push round-trip 稳定 + dirty 计数对.
//
// 运行: npx tsx src/__tests__/live_fc.mjs   (前提: mavbridge 在 8765 跑)
import WebSocket from 'ws';
import { quantize, paramRange } from '../lib/defaults.ts';

// ── 复刻 NumInput.tsx 的 decimalsFromStep (ceil(-log10) 公式) ──
function decimalsFromStep(step) {
  if (!step || step <= 0) return 0;
  return Math.max(0, Math.min(8, Math.ceil(-Math.log10(step))));
}
function display(key, value) {
  const step = paramRange(key).step ?? 0.01;
  return value.toFixed(decimalsFromStep(step));
}

const FLIGHT_KEYS = [
  'MSK_BPCH_G1','MSK_BPCH_G2','MSK_BPCH_G3',
  'MSK_KS_G1','MSK_KS_G2','MSK_KS_G3',
  'MSK_KDF_G1','MSK_KDF_G2','MSK_KDF_G3',
  'MSK_KT_G1','MSK_KT_G2','MSK_KT_G3',
  'MSK_KRD_G1','MSK_KRD_G2','MSK_KRD_G3',
  'TLT_DFL_G1','TLT_DFL_G2','TLT_DFL_G3',
  'TLT_DFR_G1','TLT_DFR_G2','TLT_DFR_G3',
  'TLT_TL1_G1','TLT_TL1_G2','TLT_TL1_G3',
  'TLT_TR1_G1','TLT_TR1_G2','TLT_TR1_G3',
  'TLT_RDL_G1','TLT_RDL_G2','TLT_RDL_G3',
  'TLT_RDR_G1','TLT_RDR_G2','TLT_RDR_G3',
  'TLT_SGRP_G1','TLT_SGRP_G2','TLT_SGRP_G3',
  'TLT_RATE','MSK_TRIM_RATE',
  'MSK_FB_EN','MSK_FB_P_SC','MSK_FB_R_SC','MSK_FB_V_SC',
  'MSK_KT_LIM','MSK_L2_SGRP_RT','MSK_L2_RD_RT','MSK_K_DRFT_RT',
  'MSK_V_TGT','MSK_V_PI_P','MSK_V_PI_I','MSK_V_PI_D',
];
console.log(`FLIGHT_KEYS = ${FLIGHT_KEYS.length}`);

const ws = new WebSocket('ws://127.0.0.1:8765');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const send = obj => ws.send(JSON.stringify(obj));

let gotHeartbeat = false;
const raw = {};
const onMsgFns = new Set();
ws.on('message', d => {
  let m; try { m = JSON.parse(d.toString()); } catch { return; }
  if (m.type === 'heartbeat') gotHeartbeat = true;
  if (m.type === 'param' && FLIGHT_KEYS.includes(m.name)) raw[m.name] = m.value;
  for (const f of onMsgFns) f(m);
});

await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
console.log('ws connected');

// 等 heartbeat
const t0 = Date.now();
while (!gotHeartbeat && Date.now() - t0 < 8000) await sleep(200);
if (!gotHeartbeat) { console.log('FAIL: no heartbeat'); process.exit(1); }
console.log('heartbeat ok');

// ─── Pull 50 个 ───
console.log('\n=== Pull 50 个 FLIGHT_KEYS ===');
for (const k of FLIGHT_KEYS) { send({ type:'param_read', name: k }); await sleep(50); }
// 等 30s 收齐
const waitT0 = Date.now();
while (Object.keys(raw).length < 50 && Date.now() - waitT0 < 30000) await sleep(100);
const got = Object.keys(raw).length;
const missing = FLIGHT_KEYS.filter(k => !(k in raw));
console.log(`收到 ${got}/50, 缺 ${missing.length}: ${missing.join(',') || '(无)'}`);

// ─── 量化 + 显示验证 (用 Tuner 真 quantize) ───
console.log('\n=== 量化输出 (Tuner 真 src/lib/defaults.ts) ===');
let alignFail = 0;
for (const k of FLIGHT_KEYS) {
  if (!(k in raw)) continue;
  const r = raw[k];
  const q = quantize(k, r);
  const d = display(k, q);
  const step = paramRange(k).step ?? 0.01;
  // 验 quantize 结果是 step 的整数倍 (容差 1e-6)
  const aligned = Math.abs(Math.round(q / step) * step - q) < 1e-6;
  if (!aligned) { alignFail++; console.log(`  ⚠ ALIGN FAIL ${k}: raw=${r} q=${q} step=${step}`); }
}
console.log(`量化对齐验证: ${50 - alignFail}/${50} 对齐 (要求 q 是 step 整数倍)`);

// ─── Push round-trip 5 个 step 的参数 ───
console.log('\n=== Push round-trip (改值 → ack → 再 quantize 应匹配) ===');
const tests = [
  ['MSK_TRIM_RATE',  3.5],
  ['MSK_KT_LIM',     0.95],
  ['MSK_K_DRFT_RT',  0.012],
  ['MSK_V_TGT',      9.5],
  ['TLT_RATE',       30],
];
const originals = {};
let rtPass = 0;
for (const [k, target] of tests) {
  originals[k] = raw[k];
  const ackP = new Promise(res => {
    const fn = m => { if (m.type === 'param' && m.name === k) { onMsgFns.delete(fn); res(m.value); } };
    onMsgFns.add(fn);
    setTimeout(() => { onMsgFns.delete(fn); res(null); }, 3000);
  });
  send({ type:'param_set', name: k, value: target });
  const ack = await ackP;
  if (ack == null) { console.log(`  ${k}: FAIL no ack`); continue; }
  const qTgt = quantize(k, target);
  const qAck = quantize(k, ack);
  const tol = (paramRange(k).step ?? 0.01) * 0.5;
  const ok = Math.abs(qTgt - qAck) < tol;
  console.log(`  ${k}: 推 ${target} → ack ${ack} → quantize ${qAck} 显示 "${display(k, qAck)}"  ${ok ? 'OK' : 'FAIL'}`);
  if (ok) rtPass++;
}
// 还原
for (const [k] of tests) {
  if (originals[k] != null) { send({ type:'param_set', name: k, value: originals[k] }); await sleep(150); }
}

// ─── dirty 计数模拟 (Tuner 真容差逻辑) ───
console.log('\n=== Dirty 计数模拟 (FlightProfile 容差逻辑) ===');
// synced = 收到的 raw 各自 quantize 一次
const synced = {};
for (const k of FLIGHT_KEYS) if (k in raw) synced[k] = quantize(k, raw[k]);
// 模拟 1: 不改值 → dirty 应 0
let dirty1 = 0;
for (const k of FLIGHT_KEYS) {
  if (!(k in raw)) continue;
  const cur = synced[k];           // 用户没动过, store 跟 synced 同
  const snap = synced[k];
  const tol = (paramRange(k).step ?? 0.01) * 0.5;
  if (Math.abs(quantize(k, cur) - quantize(k, snap)) > tol) dirty1++;
}
console.log(`  不改值: dirty=${dirty1} (期望 0)`);

// 模拟 2: 改 1 个 K (MSK_KT_G3 +0.01)
const cur2 = { ...synced };
cur2['MSK_KT_G3'] = (synced['MSK_KT_G3'] ?? 0.85) + 0.01;
let dirty2 = 0;
for (const k of FLIGHT_KEYS) {
  if (!(k in raw)) continue;
  const tol = (paramRange(k).step ?? 0.01) * 0.5;
  if (Math.abs(quantize(k, cur2[k]) - quantize(k, synced[k])) > tol) dirty2++;
}
console.log(`  改 1 个 K +0.01: dirty=${dirty2} (期望 1)`);

// 模拟 3: mavlink float32 noise (raw 直接当 cur, 不 quantize) → 应该不算 dirty
const cur3 = { ...raw };  // 用未量化的原始值 (含 0.4000000059 等 noise)
let dirty3 = 0;
for (const k of FLIGHT_KEYS) {
  if (!(k in raw)) continue;
  const tol = (paramRange(k).step ?? 0.01) * 0.5;
  if (Math.abs(quantize(k, cur3[k]) - quantize(k, synced[k])) > tol) dirty3++;
}
console.log(`  mavlink noise 当 cur (双 quantize 比较): dirty=${dirty3} (期望 0, 验容差不被 noise 误判)`);

console.log('\n=== 总结 ===');
console.log(`Pull          : ${got}/50  ${got === 50 ? 'OK' : 'FAIL'}`);
console.log(`量化对齐      : ${50 - alignFail}/${50}  ${alignFail === 0 ? 'OK' : 'FAIL'}`);
console.log(`Push 5 个     : ${rtPass}/5  ${rtPass === 5 ? 'OK' : 'FAIL'}`);
console.log(`Dirty 不改值  : ${dirty1 === 0 ? 'OK' : 'FAIL ' + dirty1}`);
console.log(`Dirty 改 1 个 : ${dirty2 === 1 ? 'OK' : 'FAIL ' + dirty2}`);
console.log(`Dirty noise   : ${dirty3 === 0 ? 'OK' : 'FAIL ' + dirty3}`);

ws.close();
process.exit(got === 50 && alignFail === 0 && rtPass === 5 && dirty1 === 0 && dirty2 === 1 && dirty3 === 0 ? 0 : 1);
