// v9 P7.4 控制律 tab — 公用参数 (Q_* ATC PID, V_PI, drift, GROUP_BOOST, 三层级)
// **不实时推送 FC** — 必须显式 "保存" 才下发.
// 旧 3 档 / K 表 / V 控制 / vmix 已搬到 模式配置 → Manual section.
import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/useStore';
import { gcs } from '../../lib/gcs';
import { NumInput } from '../common/NumInput';
import { paramRange, quantize, ATC_NATIVE_KEYS } from '../../lib/defaults';
import { Download, Upload } from 'lucide-react';

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

// v9 P7.4 控制律 tab 管理的 FC 参数 key (Pull/Save 范围)
// 旧 3 档 + K 表 + V 控制 + vmix 已迁 模式配置 → Manual section
const FLIGHT_KEYS: string[] = [
  // ATC 原生 PID + stick limit (P7.4 加, 控制律 = 公用参数)
  ...ATC_NATIVE_KEYS,
  // V_PI 速度环 PID (Manual fallback + WIG_AUTO 共用)
  'MSK_V_TGT','MSK_V_PI_P','MSK_V_PI_I','MSK_V_PI_D',
  'MSK_V_INT_LIM','MSK_G3_RAMP_MS',
  // 三层级加速 + Emergency
  'MSK_KT_LIM','MSK_L2_SGRP_RT','MSK_L2_RD_RT','MSK_P_EMRG_DEG',
  // GROUP_BOOST (V_PI demand 在 4 组分配权重) + Layer hysteresis
  'MSK_BST_KS','MSK_BST_KDF','MSK_BST_KT','MSK_BST_KRD',
  'MSK_BST_SAT_HI','MSK_BST_SAT_LO',
  // drift 学习 (MSK + MSK2 副表)
  'MSK_K_DRFT_RT','MSK_DRFT_TIME',
  'MSK2_DRFT_DZ','MSK2_DRFT_KS_R','MSK2_DRFT_KDF_R','MSK2_DRFT_KT_R','MSK2_DRFT_KRD_R',
  'MSK2_KRAMP_MS','MSK2_P5_KS_RT','MSK2_PO_NORM',
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
        <span className="card-title mb-0 flex-1">控制律同步</span>
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

      {/* P7.4 新: ATC 原生 PID + stick limit (公用) */}
      <div className="card">
        <div className="card-title">ATC 原生 PID (Q_A_*, 公用控制律)</div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="label mb-1">Roll rate P (Q_A_RAT_RLL_P)</div>
            <NumInput value={params.Q_A_RAT_RLL_P ?? 0.135} min={0} max={1} step={0.005}
                      onCommit={v => setLocal('Q_A_RAT_RLL_P', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Roll rate I (Q_A_RAT_RLL_I)</div>
            <NumInput value={params.Q_A_RAT_RLL_I ?? 0.135} min={0} max={1} step={0.005}
                      onCommit={v => setLocal('Q_A_RAT_RLL_I', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Roll rate D (Q_A_RAT_RLL_D)</div>
            <NumInput value={params.Q_A_RAT_RLL_D ?? 0.004} min={0} max={0.1} step={0.0005}
                      onCommit={v => setLocal('Q_A_RAT_RLL_D', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Pitch rate P (Q_A_RAT_PIT_P)</div>
            <NumInput value={params.Q_A_RAT_PIT_P ?? 0.135} min={0} max={1} step={0.005}
                      onCommit={v => setLocal('Q_A_RAT_PIT_P', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Pitch rate I (Q_A_RAT_PIT_I)</div>
            <NumInput value={params.Q_A_RAT_PIT_I ?? 0.135} min={0} max={1} step={0.005}
                      onCommit={v => setLocal('Q_A_RAT_PIT_I', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Pitch rate D (Q_A_RAT_PIT_D)</div>
            <NumInput value={params.Q_A_RAT_PIT_D ?? 0.004} min={0} max={0.1} step={0.0005}
                      onCommit={v => setLocal('Q_A_RAT_PIT_D', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Roll angle P (Q_A_ANG_RLL_P)</div>
            <NumInput value={params.Q_A_ANG_RLL_P ?? 4.5} min={0} max={12} step={0.1}
                      onCommit={v => setLocal('Q_A_ANG_RLL_P', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Pitch angle P (Q_A_ANG_PIT_P)</div>
            <NumInput value={params.Q_A_ANG_PIT_P ?? 4.5} min={0} max={12} step={0.1}
                      onCommit={v => setLocal('Q_A_ANG_PIT_P', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Angle MAX (Q_A_ANGLE_MAX, °)</div>
            <NumInput value={params.Q_A_ANGLE_MAX ?? 5} min={0} max={45} step={1}
                      onCommit={v => setLocal('Q_A_ANGLE_MAX', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">stick → angle 上限 (ArduPlane 4.7+ 单位 deg, default 5°)</div>
          </div>
          <div>
            <div className="label mb-1">Pitch stick + (PTCH_LIM_MAX_DEG)</div>
            <NumInput value={params.PTCH_LIM_MAX_DEG ?? 5} min={0} max={90} step={1}
                      onCommit={v => setLocal('PTCH_LIM_MAX_DEG', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Pitch stick − (PTCH_LIM_MIN_DEG)</div>
            <NumInput value={params.PTCH_LIM_MIN_DEG ?? -5} min={-90} max={0} step={1}
                      onCommit={v => setLocal('PTCH_LIM_MIN_DEG', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Roll stick ± (ROLL_LIMIT_DEG)</div>
            <NumInput value={params.ROLL_LIMIT_DEG ?? 5} min={0} max={90} step={1}
                      onCommit={v => setLocal('ROLL_LIMIT_DEG', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">Hover throttle (Q_M_THST_HOVER)</div>
            <NumInput value={params.Q_M_THST_HOVER ?? 0.50} min={0.1} max={0.8} step={0.01}
                      onCommit={v => setLocal('Q_M_THST_HOVER', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">battery sag 补偿基准</div>
          </div>
        </div>
        <div className="mt-2 text-[10px] text-fg-mute leading-snug">
          <b>ATC 调参建议</b>: 实飞 RAT_RLL/PIT_P=0.135, ANG_P=4.5, ANGLE_MAX=500 (±5°); 台架 RAT_P=0.4, ANG_P=8, ANGLE_MAX=3000 (±30°).
          PTCH_LIM_MAX/MIN_DEG + ROLL_LIMIT_DEG 控 stick travel 上限 (跟 ANGLE_MAX 取小值生效).
          Q_TRIM_PITCH 由 lua 写, 这里不暴露 (在 GCS tab 显示).
        </div>
      </div>

      {/* v9 P3.5/P3.6 三层级加速参数 */}
      <div className="card">
        <div className="card-title">CRUISE 三层级加速 (KT → SGRP 倾转改平 → 加力)</div>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <div className="label mb-1">KT 撞限阈值 (KT_LIM)</div>
            <NumInput value={params.MSK_KT_LIM ?? 1.0} min={0.5} max={1.0} step={0.01}
                      onCommit={v => setLocal('MSK_KT_LIM', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">Layer 1→2 转换 (迟滞 0.95×)</div>
          </div>
          <div>
            <div className="label mb-1">SGRP rate base (°/s)</div>
            <NumInput value={params.MSK_L2_SGRP_RT ?? 5.0} min={0.5} max={30} step={0.5}
                      onCommit={v => setLocal('MSK_L2_SGRP_RT', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">Layer 2 SGRP 朝水平 tilt 基础速率 (P7.6: × stability 自适应, 见 模式配置→Global)</div>
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
            <div className="label mb-1">CRUISE PI ramp</div>
            <NumInput value={params.MSK_G3_RAMP_MS ?? 1500} min={0} max={5000} step={100}
                      onCommit={v => setLocal('MSK_G3_RAMP_MS', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">TRANS→CRUISE PI ramp ms (param: MSK_G3_RAMP_MS)</div>
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
          <b>因子物理</b>: KS 主升力 → 1.0 (全速学); KDF 主姿态 → 0.5 (半速); KT 跟 CRUISE boost 撞 → 0.3 (抑); KRD 后部斜下吹 sign 反向 → 0.0 默认关 (打开 = 飞行员看 LOG 确定 KRD 不跟 boost 撞后改 0.5).
          <b>KRAMP_MS</b> 仅 vmix=0 (P3.10 离散三档) 切档用; vmix=1 (P4 默认) 走 set_alpha 连续插值, 不触发.
        </div>
      </div>

      {/* v9 P4 实战 GROUP_BOOST + V_TGT 范围 */}
      <div className="card">
        <div className="card-title">CRUISE 加速分配 (GROUP_BOOST) + 油门杆=V_TGT 范围</div>
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
          <b>GROUP_BOOST</b>: CRUISE V_PI 速度 demand 在 4 组分配权重. K = (K_base + drift) × ramp + boost × BST_K, 然后 clamp [0,1] × cap.
        </div>
      </div>

      {/* v9 P7.6 CRUISE V_PI 速度环 */}
      <div className="card">
        <div className="card-title">CRUISE 速度环 V_PI (P7.6 加 V_TGT smoother + L2 stability)</div>
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
          CRUISE phase + ahrs:airspeed_estimate() 有效 → 自动 PI. correction = P×err + I×∫err − D×(dV/dt).
          V_TGT 经 WIGK_V_ACC_MAX 速率限制 (P7.6) 避免 D 项跳变. 默认 D=0, 实飞振荡时调到 0.05-0.1.
          correction clamp ±0.3 (±30% thr_cap), TAXI/TRANS 时 PID 状态清零防污染.
        </div>
      </div>

      </fieldset>
    </div>
  );
}
