import React, { useMemo, useState, useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { MotorLayout } from '../common/MotorLayout';
import { MOTORS, GROUP_COLORS, TILTS } from '../../lib/actuators';
import type { GroupKey, TiltId, TiltAlias } from '../../lib/types';
import { AlertTriangle, Info, Edit3, X, Radio } from 'lucide-react';
import { dynamicGeometry, type MotorId } from '../../lib/geometry';
import { gcs } from '../../lib/gcs';

// TiltId → alias (PRE_OVR_<alias>)
const TILT_ALIAS_MAP: Record<TiltId, TiltAlias> = {
  DFL:'DFL', DFR:'DFR', TL1:'TL1', TR1:'TR1', RDL:'RDL', RDR:'RDR', S_GROUP_TILT:'SGRP',
};

interface Props { currentK: Record<GroupKey, number>; }

// motor → 控制其 tilt 的 servo id
const MOTOR_TILT_SRC: Record<string, TiltId | null> = {
  SL1: 'S_GROUP_TILT', SL2: 'S_GROUP_TILT', SR1: 'S_GROUP_TILT', SR2: 'S_GROUP_TILT',
  DFL: 'DFL', DFR: 'DFR',
  TL1: 'TL1', TR1: 'TR1',
  RDL: 'RDL', RDR: 'RDR',
  TL2: null, TR2: null,
};

export function Geometry({ currentK }: Props) {
  const { params, analysisTilts, analysisDfTarget,
          setAnalysisTilt, setAnalysisDfTarget, setParam, simulateArmed } = useStore();
  const [editingGeo, setEditingGeo] = useState(false);

  // 任一 PRE_OVR_* 非 -1 就算 "preview LIVE"
  const anyOvrActive = TILTS.some(t => (params[`PRE_OVR_${t.alias}`] ?? -1) >= 0);

  // 拖滑杆 → 实时推送 PRE_OVR
  const setAnalysisTiltLive = (tid: TiltId, v: number) => {
    setAnalysisTilt(tid, v);
    if (!simulateArmed) {
      const alias = TILT_ALIAS_MAP[tid];
      const key = `PRE_OVR_${alias}`;
      setParam(key, v);
      gcs.setParam(key, v);
    }
  };

  // 退出全部预览: 7 路 PRE_OVR 设回 -1, analysisTilts 复位到曲线 V=0 (TLTC_*_K0)
  const exitAllPreviews = () => {
    for (const t of TILTS) {
      setParam(`PRE_OVR_${t.alias}`, -1);
      gcs.setParam(`PRE_OVR_${t.alias}`, -1);
      const k0 = params[`TLTC_${t.alias}_K0`] ?? 45;
      setAnalysisTilt(t.id, k0);
    }
  };

  // armed → 强制清预览
  useEffect(() => {
    if (simulateArmed && anyOvrActive) {
      for (const t of TILTS) {
        setParam(`PRE_OVR_${t.alias}`, -1);
        gcs.setParam(`PRE_OVR_${t.alias}`, -1);
      }
    }
  }, [simulateArmed]);

  // 读 motor base geometry — 优先 MGEO_<ID>_P/R/Y, 回退 actuators 默认
  const getBase = (id: string) => ({
    pitch: params[`MGEO_${id}_P`] ?? 0,
    roll:  params[`MGEO_${id}_R`] ?? 0,
    yaw:   params[`MGEO_${id}_Y`] ?? 0,
  });

  // 用通用 cos/sin 模块算动态几何
  const rows = useMemo(() => {
    return MOTORS.map(m => {
      const tiltSrc = MOTOR_TILT_SRC[m.id];
      const base = getBase(m.id);
      const tiltDeg = tiltSrc ? (analysisTilts[tiltSrc] ?? 0) : 0;
      const eff = tiltSrc
        ? dynamicGeometry(m.id as MotorId, tiltDeg, base)
        : base;
      return { id: m.id, group: m.group, ...eff, base, tiltDeg };
    });
  }, [analysisTilts, params]);

  const sum = useMemo(() => ({
    pitch: rows.reduce((s, r) => s + Math.abs(r.pitch), 0),
    roll:  rows.reduce((s, r) => s + Math.abs(r.roll),  0),
    yaw:   rows.reduce((s, r) => s + Math.abs(r.yaw),   0),
  }), [rows]);

  // S→DF 耦合 (绝对角度: 45° = 中立). 偏离量 = S_GROUP_TILT − 45.
  const sOffset = analysisTilts.S_GROUP_TILT - 45;
  const passiveDf = params.TLT_CPL_SDF_K * sOffset;
  const finalDf = analysisDfTarget - passiveDf;       // 输出仍是绝对角度
  const dfLmin = params.TLT_DFL_LMIN ?? 0;
  const dfLmax = params.TLT_DFL_LMAX ?? 90;
  const dfSat = finalDf < dfLmin || finalDf > dfLmax;

  // 物理 PWM 检查 (输入 abs_deg, 转 offset 再算 PWM)
  const perDeg = params.TLT_PWM_PER_DEG;
  const tiltToPwm = (id: string, absDeg: number) => {
    const zKey = `TLT_${id.replace('S_GROUP_TILT','SGRP')}_ZERO`;
    const dKey = `TLT_${id.replace('S_GROUP_TILT','SGRP')}_DIR`;
    const zero = params[zKey] ?? 1500;
    const dir = params[dKey] ?? 1;
    const offset = absDeg - 45;
    return Math.max(500, Math.min(2500, Math.round(zero + dir * perDeg * offset)));
  };

  return (
    <div className="grid grid-cols-12 gap-3">
      {/* 左: 机体布局 */}
      <div className="card col-span-7">
        <div className="card-title">12 EDF 蝠鲨顶视图</div>
        <MotorLayout currentK={currentK} tiltAngle={analysisTilts.RDL} editable={true} height={580} />
        <div className="flex items-center gap-4 text-[10px] text-fg-mute mt-2">
          {Object.entries(GROUP_COLORS).map(([k, c]) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full" style={{ background: c }} />
              <span>{k}</span>
            </span>
          ))}
        </div>
      </div>

      {/* 右: 7 路 tilt 滑杆 + 几何分析 */}
      <div className="col-span-5 space-y-3">
        <div className="card">
          <div className="flex items-center mb-1">
            <div className="card-title mb-0 flex-1">7 路倾转舵动态分析</div>
            {anyOvrActive && (
              <span className="chip chip-active text-[9px] flex items-center gap-1">
                <Radio size={9} className="animate-pulse"/>LIVE
              </span>
            )}
            <button className="btn ml-2 text-[10px] py-0.5 px-2"
                    onClick={exitAllPreviews}
                    disabled={simulateArmed && !anyOvrActive}>
              <X size={10} className="inline mr-0.5"/>退出预览
            </button>
          </div>
          <div className="text-[10px] text-fg-mute mb-2">
            拖每路 tilt 角看几何系数实时变化, 同步推送到飞控 (disarmed only).
            armed 自动复位.
          </div>
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-fg-mute border-b border-line">
                <th className="text-left p-1">舵</th>
                <th className="text-left p-1" style={{width: '120px'}}>角度滑杆</th>
                <th className="text-right p-1 w-12">°</th>
                <th className="text-right p-1 w-14">PWM</th>
              </tr>
            </thead>
            <tbody>
              {TILTS.map(t => {
                // LMIN/LMAX 是 offset, 转 abs 给滑杆
                const lminOff = params[`TLT_${t.alias}_LMIN`] ?? -45;
                const lmaxOff = params[`TLT_${t.alias}_LMAX`] ?? 45;
                const lmin = 45 + lminOff;
                const lmax = 45 + lmaxOff;
                const v = analysisTilts[t.id];
                const pwm = tiltToPwm(t.id, v);
                const sat = pwm === 500 || pwm === 2500;
                const isSGroup = t.id === 'S_GROUP_TILT';
                return (
                  <tr key={t.id} className="border-b border-line/30">
                    <td className="p-1 val-mono">
                      {t.id}
                      <span className="text-[8px] text-fg-dim ml-1">中立=45°</span>
                    </td>
                    <td className="p-1">
                      <input type="range" min={lmin} max={lmax} step={1}
                             value={Math.max(lmin, Math.min(lmax, v))}
                             disabled={simulateArmed}
                             onChange={e => setAnalysisTiltLive(t.id, parseInt(e.target.value))}
                             className="slider w-full" />
                      <div className="flex justify-between text-[8px] text-fg-dim">
                        <span>{lmin}°</span>
                        <span>{lmax}°</span>
                      </div>
                    </td>
                    <td className="p-1 text-right val-mono">{v > 0 ? '+' : ''}{v}</td>
                    <td className={'p-1 text-right val-mono ' + (sat ? 'text-warn' : '')}>{pwm}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2 text-[9px] text-fg-dim">
            <b>绝对物理角度: 0°=垂直水面 (朝下) / 45°=中立 / 90°=水平水面 (朝前).</b>
            <br/>所有 motor 中位都装到 abs=45°. ZERO PWM 对应中立, DIR 决定 PWM↑↓ 方向.
            <br/>内部转换: offset = abs−45, pwm = ZERO + DIR × PER_DEG × offset
            <br/>PER_DEG={perDeg.toFixed(2)}μs/°, 180° 舵机 + PWM 500-2500.
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-2 mb-2">
            <div className="card-title mb-0 flex-1">几何系数 (12 motor)</div>
            <button className={'btn ' + (editingGeo ? 'btn-primary' : '')}
                    onClick={() => setEditingGeo(!editingGeo)}>
              <Edit3 size={11} className="inline mr-1" />
              {editingGeo ? '完成编辑' : '编辑 base'}
            </button>
          </div>
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-fg-mute border-b border-line">
                <th className="text-left p-1">ID</th>
                <th className="text-right p-1">{editingGeo ? 'Base P' : 'Pitch eff'}</th>
                <th className="text-right p-1">{editingGeo ? 'Base R' : 'Roll eff'}</th>
                <th className="text-right p-1">{editingGeo ? 'Base Y' : 'Yaw eff'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b border-line/30">
                  <td className="p-1 val-mono" style={{ color: GROUP_COLORS[r.group] }}>{r.id}</td>
                  {editingGeo ? (
                    <>
                      <td className="p-1">
                        <input type="number" step={0.05} min={-1} max={1}
                          value={params[`MGEO_${r.id}_P`] ?? 0}
                          onChange={e => setParam(`MGEO_${r.id}_P`, parseFloat(e.target.value)||0)}
                          className="input val-mono w-full text-right text-[10px]" />
                      </td>
                      <td className="p-1">
                        <input type="number" step={0.05} min={-1} max={1}
                          value={params[`MGEO_${r.id}_R`] ?? 0}
                          onChange={e => setParam(`MGEO_${r.id}_R`, parseFloat(e.target.value)||0)}
                          className="input val-mono w-full text-right text-[10px]" />
                      </td>
                      <td className="p-1">
                        <input type="number" step={0.05} min={-1} max={1}
                          value={params[`MGEO_${r.id}_Y`] ?? 0}
                          onChange={e => setParam(`MGEO_${r.id}_Y`, parseFloat(e.target.value)||0)}
                          className="input val-mono w-full text-right text-[10px]" />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={'p-1 text-right val-mono ' + (r.pitch < 0 ? 'text-err' : '')}>{r.pitch.toFixed(3)}</td>
                      <td className="p-1 text-right val-mono text-fg-mute">{r.roll.toFixed(3)}</td>
                      <td className="p-1 text-right val-mono text-fg-mute">{r.yaw.toFixed(3)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid-cols-3 gap-2 mt-2 text-center">
            <div><div className="label">Σ|pitch|</div><div className="val-mono">{sum.pitch.toFixed(2)}</div></div>
            <div><div className="label">Σ|roll|</div><div className="val-mono">{sum.roll.toFixed(2)}</div></div>
            <div><div className="label">Σ|yaw|</div><div className="val-mono">{sum.yaw.toFixed(2)}</div></div>
          </div>
        </div>
      </div>

      {/* S→DF 软解耦补偿 */}
      <div className="card col-span-12">
        <div className="card-title flex items-center gap-2">
          <Info size={12} />S_GROUP_TILT → DFL/DFR 软解耦补偿 (任何路径恒应用)
        </div>
        <div className="text-[10px] text-fg-mute mb-2">
          <span className="val-mono text-accent">DFL_final_abs = DFL_target_abs − K × (S_abs − 45°)</span>
          {' '} S=45° (中立) 时无补偿.
          机械上 S 桁架带动 DFL/DFR, 软件反向命令抵消, 让 DFL/DFR 看起来独立.
        </div>

        <div className="grid grid-cols-3 gap-4 mb-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="label">S_GROUP_TILT (abs)</span>
              <span className="val-mono ml-auto">{analysisTilts.S_GROUP_TILT}°</span>
            </div>
            <div className="text-[9px] text-fg-dim">偏离中立: {sOffset >= 0 ? '+' : ''}{sOffset}°</div>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="label">TLT_CPL_SDF_K</span>
              <span className="val-mono ml-auto">{params.TLT_CPL_SDF_K.toFixed(2)}</span>
            </div>
            <input type="range" min={0} max={1} step={0.05} value={params.TLT_CPL_SDF_K}
                   onChange={e => setParam('TLT_CPL_SDF_K', parseFloat(e.target.value))} className="slider w-full" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="label">DFL/DFR 目标 (abs)</span>
              <span className="val-mono ml-auto">{analysisDfTarget}°</span>
            </div>
            <input type="range" min={dfLmin} max={dfLmax} step={1} value={analysisDfTarget}
                   onChange={e => setAnalysisDfTarget(parseInt(e.target.value))} className="slider w-full" />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <ResultCard label="被动带动量 (机械耦合)" val={(passiveDf >= 0 ? '+' : '') + passiveDf.toFixed(1)} unit="°" />
          <ResultCard label="补偿后 DFL/DFR 命令 (abs)" val={finalDf.toFixed(1)} unit="°" warn={dfSat} />
          <ResultCard label="DFL/DFR 软限 (offset)" val={`[${dfLmin},${dfLmax >0?'+':''}${dfLmax}]°`} unit="" hint={`abs [${45+dfLmin},${45+dfLmax}]°`} />
        </div>
        {dfSat && (
          <div className="mt-2 flex items-center gap-2 bg-warn/15 border border-warn px-3 py-2 rounded text-warn text-[10px]">
            <AlertTriangle size={12} /> 补偿后撞软限 [{dfLmin},{dfLmax}]°. 降 K, 缩 target, 或扩 LMIN/LMAX.
          </div>
        )}
      </div>
    </div>
  );
}

function ResultCard({ label, val, unit, warn, hint }: { label: string; val: string; unit: string; warn?: boolean; hint?: string }) {
  return (
    <div className={'rounded border p-2 ' + (warn ? 'bg-warn/10 border-warn' : 'bg-panel-2 border-line')}>
      <div className="text-[10px] text-fg-mute">{label}</div>
      <div className={'val-mono text-[16px] ' + (warn ? 'text-warn' : 'text-fg')}>
        {val}<span className="text-fg-dim text-[11px] ml-0.5">{unit}</span>
      </div>
      {hint && <div className="text-[9px] text-fg-dim">{hint}</div>}
    </div>
  );
}
