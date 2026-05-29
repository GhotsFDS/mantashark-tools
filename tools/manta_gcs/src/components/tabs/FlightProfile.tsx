// v9 P7.9.4 控制律 tab — 公用参数 (Q_* ATC PID, V_PI, base_pitch ramp, V_TGT 映射)
// **不实时推送 FC** — 必须显式 "保存" 才下发.
// P7.9.4 撤掉的参数 (lua 不再读): MSK_KT_LIM, MSK_L2_SGRP_RT, MSK_L2_RD_RT, MSK_K_DRFT_RT,
//   MSK_BST_KS/KDF/KT/KRD, MSK_BST_SAT_HI/LO, MSK_V_TGT, MSK_P_EMRG_DEG, MSK_G3_RAMP_MS, MSK_DRFT_TIME.
import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/useStore';
import { gcs } from '../../lib/gcs';
import { NumInput } from '../common/NumInput';
import { paramRange, quantize, ATC_NATIVE_KEYS } from '../../lib/defaults';
import { Download, Upload } from 'lucide-react';

// v9 P7.9.4 控制律 tab 管理的 FC 参数 key (Pull/Save 范围)
// K 表 / vmix / 模式分档已迁 模式配置 tab.
const FLIGHT_KEYS: string[] = [
  // ATC 原生 PID + stick limit (P7.4 加, 控制律 = 公用参数)
  ...ATC_NATIVE_KEYS,
  // V_PI 速度环 PID (CRUISE 用, V_TGT 用 WIGA_V_TGT / ch10 映射)
  'MSK_V_PI_P','MSK_V_PI_I','MSK_V_PI_D','MSK_V_INT_LIM',
  // base_pitch ramp + 离散 base_pitch 值 (TAXI/CRUISE)
  'MSK_TRIM_RATE','MSK_BPCH_G1','MSK_BPCH_G2',
  // ch10 → V_TGT 映射范围
  'MSK_V_MIN','MSK_V_MAX',
  // orchestrator ATC fb 归一化
  'MSK2_PO_NORM',
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
          title={`从飞控读取 ${FLIGHT_KEYS.length} 个飞行参数, 覆盖本地 (放弃未保存修改)`}
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

      {/* P7.4 ATC 原生 PID + stick limit (公用) */}
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
          <b>ATC 调参建议</b>: 实飞 RAT_RLL/PIT_P=0.135, ANG_P=4.5, ANGLE_MAX=5 (±5°); 台架 RAT_P=0.4, ANG_P=8, ANGLE_MAX=30 (±30°).
          PTCH_LIM_MAX/MIN_DEG + ROLL_LIMIT_DEG 控 stick travel 上限 (跟 ANGLE_MAX 取小值生效).
          Q_TRIM_PITCH 由 lua 写, 这里不暴露 (在 GCS tab 显示).
        </div>
      </div>

      {/* P7.9.4 CRUISE V_PI 速度环 */}
      <div className="card">
        <div className="card-title">CRUISE V_PI 速度环 (P7.9.4)</div>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <div className="label mb-1">P 增益 (V_PI_P)</div>
            <NumInput value={params.MSK_V_PI_P ?? 0.05} min={0} max={1} step={0.005}
                      onCommit={v => setLocal('MSK_V_PI_P', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">I 增益 (V_PI_I)</div>
            <NumInput value={params.MSK_V_PI_I ?? 0.02} min={0} max={1} step={0.005}
                      onCommit={v => setLocal('MSK_V_PI_I', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">D 增益 (V_PI_D, 阻尼)</div>
            <NumInput value={params.MSK_V_PI_D ?? 0.0} min={0} max={1} step={0.005}
                      onCommit={v => setLocal('MSK_V_PI_D', v)}
                      className="input val-mono w-full" />
          </div>
          <div>
            <div className="label mb-1">I 项 cap (V_INT_LIM)</div>
            <NumInput value={params.MSK_V_INT_LIM ?? 5.0} min={0} max={50} step={0.5}
                      onCommit={v => setLocal('MSK_V_INT_LIM', v)}
                      className="input val-mono w-full" />
          </div>
        </div>
        <div className="mt-2 text-[10px] text-fg-mute leading-snug">
          CRUISE phase + ahrs:airspeed_estimate() 有效 → 自动 V_PI. correction = P×err + I×∫err − D×(dV/dt).
          V_TGT 来源: ch10 PWM 映射 (WIGA_V_CH10_EN=1, 范围 MSK_V_MIN..MSK_V_MAX) 或 WIGA_V_TGT 静态. 老 MSK_V_TGT 已撤.
          correction 直接给 mixer.set_speed_correction → KT 单组 boost (P7.9.4 撤了 GROUP_BOOST 4 组分配). TAXI/TRANS 时 PID 清零.
        </div>
      </div>

      {/* P7.9.4 base_pitch + ch10 V_TGT 映射 */}
      <div className="card">
        <div className="card-title">base_pitch + ch10 → V_TGT 映射</div>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <div className="label mb-1">TRIM_RATE (°/s)</div>
            <NumInput value={params.MSK_TRIM_RATE ?? 99} min={0} max={200} step={1}
                      onCommit={v => setLocal('MSK_TRIM_RATE', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">base_pitch ramp 速率 (默认 99 ≈ 阶跃)</div>
          </div>
          <div>
            <div className="label mb-1">BPCH_G1 (TAXI, °)</div>
            <NumInput value={params.MSK_BPCH_G1 ?? 4} min={-10} max={20} step={0.5}
                      onCommit={v => setLocal('MSK_BPCH_G1', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">TAXI 浮筒自然 base_pitch</div>
          </div>
          <div>
            <div className="label mb-1">BPCH_G2 (TRANS/CRUISE, °)</div>
            <NumInput value={params.MSK_BPCH_G2 ?? 10} min={-10} max={20} step={0.5}
                      onCommit={v => setLocal('MSK_BPCH_G2', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">抬头建气垫 + 巡航 base_pitch</div>
          </div>
          <div>
            <div className="label mb-1">PO_NORM (orchestrator)</div>
            <NumInput value={params.MSK2_PO_NORM ?? 0.5} min={0.1} max={2.0} step={0.05}
                      onCommit={v => setLocal('MSK2_PO_NORM', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">orchestrator ATC fb 归一化系数</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3 mt-3">
          <div>
            <div className="label mb-1">V_MIN (ch10 下限, m/s)</div>
            <NumInput value={params.MSK_V_MIN ?? 3.0} min={0} max={25} step={0.5}
                      onCommit={v => setLocal('MSK_V_MIN', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">ch10=1000 → V_TGT</div>
          </div>
          <div>
            <div className="label mb-1">V_MAX (ch10 上限, m/s)</div>
            <NumInput value={params.MSK_V_MAX ?? 10.0} min={0} max={25} step={0.5}
                      onCommit={v => setLocal('MSK_V_MAX', v)}
                      className="input val-mono w-full" />
            <div className="text-[9px] text-fg-mute mt-0.5">ch10=2000 → V_TGT</div>
          </div>
        </div>
        <div className="mt-2 text-[10px] text-fg-mute leading-snug">
          <b>base_pitch</b>: ch7 phase 切档 (TAXI=G1 / TRANS=G2 / CRUISE=G2) → Q_TRIM_PITCH 按 TRIM_RATE °/s 逼近.
          默认 99°/s ≈ 阶跃, 实飞振荡时调到 10-30°/s 给 ATC 缓冲.
          <b>V_TGT</b>: 当 WIGA_V_CH10_EN=1 (在 模式配置 tab), ch10 PWM linear 映射到 [V_MIN, V_MAX]; 关时用 WIGA_V_TGT 固定值.
        </div>
      </div>

      </fieldset>
    </div>
  );
}
