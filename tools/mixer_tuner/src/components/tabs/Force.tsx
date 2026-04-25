import React, { useMemo } from 'react';
import { MOTORS, GROUP_COLORS, GROUP_LABELS, SINGLE_MOTOR_MAX_N, VEHICLE_WEIGHT_N } from '../../lib/actuators';
import type { GroupKey } from '../../lib/types';
import { useStore } from '../../store/useStore';

interface Props { currentK: Record<GroupKey, number>; }

export function Force({ currentK }: Props) {
  const { currentSpeed, setSpeed, currentGear, setGear, params } = useStore();
  // K 不归一化 (与 Lua mixer 保持一致, K=1.0 即 100% 油门)
  const kn: Record<GroupKey, number> = {
    KS: Math.min(1, Math.max(0, currentK.KS)),
    KDF: Math.min(1, Math.max(0, currentK.KDF)),
    KT: Math.min(1, Math.max(0, currentK.KT)),
    KRD: Math.min(1, Math.max(0, currentK.KRD)),
  };

  const byGroup = useMemo(() => {
    const groups: Record<GroupKey, { count: number; thrust: number; kN: number }> = {
      KS: {count:0,thrust:0,kN:kn.KS}, KDF:{count:0,thrust:0,kN:kn.KDF},
      KT: {count:0,thrust:0,kN:kn.KT}, KRD:{count:0,thrust:0,kN:kn.KRD},
    };
    for (const m of MOTORS) {
      groups[m.group].count++;
      groups[m.group].thrust += kn[m.group] * SINGLE_MOTOR_MAX_N;
    }
    return groups;
  }, [kn]);

  const totalThrust = Object.values(byGroup).reduce((s, g) => s + g.thrust, 0);
  const liftMargin = totalThrust - VEHICLE_WEIGHT_N;

  // 推力-油门非线性: thrust ≈ throttle^1.5 * max_thrust
  const throttleForLiftoff = Math.pow(VEHICLE_WEIGHT_N / totalThrust, 1 / 1.5);

  return (
    <div className="grid grid-cols-12 gap-3">
      <div className="card col-span-5">
        <div className="card-title">力平衡 @ {currentSpeed.toFixed(1)} m/s</div>

        {/* 速度 + 档位 (调试用滑杆) */}
        <div className="mb-3 p-2 bg-panel-2 rounded">
          <div className="flex items-center gap-2 mb-1">
            <span className="label">速度 (调试)</span>
            <span className="val-mono ml-auto text-accent">{currentSpeed.toFixed(1)}</span>
            <span className="text-fg-dim text-[10px]">m/s</span>
          </div>
          <input type="range" min={0} max={params.MSK_V_MAX ?? 20} step={0.1}
                 value={currentSpeed}
                 onChange={e => setSpeed(parseFloat(e.target.value))}
                 className="slider w-full" />
          <div className="flex gap-1 mt-2">
            {[1,2,3].map(g => (
              <button key={g} onClick={() => setGear(g as 1|2|3)}
                      className={'btn flex-1 text-[10px] py-0.5 ' + (currentGear === g ? 'btn-primary' : '')}>
                档{g}{g===1?' V1':g===2?' V2':' 全'}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2 my-3">
          <KVRow label="总推力 (100% 油门)" val={totalThrust.toFixed(1)} unit="N" big />
          <KVRow label="机重" val={VEHICLE_WEIGHT_N.toFixed(0)} unit="N" />
          <KVRow
            label="升力富余"
            val={liftMargin.toFixed(1)}
            unit="N"
            color={liftMargin < 0 ? 'err' : liftMargin < 20 ? 'warn' : 'ok'}
          />
          <KVRow label="T/W ratio" val={(totalThrust/VEHICLE_WEIGHT_N).toFixed(2)} unit="" />
          <KVRow
            label="起飞所需油门 (理论)"
            val={Math.min(100, throttleForLiftoff*100).toFixed(0)}
            unit="%"
            hint="基于 thrust ∝ throttle^1.5"
          />
        </div>

        <div className="card-section">油门-推力非线性曲线</div>
        <ThrottleCurve totalThrust={totalThrust} />
      </div>

      <div className="card col-span-7">
        <div className="card-title">分组贡献</div>
        {(['KS','KDF','KT','KRD'] as GroupKey[]).map(g => {
          const grp = byGroup[g];
          const pct = totalThrust > 0 ? (grp.thrust / totalThrust) * 100 : 0;
          return (
            <div key={g} className="mb-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-3 h-3 rounded-full" style={{ background: GROUP_COLORS[g] }} />
                <span className="val-mono" style={{ color: GROUP_COLORS[g] }}>{g}</span>
                <span className="text-[10px] text-fg-mute">{GROUP_LABELS[g]}</span>
                <span className="text-[10px] text-fg-dim">({grp.count} 电机)</span>
                <span className="ml-auto">
                  <span className="val-mono">{grp.thrust.toFixed(1)}</span>
                  <span className="text-fg-dim text-[10px] mx-1">N</span>
                  <span className="text-fg-mute text-[10px]">({pct.toFixed(0)}%)</span>
                </span>
              </div>
              <div className="h-2 bg-panel-2 rounded overflow-hidden">
                <div className="h-full transition-all" style={{ width: pct+'%', background: GROUP_COLORS[g] }} />
              </div>
            </div>
          );
        })}

        <div className="card-section mt-4">每电机详表</div>
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-fg-mute border-b border-line">
              <th className="text-left p-1">Motor</th>
              <th className="text-left p-1">组</th>
              <th className="text-right p-1">归一 K%</th>
              <th className="text-right p-1">100% 推力 N</th>
              <th className="text-right p-1">50% 推力 N</th>
            </tr>
          </thead>
          <tbody>
            {MOTORS.map(m => (
              <tr key={m.id} className="border-b border-line/30">
                <td className="p-1 val-mono">{m.id}</td>
                <td className="p-1 val-mono" style={{ color: GROUP_COLORS[m.group] }}>{m.group}</td>
                <td className="p-1 text-right val-mono">{(kn[m.group]*100).toFixed(0)}</td>
                <td className="p-1 text-right val-mono">{(kn[m.group]*SINGLE_MOTOR_MAX_N).toFixed(1)}</td>
                <td className="p-1 text-right val-mono text-fg-mute">
                  {(Math.pow(0.5, 1.5) * kn[m.group] * SINGLE_MOTOR_MAX_N).toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-[10px] text-fg-dim mt-2">
          50% 推力 ≈ 100% × 0.354 (thrust ∝ throttle^1.5 非线性).
          单涵道满推 23.25 N @ 6S 满电 (QF2822 2300KV 64mm 12 叶).
        </div>
      </div>
    </div>
  );
}

function KVRow({ label, val, unit, color, big, hint }: { label: string; val: string; unit: string; color?: 'ok'|'warn'|'err'; big?: boolean; hint?: string }) {
  const cls = color === 'err' ? 'text-err' : color === 'warn' ? 'text-warn' : color === 'ok' ? 'text-ok' : 'text-fg';
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="label flex-1">{label}</span>
        <span className={'val-mono ' + (big ? 'text-[18px]' : 'text-[13px]') + ' ' + cls}>
          {val}<span className="text-fg-dim text-[10px] ml-1">{unit}</span>
        </span>
      </div>
      {hint && <div className="text-[9px] text-fg-dim text-right">{hint}</div>}
    </div>
  );
}

function ThrottleCurve({ totalThrust }: { totalThrust: number }) {
  // 画 thrust ∝ throttle^1.5 曲线 vs 线性对比
  return (
    <svg viewBox="0 0 200 100" className="w-full h-20">
      <line x1="20" y1="80" x2="195" y2="80" stroke="#2a3342" strokeWidth="1" />
      <line x1="20" y1="80" x2="20" y2="10" stroke="#2a3342" strokeWidth="1" />
      <text x="10" y="15" fill="#5a6374" fontSize="7">N</text>
      <text x="190" y="90" fill="#5a6374" fontSize="7">油门 %</text>
      {/* 线性 */}
      <line x1="20" y1="80" x2="195" y2="10" stroke="#5a6374" strokeWidth="1" strokeDasharray="2 2" />
      {/* 非线性 */}
      <path d={(() => {
        let d = 'M 20 80';
        for (let t = 0; t <= 100; t += 5) {
          const thr = Math.pow(t/100, 1.5);
          d += ` L ${20 + t * 1.75} ${80 - thr * 70}`;
        }
        return d;
      })()} stroke="#58b4ff" strokeWidth="1.5" fill="none" />
      {/* 机重水平线 */}
      {totalThrust > 0 && (
        <line x1="20" y1={80 - (VEHICLE_WEIGHT_N / totalThrust) * 70} x2="195" y2={80 - (VEHICLE_WEIGHT_N / totalThrust) * 70}
              stroke="#f25f5c" strokeWidth="1" strokeDasharray="3 2" />
      )}
      <text x="100" y="98" fill="#5a6374" fontSize="6">
        蓝=实际 thrust∝throttle^1.5 · 灰虚=线性参考 · 红虚=机重
      </text>
    </svg>
  );
}
