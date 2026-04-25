import React from 'react';
import { useStore } from '../../store/useStore';
import type { GroupKey } from '../../lib/types';
import { GROUP_COLORS, GROUP_LABELS, SINGLE_MOTOR_MAX_N, VEHICLE_WEIGHT_N, MOTORS, TILT_IDS } from '../../lib/actuators';
import { Activity, TrendingUp, AlertCircle } from 'lucide-react';

interface Props {
  currentK: Record<GroupKey, number>;
  effectiveSpeed: number;
}

export function Overview({ currentK, effectiveSpeed }: Props) {
  const { currentSpeed, setSpeed, currentGear, setGear, currentPhase, phaseAutoSync,
          setPhaseAutoSync, simulateArmed, setSimulateArmed, setPhase, phaseConfig } = useStore();

  const kmax = Math.max(currentK.KS, currentK.KDF, currentK.KT, currentK.KRD, 1e-6);
  const kn: Record<GroupKey, number> = {
    KS: currentK.KS/kmax, KDF: currentK.KDF/kmax, KT: currentK.KT/kmax, KRD: currentK.KRD/kmax,
  };

  const totalThrust = MOTORS.reduce((sum, m) => sum + (kn[m.group] ?? 0) * SINGLE_MOTOR_MAX_N, 0);
  const liftMargin = totalThrust - VEHICLE_WEIGHT_N;
  const currentTilts = phaseConfig[currentPhase]?.tilts ?? {};

  return (
    <div className="grid grid-cols-12 gap-3">
      {/* 主控 */}
      <div className="card col-span-6">
        <div className="card-title flex items-center gap-2"><Activity size={14} />飞行状态控制</div>

        <div className="mb-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="label">速度 (GPS 地速)</span>
            <span className="val-mono ml-auto text-[16px] text-accent">{currentSpeed.toFixed(1)}</span>
            <span className="text-fg-dim text-[10px]">m/s</span>
          </div>
          <input
            type="range" min={0} max={20} step={0.1}
            value={currentSpeed}
            onChange={e => setSpeed(parseFloat(e.target.value))}
            className="slider w-full"
          />
          <div className="flex justify-between text-[9px] text-fg-dim mt-0.5">
            <span>0</span><span>5</span><span>10</span><span>15</span><span>20</span>
          </div>
          <div className="text-[10px] text-fg-mute mt-1">
            档位限速后评估速度 <span className="val-mono text-fg">{effectiveSpeed.toFixed(1)} m/s</span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-3">
          {[1, 2, 3].map(g => (
            <button
              key={g}
              onClick={() => setGear(g as 1 | 2 | 3)}
              className={'btn ' + (currentGear === g ? 'btn-primary' : '')}
            >
              档 {g}
              <div className="text-[9px] opacity-70 mt-0.5">
                {g === 1 ? '锁 V1 慢' : g === 2 ? '锁 V2 驼峰' : '全开'}
              </div>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-2">
          <label className="flex items-center gap-2 text-[11px] cursor-pointer">
            <input
              type="checkbox" checked={phaseAutoSync}
              onChange={e => setPhaseAutoSync(e.target.checked)}
              className="accent-accent"
            />
            Phase 自动同步
          </label>
          <label className="flex items-center gap-2 text-[11px] cursor-pointer">
            <input
              type="checkbox" checked={simulateArmed}
              onChange={e => setSimulateArmed(e.target.checked)}
              className="accent-accent"
            />
            模拟已解锁
          </label>
        </div>

        {!phaseAutoSync && (
          <select
            value={currentPhase}
            onChange={e => setPhase(e.target.value as any)}
            className="input w-full"
          >
            {['STATIONARY','TAXI','CUSHION','GROUND_EFFECT','EMERGENCY'].map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
      </div>

      {/* K 值 */}
      <div className="card col-span-6">
        <div className="card-title flex items-center gap-2"><TrendingUp size={14} />当前 K 值 (PCHIP @ {effectiveSpeed.toFixed(1)} m/s)</div>
        {(['KS','KDF','KT','KRD'] as GroupKey[]).map(g => (
          <div key={g} className="mb-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="val-mono" style={{ color: GROUP_COLORS[g] }}>{g}</span>
              <span className="text-fg-mute text-[10px]">{GROUP_LABELS[g]}</span>
              <div className="ml-auto flex gap-3">
                <span className="val-mono text-[11px]">{(currentK[g]*100).toFixed(0)}<span className="text-fg-dim">%</span></span>
                <span className="val-mono text-[11px] text-fg-dim">→ {(kn[g]*100).toFixed(0)}<span className="text-fg-dim">%</span></span>
              </div>
            </div>
            <div className="relative h-2 bg-panel-2 rounded overflow-hidden">
              <div className="absolute inset-y-0 left-0 transition-all" style={{ width: (currentK[g]*100)+'%', background: GROUP_COLORS[g] + '60' }} />
              <div className="absolute inset-y-0 left-0 transition-all" style={{ width: (kn[g]*100)+'%', background: GROUP_COLORS[g] }} />
            </div>
          </div>
        ))}
        <div className="text-[9px] text-fg-dim mt-1">深色=原始 K · 亮色=÷kmax 归一化 (Lua mixer 用归一值驱动 Motors_dynamic)</div>
      </div>

      {/* Tilt 目标角 (来自 phase) */}
      <div className="card col-span-8">
        <div className="card-title">当前 Phase <b className="text-accent">{currentPhase}</b> 的 Tilt 目标角</div>
        <div className="grid grid-cols-7 gap-2">
          {TILT_IDS.map(id => {
            const deg = currentTilts[id] ?? 0;
            return (
              <div key={id} className="text-center">
                <div className="text-[10px] text-fg-mute">{id}</div>
                <div className="val-mono text-[14px] my-1">{deg}°</div>
                <div className="relative h-1.5 bg-panel-2 rounded overflow-hidden">
                  <div
                    className="absolute inset-y-0 bg-accent transition-all"
                    style={{ left: '50%', width: `${Math.abs(deg) / 45 * 50}%`, transform: deg < 0 ? 'translateX(-100%)' : 'none' }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 力平衡 快览 */}
      <div className="card col-span-4">
        <div className="card-title flex items-center gap-2">
          {liftMargin < 0 ? <AlertCircle size={14} className="text-err" /> : <AlertCircle size={14} />}
          力平衡快览
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="总推力" val={totalThrust.toFixed(0)} unit="N" />
          <Stat label="机重" val="98" unit="N" />
          <Stat
            label="富余"
            val={liftMargin.toFixed(0)}
            unit="N"
            color={liftMargin < 0 ? 'err' : liftMargin < 20 ? 'warn' : 'ok'}
          />
        </div>
        <div className="mt-2 text-center">
          <span className="text-fg-mute text-[10px]">T/W </span>
          <span className="val-mono text-[16px] text-accent">{(totalThrust / 98).toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, val, unit, color }: { label: string; val: string; unit: string; color?: 'ok'|'warn'|'err' }) {
  const cls = color === 'err' ? 'text-err' : color === 'warn' ? 'text-warn' : color === 'ok' ? 'text-ok' : 'text-fg';
  return (
    <div>
      <div className="text-[10px] text-fg-mute">{label}</div>
      <div className={'val-mono text-[14px] ' + cls}>{val}<span className="text-fg-dim text-[10px] ml-0.5">{unit}</span></div>
    </div>
  );
}
