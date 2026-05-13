// v9 P7: WIG_AUTO debug tab
//
// 4 个 section:
//   1. Mode + Phase 状态 (read-only, STATUSTEXT 流解析)
//   2. V + Sensor 实时数据 (read-only, MSK3/4/5/8 + ATTITUDE + VFR_HUD)
//   3. SIM Tools (write-only, WIGA_SIM_* SITL 用)
//   4. Mode + Strategy 选择 (write-only WIGA_*, set_mode 紧急按钮)
//
// 数据流:
//   - STATUSTEXT 'WIG_AUTO phase → XXX'         → phase 状态机
//   - STATUSTEXT 'WIG_AUTO start: profile=...'   → run state latch
//   - STATUSTEXT 'WIG dispatcher: X → Y'         → ArduPilot mode 切换
//   - ATTITUDE pitch/roll/yaw                    → 实时姿态 (注意 quadplane view 帧)
//   - VFR_HUD airspeed                           → V actual
//   - heartbeat.mode                             → ArduPilot mode 字符串

import React, { useEffect, useState, useRef } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';
import { useStore } from '../../store/useStore';
import { paramRange } from '../../lib/defaults';
import { AlertTriangle, Gauge, RotateCcw, Send } from 'lucide-react';

// ───────────────────────────── Phase 状态机 ─────────────────────────────
const PHASE_NAMES = [
  'IDLE', 'FLOAT_TAXI', 'TRANS_A', 'TRANS_B', 'TRANS_C',
  'CRUISE', 'TURN', 'DECEL_A', 'DECEL_B', 'DECEL_C',
  'ABORT_L1', 'EMERGENCY',
] as const;
type PhaseName = typeof PHASE_NAMES[number];

// 用户视图上的"主链" — 异常 phase 不在线性流程里
const MAIN_FLOW: PhaseName[] = [
  'IDLE', 'FLOAT_TAXI', 'TRANS_A', 'TRANS_B', 'TRANS_C', 'CRUISE',
  'TURN', 'DECEL_A', 'DECEL_B', 'DECEL_C',
];

// ArduPilot Plane custom mode ID (跟 wig_dispatcher.lua / wig_auto.lua 一致)
const MODE_QSTAB    = 17;
const MODE_WIG_AUTO = 27;
const MODE_WIG_RECV = 29;

const MODE_LABELS: Record<number, string> = {
  [MODE_QSTAB]:    'QSTAB MANUAL (17)',
  [MODE_WIG_AUTO]: 'WIG Auto (27)',
  [MODE_WIG_RECV]: 'WIG Recover (29)',
};

// ───────────────────────────── 解析 STATUSTEXT ─────────────────────────────
interface RunState {
  profile: string;
  cruise: string;
  strat: string;
  v_tgt: number;
}

function parsePhase(text: string): PhaseName | null {
  const m = text.match(/WIG_AUTO phase\s*[→\->]+\s*(\w+)/);
  if (!m) return null;
  const name = m[1] as PhaseName;
  return (PHASE_NAMES as readonly string[]).includes(name) ? name : null;
}

function parseRunState(text: string): RunState | null {
  // 'WIG_AUTO start: profile=MATRIX cruise=FRONT_VENT strat=STEADY V_TGT=7.0'
  const m = text.match(/WIG_AUTO start:\s*profile=(\w+)\s+cruise=(\w+)\s+strat=(\w+)\s+V_TGT=([\d.]+)/);
  if (!m) return null;
  return { profile: m[1], cruise: m[2], strat: m[3], v_tgt: parseFloat(m[4]) };
}

function parseDispatcherMode(text: string): number | null {
  // 'WIG dispatcher: <from> → <to>'  各 mode 名跟 ArduPilot 一致 (QSTAB / WIG_AUTO / WIG_RECV)
  const m = text.match(/WIG dispatcher:\s*\S+\s*[→\->]+\s*(\S+)/);
  if (!m) return null;
  const name = m[1].toUpperCase();
  if (name.includes('AUTO')) return MODE_WIG_AUTO;
  if (name.includes('RECV') || name.includes('RECOVER')) return MODE_WIG_RECV;
  if (name.includes('QSTAB') || name.includes('MANUAL')) return MODE_QSTAB;
  return null;
}

// ───────────────────────────── 子组件 ─────────────────────────────

