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

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';
import { useStore } from '../../store/useStore';
import { paramRange } from '../../lib/defaults';
import { NumInput } from '../common/NumInput';
import { AlertTriangle, Gauge, RotateCcw, Send, Save } from 'lucide-react';

// ───────────────────────────── Phase 状态机 (P7.9.4: 6 phase) ─────────────────────────────
const PHASE_NAMES = [
  'IDLE', 'FLOAT_TAXI', 'TRANSITION', 'CRUISE', 'DECEL', 'EMERGENCY',
] as const;
type PhaseName = typeof PHASE_NAMES[number];

// 用户视图上的"主链" — 异常 phase 不在线性流程里
const MAIN_FLOW: PhaseName[] = [
  'IDLE', 'FLOAT_TAXI', 'TRANSITION', 'CRUISE', 'DECEL',
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

// P7.8ω: 实飞前检查 — 列所有可能挂飞的参数 + 安全 gate
type CheckResult = { sev: 'err'|'warn'|'ok'; label: string; cur: string; expected: string; note?: string };

function runPreflightChecks(params: Record<string, number>): CheckResult[] {
  const results: CheckResult[] = [];
  const v = (k: string) => params[k];
  const check = (label: string, k: string, ok: (x: number)=>boolean, expected: string, sev: 'err'|'warn'='err', note?: string) => {
    const cur = v(k);
    const passing = cur !== undefined && ok(cur);
    results.push({ sev: passing ? 'ok' : sev, label, cur: cur !== undefined ? cur.toString() : '?', expected, note });
  };

  // ─── 安全 gate (必须正确, err) — P7.9.4 ───
  check('SIM 必须关',           'WIGA_SIM_EN',     x => x===0, '=0', 'err', '虚拟传感器不能实飞');
  check('GTEST 必须关',         'WIGA_GTEST_EN',   x => x===0, '=0', 'err', '锁 phase 不能实飞');
  check('SCR_ENABLE',           'SCR_ENABLE',      x => x===1, '=1', 'err', 'lua 没启用');
  check('Q_FRAME_CLASS',        'Q_FRAME_CLASS',   x => x===17, '=17', 'err', 'Dynamic Matrix');

  // ─── 速度参数 ───
  check('巡航 V_TGT',           'WIGA_V_TGT',      x => x>=3 && x<=15, '3-15 m/s', 'err', '<3 起不来');
  check('TRANSITION V_OK',      'WIGA_TX_V_OK',    x => x>=3 && x<=10, '3-10 m/s', 'err', '跃迁完成 V 阈值');
  check('V_PI I 项',            'MSK_V_PI_I',      x => x<=0.1,    '≤0.1 (default 0.02)', 'err', '太大 windup');
  check('V_INT_LIM',            'MSK_V_INT_LIM',   x => x>=2 && x<=10, '2-10', 'warn');

  // ─── Layer 1/2 abort 阈值 (P7.9.4 替代旧 envelope/emergency) ───
  check('Layer 1 body 阈值',    'WIGA_L1_BODY',    x => x>=10 && x<=20, '10-20°', 'warn', '软减油触发');
  check('Layer 1 rate 阈值',    'WIGA_L1_RATE',    x => x>=15 && x<=40, '15-40°/s', 'warn');
  check('Layer 2 body 阈值',    'WIGA_L2_BODY',    x => x>=15 && x<=30, '15-30°', 'warn', '硬截 disarm');
  check('Stick ANGLE_MAX',      'Q_A_ANGLE_MAX',   x => x>=5 && x<=20, '5-20', 'warn', 'stick → angle 上限');

  // ─── tilt servo BW (lua clamp [0.1, 5]) ───
  for (const sv of ['SGRP','DFL','DFR','TL1','TR1','RDL','RDR']) {
    check(`TLT_${sv}_BW`, `TLT_${sv}_BW`, x => x>=0.1 && x<=5.0, '0.1-5.0', 'warn',
      sv==='DFL'||sv==='DFR' ? 'default 4.0' : 'default 1.0');
  }

  // ─── ATC PID 在合理范围 ───
  check('ATC PIT rate P',       'Q_A_RAT_PIT_P',   x => x>=0.05 && x<=0.5, '0.05-0.5', 'warn');
  check('ATC RLL rate P',       'Q_A_RAT_RLL_P',   x => x>=0.05 && x<=0.5, '0.05-0.5', 'warn');

  // ─── EKF / GPS ───
  check('EK3 yaw 源',           'EK3_SRC1_YAW',    x => x===1 || x===3, '1=Compass / 3=GPS+Compass', 'warn', '室内 1, 户外 3');
  check('COMPASS_USE',          'COMPASS_USE',     x => x===1, '=1', 'warn');

  return results;
}

function PreflightCheckButton() {
  // P7.8ω 修: 直接 hook store 不依赖 props (避免 stale closure)
  const params = useStore(s => s.params);
  const [show, setShow] = useState(false);
  const results = useMemo(() => runPreflightChecks(params), [params, show]);
  const errs = results.filter(r => r.sev === 'err');
  const warns = results.filter(r => r.sev === 'warn');
  const oks = results.filter(r => r.sev === 'ok');
  const totalProblems = errs.length + warns.length;
  return (
    <>
      <button
        className={`btn text-[10px] py-0.5 px-2 mr-1 ${errs.length > 0 ? 'btn-err' : warns.length > 0 ? 'btn-warn' : 'btn-primary'}`}
        onClick={() => setShow(s => !s)}
        title="实飞前检查所有关键参数 + 安全 gate"
      >
        🚀 实飞检查 {totalProblems > 0 ? `(${errs.length}❌ ${warns.length}⚠)` : '✓'}
      </button>
      {show && (
        <div className="fixed top-20 right-4 z-50 bg-panel border border-line rounded p-3 shadow-2xl max-h-[80vh] overflow-auto text-[11px]" style={{minWidth: 480}}>
          <div className="flex items-center mb-2 sticky top-0 bg-panel pb-1 border-b border-line/40">
            <span className="font-bold flex-1">实飞前检查 ({oks.length} ✓ / {warns.length} ⚠ / {errs.length} ❌)</span>
            <button className="btn text-[10px] py-0.5 px-1.5" onClick={()=>setShow(false)}>关</button>
          </div>
          {[...errs, ...warns, ...oks].map((r, i) => (
            <div key={i} className={'flex items-start gap-2 py-0.5 ' +
                (r.sev==='err' ? 'text-err' : r.sev==='warn' ? 'text-warn' : 'text-fg-dim')}>
              <span className="w-4">{r.sev==='err'?'❌':r.sev==='warn'?'⚠':'✓'}</span>
              <span className="flex-1">{r.label}</span>
              <span className="val-mono w-20 text-right">{r.cur}</span>
              <span className="val-mono w-32 text-fg-mute">期望 {r.expected}</span>
              {r.note && <span className="text-[10px] text-fg-mute italic">({r.note})</span>}
            </div>
          ))}
          {errs.length > 0 && (
            <div className="mt-2 pt-2 border-t border-line text-err font-bold">
              ⚠ {errs.length} 个 error 阻飞, 必须修复才能解锁
            </div>
          )}
        </div>
      )}
    </>
  );
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
  // P7.8γ: liveQTrim NVF "QTRIM" (lua 推) - 用 ref 避免 attitude useEffect 重订
  const liveQTrimRef = useRef<number>(0);

  // P7.8: 拨杆/K_eff 段移到 GCS tab. 这里只保留 phase/mode 状态机显示

  // ArduPilot Plane custom mode 映射 (heartbeat.mode 是字符串, 我们看 dispatcher STATUSTEXT 拿 mode id)
  // 但 heartbeat 没传 custom_mode 数值, 只能靠 STATUSTEXT
  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'attitude') {
        // P7.8γ: MAVLink ATTITUDE.pitch = view 帧 (= body - Q_TRIM_PITCH), Tuner 加回 liveQTrim 算 body.
        // liveQTrim 由 NVF "QTRIM" 推 (lua 5Hz). 收到前用 0 不加 (短暂窗口跟旧行为一致).
        setTlm(t => ({
          ...t,
          pitch_deg: m.pitch + (liveQTrimRef.current ?? 0),
          roll_deg: m.roll,
          yaw_deg: (m.yaw + 360) % 360,
        }));
      } else if (m.type === 'named_float' && m.name === 'QTRIM') {
        liveQTrimRef.current = m.value;
      } else if (m.type === 'named_float' && m.name === 'PHASE') {
        // P7.8δ: lua 直推 phase id, 不再靠 STATUSTEXT regex (中文 → 解析 + 错过事件不稳)
        const idx = Math.round(m.value);
        const name = PHASE_NAMES[idx];
        if (name) setPhase(name);
      } else if (m.type === 'vfr_hud') {
        setTlm(t => ({ ...t, airspeed: m.airspeed }));
      } else if (m.type === 'heartbeat') {
        // 优先用 custom_mode 数字 (Plane 27/29 自定义 mode_string_v10 返回 "Mode(27)" 无法识别)
        if (typeof m.custom_mode === 'number') {
          setArduMode(m.custom_mode);
        } else {
          const s = m.mode;
          if (/auto/i.test(s) && /wig/i.test(s)) setArduMode(MODE_WIG_AUTO);
          else if (/recv|recov/i.test(s)) setArduMode(MODE_WIG_RECV);
          else if (/qstab|stabilize/i.test(s)) setArduMode(MODE_QSTAB);
        }
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

  // — 立即写 (双写 store + FC, 用于命令/紧急按钮) —
  const push = (k: string, v: number) => {
    setParam(k, v);
    if (gcs.isConnected()) gcs.setParam(k, v);
  };
  // — 只写 store (用于调参, 等 Save 按钮再 push 到 FC) —
  const setLocal = (k: string, v: number) => setParam(k, v);

  // — Section 8 Phase 时序 sub-tab state —
  type PhaseTab = 'TAXI'|'TRANS'|'CRUISE'|'DECEL'|'YAW'|'GLOBAL';
  const [phTab, setPhTab] = useState<PhaseTab>('TAXI');

  // — Per-card save-style 状态 —
  // 每卡片 keys 是固定的, savedSnap 跟踪最近 saved 值
  const ALL_TUNABLE_KEYS = React.useMemo(() => [
    // P7.9.4: 全部 WIGA_/MSK_ 真实 lua 注册参数 (撤旧 WIGK_/FV_/RV_/DF_/DEC_*/TX_*/CRUISE_MODE/STRAT/FAC)
    // V 控制
    'WIGA_V_TGT','WIGA_V_CH10_EN','WIGA_PREFLT_REQ',
    'MSK_BPCH_G1','MSK_BPCH_G2',
    'MSK_V_MIN','MSK_V_MAX',
    // FLOAT_TAXI
    'WIGA_TAXI_DUR','WIGA_TAXI_THR_T',
    // TRANSITION (P7.9.4 新: K+ch3 lerp + V≥TX_V_OK → CRUISE)
    'WIGA_TX_DUR','WIGA_TX_V_OK','WIGA_TX_TO_MS',
    // CRUISE + 限时巡航
    'WIGA_CMAX_MS',
    // DECEL
    'WIGA_DECEL_MS','WIGA_DECEL_V_OFF',
    // Layer 1 (软减油)
    'WIGA_L1_BODY','WIGA_L1_RATE','WIGA_L1_MMS','WIGA_L1_CH3','WIGA_L1_R_PWM',
    'WIGA_L1_HOLD','WIGA_L1_REC_W','WIGA_L1_REC_MS',
    // Layer 2 (硬截 disarm)
    'WIGA_L2_BODY','WIGA_RATE_MMS',
    // Yaw P+I+D
    'WIGA_HDG_HOLD_EN','WIGA_HDG_KP','WIGA_HDG_KI','WIGA_HDG_KD','WIGA_HDG_I_LIM',
    // GTEST 地面测试
    'WIGA_GTEST_EN','WIGA_GTEST_PH','WIGA_GTEST_CAP',
    // Preflight
    'WIGA_PRE_SPEED',
    // SITL
    'WIGA_SIM_EN','WIGA_SIM_V','WIGA_SIM_PITCH','WIGA_SIM_ROLL',
  ], []);

  const [savedSnap, setSavedSnap] = useState<Record<string, number>>(() => {
    const s: Record<string, number> = {};
    for (const k of ALL_TUNABLE_KEYS) if (k in params) s[k] = params[k];
    return s;
  });
  // 连上 FC 1.5s 后同步 savedSnap (等 App-level autoSync 落 store)
  useEffect(() => {
    if (!gcs.isConnected()) return;
    const t = setTimeout(() => {
      const fresh = useStore.getState().params;
      const s: Record<string, number> = {};
      for (const k of ALL_TUNABLE_KEYS) if (k in fresh) s[k] = fresh[k];
      setSavedSnap(s);
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // 计算某 keys 子集的 dirty 列表
  const computeDirty = (keys: string[]) => keys.filter(k => {
    const cur = params[k];
    if (cur == null) return false;
    const snap = savedSnap[k];
    const step = paramRange(k).step ?? 0.001;
    const tol = step * 0.5;
    return snap == null || Math.abs(cur - snap) > tol;
  });

  // 保存某 keys 子集 (推到 FC, 更新 savedSnap)
  const saveKeys = (keys: string[], label: string) => {
    if (!gcs.isConnected()) {
      setSaveMsg('⚠ 未连接 FC');
      setTimeout(() => setSaveMsg(null), 3000);
      return;
    }
    const dirty = computeDirty(keys);
    if (dirty.length === 0) {
      setSaveMsg(`${label}: 无改动`);
      setTimeout(() => setSaveMsg(null), 2000);
      return;
    }
    for (const k of dirty) gcs.setParam(k, params[k]);
    setSavedSnap(prev => ({ ...prev, ...Object.fromEntries(dirty.map(k => [k, params[k]])) }));
    setSaveMsg(`✓ ${label}: 已保存 ${dirty.length} 个`);
    setTimeout(() => setSaveMsg(null), 3000);
  };

  // — Card 同步小工具栏 (放卡片标题旁) —
  const CardSync = ({ keys, label }: { keys: string[]; label: string }) => {
    const dirty = computeDirty(keys);
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <span className={dirty.length > 0 ? 'text-warn val-mono' : 'text-fg-dim val-mono'}>
          {dirty.length > 0 ? `未保存 ${dirty.length}` : '已同步'}
        </span>
        <button
          onClick={() => saveKeys(keys, label)}
          disabled={dirty.length === 0 || !gcs.isConnected()}
          className={'btn text-[11px] py-0.5 px-2 ' + (dirty.length > 0 ? 'btn-primary' : '')}
        >
          <Save size={11} className="inline mr-1" />保存
        </button>
      </div>
    );
  };

  // — ParamRow helper (Section 7/8 用, 改用 setLocal 不立即推) —
  const ParamRow = ({ k, label, unit, hint }: { k: string; label?: string; unit?: string; hint?: string }) => {
    const r = paramRange(k);
    return (
      <div className="grid grid-cols-[170px_90px_35px_1fr] gap-2 items-center text-[11px] py-0.5">
        <span className="text-fg-mute val-mono">{label || k}</span>
        <NumInput
          value={params[k] ?? 0}
          min={r.min} max={r.max} step={r.step}
          onCommit={v => setLocal(k, v)}
          className="input val-mono w-full text-right"
        />
        <span className="text-fg-dim text-[10px]">{unit || ''}</span>
        <span className="text-[10px] text-fg-dim">{hint || ''}</span>
      </div>
    );
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
  const isAbnormal = phase === 'EMERGENCY';   // P7.9.4 撤 ABORT_L1, dispatcher L1/L2 接管

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

      {/* 顶部全局 Save All toolbar */}
      <div className="card flex items-center gap-3 py-2">
        <span className="card-title mb-0 flex-1">模式配置同步 (调参 save 式, 改完点保存才下发 FC)</span>
        {(() => {
          const allDirty = computeDirty(ALL_TUNABLE_KEYS);
          return (
            <>
              <span className={'val-mono text-[11px] ' + (allDirty.length > 0 ? 'text-warn' : 'text-fg-dim')}>
                {allDirty.length > 0 ? `未保存 ${allDirty.length} 项` : '与 FC 一致'}
              </span>
              {saveMsg && <span className="val-mono text-[11px] text-accent">{saveMsg}</span>}
              <button
                onClick={() => saveKeys(ALL_TUNABLE_KEYS, '全部')}
                disabled={allDirty.length === 0 || !gcs.isConnected()}
                className={'btn flex items-center gap-1.5 disabled:opacity-50 ' + (allDirty.length > 0 ? 'btn-primary' : '')}
              >
                <Save size={12} /> 保存全部 ({allDirty.length})
              </button>
            </>
          );
        })()}
      </div>

      {/* ═════════ Section 1: Mode + Phase 状态 + 拨杆 + 实时 K (P7.7) ═════════ */}
      <Card title="Mode + Phase 状态 (read-only, FLTMODE_CH=6)">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] text-fg-mute mb-1">ArduPilot Mode (ch6 FLTMODE)</div>
            <div className="val-mono text-[14px] text-accent">
              {arduMode != null ? MODE_LABELS[arduMode] || `Mode ${arduMode}` : '— (未知)'}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-fg-mute mb-1">Phase (WIG_AUTO 状态机)</div>
            <div className={'val-mono text-[14px] ' + (isAbnormal ? 'text-err' : 'text-accent')}>
              {phase} {phaseIdx >= 0 ? `(${phaseIdx + 1}/${MAIN_FLOW.length})` : ''}
            </div>
          </div>
        </div>

        {/* P7.8: 拨杆 + 实时 K_eff 段移到 GCS tab 统一显示 (避免 dup, 公式以 lua NVF 为准) */}
        <div className="mt-3 pt-3 border-t border-line/40 text-[10px] text-fg-dim">
          ℹ 拨杆 PWM / 4 路 K_eff bar / Layer 显示 → 在 <b className="text-accent">GCS</b> tab (lua mixer 5Hz 推 NAMED_VALUE_FLOAT)
        </div>

        {/* Phase progress bar — 主链可视化 */}
        <div className="mt-3 pt-3 border-t border-line/40 flex flex-wrap items-center gap-1 text-[10px] val-mono">
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

        {/* Latched run state (arm 时锁) — P7.9.4 只剩 V_TGT */}
        <div className="mt-3 text-[11px] border-t border-line pt-2">
          <div className="text-fg-mute mb-1">Run state (armed 边沿 latch):</div>
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
            color={Math.abs(tlm.airspeed - (runState?.v_tgt ?? params.WIGA_V_TGT)) < 1.0
              ? 'ok' : 'warn'}
          />
          <SensorBox
            label="Body pitch"
            value={tlm.pitch_deg.toFixed(1)}
            unit="°"
            color={Math.abs(tlm.pitch_deg) > (params.WIGA_L2_BODY ?? 20)
              ? 'err'
              : Math.abs(tlm.pitch_deg) > (params.WIGA_L1_BODY ?? 15) ? 'warn' : 'fg'}
          />
          <SensorBox
            label="Body roll"
            value={tlm.roll_deg.toFixed(1)}
            unit="°"
            color={Math.abs(tlm.roll_deg) > (params.WIGA_L2_BODY ?? 20)
              ? 'err'
              : Math.abs(tlm.roll_deg) > (params.WIGA_L1_BODY ?? 15) ? 'warn' : 'fg'}
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

      {/* ═════════ Section 3: SIM 状态 (read-only + 强制关闭, 仅 SITL 用) ═════════ */}
      <Card title="SIM 虚拟传感器状态 (read-only, 仅 SITL)">
        {(() => {
          const simOn = (params.WIGA_SIM_EN ?? 0) >= 0.5;
          return (
            <>
              <div className="grid grid-cols-[200px_1fr] gap-2 items-center">
                <span className="text-[11px] text-fg-mute">WIGA_SIM_EN</span>
                <span className={'val-mono text-[12px] ' + (simOn ? 'text-err' : 'text-ok')}>
                  {simOn
                    ? '⚠ ON — 虚拟传感器输出, 实飞应为 OFF'
                    : '✓ OFF — 实传感器 (正常)'}
                </span>
              </div>
              {simOn && (
                <div className="mt-3 border-t border-line pt-2">
                  <div className="text-[10px] text-fg-mute mb-2">
                    SIM 仅 SITL 测试用. 地面站不直接控制 SIM_V/PITCH/ROLL/RAMP — 改用 SITL CLI 或 Params tab.
                    检测到开启时下方按钮可强制关闭:
                  </div>
                  <button
                    onClick={() => push('WIGA_SIM_EN', 0)}
                    className="btn text-[11px] border-err text-err hover:bg-err/10"
                  >
                    <RotateCcw size={11} className="inline mr-1" /> 强制关闭 SIM_EN
                  </button>
                  <div className="mt-2 text-[10px] text-fg-dim grid grid-cols-3 gap-1 val-mono">
                    <div>V = {(params.WIGA_SIM_V ?? 0).toFixed(1)}</div>
                    <div>Pitch = {(params.WIGA_SIM_PITCH ?? 0).toFixed(1)}°</div>
                    <div>Roll = {(params.WIGA_SIM_ROLL ?? 0).toFixed(1)}°</div>
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </Card>

      {/* GTEST 已搬到 "地面测试" 独立 tab — 不在 模式配置 里 */}

      {/* ═════════ Section 5: V + Preflight (P7.9.4 撤 mode/strategy/fac_scl) ═════════ */}
      <div className="card">
        <div className="flex items-center mb-3">
          <span className="card-title mb-0 flex-1">V 控制 + Preflight (P7.9.4 撤 cruise_mode/strategy/fac_scl)</span>
          <PreflightCheckButton />
          {CardSync({ keys: ['WIGA_V_CH10_EN','WIGA_PREFLT_REQ','WIGA_V_TGT','WIGA_CMAX_MS'], label: "V 控制" })}
        </div>
        <div className="space-y-2">
          <RadioRow
            label="ch10 V_TGT"
            value={params.WIGA_V_CH10_EN ?? 0}
            onChange={v => setLocal('WIGA_V_CH10_EN', v)}
            options={[
              { label: 'static (GCS WIGA_V_TGT)',  value: 0 },
              { label: 'dynamic (ch10 PWM 映射)', value: 1 },
            ]}
          />
          <RadioRow
            label="Preflight"
            value={params.WIGA_PREFLT_REQ ?? 1}
            onChange={v => setLocal('WIGA_PREFLT_REQ', v)}
            options={[
              { label: 'skip (SITL/紧急)', value: 0 },
              { label: 'required',         value: 1 },
            ]}
          />
          <SliderRow
            paramKey="WIGA_V_TGT"
            label="V_TGT static"
            value={params.WIGA_V_TGT ?? 6.0}
            onChange={v => setLocal('WIGA_V_TGT', v)}
            disabled={(params.WIGA_V_CH10_EN ?? 0) >= 0.5}
            unit="m/s"
          />
          <SliderRow
            paramKey="WIGA_CMAX_MS"
            label="限时巡航"
            value={params.WIGA_CMAX_MS ?? 0}
            onChange={v => setLocal('WIGA_CMAX_MS', v)}
            unit="ms (0=无限)"
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
      </div>

      {/* ═════════ Section 8: AUTO Phase 时序 & 角度 (6 sub-tab, P7.5a 移到 Manual 上面) ═════════ */}
      <div className="card">
        <div className="card-title">AUTO Phase 时序 & 角度 (WIGA_ 调参)</div>
        <div className="flex gap-1 mb-3 border-b border-line pb-2">
          {([
            ['TAXI',   '浮筒滑水'],
            ['TRANS',  '跃迁'],
            ['CRUISE', '巡航 (FV/RV/DF)'],
            ['DECEL',  '减速'],
            ['YAW',    'Yaw + TURN'],
            ['GLOBAL', '全局阈值'],
          ] as [PhaseTab, string][]).map(([id, lbl]) => (
            <button
              key={id}
              onClick={() => setPhTab(id)}
              className={'btn text-[11px] flex-1 ' + (phTab === id ? 'btn-primary' : '')}
            >{lbl}</button>
          ))}
        </div>

        {phTab === 'TAXI' && (() => {
          const keys = ['WIGA_TAXI_DUR','WIGA_TAXI_THR_T','WIGA_TAXI_THR_R'];
          return (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-fg-dim">浮筒滑水: K=TAXI 表 (lua 内置), ch3 自动 ramp 到目标值, base_pitch=4°</span>
                {CardSync({ keys, label: "TAXI" })}
              </div>
              {ParamRow({ k: "WIGA_TAXI_DUR",   unit: "ms",  hint: "浮筒滑水总时长, 跑完进 TRANSITION" })}
              {ParamRow({ k: "WIGA_TAXI_THR_T", unit: "",    hint: "末值油门 [0,1] (0.5=半推, 1.0=满推)" })}
              {ParamRow({ k: "WIGA_TAXI_THR_R", unit: "1/s", hint: "ch3 ramp 速率 (0.3=满推约 3s 到位)" })}
              <div className="mt-2 text-[10px] text-fg-dim pt-2 border-t border-line/30">
                K 表 P7.9.4 内置 wig_control: TAXI = {`{KS=0.3 KDF=0.3 KT=0.3 KRD=0.3}`}. base_pitch=MSK_BPCH_G1=4°.
              </div>
            </div>
          );
        })()}

        {phTab === 'TRANS' && (() => {
          const keys = ['WIGA_TX_DUR','WIGA_TX_V_OK','WIGA_TX_TO_MS'];
          return (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-fg-dim">TRANSITION (P7.9.4 单一 phase): K + ch3 同步 lerp TAXI→CRUISE, base_pitch=10°, V≥V_OK → CRUISE</span>
                {CardSync({ keys, label: "TRANSITION" })}
              </div>
              {ParamRow({ k: "WIGA_TX_DUR",   unit: "ms",  hint: "K + ch3 同步 lerp 时长 (默认 4000ms)" })}
              {ParamRow({ k: "WIGA_TX_V_OK",  unit: "m/s", hint: "跃迁成功阈值 V (达到即进 CRUISE)" })}
              {ParamRow({ k: "WIGA_TX_TO_MS", unit: "ms",  hint: "跃迁超时 (没达到 V_OK 自动 DECEL)" })}
              <div className="mt-2 text-[10px] text-fg-dim pt-2 border-t border-line/30">
                K 表 P7.9.4 内置: TRANS = {`{KS=0.8 KDF=0.5 KT=0.3 KRD=0.3}`} (跃迁慢推). 入口立即 base_pitch=10°.
                <br/>进 CRUISE 时 K_KT 一次性 0.3 → 0.5 (V_PI 中位).
              </div>
            </div>
          );
        })()}

        {phTab === 'CRUISE' && (() => {
          const keys = ['WIGA_V_TGT','WIGA_V_CH10_EN','WIGA_CMAX_MS'];
          return (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-fg-dim">稳态 cruise: V_PI 调 K_KT = 0.5 + V_COR (V_COR ±0.5 → K_KT ∈ [0, 1])</span>
                {CardSync({ keys, label: "CRUISE" })}
              </div>
              {ParamRow({ k: "WIGA_V_TGT",        unit: "m/s", hint: "V_PI 目标速度" })}
              {ParamRow({ k: "WIGA_V_CH10_EN",    unit: "0/1", hint: "=1 用 ch10 PWM 映射到 V_TGT (MSK_V_MIN/V_MAX 配)" })}
              {ParamRow({ k: "WIGA_CMAX_MS",unit: "ms",  hint: "限时巡航 (0=无限, >0=N ms 自动 DECEL). 配合 ch7 latch 启用" })}
              <div className="mt-2 text-[10px] text-fg-dim pt-2 border-t border-line/30">
                K=CRUISE 表 (KS=0.8 KDF=0.5 KT=0.5 KRD=0.5, manual G3 共用), V_PI 仅调 KT (= 0.5+V_COR ∈ [0,1]). ch3 锁 2000. base_pitch=10°.
                <br/>限时启用: armed 时 ch7&lt;1300 latch _test_mode, V_PI 起算 N ms → DECEL.
              </div>
            </div>
          );
        })()}

        {phTab === 'DECEL' && (() => {
          const keys = ['WIGA_DECEL_MS','WIGA_DECEL_V_OFF'];
          return (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-fg-dim">缓降单一 phase (P7.9.4): K_KT 0.5→0, ch3 2000→1100 over DECEL_MS</span>
                {CardSync({ keys, label: "DECEL" })}
              </div>
              {ParamRow({ k: "WIGA_DECEL_MS",     unit: "ms",  hint: "DECEL 总时长 (lerp K_KT + ch3)" })}
              {ParamRow({ k: "WIGA_DECEL_V_OFF",  unit: "m/s", hint: "V 低于此值 + 时间过半 → arming:disarm() 进 IDLE" })}
              <div className="mt-2 text-[10px] text-fg-dim pt-2 border-t border-line/30">
                DECEL 入口: pilot 切 mode / GTEST 软退 / 限时巡航到期. base_pitch 回 4° (TAXI) 准备触水.
              </div>
            </div>
          );
        })()}

        {phTab === 'YAW' && (() => {
          const keys = ['WIGA_HDG_HOLD_EN','WIGA_HDG_KP','WIGA_HDG_KI','WIGA_HDG_KD','WIGA_HDG_I_LIM'];
          return (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-fg-dim">Yaw P+I+D 慢校正 (denom 越大越温和)</span>
                {CardSync({ keys, label: "Yaw" })}
              </div>
              {ParamRow({ k: "WIGA_HDG_HOLD_EN", unit: "0/1", hint: "1=lua 自动 yaw hold (override ch4), 0=pilot 手控 ch4" })}
              {ParamRow({ k: "WIGA_HDG_KP",      unit: "denom", hint: "P denom (err=180° 才给满杆, default 180)" })}
              {ParamRow({ k: "WIGA_HDG_KI",      unit: "denom", hint: "I denom (长期累积慢, default 3600)" })}
              {ParamRow({ k: "WIGA_HDG_KD",      unit: "denom", hint: "D denom (err_rate=30°/s 满 D 阻尼)" })}
              {ParamRow({ k: "WIGA_HDG_I_LIM",   unit: "", hint: "I 项 norm 上限 (anti-windup, default 0.3)" })}
              <div className="mt-2 text-[10px] text-fg-dim pt-2 border-t border-line/30">
                公式: norm = err/KP + ∫err/KI + err_rate/KD, clamp ±1, ch4 = 1500 - norm × 400.
                <br/>FLOAT_TAXI / TRANSITION / CRUISE / DECEL 全程跑.
              </div>
            </div>
          );
        })()}

        {phTab === 'GLOBAL' && (() => {
          const keys = ['WIGA_L1_BODY','WIGA_L1_RATE','WIGA_L1_MMS','WIGA_L1_CH3','WIGA_L1_R_PWM',
                        'WIGA_L1_HOLD','WIGA_L1_REC_W','WIGA_L1_REC_MS',
                        'WIGA_L2_BODY','WIGA_RATE_MMS','WIGA_PRE_SPEED'];
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-fg-dim">L1 软减油 (|body|&gt;15°+rate, ch3 减 50%) / L2 硬截 (|body|&gt;20°, disarm)</span>
                {CardSync({ keys, label: "L1/L2" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">Layer 1 (软减油, 保 ATC)</div>
                {ParamRow({ k: "WIGA_L1_BODY",   unit: "°",    hint: "L1 角度阈值 (default 15°)" })}
                {ParamRow({ k: "WIGA_L1_RATE",   unit: "°/s",  hint: "L1 rate 阈值 (default 20°/s, 同向才算发散)" })}
                {ParamRow({ k: "WIGA_L1_MMS",    unit: "ms",   hint: "L1 持续时长 (deglitch 100ms)" })}
                {ParamRow({ k: "WIGA_L1_CH3",    unit: "PWM",  hint: "ch3 平滑下降到 (default 1500=50%)" })}
                {ParamRow({ k: "WIGA_L1_R_PWM",  unit: "PWM/s",hint: "ch3 下降速率 (500=1s 内完成)" })}
                {ParamRow({ k: "WIGA_L1_HOLD",   unit: "ms",   hint: "救稳上限 (没恢复 → 升 L2)" })}
                {ParamRow({ k: "WIGA_L1_REC_W",  unit: "°",    hint: "恢复 |body| 阈值 (default 10°)" })}
                {ParamRow({ k: "WIGA_L1_REC_MS", unit: "ms",   hint: "恢复持续 (姿态稳 N ms 解 latch)" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">Layer 2 (硬截 disarm)</div>
                {ParamRow({ k: "WIGA_L2_BODY",   unit: "°",  hint: "L2 角度阈值 (单帧, default 20°)" })}
                {ParamRow({ k: "WIGA_RATE_MMS",  unit: "ms", hint: "L2 disarm 前缓冲 (default 300ms)" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">Preflight</div>
                {ParamRow({ k: "WIGA_PRE_SPEED", unit: "°/s", hint: "7 路 servo sweep 速度" })}
              </div>
            </div>
          );
        })()}
      </div>

      {/* ═════════ Section 7: Manual 配置 (P7.9.4 极简) ═════════ */}
      <div className="card">
        <div className="flex items-center mb-3">
          <span className="card-title mb-0 flex-1">Manual + V_PI 共用 (Mode 17 QSTAB / ch7 拨 G1/G2/G3)</span>
          {CardSync({ keys: ['MSK_BPCH_G1','MSK_BPCH_G2','MSK_V_MIN','MSK_V_MAX'], label: "Manual" })}
        </div>
        <div className="space-y-3">
          <div>
            <div className="text-[11px] text-fg-mute mb-1">base_pitch (ch7 切档 Q_TRIM_PITCH)</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'TAXI (G1)',         key: 'MSK_BPCH_G1' },
                { label: 'TRANS = CRUISE (G2)', key: 'MSK_BPCH_G2' },
              ].map(({ label, key }) => {
                const r = paramRange(key);
                return (
                  <div key={label}>
                    <div className="text-[10px] text-fg-dim">{label}</div>
                    <NumInput value={params[key] ?? 0} min={r.min} max={r.max} step={r.step}
                      onCommit={v => setLocal(key, v)} className="input val-mono w-full text-right" />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 text-[10px] text-fg-dim">
              P7.9.4: G3 (CRUISE) 撤了, CRUISE 读 G2. K 表全内置在 wig_control (不再 WIGK_*).
            </div>
          </div>

          <div className="border-t border-line pt-2">
            <div className="text-[11px] text-fg-mute mb-1">CRUISE ch10 旋钮速度控制 (V_PI 用)</div>
            {ParamRow({ k: "MSK_V_MIN", unit: "m/s", hint: "ch10 PWM 1000 对应的 V_TGT 下限" })}
            {ParamRow({ k: "MSK_V_MAX", unit: "m/s", hint: "ch10 PWM 2000 对应的 V_TGT 上限" })}
            <div className="text-[10px] text-fg-dim mt-1">
              WIGA_V_CH10_EN=1 时 V_PI 读 ch10 映射. =0 用 WIGA_V_TGT 静态.
            </div>
          </div>
        </div>
      </div>
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
