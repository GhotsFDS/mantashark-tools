// v9 P2 飞行配置 tab — 3 档 G1/G2/G3 调参 (4 K + 7 倾转 + 平滑速率)
// **不实时推送 FC** — 飞行参数效果不可见 (K/PID/base_pitch), 必须显式 "保存" 才下发.
// 舵机标定 (Tilts) 是另一回事: 那里转动可见, 才允许实时推.
import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/useStore';
import { gcs } from '../../lib/gcs';
import { NumInput } from '../common/NumInput';
import { paramRange, quantize } from '../../lib/defaults';
import { Download, Upload } from 'lucide-react';

const GEARS = ['G1', 'G2', 'G3'] as const;
type Gear = typeof GEARS[number];

const GEAR_LABELS: Record<Gear, string> = {
  G1: '慢滑 (远程返航/对准)',
  G2: '抬头建气垫 (静止/<2 m/s)',
  G3: '巡航 (≥9 m/s)',
};
const GEAR_BPCH_KEY: Record<Gear, string> = { G1: 'MSK_BPCH_G1', G2: 'MSK_BPCH_G2', G3: 'MSK_BPCH_G3' };
const GEAR_DESC: Record<Gear, string> = {
  G1: '浮筒承重 + KT 慢推. 油门 stick 直通基线.',
  G2: 'KS+KDF 抬头, RD 反向上吹 (>90°) 抬头, 静态建气垫. 油门直通.',
  G3: 'KT 主推 + 地效托底, RD 满下吹低头 (<90°). G3 速度环 P3 加.',
};

const K_GROUPS = ['KS', 'KDF', 'KT', 'KRD'] as const;
type KGroup = typeof K_GROUPS[number];
const K_LABELS: Record<KGroup, string> = {
  KS:  'KS — S 斜吹 (主升力+前推, 4 EDF)',
  KDF: 'KDF — DF 前下吹 (升力辅+pitch快响应, 2 EDF)',
  KT:  'KT — T 后推 (前推主, 4 EDF)',
  KRD: 'KRD — RD 后斜 (pitch 主源, 2 EDF)',
};

const TILT_IDS = ['DFL', 'DFR', 'TL1', 'TR1', 'RDL', 'RDR', 'SGRP'] as const;
type TiltId = typeof TILT_IDS[number];
const TILT_LABELS: Record<TiltId, string> = {
  DFL: 'DFL — 左前下吹 (0..75°)',
  DFR: 'DFR — 右前下吹 (0..75°)',
  TL1: 'TL1 — 左 T1 roll 主 (90..135°)',
  TR1: 'TR1 — 右 T1 roll 主 (90..135°)',
  RDL: 'RDL — 左后斜 (0..135°)',
  RDR: 'RDR — 右后斜 (0..135°)',
  SGRP:'SGRP — S 组中央 (0..75°)',
};

