import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { Play, Square, AlertTriangle, ListChecks } from 'lucide-react';

// 7 路 tilt × 4 sub-step (中立→+swing→中立→-swing→中立 一共 4 段, 第 5 段并入下一路开头)
const TILT_ORDER = ['DFL', 'DFR', 'TL1', 'TR1', 'RDL', 'RDR', 'S_GROUP_TILT'] as const;
const SWING_PATTERN = [+1, 0, -1, 0];

const buildTiltSubs = (swing: number): string[] => {
  const subs: string[] = [];
  for (const id of TILT_ORDER) {
    for (const s of SWING_PATTERN) {
      const sign = s > 0 ? '+' : s < 0 ? '−' : '0';
      const val = s === 0 ? 'neutral' : `${sign}${swing}°`;
      subs.push(`${id} ${val}`);
    }
  }
  return subs;
};

export function Preflight() {
  const { params, setParam, simulateArmed } = useStore();
  const [playing, setPlaying] = useState(false);
  const [stageIdx, setStageIdx] = useState(-1);
  const [subIdx, setSubIdx]     = useState(-1);
  const timer = useRef<number | null>(null);

  const swing = params.PRE_SWING ?? 10;

  const STAGES: Array<{ name: string; subs: string[]; hint: string }> = [
    {
      name: 'STAGE 1: MOTOR GROUPS',
      subs: ['S 斜吹 (KS)', 'DF 前下吹 (KDF)', 'T 后推 (KT)', 'RD 后斜下 (KRD)'],
      hint: '4 组依次怠速, 每组 grp_ms. tilt 全归 abs=45°',
    },
    {
      name: 'STAGE 2: TILT SWEEP ±' + swing + '°',
      subs: buildTiltSubs(swing),
      hint: '7 路 tilt 依次 ±swing° 扫描 (中立 abs=45°). S 摆动时 DFL/DFR 反向补偿 (软解耦验证)',
    },
    {
      name: 'STAGE 3: STAB FEEDBACK',
      subs: ['pitch+', 'pitch−', 'roll+', 'roll−', 'yaw+', 'yaw−'],
      hint: 'GEOM 反推应激活的电机怠速, 验证混控方向',
    },
    {
      name: 'STAGE 4: STICK CHECK',
      subs: ['pilot 摇杆遥控, 正反馈电机怠速 (无限时, 关 CHK 退出)'],
      hint: 'STAGE 3 与 4 必须激活同一组电机 — 交叉验证混控方向. 读 RC pitch/roll/yaw → mixer',
    },
  ];

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const start = () => {
    if (simulateArmed) { alert('❌ 已解锁 → 预检会被拒绝. 总览页取消解锁再试.'); return; }
    setPlaying(true); setStageIdx(0); setSubIdx(0);
  };
  const stop = () => {
    setPlaying(false); setStageIdx(-1); setSubIdx(-1);
    if (timer.current) clearTimeout(timer.current);
  };

  useEffect(() => {
    if (!playing || stageIdx < 0) return;
    if (stageIdx >= STAGES.length) { setPlaying(false); return; }
    const stage = STAGES[stageIdx];
    if (subIdx >= stage.subs.length) {
      setStageIdx(stageIdx + 1);
      setSubIdx(0);
      return;
    }
    timer.current = window.setTimeout(() => setSubIdx(subIdx + 1), params.PRE_GRP_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [playing, stageIdx, subIdx, params.PRE_GRP_MS]);

  const currentStage = stageIdx >= 0 && stageIdx < STAGES.length ? STAGES[stageIdx] : null;
  const currentSub = currentStage && subIdx < currentStage.subs.length ? currentStage.subs[subIdx] : null;

  return (
    <div className="grid grid-cols-12 gap-3">
      {/* PRE_ 参数 */}
      <div className="card col-span-5">
        <div className="card-title flex items-center gap-2"><ListChecks size={14} />PRE_ 参数</div>

        <ParamRow k="PRE_CH"     label="CH (RC 通道)"     unit="" />
        <ParamRow k="PRE_PWM"    label="PWM (怠速)"       unit="μs" />
        <ParamRow k="PRE_STOP"   label="STOP (停转)"      unit="μs" />
        <ParamRow k="PRE_GRP_MS" label="GRP_MS (每子步)"  unit="ms" />
        <ParamRow k="PRE_SWING"  label="SWING (TILT ±)"   unit="°" />

        <div className="card-section mt-4">安全说明</div>
        <ul className="text-[10px] text-fg-mute space-y-1 list-disc ml-4">
          <li>预检只在 <b>disarmed</b> 状态执行 (arming gate)</li>
          <li>中途 armed → 立即 ABORT 回混控</li>
          <li>STAGE 1 经 <code>tilt_driver.set_target</code> + <code>update()</code>,
              S→DF 软解耦补偿在所有路径生效</li>
          <li>STAGE 2/3 用 SRV_Channels:set_output_pwm_chan_timeout 直写 motor PWM</li>
          <li>飞行员不需推油门 (PRE_PWM=1100 自动怠速)</li>
        </ul>

        <div className="mt-3 flex items-center gap-2 bg-warn/15 border border-warn px-3 py-2 rounded text-warn text-[10px]">
          <AlertTriangle size={12} />
          STAGE 2 与 3 必须激活同一组电机 — 交叉验证 GEOM 方向
        </div>
      </div>

      {/* 模拟播放 */}
      <div className="card col-span-7">
        <div className="card-title">4 阶段模拟播放 (v7 兼容)</div>

        <div className="flex items-center gap-2 mb-3">
          {!playing ? (
            <button className="btn btn-primary" onClick={start}>
              <Play size={12} className="inline mr-1" /> 播放
            </button>
          ) : (
            <button className="btn btn-warn" onClick={stop}>
              <Square size={12} className="inline mr-1" /> 停止
            </button>
          )}
          {simulateArmed && (
            <span className="chip chip-err">
              <AlertTriangle size={10} /> 已解锁 · 预检会被拒
            </span>
          )}
        </div>

        {currentStage && (
          <div className="mb-3 p-3 bg-panel-2 rounded">
            <div className="text-[10px] text-fg-mute mb-1">当前阶段</div>
            <div className="val-mono text-[16px] text-accent mb-2">{currentStage.name}</div>
            <div className="text-[10px] text-fg-mute mb-1">子步 {subIdx+1}/{currentStage.subs.length}</div>
            <div className="val-mono text-[13px]">{currentSub || '(完成, 切下一阶段)'}</div>
            <div className="mt-2 h-1 bg-panel-3 rounded overflow-hidden">
              <div className="h-full bg-accent transition-all"
                   style={{ width: `${((subIdx+1) / currentStage.subs.length) * 100}%` }} />
            </div>
          </div>
        )}

        <div className="space-y-2">
          {STAGES.map((s, i) => {
            const done = i < stageIdx;
            const active = i === stageIdx;
            return (
              <div key={i} className={
                'border rounded p-2 ' +
                (active ? 'border-accent bg-accent/5' :
                 done   ? 'border-ok/50  bg-ok/5' :
                          'border-line')
              }>
                <div className="flex items-center gap-2">
                  <span className={'w-5 h-5 rounded-full flex items-center justify-center text-[10px] val-mono ' +
                    (done ? 'bg-ok text-bg' : active ? 'bg-accent text-bg' : 'bg-panel-2 text-fg-mute')}>
                    {i+1}
                  </span>
                  <span className={'val-mono ' + (active ? 'text-accent' : done ? 'text-ok' : '')}>{s.name}</span>
                  <span className="ml-auto text-[9px] text-fg-dim">
                    {s.subs.length} 子步 · ~{(s.subs.length * params.PRE_GRP_MS / 1000).toFixed(0)}s
                  </span>
                </div>
                <div className="mt-1 pl-7 text-[10px] text-fg-dim italic">{s.hint}</div>
                {active && (
                  <div className="mt-1 text-[10px] text-fg-mute pl-7 space-y-0.5 max-h-32 overflow-y-auto">
                    {s.subs.map((sub, j) => (
                      <div key={j} className={j === subIdx ? 'text-accent val-mono' : j < subIdx ? 'text-ok opacity-50' : ''}>
                        {j === subIdx ? '▶ ' : j < subIdx ? '✓ ' : '  '}{sub}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ParamRow({ k, label, unit }: { k: string; label: string; unit: string }) {
  const { params, setParam } = useStore();
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="label flex-1">{label}</span>
      <input type="number" step={k === 'PRE_PWM' || k === 'PRE_STOP' || k === 'PRE_GRP_MS' ? 10 : 1}
             value={params[k]}
             onChange={e => setParam(k, parseFloat(e.target.value) || 0)}
             className="input w-24 val-mono text-right" />
      {unit && <span className="text-[10px] text-fg-dim w-6">{unit}</span>}
    </div>
  );
}
