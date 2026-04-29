import React, { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { gcs } from '../../lib/gcs';
import { Play, Square, AlertTriangle, ListChecks, Zap, StopCircle } from 'lucide-react';
import { MOTORS } from '../../lib/actuators';

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
    <div className="space-y-3">
      {/* 电机测试 (绕过 lua + Motors disarmed 限制, 用 ArduPilot 自带 MOTOR_TEST) */}
      <MotorTestPanel />

      <div className="grid grid-cols-12 gap-3">
      {/* PRE_ 参数 */}
      <div className="card col-span-5">
        <div className="card-title flex items-center gap-2"><ListChecks size={14} />PRE_ 参数</div>

        <ParamRow k="PRE_CH"     label="CH (RC 通道)"     unit="ch" />
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
    </div>
  );
}

// ─── 电机测试 (MAV_CMD_DO_MOTOR_TEST = 209) ───
// 绕过 ArduPlane Q_M_PWM disarmed 强制 0, 不需 arm 也能让 ESC 真转.
// 走 mavlink, 不经 lua, 不经 Motors_Multicopter disarmed 拦截.
function MotorTestPanel() {
  const [throttlePct, setThrottlePct] = useState(5);
  const [timeoutSec, setTimeoutSec] = useState(2);
  const [lastTested, setLastTested] = useState<number | null>(null);
  const [connected, setConnected] = useState(gcs.isConnected());

  useEffect(() => {
    const off = gcs.on(m => { if (m.type === 'status') setConnected(m.connected); });
    setConnected(gcs.isConnected());
    return () => { off(); };
  }, []);

  const test = (motor: number) => {
    if (!connected) return;
    gcs.motorTest(motor, throttlePct, timeoutSec);
    setLastTested(motor);
    setTimeout(() => setLastTested(null), timeoutSec * 1000 + 500);
  };
  const stopAll = () => gcs.motorTestStop();

  return (
    <div className="card">
      <div className="card-title flex items-center gap-2 mb-2">
        <Zap size={14} className="text-warn" />
        <span>电机测试 (MAVLINK MOTOR_TEST · 不需 arm)</span>
        {!connected && <span className="chip text-[9px] text-warn ml-auto">未连接 FC</span>}
      </div>
      <div className="flex items-center gap-3 mb-2 text-[11px]">
        <span className="text-fg-dim">油门</span>
        <input type="number" min={1} max={50} step={1} value={throttlePct}
               onChange={e => setThrottlePct(Math.max(1, Math.min(50, parseInt(e.target.value) || 5)))}
               className="input val-mono w-16 text-right" />
        <span className="text-fg-dim">%</span>
        <span className="text-fg-dim ml-3">时长</span>
        <input type="number" min={1} max={10} step={1} value={timeoutSec}
               onChange={e => setTimeoutSec(Math.max(1, Math.min(10, parseInt(e.target.value) || 2)))}
               className="input val-mono w-16 text-right" />
        <span className="text-fg-dim">秒</span>
        <button onClick={stopAll} disabled={!connected}
                className="btn btn-warn ml-auto disabled:opacity-50">
          <StopCircle size={12} className="inline mr-1" />全停
        </button>
      </div>
      {/* 12 个 motor 按钮, 6 列 2 行 */}
      <div className="grid grid-cols-6 gap-2">
        {MOTORS.map((m, i) => {
          const motorIdx = i + 1;  // mavlink motor_instance 是 1-based
          const active = lastTested === motorIdx;
          return (
            <button key={m.id}
                    onClick={() => test(motorIdx)}
                    disabled={!connected || lastTested !== null}
                    className={'btn flex flex-col items-center py-2 text-[10px] disabled:opacity-50 ' +
                               (active ? 'btn-primary animate-pulse' : '')}>
              <span className="val-mono font-semibold">{motorIdx}</span>
              <span className="text-[9px] text-fg-dim">{m.id}</span>
              <span className="text-[8px] text-fg-mute">{m.group}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-[10px] text-fg-mute leading-snug">
        <b>用法</b>: 地面, 飞控通电不解锁, 点对应 motor 按钮 → ESC 转 {throttlePct}% × {timeoutSec}s 后自动停.
        如果 motor 不转 → ESC 没解锁信号 / 接线错 / DShot 协议不匹配 (Q_M_PWM_TYPE).
        <span className="text-warn"> ⚠ 必须空载 (移除桨叶或绑死), 否则飞机会跑.</span>
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
      {/* unit span 总是渲染 (即使空也保留 w-8 占位, 让 5 行 input 右边对齐) */}
      <span className="text-[10px] text-fg-dim w-8 shrink-0">{unit}</span>
    </div>
  );
}
