import React from 'react';
import { CurveEditor } from '../common/CurveEditor';
import { useStore } from '../../store/useStore';
import type { GroupKey, TiltAlias } from '../../lib/types';
import { TILT_IDS, PHASES, GROUP_COLORS, TILTS } from '../../lib/actuators';

interface Props {
  effectiveSpeed: number;
  currentK: Record<GroupKey, number>;
}

const TILT_COLORS_LOCAL: Record<TiltAlias, string> = {
  SGRP: '#58b4ff',
  DFL:  '#ffa657',
  DFR:  '#f5a524',
  TL1:  '#7ee787',
  TR1:  '#56d364',
  RDL:  '#ff7b72',
  RDR:  '#f85149',
};

export function FlightProfile({ effectiveSpeed, currentK }: Props) {
  const { params, setParam, selectedCurve, selectedTiltCurve, setPhaseConfig,
          phaseConfig, currentPhase, currentSpeed, setSpeed, simulateArmed,
          curveMode, setCurveMode } = useStore();

  const V1 = params.MSK_V1, V2 = params.MSK_V2;
  const isK = curveMode === 'k';

  return (
    <div className="grid grid-cols-12 gap-3">
      {/* ─── 上: 曲线编辑 + 数值侧栏 ─── */}
      <div className="card col-span-9">
        <div className="flex items-center gap-2 mb-2">
          <div className="card-title mb-0 flex-1">
            {isK ? 'K 曲线 (PCHIP 保形插值)' : '倾转曲线 (PCHIP 保形插值)'}
            <span className="ml-2 text-[10px] text-fg-dim font-normal">
              {isK ? '● 4 组曲线 · 速度 → 油门系数' : '● 7 路 tilt · 速度 → 用户视角角度°'}
            </span>
          </div>
          <div className="flex border border-line rounded overflow-hidden">
            <button
              className={'px-3 py-1 text-[11px] ' + (isK ? 'bg-accent text-bg' : 'text-fg-mute hover:text-fg')}
              onClick={() => setCurveMode('k')}
            >K 曲线</button>
            <button
              className={'px-3 py-1 text-[11px] border-l border-line ' + (!isK ? 'bg-accent text-bg' : 'text-fg-mute hover:text-fg')}
              onClick={() => setCurveMode('tilt')}
            >倾转曲线</button>
          </div>
        </div>
        <CurveEditor effectiveSpeed={effectiveSpeed} height={440} showAll={true} mode={curveMode} />
      </div>

      <div className="card col-span-3 space-y-3">
        <div>
          <div className="card-title">速度 + 档位</div>
          <div className="flex items-center gap-2 mb-1">
            <span className="label">速度</span>
            <span className="val-mono ml-auto text-accent">{currentSpeed.toFixed(1)} m/s</span>
          </div>
          <input type="range" min={0} max={20} step={0.1}
                 value={currentSpeed}
                 onChange={e => setSpeed(parseFloat(e.target.value))}
                 className="slider w-full" />
          <div className="text-[10px] text-fg-dim mt-1">评估速度 {effectiveSpeed.toFixed(1)} m/s</div>
        </div>

        {isK ? (
          <div>
            <div className="card-title">
              选中 <span className="val-mono" style={{ color: GROUP_COLORS[selectedCurve] }}>{selectedCurve}</span>
            </div>
            <table className="w-full">
              <tbody>
                {[0, 1, 2, 3, 4].map(i => (
                  <tr key={i} className="border-b border-line/20">
                    <td className="text-[10px] text-fg-mute p-0.5">K{i}</td>
                    <td className="text-[9px] text-fg-dim p-0.5 text-right">
                      @V={[0, V1, V2, params.MSK_V3, params.MSK_V_MAX][i].toFixed(1)}
                    </td>
                    <td className="p-0.5">
                      <input type="number" min={0} max={1} step={0.01}
                             value={params[`MSK_${selectedCurve}${i}`]}
                             onChange={e => setParam(`MSK_${selectedCurve}${i}`, parseFloat(e.target.value) || 0)}
                             className="input w-full val-mono text-right text-[10px]" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div>
            <div className="card-title">
              选中 <span className="val-mono" style={{ color: TILT_COLORS_LOCAL[selectedTiltCurve] }}>{selectedTiltCurve}</span>
            </div>
            <table className="w-full">
              <tbody>
                {[0, 1, 2, 3, 4].map(i => {
                  const k = `TLTC_${selectedTiltCurve}_K${i}`;
                  return (
                    <tr key={i} className="border-b border-line/20">
                      <td className="text-[10px] text-fg-mute p-0.5">K{i}</td>
                      <td className="text-[9px] text-fg-dim p-0.5 text-right">
                        @V={[0, V1, V2, params.MSK_V3, params.MSK_V_MAX][i].toFixed(1)}
                      </td>
                      <td className="p-0.5">
                        <input type="number" min={-180} max={180} step={1}
                               value={params[k] ?? 0}
                               onChange={e => setParam(k, parseFloat(e.target.value) || 0)}
                               className="input w-full val-mono text-right text-[10px]" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="text-[9px] text-fg-dim mt-2">
              用户视角: 0=中立, +趋水平, −趋垂直.
              软限 [{params[`TLT_${selectedTiltCurve}_LMIN`] ?? '?'},{params[`TLT_${selectedTiltCurve}_LMAX`] ?? '?'}]°
            </div>
          </div>
        )}

        <div>
          <div className="card-title">{isK ? '当前 K 值' : '当前 tilt 角'}</div>
          {isK
            ? (['KS','KDF','KT','KRD'] as GroupKey[]).map(g => (
                <div key={g} className="flex items-center gap-1.5 mb-0.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: GROUP_COLORS[g] }} />
                  <span className="val-mono text-[10px]" style={{ color: GROUP_COLORS[g] }}>{g}</span>
                  <span className="ml-auto val-mono text-[11px]">{(currentK[g]*100).toFixed(1)}%</span>
                </div>
              ))
            : TILTS.map(t => {
                const a = t.alias;
                return (
                  <div key={a} className="flex items-center gap-1.5 mb-0.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: TILT_COLORS_LOCAL[a] }} />
                    <span className="val-mono text-[10px]" style={{ color: TILT_COLORS_LOCAL[a] }}>{a}</span>
                  </div>
                );
              })
          }
        </div>
      </div>

      {/* ─── 下: Phase 配置表 ─── */}
      <div className="card col-span-12">
        <div className="card-title flex items-center gap-2">
          阶段配置 (PHASE_CONFIG) — Q_TRIM + 7 路 tilt 目标角
          <span className="text-[10px] text-fg-dim font-normal">
            ● 阶段离散值 vs 倾转曲线连续值: 由 phases.lua 选用
          </span>
        </div>

        <div className="grid grid-cols-12 gap-3 mb-3">
          <div className="col-span-5 text-[10px] text-fg-mute">
            <b className="text-fg">Phase 切换阈值</b> (基于 MSK_V1={V1.toFixed(1)} / MSK_V2={V2.toFixed(1)}):
            <div className="mt-1 pl-2 space-y-0.5 val-mono text-[9px]">
              <div>STATIONARY ↔ TAXI : spd ⚷ 0.5 / 0.3</div>
              <div>TAXI ↔ CUSHION    : spd ⚷ {(V1-0.5).toFixed(1)} / {(V1-1.5).toFixed(1)}</div>
              <div>CUSHION ↔ GE      : spd ⚷ {(V2-0.5).toFixed(1)} / {(V2-1.5).toFixed(1)}</div>
              <div>disarmed → STATIONARY (无 dwell)</div>
            </div>
          </div>
          <div className="col-span-7 flex items-center justify-end gap-3 text-[11px]">
            <span className="label">当前 Phase</span>
            <span className={'chip chip-active text-[11px] ' + (currentPhase === 'EMERGENCY' ? 'chip-err' : '')}>{currentPhase}</span>
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={simulateArmed} onChange={e => useStore.getState().setSimulateArmed(e.target.checked)} className="accent-accent" />
              <span className="text-fg-mute">armed</span>
            </label>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-fg-mute border-b border-line">
                <th className="text-left p-1.5">Phase</th>
                <th className="text-center p-1.5 min-w-[70px]">Q_TRIM °</th>
                {TILT_IDS.map(id => (
                  <th key={id} className="text-center p-1.5 min-w-[60px]">{id}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PHASES.map(p => {
                const active = currentPhase === p;
                return (
                  <tr key={p} className={'border-b border-line/30 ' + (active ? 'bg-accent/10' : '')}>
                    <td className={'p-1.5 val-mono ' + (active ? 'text-accent' : '')}>{p}</td>
                    <td className="p-1">
                      <input type="number" step={0.5}
                             value={phaseConfig[p].trim}
                             onChange={e => setPhaseConfig(p, 'trim', parseFloat(e.target.value) || 0)}
                             className="input w-full val-mono text-right text-[10px]" />
                    </td>
                    {TILT_IDS.map(id => (
                      <td key={id} className="p-1">
                        <input type="number" step={1}
                               value={phaseConfig[p].tilts[id]}
                               onChange={e => setPhaseConfig(p, id, parseFloat(e.target.value) || 0)}
                               className="input w-full val-mono text-right text-[10px]" />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="text-[10px] text-fg-dim mt-2">
          导出 phase_config.lua → 参数 Tab. 这个表写入 scripts-plane/phases.lua 的 PHASE_CONFIG.
        </div>
      </div>
    </div>
  );
}