// 本 tab 管理的所有 FC 参数 key (Pull/Save 范围)
const FLIGHT_KEYS: string[] = [
  // 3 档 base_pitch
  'MSK_BPCH_G1','MSK_BPCH_G2','MSK_BPCH_G3',
  // 12 K (KS/KDF/KT/KRD × G1/G2/G3)
  'MSK_KS_G1','MSK_KS_G2','MSK_KS_G3',
  'MSK_KDF_G1','MSK_KDF_G2','MSK_KDF_G3',
  'MSK_KT_G1','MSK_KT_G2','MSK_KT_G3',
  'MSK_KRD_G1','MSK_KRD_G2','MSK_KRD_G3',
  // 21 倾转 (7 路 × 3 档)
  'TLT_DFL_G1','TLT_DFL_G2','TLT_DFL_G3',
  'TLT_DFR_G1','TLT_DFR_G2','TLT_DFR_G3',
  'TLT_TL1_G1','TLT_TL1_G2','TLT_TL1_G3',
  'TLT_TR1_G1','TLT_TR1_G2','TLT_TR1_G3',
  'TLT_RDL_G1','TLT_RDL_G2','TLT_RDL_G3',
  'TLT_RDR_G1','TLT_RDR_G2','TLT_RDR_G3',
  'TLT_SGRP_G1','TLT_SGRP_G2','TLT_SGRP_G3',
  // 全局过渡速率 (兼容老 TLT_RATE 兜底, 推荐用 4 路分组 rate)
  'TLT_RATE','MSK_TRIM_RATE',
  // v9 P4 tilt 带宽分级 (DF 快 / S 慢 / T+RD 中)
  'MSK_TLT_R_DF','MSK_TLT_R_S','MSK_TLT_R_T','MSK_TLT_R_RD',
  // ATC tilt 反馈 + 死区 (P4 摸黑加 deadband)
  'MSK_FB_EN','MSK_FB_P_SC','MSK_FB_R_SC','MSK_FB_V_SC',
  'MSK_FB_R_DEAD','MSK_FB_P_DEAD',
  // 三层级加速 + drift 学习
  'MSK_KT_LIM','MSK_L2_SGRP_RT','MSK_L2_RD_RT','MSK_K_DRFT_RT',
  'MSK_TLT_DRFT_R','MSK_TLT_DRFT_M',
  // G3 速度 PID
  'MSK_V_TGT','MSK_V_PI_P','MSK_V_PI_I','MSK_V_PI_D',
  // v9 P4 vmix 速度连续混合 (P4 默认开)
  'MSK_VMIX_EN','MSK_VMIX_TAU','MSK_VMIX_LO','MSK_VMIX_MID','MSK_VMIX_HI',
  // v9 P4 实战 GROUP_BOOST (G3 PID 加速 demand 在 4 组分配权重)
  'MSK_BST_KS','MSK_BST_KDF','MSK_BST_KT','MSK_BST_KRD',
  // v9 P4 实战 G3 速度控制 (设计 X): ch10 旋钮 + 加速度命令
  'MSK_V_MIN','MSK_V_MAX','MSK_V_DRIVE_MIN','MSK_V_ACC_MAX','MSK_V_DEADZONE',
  // v9 P4 修关键: DF tilt ATC 系数 + Layer 2 emergency 阈值
  'MSK_FB_P_SC_DF','MSK_P_EMRG_DEG',
  // v9 P4 暴露之前硬编码 (Layer 阈值/积分/ramp/drift)
  'MSK_BST_SAT_HI','MSK_BST_SAT_LO','MSK_V_INT_LIM','MSK_G3_RAMP_MS','MSK_DRFT_TIME',
  // v9 P4 副表 MSK2_ (drift 学率 + dead zone + ramp)
  'MSK2_DRFT_DZ','MSK2_DRFT_KS_R','MSK2_DRFT_KDF_R','MSK2_DRFT_KT_R','MSK2_DRFT_KRD_R','MSK2_KRAMP_MS',
];