interface CardProps { title: string; children: React.ReactNode; }
function Card({ title, children }: CardProps) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      {children}
    </div>
  );
}

interface SliderRowProps {
  paramKey: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  unit?: string;
}
function SliderRow({ paramKey, label, value, onChange, disabled, unit }: SliderRowProps) {
  const r = paramRange(paramKey);
  return (
    <div className="grid grid-cols-[140px_1fr_80px] gap-2 items-center">
      <label className="text-[11px] text-fg-mute">{label}</label>
      <input
        type="range"
        min={r.min}
        max={r.max}
        step={r.step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        className="accent-accent"
      />
      <span className="val-mono text-[11px] text-right">
        {value.toFixed(r.step >= 1 ? 0 : r.step >= 0.1 ? 1 : 2)}
        {unit && <span className="text-fg-dim ml-1">{unit}</span>}
      </span>
    </div>
  );
}

interface RadioRowProps {
  label: string;
  options: { label: string; value: number }[];
  value: number;
  onChange: (v: number) => void;
}
function RadioRow({ label, options, value, onChange }: RadioRowProps) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 items-center">
      <label className="text-[11px] text-fg-mute">{label}</label>
      <div className="flex gap-2">
        {options.map(o => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={'btn flex-1 text-[11px] ' + (value === o.value ? 'btn-primary' : '')}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── 主组件 ─────────────────────────────

export function Auto() {
  const { params, setParam } = useStore();

  // — 1. 状态机相关 (STATUSTEXT 解析) —
  const [phase, setPhase] = useState<PhaseName>('IDLE');
  const [arduMode, setArduMode] = useState<number | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [recentMsgs, setRecentMsgs] = useState<string[]>([]);

  // — 2. 实时遥测 (50Hz throttle 显示) —
  const [tlm, setTlm] = useState<{
    airspeed: number;
    pitch_deg: number;
    roll_deg: number;
    yaw_deg: number;
  }>({ airspeed: 0, pitch_deg: 0, roll_deg: 0, yaw_deg: 0 });

  // ArduPilot Plane custom mode 映射 (heartbeat.mode 是字符串, 我们看 dispatcher STATUSTEXT 拿 mode id)
  // 但 heartbeat 没传 custom_mode 数值, 只能靠 STATUSTEXT
  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'attitude') {
        setTlm(t => ({
          ...t,
          pitch_deg: m.pitch * 180 / Math.PI,
          roll_deg: m.roll * 180 / Math.PI,
          yaw_deg: ((m.yaw * 180 / Math.PI) + 360) % 360,
        }));
      } else if (m.type === 'vfr_hud') {
        setTlm(t => ({ ...t, airspeed: m.airspeed }));
      } else if (m.type === 'heartbeat') {
        // ArduPlane heartbeat.mode 字符串 (e.g. 'QSTABILIZE') — 自定义 27/29 通常显示为数字
        const s = m.mode;
        if (/auto/i.test(s) && /wig/i.test(s)) setArduMode(MODE_WIG_AUTO);
        else if (/recv|recov/i.test(s)) setArduMode(MODE_WIG_RECV);
        else if (/qstab|stabilize/i.test(s)) setArduMode(MODE_QSTAB);
      } else if (m.type === 'statustext') {
        const p = parsePhase(m.text);
        if (p) setPhase(p);
        const rs = parseRunState(m.text);
        if (rs) setRunState(rs);
        const mode = parseDispatcherMode(m.text);
        if (mode != null) setArduMode(mode);
        if (/wig/i.test(m.text)) {
          setRecentMsgs(arr => [...arr.slice(-9), `[${new Date().toLocaleTimeString()}] ${m.text}`]);
        }
      }
    });
    return () => { off(); };
  }, []);

  // — 写参数 helper (双写 store + FC) —
  const push = (k: string, v: number) => {
    setParam(k, v);
    if (gcs.isConnected()) gcs.setParam(k, v);
  };

  // — 紧急按钮 —
  const forceIdle = () => {
    if (!gcs.isConnected()) return;
    gcs.setParam('WIGA_SIM_V', 0);
    setParam('WIGA_SIM_V', 0);
    gcs.setMode(MODE_QSTAB);
  };

  // Phase index for progress bar
  const phaseIdx = MAIN_FLOW.indexOf(phase);
  const isAbnormal = phase === 'ABORT_L1' || phase === 'EMERGENCY';

  // KTC / Layer 没有 dedicated MAVLink msg — 暂时从 STATUSTEXT 抽 (P7 后 add MSK8 stream)
  // 这里 placeholder, 实测后 add log_msg listener

  return (
    <div className="space-y-3">
      {!gcs.isConnected() && (
        <div className="card border-warn">
          <div className="text-warn text-[12px] flex items-center gap-2">
            <AlertTriangle size={14} /> 未连接 mavbridge.py — 实时数据 / 参数写入不可用
          </div>
        </div>
      )}

      {/* ═════════ Section 1: Mode + Phase 状态 ═════════ */}
      <Card title="Mode + Phase 状态 (read-only, STATUSTEXT 流)">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] text-fg-mute mb-1">ArduPilot Mode</div>
            <div className="val-mono text-[14px] text-accent">
              {arduMode != null ? MODE_LABELS[arduMode] || `Mode ${arduMode}` : '— (未知)'}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-fg-mute mb-1">Phase</div>
            <div className={'val-mono text-[14px] ' + (isAbnormal ? 'text-err' : 'text-accent')}>
              {phase} (Phase {MAIN_FLOW.indexOf(phase) >= 0 ? `${phaseIdx + 1}/${MAIN_FLOW.length}` : '!'})
            </div>
          </div>
        </div>

        {/* Phase progress bar — 主链可视化 */}
        <div className="mt-3 flex flex-wrap items-center gap-1 text-[10px] val-mono">
          {MAIN_FLOW.map((p, i) => {
            const passed = phaseIdx >= 0 && i < phaseIdx;
            const current = phaseIdx >= 0 && i === phaseIdx;
            return (
              <React.Fragment key={p}>
                <span
                  className={
                    'px-1.5 py-0.5 rounded ' +
                    (current ? 'bg-accent text-bg font-semibold' :
                     passed ? 'text-ok' :
                     'text-fg-dim')
                  }
                >
                  {passed && '✓'}{current && '▶'}{p}
                </span>
                {i < MAIN_FLOW.length - 1 && <span className="text-fg-dim">→</span>}
              </React.Fragment>
            );
          })}
        </div>
        {isAbnormal && (
          <div className="mt-2 text-warn text-[11px] flex items-center gap-1.5">
            <AlertTriangle size={12} /> 异常 phase: {phase} (脱离主链)
          </div>
        )}

        {/* Latched run state (arm 时锁) */}
        <div className="mt-3 text-[11px] border-t border-line pt-2">
          <div className="text-fg-mute mb-1">Run state (armed 边沿 latch):</div>
          <div className="val-mono">
            cruise_mode = <span className="text-accent">{runState?.cruise ?? '— (待 STATUSTEXT)'}</span>
            <span className="text-fg-dim ml-1">
              (WIGA_CRUISE_MODE = {params.WIGA_CRUISE_MODE?.toFixed(0)})
            </span>
          </div>
          <div className="val-mono">
            strategy    = <span className="text-accent">{runState?.strat ?? '—'}</span>
            <span className="text-fg-dim ml-1">
              (WIGA_TRANS_STRAT = {params.WIGA_TRANS_STRAT?.toFixed(0)})
            </span>
          </div>
          <div className="val-mono">
            profile     = <span className="text-accent">{runState?.profile ?? '— (ch7 latch)'}</span>
          </div>
          <div className="val-mono">
            V_TGT runtime = <span className="text-accent">{runState?.v_tgt?.toFixed(1) ?? '—'}</span> m/s
          </div>
        </div>

        {/* Recent WIG STATUSTEXT (debug) */}
        {recentMsgs.length > 0 && (
          <details className="mt-3 text-[10px]">
            <summary className="cursor-pointer text-fg-mute">最近 WIG STATUSTEXT ({recentMsgs.length})</summary>
            <div className="val-mono max-h-32 overflow-auto mt-1 bg-bg/40 p-1 rounded">
              {recentMsgs.map((m, i) => <div key={i}>{m}</div>)}
            </div>
          </details>
        )}
      </Card>

      {/* ═════════ Section 2: V + Sensor 实时数据 ═════════ */}
      <Card title="V + Sensor 实时数据 (read-only)">
        <div className="grid grid-cols-4 gap-3">
          <SensorBox
            label="V actual / target"
            value={`${tlm.airspeed.toFixed(1)} / ${(runState?.v_tgt ?? params.WIGA_V_TGT).toFixed(1)}`}
            unit="m/s"
            color={Math.abs(tlm.airspeed - (runState?.v_tgt ?? params.WIGA_V_TGT)) < (params.WIGA_V_OK_W ?? 0.7)
              ? 'ok' : 'warn'}
          />
          <SensorBox
            label="Body pitch"
            value={tlm.pitch_deg.toFixed(1)}
            unit="°"
            color={Math.abs(tlm.pitch_deg) > (params.WIGA_P_RECV_W ?? 30)
              ? 'err'
              : Math.abs(tlm.pitch_deg) > (params.WIGA_P_ENV_W ?? 15) ? 'warn' : 'fg'}
          />
          <SensorBox
            label="Body roll"
            value={tlm.roll_deg.toFixed(1)}
            unit="°"
            color={Math.abs(tlm.roll_deg) > (params.WIGA_R_RECV_W ?? 40)
              ? 'err'
              : Math.abs(tlm.roll_deg) > (params.WIGA_ROLL_OK_W ?? 5) ? 'warn' : 'fg'}
          />
          <SensorBox
            label="Heading (yaw)"
            value={tlm.yaw_deg.toFixed(0)}
            unit="°"
            color="fg"
          />
        </div>
        <div className="mt-2 text-[10px] text-fg-dim">
          注意: MAVLink ATTITUDE.pitch 是 quadplane view 帧 (减 Q_TRIM_PITCH). 真实 body = view + Q_TRIM_PITCH.
        </div>
        <div className="mt-1 text-[10px] text-fg-dim">
          KTC / Layer / V_PI 输出 (MSK5/MSK8) 暂未 stream 到 MAVLink — 看 BIN log 或 P8 加 NAMED_VALUE_FLOAT.
        </div>
      </Card>

      {/* ═════════ Section 3: SIM Tools ═════════ */}
      <Card title="SIM Tools (SITL phase chain 测试用, 实飞勿用)">
        <div className="mb-2">
          <RadioRow
            label="WIGA_SIM_EN"
            value={params.WIGA_SIM_EN ?? 0}
            onChange={v => push('WIGA_SIM_EN', v)}
            options={[
              { label: 'OFF (实传感器)', value: 0 },
              { label: 'ON  (虚拟传感器)', value: 1 },
            ]}
          />
        </div>
        <div className="space-y-2">
          <SliderRow
            paramKey="WIGA_SIM_V"
            label="WIGA_SIM_V"
            value={params.WIGA_SIM_V ?? 0}
            onChange={v => push('WIGA_SIM_V', v)}
            disabled={(params.WIGA_SIM_EN ?? 0) < 0.5}
            unit="m/s"
          />
          <SliderRow
            paramKey="WIGA_SIM_V_RAMP"
            label="WIGA_SIM_V_RAMP"
            value={params.WIGA_SIM_V_RAMP ?? 0}
            onChange={v => push('WIGA_SIM_V_RAMP', v)}
            disabled={(params.WIGA_SIM_EN ?? 0) < 0.5}
            unit="m/s²"
          />
          <SliderRow
            paramKey="WIGA_SIM_PITCH"
            label="WIGA_SIM_PITCH"
            value={params.WIGA_SIM_PITCH ?? 0}
            onChange={v => push('WIGA_SIM_PITCH', v)}
            disabled={(params.WIGA_SIM_EN ?? 0) < 0.5}
            unit="°"
          />
          <SliderRow
            paramKey="WIGA_SIM_ROLL"
            label="WIGA_SIM_ROLL"
            value={params.WIGA_SIM_ROLL ?? 0}
            onChange={v => push('WIGA_SIM_ROLL', v)}
            disabled={(params.WIGA_SIM_EN ?? 0) < 0.5}
            unit="°"
          />
        </div>
        <button
          onClick={() => {
            push('WIGA_SIM_V', 0);
            push('WIGA_SIM_V_RAMP', 0);
            push('WIGA_SIM_PITCH', 0);
            push('WIGA_SIM_ROLL', 0);
          }}
          disabled={(params.WIGA_SIM_EN ?? 0) < 0.5}
          className="btn mt-2 text-[11px]"
        >
          <RotateCcw size={11} className="inline mr-1" /> 重置 SIM 全 0
        </button>
      </Card>

      {/* ═════════ Section 4: Mode + Strategy 选择 ═════════ */}
      <Card title="Mode + Strategy 选择 (write WIGA_*, set_mode)">
        <div className="space-y-2">
          <RadioRow
            label="Cruise Mode"
            value={params.WIGA_CRUISE_MODE ?? 0}
            onChange={v => push('WIGA_CRUISE_MODE', v)}
            options={[
              { label: 'FRONT_VENT (前出气)', value: 0 },
              { label: 'REAR_VENT (后出气)',  value: 1 },
            ]}
          />
          <RadioRow
            label="Strategy"
            value={params.WIGA_TRANS_STRAT ?? 0}
            onChange={v => push('WIGA_TRANS_STRAT', v)}
            options={[
              { label: 'STEADY (慢推)', value: 0 },
              { label: 'BURST  (速推)', value: 1 },
            ]}
          />
          <RadioRow
            label="Factor Scale"
            value={params.WIGA_FAC_SCL ?? 0}
            onChange={v => push('WIGA_FAC_SCL', v)}
            options={[
              { label: 'OFF (默认)', value: 0 },
              { label: 'ON (按 mode 改 KS/KDF)', value: 1 },
            ]}
          />
          <RadioRow
            label="ch10 V_TGT"
            value={params.WIGA_V_CH10_EN ?? 0}
            onChange={v => push('WIGA_V_CH10_EN', v)}
            options={[
              { label: 'static (GCS)',  value: 0 },
              { label: 'dynamic (ch10)', value: 1 },
            ]}
          />
          <RadioRow
            label="Preflight"
            value={params.WIGA_PREFLT_REQ ?? 1}
            onChange={v => push('WIGA_PREFLT_REQ', v)}
            options={[
              { label: 'skip (SITL/紧急)', value: 0 },
              { label: 'required',         value: 1 },
            ]}
          />
          <SliderRow
            paramKey="WIGA_V_TGT"
            label="V_TGT static"
            value={params.WIGA_V_TGT ?? 7.0}
            onChange={v => push('WIGA_V_TGT', v)}
            disabled={(params.WIGA_V_CH10_EN ?? 0) >= 0.5}
            unit="m/s"
          />
        </div>

        {/* Emergency buttons */}
        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[11px] text-fg-mute mb-2 flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-warn" /> 紧急按钮 (直发 MAV_CMD_DO_SET_MODE)
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={forceIdle}
              disabled={!gcs.isConnected()}
              className="btn text-[11px] border-err text-err hover:bg-err/10"
              title="WIGA_SIM_V=0 + set_mode(17 QSTAB)"
            >
              <RotateCcw size={11} className="inline mr-1" /> Force IDLE
            </button>
            <button
              onClick={() => gcs.setMode(MODE_QSTAB)}
              disabled={!gcs.isConnected()}
              className="btn text-[11px]"
            >
              <Send size={11} className="inline mr-1" /> Set mode 17 QSTAB
            </button>
            <button
              onClick={() => gcs.setMode(MODE_WIG_AUTO)}
              disabled={!gcs.isConnected()}
              className="btn btn-primary text-[11px]"
            >
              <Send size={11} className="inline mr-1" /> Set mode 27 WIG_AUTO
            </button>
            <button
              onClick={() => gcs.setMode(MODE_WIG_RECV)}
              disabled={!gcs.isConnected()}
              className="btn text-[11px] border-warn text-warn hover:bg-warn/10"
            >
              <Send size={11} className="inline mr-1" /> Set mode 29 WIG_RECV
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ───────────────────────────── 小工具 ─────────────────────────────

interface SensorBoxProps {
  label: string;
  value: string;
  unit: string;
  color: 'ok' | 'warn' | 'err' | 'fg';
}
function SensorBox({ label, value, unit, color }: SensorBoxProps) {
  const cls =
    color === 'ok'   ? 'text-ok'   :
    color === 'warn' ? 'text-warn' :
    color === 'err'  ? 'text-err'  :
                       'text-fg';
  return (
    <div className="bg-bg/40 border border-line rounded p-2">
      <div className="text-[10px] text-fg-mute">{label}</div>
      <div className={'val-mono text-[16px] ' + cls}>
        {value} <span className="text-[10px] text-fg-dim">{unit}</span>
      </div>
    </div>
  );
}
