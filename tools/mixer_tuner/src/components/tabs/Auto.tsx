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

  // ─── 安全 gate (必须正确, err) ───
  check('SIM 必须关',           'WIGA_SIM_EN',     x => x===0, '=0', 'err', '虚拟传感器不能实飞');
  check('GTEST 必须关',         'WIGA_GTEST_EN',   x => x===0, '=0', 'err', '锁 phase 不能实飞');
  check('V_PI 安全 gate',       'WIGK_V_TEST_OK',  x => x===0, '=0', 'err', '=1 时绕过 V 检查, 实飞危险');
  check('SCR_ENABLE',           'SCR_ENABLE',      x => x===1, '=1', 'err', 'lua 没启用');
  check('Q_FRAME_CLASS',        'Q_FRAME_CLASS',   x => x===17, '=17', 'err', 'Dynamic Matrix');

  // ─── 速度参数 (不能 0 / 范围) ───
  check('巡航 V_TGT',           'WIGA_V_TGT',      x => x>=5 && x<=15, '5-15 m/s', 'err', '<5 起不来, >15 离水太快');
  check('TRANS_B → CRUISE V',  'WIGK_TX_V_TGT',   x => x>=3 && x<=10, '3-10 m/s', 'err', '=0 立即满足, TRANS_B 形同跳过');
  check('V_PI I 项',            'MSK_V_PI_I',      x => x<=0.1,    '≤0.1 (default 0.02)', 'err', '太大 windup');
  check('V_INT_LIM',            'MSK_V_INT_LIM',   x => x>=2 && x<=10, '2-10', 'warn');
  check('KT_LIM (saturate)',    'MSK_KT_LIM',      x => x>=0.7 && x<=0.95, '0.7-0.95', 'warn', 'default 0.85');

  // ─── envelope / safety ───
  check('Pitch envelope',       'WIGA_P_ENV_W',    x => x>=15 && x<=35, '15-35°', 'warn', 'abort 阈值');
  check('Emerg pitch (预测)',  'WIGA_P_RECV_W',   x => x>=10 && x<=20, '10-20°', 'warn');
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
    // Section 5 Mode + Strategy
    'WIGA_CRUISE_MODE','WIGA_TRANS_STRAT','WIGA_FAC_SCL','WIGA_V_CH10_EN','WIGA_PREFLT_REQ','WIGA_V_TGT',
    // Section 7 Manual (P7.6: K 表改 WIGK_TAXI/TRANS/CRUISE)
    'MSK_BPCH_G1','MSK_BPCH_G2','MSK_BPCH_G3',
    'WIGK_TAXI_KS','WIGK_TAXI_KDF','WIGK_TAXI_KT','WIGK_TAXI_KRD',
    'WIGK_TRANS_KS','WIGK_TRANS_KDF','WIGK_TRANS_KT','WIGK_TRANS_KRD',
    'WIGK_CRUISE_KS','WIGK_CRUISE_KDF','WIGK_CRUISE_KT','WIGK_CRUISE_KRD',
    'MSK_V_MIN','MSK_V_MAX','MSK_V_DRIVE_MIN','MSK_V_DEADZONE',
    'MSK_THR_CHECK','MSK_THR_TEST',
    // Section 8 Phase (按 sub-tab 分组, 但同一 saved snap 跟踪)
    'WIGA_TAXI_DUR','WIGA_TAXI_CAP','WIGA_TAXI_THR_T','WIGA_TAXI_THR_R',
    'WIGA_TX_TO_MS','WIGA_TX_BTRIM','WIGA_TX_STRIM','WIGA_TX_S_MS','WIGK_TX_B_MS','WIGK_TX_A_TOL','WIGK_TX_V_TGT',
    'WIGA_FV_KS_GOAL','WIGA_FV_KS_LMIN','WIGA_FV_KS_LMAX','WIGA_FV_TRIM',
    'WIGA_RV_KS_GOAL','WIGA_RV_KS_LMIN','WIGA_RV_KS_LMAX','WIGA_RV_TRIM',
    'WIGA_DF_GOAL','WIGA_DF_LMIN','WIGA_DF_LMAX',
    'WIGA_V_OK_W',
    'WIGA_DEC_A_MS','WIGA_DEC_B_MS','WIGA_DEC_C_MS','WIGA_DEC_V_A','WIGA_DEC_V_B',
    'WIGK_HDG_HOLD_EN','WIGA_HDG_KP','WIGA_HDG_KD','WIGA_TRN_HDG','WIGA_MTX_DUR','WIGA_TRN_DUR',
    'WIGA_PITCH_OK_W','WIGA_ROLL_OK_W','WIGA_KTC_OK_W','WIGA_P_ENV_W','WIGA_P_RECV_W','WIGA_R_RECV_W',
    'WIGA_RATE_TH','WIGA_RATE_MMS','WIGA_PRE_SPEED',
    // P7.6 新参数 + P7.8v V_PI 安全 override
    'WIGK_L2_STAB_P','WIGK_L2_STAB_R','WIGK_V_ACC_MAX','WIGK_V_TEST_OK',
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
                    <div>V = {(params.WIGA_SIM_V ?? 0).toFixed(1)}  +ramp {(params.WIGA_SIM_V_RAMP ?? 0).toFixed(2)}/s</div>
                    <div>Pitch = {(params.WIGA_SIM_PITCH ?? 0).toFixed(1)}°  +ramp {(params.WIGA_SIM_P_RAMP ?? 0).toFixed(0)}°/s</div>
                    <div>Roll = {(params.WIGA_SIM_ROLL ?? 0).toFixed(1)}°  +ramp {(params.WIGA_SIM_R_RAMP ?? 0).toFixed(0)}°/s</div>
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </Card>

      {/* GTEST 已搬到 "地面测试" 独立 tab — 不在 模式配置 里 */}

      {/* ═════════ Section 5: Mode + Strategy 选择 (save 式) ═════════ */}
      <div className="card">
        <div className="flex items-center mb-3">
          <span className="card-title mb-0 flex-1">Mode + Strategy 选择 (armed 边沿 latch, 改完点保存)</span>
          <PreflightCheckButton />
          {CardSync({ keys: ['WIGA_CRUISE_MODE','WIGA_TRANS_STRAT','WIGA_FAC_SCL','WIGA_V_CH10_EN','WIGA_PREFLT_REQ','WIGA_V_TGT'], label: "Mode+Strategy" })}
        </div>
        <div className="space-y-2">
          <RadioRow
            label="Cruise Mode"
            value={params.WIGA_CRUISE_MODE ?? 0}
            onChange={v => setLocal('WIGA_CRUISE_MODE', v)}
            options={[
              { label: 'FRONT_VENT (前出气)', value: 0 },
              { label: 'REAR_VENT (后出气)',  value: 1 },
            ]}
          />
          <RadioRow
            label="Strategy"
            value={params.WIGA_TRANS_STRAT ?? 0}
            onChange={v => setLocal('WIGA_TRANS_STRAT', v)}
            options={[
              { label: 'STEADY (慢推)', value: 0 },
              { label: 'BURST  (速推)', value: 1 },
            ]}
          />
          <RadioRow
            label="Factor Scale"
            value={params.WIGA_FAC_SCL ?? 0}
            onChange={v => setLocal('WIGA_FAC_SCL', v)}
            options={[
              { label: 'OFF (默认)', value: 0 },
              { label: 'ON (按 mode 改 KS/KDF)', value: 1 },
            ]}
          />
          <RadioRow
            label="ch10 V_TGT"
            value={params.WIGA_V_CH10_EN ?? 0}
            onChange={v => setLocal('WIGA_V_CH10_EN', v)}
            options={[
              { label: 'static (GCS)',  value: 0 },
              { label: 'dynamic (ch10)', value: 1 },
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
            value={params.WIGA_V_TGT ?? 7.0}
            onChange={v => setLocal('WIGA_V_TGT', v)}
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
          const keys = ['WIGA_TAXI_DUR','WIGA_TAXI_CAP','WIGA_TAXI_THR_T','WIGA_TAXI_THR_R',
                        'WIGK_TAXI_KS','WIGK_TAXI_KDF','WIGK_TAXI_KT','WIGK_TAXI_KRD'];
          return (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-fg-dim">浮筒滑水: 7 路 servo 锁固定, 油门自动从 0 渐增到目标值. 涵道 K (KS/KDF/KT/KRD) 在下方 K 涵道权重 section 调.</span>
                {CardSync({ keys, label: "TAXI" })}
              </div>
              {ParamRow({ k: "WIGA_TAXI_DUR",     unit: "ms",  hint: "浮筒滑水的总时长, 跑完后进入起飞跃迁" })}
              {ParamRow({ k: "WIGA_TAXI_THR_T", unit: "",    hint: "油门最终目标 (0=停, 0.5=半推, 1.0=满推, 实飞建议 0.5-0.8)" })}
              {ParamRow({ k: "WIGA_TAXI_THR_R",   unit: "1/s", hint: "油门从 0 渐增到目标的速度 (0.3 = 满推约 3 秒到位)" })}
              {ParamRow({ k: "WIGA_TAXI_CAP",     unit: "",    hint: "滑水期间油门倍数 (实飞 1.0 不限; 地检 0.3 半推台架用)" })}
              <div className="mt-2 pt-2 border-t border-line/30">
                <div className="text-[11px] text-fg-mute mb-1">K 涵道权重 (各组目标推力比例 [0,1])</div>
                {ParamRow({ k: "WIGK_TAXI_KS",  unit: "", hint: "S 组斜吹 (主升力, 4 涵道) — 浮筒滑水期 KS 比例" })}
                {ParamRow({ k: "WIGK_TAXI_KDF", unit: "", hint: "DF 前下吹 (姿态主, 2 涵道) — 浮筒期低占比" })}
                {ParamRow({ k: "WIGK_TAXI_KT",  unit: "", hint: "T 后推 (4 涵道, 主推力) — 浮筒期慢推" })}
                {ParamRow({ k: "WIGK_TAXI_KRD", unit: "", hint: "RD 后斜下吹 (2 涵道, 推力+尾压) — 浮筒期低占比" })}
              </div>
            </div>
          );
        })()}

        {phTab === 'TRANS' && (() => {
          const keys = ['WIGA_TX_TO_MS','WIGA_TX_BTRIM','WIGA_TX_STRIM',
                        'WIGA_TX_S_MS','WIGK_TX_B_MS','WIGK_TX_A_TOL',
                        'WIGK_TX_V_TGT',
                        'WIGK_TRANS_KS','WIGK_TRANS_KDF','WIGK_TRANS_KT','WIGK_TRANS_KRD'];
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-fg-dim">跃迁 (P7.8l 简化): TRANS_A 等 view ±tol 维持 → TRANS_B 满油门, V≥V_TGT → CRUISE</span>
                {CardSync({ keys, label: "TRANS" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">超时</div>
                {ParamRow({ k: "WIGA_TX_TO_MS", unit: "ms", hint: "TRANS_A/B 每阶段最长时长, 超时 → ABORT_L1" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">TRANS_A 角度目标 (过推角)</div>
                {ParamRow({ k: "WIGA_TX_BTRIM", unit: "°", hint: "BURST 策略 (火箭模式) 机头过推角度" })}
                {ParamRow({ k: "WIGA_TX_STRIM", unit: "°", hint: "STEADY 策略 (稳推模式) 机头过推角度" })}
                {ParamRow({ k: "WIGK_TX_A_TOL", unit: "°", hint: "角度容忍 (body 偏 target ±° 才算到位)" })}
                {ParamRow({ k: "WIGA_TX_S_MS", unit: "ms", hint: "STEADY 模式 维持时长 (默认 1000ms)" })}
                {ParamRow({ k: "WIGK_TX_B_MS", unit: "ms", hint: "BURST 模式 维持时长 (默认 300ms)" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">TRANS_B → CRUISE 入口速度 (跟 CRUISE 维持 V_TGT 解耦)</div>
                {ParamRow({ k: "WIGK_TX_V_TGT", unit: "m/s", hint: "TRANS_B → CRUISE 入口速度阈值 (默认 5 = 离水速度). 跟巡航维持的 WIGA_V_TGT 分开调" })}
              </div>
              <div className="pt-2 border-t border-line/30">
                <div className="text-[11px] text-fg-mute mb-1">K 涵道权重 (跃迁期共用 A/B/C)</div>
                {ParamRow({ k: "WIGK_TRANS_KS",  unit: "", hint: "S 组斜吹 — 跃迁期 KS 比例 (抬头 + 升力)" })}
                {ParamRow({ k: "WIGK_TRANS_KDF", unit: "", hint: "DF 前下吹 — 跃迁期辅助抬头" })}
                {ParamRow({ k: "WIGK_TRANS_KT",  unit: "", hint: "T 后推 — 跃迁期主推力建立 (KT_ramp 渐增到这值)" })}
                {ParamRow({ k: "WIGK_TRANS_KRD", unit: "", hint: "RD 后斜下吹 — 跃迁期推力 + 抵消 KS 抬头" })}
              </div>
              </div>
          );
        })()}

        {phTab === 'CRUISE' && (() => {
          const keys = ['WIGA_FV_KS_GOAL','WIGA_FV_KS_LMIN','WIGA_FV_KS_LMAX','WIGA_FV_TRIM',
                        'WIGA_RV_KS_GOAL','WIGA_RV_KS_LMIN','WIGA_RV_KS_LMAX','WIGA_RV_TRIM',
                        'WIGA_DF_GOAL','WIGA_DF_LMIN','WIGA_DF_LMAX',
                        'WIGA_V_TGT','WIGA_V_OK_W',
                        'WIGA_MTX_DUR','WIGA_TRN_DUR',
                        'WIGK_CRUISE_KS','WIGK_CRUISE_KDF','WIGK_CRUISE_KT','WIGK_CRUISE_KRD'];
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-fg-dim">巡航 mode-aware tilt 配方 + V_PI 维持 V_TGT</span>
                {CardSync({ keys, label: "CRUISE" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">FV (前出气, LOG65 风格)</div>
                {ParamRow({ k: "WIGA_FV_KS_GOAL", unit: "°", hint: "前出气模式 — S 组桁架的目标角度" })}
                {ParamRow({ k: "WIGA_FV_KS_LMIN", unit: "°", hint: "前出气模式 — S 组允许的最低角度 (软限位)" })}
                {ParamRow({ k: "WIGA_FV_KS_LMAX", unit: "°", hint: "前出气模式 — S 组允许的最高角度" })}
                {ParamRow({ k: "WIGA_FV_TRIM", unit: "°", hint: "前出气模式 — 巡航机头俯仰角度" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">RV (后出气, LOG17 风格)</div>
                {ParamRow({ k: "WIGA_RV_KS_GOAL", unit: "°", hint: "后出气模式 — S 组桁架的目标角度" })}
                {ParamRow({ k: "WIGA_RV_KS_LMIN", unit: "°", hint: "后出气模式 — S 组允许的最低角度" })}
                {ParamRow({ k: "WIGA_RV_KS_LMAX", unit: "°", hint: "后出气模式 — S 组允许的最高角度" })}
                {ParamRow({ k: "WIGA_RV_TRIM", unit: "°", hint: "后出气模式 — 巡航机头俯仰角度" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">DF 通用 (FV+RV 共用)</div>
                {ParamRow({ k: "WIGA_DF_GOAL", unit: "°", hint: "DF (前下吹) 涵道的目标角度" })}
                {ParamRow({ k: "WIGA_DF_LMIN", unit: "°", hint: "DF 涵道允许的最低角度" })}
                {ParamRow({ k: "WIGA_DF_LMAX", unit: "°", hint: "DF 涵道允许的最高角度" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">V 目标</div>
                {ParamRow({ k: "WIGA_V_TGT", unit: "m/s", hint: "巡航目标速度 (米/秒). ch10 模式开启时由油门旋钮覆盖" })}
                {ParamRow({ k: "WIGA_V_OK_W", unit: "m/s", hint: "允许的速度误差范围 (±)" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">CRUISE 退档时长 (profile 决定)</div>
                {ParamRow({ k: "WIGA_MTX_DUR", unit: "ms", hint: "MATRIX profile: CRUISE 跑这么久后自动 → DECEL_A (默认 30000ms = 30s)" })}
                {ParamRow({ k: "WIGA_TRN_DUR", unit: "ms", hint: "TURN profile: CRUISE 跑这么久后 → TURN phase 开始转弯 (默认 15000ms)" })}
              </div>
              <div className="pt-2 border-t border-line/30">
                <div className="text-[11px] text-fg-mute mb-1">K 涵道权重 (CRUISE / TURN 共用, FV+RV 都用这套)</div>
                {ParamRow({ k: "WIGK_CRUISE_KS",  unit: "", hint: "S 组斜吹 — 巡航期 KS 比例 (wing 主升, 较低值)" })}
                {ParamRow({ k: "WIGK_CRUISE_KDF", unit: "", hint: "DF 前下吹 — 巡航期低占比 (主姿态 ATC)" })}
                {ParamRow({ k: "WIGK_CRUISE_KT",  unit: "", hint: "T 后推 — 巡航期主前推 (高占比, 配合 V_PI)" })}
                {ParamRow({ k: "WIGK_CRUISE_KRD", unit: "", hint: "RD 后斜下吹 — 巡航期推力源 (KS 副推)" })}
              </div>
              </div>
          );
        })()}

        {phTab === 'DECEL' && (() => {
          const keys = ['WIGA_DEC_A_MS','WIGA_DEC_B_MS','WIGA_DEC_C_MS','WIGA_DEC_V_A','WIGA_DEC_V_B'];
          return (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-fg-dim">减速: A ch3 ramp + base_pitch 回收 → B lua 接管 tilt 降 lift → C motor cut</span>
                {CardSync({ keys, label: "DECEL" })}
              </div>
              {ParamRow({ k: "WIGA_DEC_A_MS", unit: "ms", hint: "减速 A 段 (主推力减) 的时长" })}
              {ParamRow({ k: "WIGA_DEC_B_MS", unit: "ms", hint: "减速 B 段 (姿态归位) 的时长" })}
              {ParamRow({ k: "WIGA_DEC_C_MS", unit: "ms", hint: "减速 C 段 (电机停车) 的时长" })}
              {ParamRow({ k: "WIGA_DEC_V_A", unit: "m/s", hint: "速度低于此值时, 从减速 A 段进入 B 段" })}
              {ParamRow({ k: "WIGA_DEC_V_B", unit: "m/s", hint: "速度低于此值时, 从减速 B 段进入 C 段" })}
                          <div className="mt-2 text-[10px] text-fg-dim leading-snug pt-2 border-t border-line/30">
                <b>K 涵道权重</b>: DECEL_A 复用 <b>TRANS K 表</b>, DECEL_B 复用 <b>TAXI K 表</b> — 在 TRANS / TAXI 子页配置
              </div>
              </div>
          );
        })()}

        {phTab === 'YAW' && (() => {
          const keys = ['WIGK_HDG_HOLD_EN','WIGA_HDG_KP','WIGA_HDG_KD','WIGA_TRN_HDG','WIGA_MTX_DUR','WIGA_TRN_DUR'];
          return (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-fg-dim">Yaw hold P+D 锁航向, TURN profile 时偏 TRN_HDG</span>
                {CardSync({ keys, label: "Yaw+TURN" })}
              </div>
              {ParamRow({ k: "WIGK_HDG_HOLD_EN", unit: "0/1", hint: "P7.8ω: 1=lua 自动 yaw hold (override ch4), 0=禁用 hold pilot 手控 (水里失稳兜底)" })}
              {ParamRow({ k: "WIGA_HDG_KP", unit: "", hint: "航向锁定的比例增益 (越大转向越激进)" })}
              {ParamRow({ k: "WIGA_HDG_KD", unit: "", hint: "航向锁定的微分增益 (越大阻尼越强, 防超调)" })}
              {ParamRow({ k: "WIGA_TRN_HDG", unit: "°", hint: "转向模式下, 相对起始航向偏多少度 (180=调头)" })}
              {ParamRow({ k: "WIGA_MTX_DUR", unit: "ms", hint: "MATRIX 档下巡航多久后自动减速" })}
              {ParamRow({ k: "WIGA_TRN_DUR", unit: "ms", hint: "TURN 档下巡航多久后开始转向" })}
                          <div className="mt-2 text-[10px] text-fg-dim leading-snug pt-2 border-t border-line/30">
                <b>K 涵道权重</b>: TURN 复用 <b>CRUISE K 表</b> — 在 CRUISE 子页配置
              </div>
              </div>
          );
        })()}

        {phTab === 'GLOBAL' && (() => {
          const keys = ['WIGA_PITCH_OK_W','WIGA_ROLL_OK_W','WIGA_KTC_OK_W','WIGA_P_ENV_W','WIGA_P_RECV_W','WIGA_R_RECV_W',
                        'WIGA_RATE_TH','WIGA_RATE_MMS','WIGA_PRE_SPEED',
                        'WIGK_L2_STAB_P','WIGK_L2_STAB_R','WIGK_V_ACC_MAX','WIGK_V_TEST_OK'];
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-fg-dim">公用阈值: 稳态 / L1 envelope / L3 set_mode(29) / Emergency / Preflight</span>
                {CardSync({ keys, label: "Global" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">稳态容差</div>
                {ParamRow({ k: "WIGA_PITCH_OK_W", unit: "°", hint: "判定俯仰稳态的容差" })}
                {ParamRow({ k: "WIGA_ROLL_OK_W", unit: "°", hint: "判定横滚稳态的容差" })}
                {ParamRow({ k: "WIGA_KTC_OK_W", unit: "%", hint: "判定 T 组推力稳态的容差" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">L1 envelope (ABORT_L1 触发)</div>
                {ParamRow({ k: "WIGA_P_ENV_W", unit: "°", hint: "巡航俯仰超过此误差, 触发 L1 内部退档" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">L3 set_mode(29) 安全网</div>
                {ParamRow({ k: "WIGA_P_RECV_W", unit: "°", hint: "俯仰超过此角度, 切换到 WIG_RECOVER 救援模式" })}
                {ParamRow({ k: "WIGA_R_RECV_W", unit: "°", hint: "横滚超过此角度, 切换到 WIG_RECOVER 救援模式" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">Emergency (角度+rate+单调)</div>
                {ParamRow({ k: "WIGA_RATE_TH", unit: "°/s", hint: "角速度阈值 (配合角度+持续判定紧急姿态失控)" })}
                {ParamRow({ k: "WIGA_RATE_MMS", unit: "ms", hint: "失控姿态持续多久后, 触发紧急反向打杆" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">Preflight</div>
                {ParamRow({ k: "WIGA_PRE_SPEED", unit: "°/s", hint: "7 路舵机自检扫描的速度 (越大越快)" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">Layer 2 自适应 (SGRP tilt 速率跟姿态稳定性成正比)</div>
                {ParamRow({ k: "WIGK_L2_STAB_P", unit: "°", hint: "判定姿态不稳的 pitch err 临界 (越大越宽容)" })}
                {ParamRow({ k: "WIGK_L2_STAB_R", unit: "°/s", hint: "判定姿态不稳的 pitch 角速度临界" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">V_TGT 加速度限制 (防 V_PI 看到突变)</div>
                {ParamRow({ k: "WIGK_V_ACC_MAX", unit: "m/s²", hint: "V_TGT 内部最大爬升率 (0.5 = V 从 5 爬到 12 约 14 秒)" })}
              </div>
              <div>
                <div className="text-[11px] text-fg-mute mb-1 border-b border-line/30">V_PI 安全 gate (无空速 + 无 GPS 时)</div>
                {ParamRow({ k: "WIGK_V_TEST_OK", unit: "0/1", hint: "默认 0 安全 (无空速+GPS 时 V_PI 不跑, 防 motor 失控). 桌面测试设 1 用 0 跑 V_PI" })}
              </div>
            </div>
          );
        })()}
      </div>

      {/* ═════════ Section 7: Manual 配置 (P7.5a 移到 AUTO 时序下面) ═════════ */}
      <div className="card">
        <div className="flex items-center mb-3">
          <span className="card-title mb-0 flex-1">Manual 配置 (Mode 17 QSTAB / ch7: LOW=TAXI MID=TRANS HIGH=CRUISE)</span>
          {CardSync({ keys: [
              'MSK_BPCH_G1','MSK_BPCH_G2','MSK_BPCH_G3',
              'WIGK_TAXI_KS','WIGK_TAXI_KDF','WIGK_TAXI_KT','WIGK_TAXI_KRD',
              'WIGK_TRANS_KS','WIGK_TRANS_KDF','WIGK_TRANS_KT','WIGK_TRANS_KRD',
              'WIGK_CRUISE_KS','WIGK_CRUISE_KDF','WIGK_CRUISE_KT','WIGK_CRUISE_KRD',
              'MSK_V_MIN','MSK_V_MAX','MSK_V_DRIVE_MIN','MSK_V_DEADZONE',
              'MSK_THR_CHECK','MSK_THR_TEST',
            ], label: "Manual" })}
        </div>
        <div className="space-y-3">
          {/* 3 phase base_pitch (param key 仍是 MSK_BPCH_G1/2/3 兼容历史 EEPROM) */}
          <div>
            <div className="text-[11px] text-fg-mute mb-1">3 phase base_pitch (ch7 切档目标 Q_TRIM_PITCH)</div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'TAXI',   key: 'MSK_BPCH_G1' },
                { label: 'TRANS',  key: 'MSK_BPCH_G2' },
                { label: 'CRUISE', key: 'MSK_BPCH_G3' },
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
          </div>

          {/* 12 K 表 (P7.6: G1/G2/G3 → TAXI/TRANS/CRUISE phase 命名, 读 WIGK_*) */}
          <div>
            <div className="text-[11px] text-fg-mute mb-1">K 涵道权重 — motor[i] = ch3 × (K_base × ramp + boost × BST) × thr_cap</div>
            <table className="w-full text-[11px]">
              <thead><tr className="border-b border-line">
                <th className="text-left py-1 pr-2 text-fg-dim">组</th>
                {['TAXI','TRANS','CRUISE'].map(p => <th key={p} className="text-center text-accent">{p}</th>)}
              </tr></thead>
              <tbody>
                {['KS','KDF','KT','KRD'].map(grp => (
                  <tr key={grp} className="border-b border-line/30">
                    <td className="py-1 pr-2 text-fg-mute">{grp}</td>
                    {['TAXI','TRANS','CRUISE'].map(p => {
                      const k = `WIGK_${p}_${grp}`;
                      const r = paramRange(k);
                      return (
                        <td key={p} className="px-1 py-0.5">
                          <NumInput value={params[k] ?? 0} min={r.min} max={r.max} step={r.step}
                            onCommit={v => setLocal(k, v)} className="input val-mono text-center w-full" />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1 text-[10px] text-fg-dim">
              AUTO 状态机也用这套 K 表 (TAXI/TRANS/CRUISE 跟 phase 对应). Manual 模式 ch7 切档跟 AUTO phase 一致.
            </div>
          </div>

          {/* CRUISE ch10 V 控制 (Manual + AUTO 共用) */}
          <div className="border-t border-line pt-2">
            <div className="text-[11px] text-fg-mute mb-1">CRUISE ch10 旋钮速度控制 (Manual + AUTO 共用)</div>
            {ParamRow({ k: "MSK_V_MIN",       unit: "m/s", hint: "ch10 速度下限 (拨杆最低位)" })}
            {ParamRow({ k: "MSK_V_MAX",       unit: "m/s", hint: "ch10 速度上限 (拨杆最高位)" })}
            {ParamRow({ k: "MSK_V_DRIVE_MIN", unit: "m/s", hint: "CRUISE 入档兜底 (破驼峰最低速)" })}
            {ParamRow({ k: "MSK_V_DEADZONE",  unit: "PWM", hint: "ch10 中位死区 ±" })}
            <div className="text-[10px] text-fg-dim mt-1">
              加速度限制改用 WIGK_V_ACC_MAX (Global 阈值 sub-tab), 旧 MSK_V_ACC_MAX 撤
            </div>
          </div>

          {/* thr_cap 调试 */}
          <div className="border-t border-line pt-2">
            <div className="text-[11px] text-fg-mute mb-1">ch6 thr_cap 调试限幅 (Manual mode)</div>
            {ParamRow({ k: "MSK_THR_CHECK", unit: "", hint: "ch6=CHECK 地面检查限幅" })}
            {ParamRow({ k: "MSK_THR_TEST", unit: "", hint: "ch6=TEST 台架测试限幅" })}
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