export function FlightProfile() {
  const { params, setParam } = useStore();
  // 仅写本地 store, 不推 FC (用户必须按 "保存" 才下发)
  const setLocal = (k: string, v: number) => setParam(k, v);

  // ─── 同步状态: 最近一次 pull/push 后的快照 → 计算 dirty ───
  const [synced, setSynced] = useState<Record<string, number>>(() => {
    const s: Record<string, number> = {};
    for (const k of FLIGHT_KEYS) if (k in params) s[k] = params[k];
    return s;
  });
  const [busy, setBusy] = useState<'idle' | 'pulling' | 'pushing'>('idle');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // 计算 dirty (本地值 ≠ 最近 synced 值)
  // 容差 = quantize step / 2: 量化粒度内不算 dirty, 否则 mavlink float32 round-trip 误差会误判
  const dirtyKeys = useMemo(() => {
    const d: string[] = [];
    for (const k of FLIGHT_KEYS) {
      const cur = params[k];
      const snap = synced[k];
      if (cur == null) continue;
      const step = paramRange(k).step ?? 0.01;
      const tol = step * 0.5;
      // 双重量化保证比较干净 (mavlink → 7 位浮点 → 量化后比较)
      if (snap == null || Math.abs(quantize(k, cur) - quantize(k, snap)) > tol) d.push(k);
    }
    return d;
  }, [params, synced]);

  // 连接到 FC 后 1.5s (等 App-level autoSync 落 store) 重置 synced 快照, 让 dirty=0
  useEffect(() => {
    if (!gcs.isConnected()) return;
    const t = setTimeout(() => {
      const s: Record<string, number> = {};
      for (const k of FLIGHT_KEYS) if (k in params) s[k] = params[k];
      setSynced(s);
    }, 1500);
    return () => clearTimeout(t);
    // 仅在挂载/参数表 keys 数量变化时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPull = async () => {
    if (busy !== 'idle') return;
    if (!gcs.isConnected()) { setStatusMsg('⚠ 未连接 FC'); setTimeout(() => setStatusMsg(null), 3000); return; }
    setBusy('pulling');
    setStatusMsg(`拉取 0/${FLIGHT_KEYS.length}`);
    const r = await gcs.pullParams(FLIGHT_KEYS, (g, t) => setStatusMsg(`拉取 ${g}/${t}`));
    // pull 完成后 store 已被 App-level listener 更新, 等 100ms 用 zustand 读最新 params (绕开闭包 stale)
    setTimeout(() => {
      const fresh = useStore.getState().params;
      const s: Record<string, number> = {};
      for (const k of FLIGHT_KEYS) if (k in fresh) s[k] = fresh[k];
      setSynced(s);
    }, 100);
    setStatusMsg(r.timedOut
      ? `⚠ 拉取超时 ${r.got}/${FLIGHT_KEYS.length}, 缺 ${r.missing.length}`
      : `✓ 已拉取 ${r.got} 个参数`);
    setBusy('idle');
    setTimeout(() => setStatusMsg(null), 4000);
  };

  const onSave = async () => {
    if (busy !== 'idle') return;
    if (!gcs.isConnected()) { setStatusMsg('⚠ 未连接 FC'); setTimeout(() => setStatusMsg(null), 3000); return; }
    if (dirtyKeys.length === 0) { setStatusMsg('已是最新, 无需保存'); setTimeout(() => setStatusMsg(null), 2500); return; }
    setBusy('pushing');
    const map: Record<string, number> = {};
    // 推送前再量化一次, 防 0.30000004 这种 IEEE 噪声进数传
    for (const k of dirtyKeys) map[k] = quantize(k, params[k]);
    setStatusMsg(`保存 0/${dirtyKeys.length}`);
    const r = await gcs.pushParams(map, (a, t) => setStatusMsg(`保存 ${a}/${t}`));
    // 推送 ack 的部分写入 synced
    setSynced(prev => {
      const next = { ...prev };
      for (const k of dirtyKeys) {
        if (!r.missing.includes(k)) next[k] = params[k];
      }
      return next;
    });
    setStatusMsg(r.timedOut
      ? `⚠ 保存超时 ${r.acked}/${dirtyKeys.length}, 缺 ${r.missing.length}`
      : `✓ 已保存 ${r.acked} 个参数`);
    setBusy('idle');
    setTimeout(() => setStatusMsg(null), 4000);
  };

  return (
    <div className="space-y-3">
      {/* Pull / Save toolbar (无实时推, 用户显式保存才下发) */}
      <div className="card flex items-center gap-3 py-2">
        <span className="card-title mb-0 flex-1">飞行配置同步</span>
        <span className={
          'val-mono text-[11px] ' +
          (dirtyKeys.length > 0 ? 'text-warn' : 'text-fg-dim')
        }>
          {dirtyKeys.length > 0 ? `未保存 ${dirtyKeys.length} 项` : '与 FC 一致'}
        </span>
        {statusMsg && <span className="val-mono text-[11px] text-accent">{statusMsg}</span>}
        <button
          onClick={onPull}
          disabled={busy !== 'idle'}
          className="btn flex items-center gap-1.5 disabled:opacity-50"
          title="从飞控读取 50 个飞行参数, 覆盖本地 (放弃未保存修改)"
        >
          <Download size={12} />
          拉取 ({FLIGHT_KEYS.length})
        </button>
        <button
          onClick={onSave}
          disabled={busy !== 'idle' || dirtyKeys.length === 0}
          className={'btn flex items-center gap-1.5 disabled:opacity-50 ' + (dirtyKeys.length > 0 ? 'btn-primary' : '')}
          title="把本地修改下发到飞控 (仅推送已修改项)"
        >
          <Upload size={12} />
          保存 ({dirtyKeys.length})
        </button>
      </div>

      {/* 拉取/保存中禁用所有输入, 防中途改值污染 dirty 集合 / 推送一致性 */}
      <fieldset disabled={busy !== 'idle'} className={'space-y-3 ' + (busy !== 'idle' ? 'opacity-60 pointer-events-none' : '')}>

      {/* 3 档摘要 */}
      <div className="card">
        <div className="card-title">v9 P2 — 3 档飞行配置 (ch7 切档)</div>
        <div className="grid grid-cols-3 gap-3">
          {GEARS.map(g => (
            <div key={g} className="bg-panel-2 p-3 rounded">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-accent text-[14px]">{g}</span>
                <span className="text-[10px] text-fg-dim">{GEAR_LABELS[g]}</span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px]">
                <span className="text-fg-dim">base_pitch</span>
                <NumInput value={params[GEAR_BPCH_KEY[g]] ?? 0} min={0} max={20} step={0.5}
                          onCommit={v => setLocal(GEAR_BPCH_KEY[g], v)}
                          className="input val-mono text-accent text-[14px] w-16 px-1.5 py-0.5" />
                <span className="text-fg-dim text-[10px]">°</span>
              </div>
              <div className="mt-1 text-[9px] text-fg-mute leading-snug">{GEAR_DESC[g]}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[9px] text-fg-mute">
          ch7 PWM &lt;1300 = G1, 1300-1700 = G2, &gt;1700 = G3.
          切档时 K 表 + 倾转 + Q_TRIM_PITCH(base_pitch) 同步阶跃.
          倾转走 rate-limit 平滑 (TLT_RATE 默认 30°/s).
        </div>
      </div>

      {/* K 表 4 × 3 */}
      <div className="card">
        <div className="card-title">K 油门系数 — motor[i] = throttle × K_group × thr_cap</div>
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left py-1.5 pr-2 text-fg-dim w-2/5">分组</th>
              {GEARS.map(g => (
                <th key={g} className="text-center py-1.5 px-1 text-accent">{g}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {K_GROUPS.map(k => (
              <tr key={k} className="border-b border-line/30">
                <td className="py-1.5 pr-2 text-fg-mute">{K_LABELS[k]}</td>
                {GEARS.map(g => {
                  const key = `MSK_${k}_${g}`;
                  const val = params[key] ?? 0;
                  return (
                    <td key={g} className="px-1 py-1">
                      <NumInput value={val} min={0} max={1} step={0.01}
                                onCommit={v => setLocal(key, v)}
                                className="input val-mono text-center w-full" />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 倾转 7 × 3 */}
      <div className="card">
        <div className="card-title">倾转目标 abs° — mode 切档 rate-limited 平滑到目标</div>
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left py-1.5 pr-2 text-fg-dim w-2/5">舵机</th>
              {GEARS.map(g => (
                <th key={g} className="text-center py-1.5 px-1 text-accent">{g}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TILT_IDS.map(t => (
              <tr key={t} className="border-b border-line/30">
                <td className="py-1.5 pr-2 text-fg-mute">{TILT_LABELS[t]}</td>
                {GEARS.map(g => {
                  const key = `TLT_${t}_${g}`;
                  const val = params[key] ?? 45;
                  return (
                    <td key={g} className="px-1 py-1">
                      <NumInput value={val} min={0} max={180} step={1}
                                onCommit={v => setLocal(key, v)}
                                className="input val-mono text-center w-full" />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 text-[9px] text-fg-mute leading-snug">
          约定: 0° = 推力 −Y 沿机身正下 / 45° = 中立 (PWM ZERO) /
          90° = +X 沿机身正前 / &gt;90° = 进 +Y 上半象限 (反向力矩).
          软限位 (LMIN/LMAX) 在舵机标定 tab 单独设, 这里输入超出会被 clamp.
        </div>
      </div>

      {/* 全局 */}
      <div className="card">
        <div className="card-title">全局 (切档过渡)</div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="label mb-1">tilt 平滑速率 (TLT_RATE)</div>
            <div className="flex items-center gap-2">
              <NumInput value={params.TLT_RATE ?? 30} min={5} max={90} step={1}
                        onCommit={v => setLocal('TLT_RATE', v)}
                        className="input val-mono w-24" />
              <span className="text-[10px] text-fg-dim">°/s</span>
            </div>
            <div className="text-[9px] text-fg-mute mt-1">
              tilt 切档 rate (30 = 1.5s 完成 45° 过渡)
            </div>
          </div>
          <div>
            <div className="label mb-1">base_pitch ramp (TRIM_RATE)</div>
            <div className="flex items-center gap-2">
              <NumInput value={params.MSK_TRIM_RATE ?? 3.0} min={0} max={30} step={0.5}
                        onCommit={v => setLocal('MSK_TRIM_RATE', v)}
                        className="input val-mono w-24" />
              <span className="text-[10px] text-fg-dim">°/s</span>
            </div>
            <div className="text-[9px] text-fg-mute mt-1">
              Q_TRIM_PITCH 切档过渡 (3 = 6° 用 2s, 0=阶跃). 防 ATC I 饱和
            </div>
          </div>
        </div>
      </div>

      {/* v9 P3.2/P3.4 tilt ATC + V 反馈 */}
      <div className="card">
        <div className="card-title">tilt ATC 反馈 (50Hz, G1/G2/G3 三档全开; Layer≥2 时仅 T1+DF)</div>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <div className="label mb-1">启用 (FB_EN)</div>
            <div className="flex">
              <button
                onClick={() => setLocal('MSK_FB_EN', (params.MSK_FB_EN ?? 1) >= 0.5 ? 0 : 1)}
                className={'btn flex-1 ' + ((params.MSK_FB_EN ?? 1) >= 0.5 ? 'btn-primary' : '')}
              >{(params.MSK_FB_EN ?? 1) >= 0.5 ? 'ON' : 'OFF'}</button>
            </div>
            <div className="text-[9px] text-fg-mute mt-1">
              motors:get_pitch/roll/V → bias SGRP/RD/T1
            </div>
          </div>
          <div>
            <div className="label mb-1">Pitch scale (P_SC)</div>
            <NumInput value={params.MSK_FB_P_SC ?? 5} min={0} max={100} step={0.5}
                      onCommit={v => setLocal('MSK_FB_P_SC', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">SGRP+RD pitch 反馈 °/unit (飞行 50)</div>
          </div>
          <div>
            <div className="label mb-1">DF Pitch scale (P_SC_DF)</div>
            <NumInput value={params.MSK_FB_P_SC_DF ?? 75} min={0} max={200} step={1}
                      onCommit={v => setLocal('MSK_FB_P_SC_DF', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">DF 优先 1.5× P_SC (主抬头)</div>
          </div>
          <div>
            <div className="label mb-1">Emergency thresh (°)</div>
            <NumInput value={params.MSK_P_EMRG_DEG ?? 1.5} min={0.1} max={10} step={0.1}
                      onCommit={v => setLocal('MSK_P_EMRG_DEG', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">pitch 偏 target ≥ 这值 ATC 抢 S/RD</div>
          </div>
          <div>
            <div className="label mb-1">Roll scale (R_SC)</div>
            <NumInput value={params.MSK_FB_R_SC ?? 5} min={0} max={30} step={0.5}
                      onCommit={v => setLocal('MSK_FB_R_SC', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">TL1/TR1 roll 反馈 °/unit</div>
          </div>
          <div>
            <div className="label mb-1">RD V scale (V_SC)</div>
            <NumInput value={params.MSK_FB_V_SC ?? 8} min={0} max={30} step={0.5}
                      onCommit={v => setLocal('MSK_FB_V_SC', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">G3+稳态 °/m/s err</div>
          </div>
        </div>
        <div className="mt-2 text-[9px] text-fg-mute leading-snug">
          <b>速度协同</b>: T 组 (KT throttle) + S/RD (倾转) 协同, DF 不参与 (主姿态).
          <b>RD 双职责</b>: |pitch_in|&gt;0.2 → pitch ATC 反馈; ≤0.2 + G3 → V 反馈助推
          (慢→朝 90° max +75° / 快→朝默认 15°).
          <b>SGRP</b>: 仅 pitch 反馈 (避免撞 0-75 软限). <b>TL1/TR1</b>: 仅 roll.
          <b>G2→G3 跃迁</b> PI correction 1.5s ramp 防全推冲.
        </div>
      </div>

      {/* v9 P3.5/P3.6 三层级加速参数 */}
      <div className="card">
        <div className="card-title">G3 三层级加速 (KT → 倾转改平 → 加力)</div>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <div className="label mb-1">KT 撞限阈值 (KT_LIM)</div>
            <NumInput value={params.MSK_KT_LIM ?? 1.0} min={0.5} max={1.0} step={0.01}
                      onCommit={v => setLocal('MSK_KT_LIM', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">Layer 1→2 转换 (迟滞 0.95×)</div>
          </div>
          <div>
            <div className="label mb-1">SGRP rate (°/s)</div>
            <NumInput value={params.MSK_L2_SGRP_RT ?? 5.0} min={0.5} max={30} step={0.5}
                      onCommit={v => setLocal('MSK_L2_SGRP_RT', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">Layer 2 SGRP 改平</div>
          </div>
          <div>
            <div className="label mb-1">RD rate (°/s)</div>
            <NumInput value={params.MSK_L2_RD_RT ?? 3.0} min={0.5} max={30} step={0.5}
                      onCommit={v => setLocal('MSK_L2_RD_RT', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">Layer 2 RDL/RDR 改平</div>
          </div>
          <div>
            <div className="label mb-1">K_drift rate (/s, P3.7)</div>
            <NumInput value={params.MSK_K_DRFT_RT ?? 0.0} min={0} max={0.1} step={0.001}
                      onCommit={v => setLocal('MSK_K_DRFT_RT', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">0=关, 0.005-0.02=学习</div>
          </div>
        </div>
        <div className="grid grid-cols-5 gap-3 mt-3">
          <div>
            <div className="label mb-1">BST_SAT_HI</div>
            <NumInput value={params.MSK_BST_SAT_HI ?? 0.95} min={0.5} max={1.0} step={0.01}
                      onCommit={v => setLocal('MSK_BST_SAT_HI', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">Layer 1→2 进入</div>
          </div>
          <div>
            <div className="label mb-1">BST_SAT_LO</div>
            <NumInput value={params.MSK_BST_SAT_LO ?? 0.85} min={0.5} max={1.0} step={0.01}
                      onCommit={v => setLocal('MSK_BST_SAT_LO', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">退出 hysteresis</div>
          </div>
          <div>
            <div className="label mb-1">V_INT_LIM</div>
            <NumInput value={params.MSK_V_INT_LIM ?? 10} min={1} max={50} step={0.5}
                      onCommit={v => setLocal('MSK_V_INT_LIM', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">PID I 项 cap</div>
          </div>
          <div>
            <div className="label mb-1">G3_RAMP_MS</div>
            <NumInput value={params.MSK_G3_RAMP_MS ?? 1500} min={0} max={5000} step={100}
                      onCommit={v => setLocal('MSK_G3_RAMP_MS', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">G2→G3 ramp ms</div>
          </div>
          <div>
            <div className="label mb-1">DRFT_TIME (s)</div>
            <NumInput value={params.MSK_DRFT_TIME ?? 5} min={0.5} max={30} step={0.5}
                      onCommit={v => setLocal('MSK_DRFT_TIME', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">drift 学习触发持续 s</div>
          </div>
        </div>
        <div className="mt-2 text-[9px] text-fg-mute leading-snug">
          <b>Layer 1</b>: boost &lt; SAT_HI, mixer 加法 (KS/KT/KRD 按 BST 比例). <b>Layer 2</b>: boost ≥ SAT_HI, _l2_offset 朝 90° 改平 SGRP/RDL/RDR.
          <b>Layer 3</b>: 倾转撞机械限位 = 飞机能力极限, 仅 STATUSTEXT 警告.
          <b>Emergency 阈值</b>: pitch 偏 target ≥ P_EMRG_DEG 时让 Layer 2 退回 Layer 1 (姿态优先).
          <b>K_drift</b>: pitch_in 出死区持续 DRFT_TIME 秒 → 慢加 K_drift (lua 内部, 不写 EEPROM).
        </div>
      </div>

      {/* v9 P4 副表 MSK2_ — drift 学率因子 + dead zone + K ramp */}
      <div className="card">
        <div className="card-title">drift 学习参数 (MSK2_ 副表)</div>
        <div className="grid grid-cols-6 gap-3">
          <div>
            <div className="label mb-1">DRFT_DZ</div>
            <NumInput value={params.MSK2_DRFT_DZ ?? 0.2} min={0} max={1} step={0.01}
                      onCommit={v => setLocal('MSK2_DRFT_DZ', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">pitch_in 死区</div>
          </div>
          <div>
            <div className="label mb-1">DRFT_KS_R</div>
            <NumInput value={params.MSK2_DRFT_KS_R ?? 1.0} min={0} max={2} step={0.05}
                      onCommit={v => setLocal('MSK2_DRFT_KS_R', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">KS 学率因子</div>
          </div>
          <div>
            <div className="label mb-1">DRFT_KDF_R</div>
            <NumInput value={params.MSK2_DRFT_KDF_R ?? 0.5} min={0} max={2} step={0.05}
                      onCommit={v => setLocal('MSK2_DRFT_KDF_R', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">KDF 学率因子</div>
          </div>
          <div>
            <div className="label mb-1">DRFT_KT_R</div>
            <NumInput value={params.MSK2_DRFT_KT_R ?? 0.3} min={0} max={2} step={0.05}
                      onCommit={v => setLocal('MSK2_DRFT_KT_R', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">KT 学率因子</div>
          </div>
          <div>
            <div className="label mb-1">DRFT_KRD_R</div>
            <NumInput value={params.MSK2_DRFT_KRD_R ?? 0.0} min={0} max={2} step={0.05}
                      onCommit={v => setLocal('MSK2_DRFT_KRD_R', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">KRD 反向学率 (默认 0)</div>
          </div>
          <div>
            <div className="label mb-1">KRAMP_MS</div>
            <NumInput value={params.MSK2_KRAMP_MS ?? 1000} min={0} max={5000} step={50}
                      onCommit={v => setLocal('MSK2_KRAMP_MS', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">vmix=0 K ramp ms</div>
          </div>
        </div>
        <div className="mt-2 text-[9px] text-fg-mute leading-snug">
          <b>因子物理</b>: KS 主升力 → 1.0 (全速学); KDF 主姿态 → 0.5 (半速); KT 跟 G3 boost 撞 → 0.3 (抑); KRD 后部斜下吹 sign 反向 → 0.0 默认关 (打开 = 飞行员看 LOG 确定 KRD 不跟 boost 撞后改 0.5).
          <b>KRAMP_MS</b> 仅 vmix=0 (P3.10 离散三档) 切档用; vmix=1 (P4 默认) 走 set_alpha 连续插值, 不触发.
        </div>
      </div>

      {/* v9 P4 实战 GROUP_BOOST + V_TGT 范围 */}
      <div className="card">
        <div className="card-title">G3 加速分配 (GROUP_BOOST) + 油门杆=V_TGT 范围</div>
        <div className="grid grid-cols-6 gap-3">
          <div>
            <div className="label mb-1">BST_KS</div>
            <NumInput value={params.MSK_BST_KS ?? 0.5} min={0} max={1} step={0.01}
                      onCommit={v => setLocal('MSK_BST_KS', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">S 副推力比例</div>
          </div>
          <div>
            <div className="label mb-1">BST_KDF</div>
            <NumInput value={params.MSK_BST_KDF ?? 0.0} min={0} max={1} step={0.01}
                      onCommit={v => setLocal('MSK_BST_KDF', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">DF (建议 0, 主姿态)</div>
          </div>
          <div>
            <div className="label mb-1">BST_KT</div>
            <NumInput value={params.MSK_BST_KT ?? 1.0} min={0} max={1} step={0.01}
                      onCommit={v => setLocal('MSK_BST_KT', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">T 主推 (建议 1.0)</div>
          </div>
          <div>
            <div className="label mb-1">BST_KRD</div>
            <NumInput value={params.MSK_BST_KRD ?? 0.5} min={0} max={1} step={0.01}
                      onCommit={v => setLocal('MSK_BST_KRD', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">RD 副推+尾控</div>
          </div>
        </div>
        <div className="mt-2 text-[9px] text-fg-mute leading-snug">
          <b>GROUP_BOOST</b>: G3 PID 速度 demand 在 4 组分配权重. K = (K_base + drift + boost × BST_K) × cap.
        </div>
      </div>

      {/* v9 P4 实战 设计 X: G3 速度控制 ch10 旋钮 */}
      <div className="card">
        <div className="card-title">G3 速度控制 (设计 X) — ch10 旋钮命令加速度, ch3 lua 锁满</div>
        <div className="grid grid-cols-5 gap-3">
          <div>
            <div className="label mb-1">V_MIN (m/s)</div>
            <NumInput value={params.MSK_V_MIN ?? 5.0} min={0} max={30} step={0.1}
                      onCommit={v => setLocal('MSK_V_MIN', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">V_TGT 下限</div>
          </div>
          <div>
            <div className="label mb-1">V_MAX (m/s)</div>
            <NumInput value={params.MSK_V_MAX ?? 14.0} min={0} max={30} step={0.1}
                      onCommit={v => setLocal('MSK_V_MAX', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">V_TGT 上限</div>
          </div>
          <div>
            <div className="label mb-1">V_DRIVE_MIN</div>
            <NumInput value={params.MSK_V_DRIVE_MIN ?? 9.0} min={0} max={30} step={0.1}
                      onCommit={v => setLocal('MSK_V_DRIVE_MIN', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">G3 入档兜底 (破驼峰)</div>
          </div>
          <div>
            <div className="label mb-1">V_ACC_MAX (m/s²)</div>
            <NumInput value={params.MSK_V_ACC_MAX ?? 2.0} min={0} max={10} step={0.1}
                      onCommit={v => setLocal('MSK_V_ACC_MAX', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">ch10 满杆加速度</div>
          </div>
          <div>
            <div className="label mb-1">V_DEADZONE (PWM)</div>
            <NumInput value={params.MSK_V_DEADZONE ?? 50} min={0} max={200} step={1}
                      onCommit={v => setLocal('MSK_V_DEADZONE', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">ch10 中位死区 (维持)</div>
          </div>
        </div>
        <div className="mt-2 text-[9px] text-fg-mute leading-snug">
          <b>设计 X</b>: G3 进入瞬间 V_TGT_init = max(V_actual, V_DRIVE_MIN). 之后 ch10 旋钮:
          中位 ±DEADZONE → V_TGT 维持; 出杆 → V_TGT 累加 ±ACC_MAX m/s². ch3 lua 强制 override 1900,
          ATC throttle 锁满, motor PWM 完全由 K (含 PID boost) 决定. <b>一个杆一件事</b>, 不冲突.
        </div>
      </div>

      {/* v9 P4 vmix */}
      <div className="card">
        <div className="card-title">vmix 速度连续混合 (P4 默认)</div>
        <div className="grid grid-cols-5 gap-3">
          <div>
            <div className="label mb-1">VMIX_EN</div>
            <NumInput value={params.MSK_VMIX_EN ?? 1} min={0} max={1} step={1}
                      onCommit={v => setLocal('MSK_VMIX_EN', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">1=连续 0=离散三档</div>
          </div>
          <div>
            <div className="label mb-1">VMIX_TAU (s)</div>
            <NumInput value={params.MSK_VMIX_TAU ?? 0.5} min={0.05} max={5} step={0.05}
                      onCommit={v => setLocal('MSK_VMIX_TAU', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">V LPF 时间常数</div>
          </div>
          <div>
            <div className="label mb-1">VMIX_LO (m/s)</div>
            <NumInput value={params.MSK_VMIX_LO ?? 3.0} min={0} max={30} step={0.1}
                      onCommit={v => setLocal('MSK_VMIX_LO', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">V&lt;LO → α=0 (G1)</div>
          </div>
          <div>
            <div className="label mb-1">VMIX_MID (m/s)</div>
            <NumInput value={params.MSK_VMIX_MID ?? 6.5} min={0} max={30} step={0.1}
                      onCommit={v => setLocal('MSK_VMIX_MID', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">V=MID → α=0.5 (G2)</div>
          </div>
          <div>
            <div className="label mb-1">VMIX_HI (m/s)</div>
            <NumInput value={params.MSK_VMIX_HI ?? 10.0} min={0} max={30} step={0.1}
                      onCommit={v => setLocal('MSK_VMIX_HI', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">V&gt;HI → α=1 (G3)</div>
          </div>
        </div>
      </div>

      {/* v9 P3.1 G3 PID 速度环 */}
      <div className="card">
        <div className="card-title">G3 速度环 (PID) — 进 G3 自动启用</div>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <div className="label mb-1">老 V_TGT (兼容)</div>
            <NumInput value={params.MSK_V_TGT ?? 9.0} min={1} max={30} step={0.1}
                      onCommit={v => setLocal('MSK_V_TGT', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">P4 用 ch3=V_TGT 替代</div>
          </div>
          <div>
            <div className="label mb-1">P 增益</div>
            <NumInput value={params.MSK_V_PI_P ?? 0.05} min={0} max={1} step={0.01}
                      onCommit={v => setLocal('MSK_V_PI_P', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">I 增益</div>
            <NumInput value={params.MSK_V_PI_I ?? 0.02} min={0} max={1} step={0.01}
                      onCommit={v => setLocal('MSK_V_PI_I', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">D 增益 (阻尼)</div>
            <NumInput value={params.MSK_V_PI_D ?? 0.0} min={0} max={1} step={0.01}
                      onCommit={v => setLocal('MSK_V_PI_D', v)}
                      className="input val-mono w-full" />
          </div>
        </div>
        <div className="mt-2 text-[9px] text-fg-mute leading-snug">
          G3 mode + ahrs:airspeed_estimate() 有效 → 自动 PID. correction = P×err + I×∫err − D×(dV/dt).
          D 项用 V_actual 微分 (非 err 微分), 防 V_target 跳变引发 D 跳. 默认 0, 实飞振荡时调到 0.05-0.1.
          correction clamp ±0.3 (±30% thr_cap), G1/G2 时 PID 状态清零防污染.
        </div>
      </div>

      </fieldset>
    </div>
  );
}
