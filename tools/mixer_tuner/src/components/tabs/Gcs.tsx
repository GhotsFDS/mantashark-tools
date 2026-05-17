import React, { useEffect, useState, useRef, useMemo } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';
import { useStore } from '../../store/useStore';
import { Wifi, WifiOff, PlugZap, Upload, Download, Lock, Unlock, RefreshCcw, Terminal, TrendingUp } from 'lucide-react';
import { DEFAULT_PARAMS, SYNC_SKIP_RE } from '../../lib/defaults';
import { GROUP_COLORS, GROUP_LABELS, MOTORS, SINGLE_MOTOR_MAX_N, VEHICLE_WEIGHT_N } from '../../lib/actuators';
import type { GroupKey } from '../../lib/types';

// P7.8: mode 17/27/29 标签 (custom_mode 数字; heartbeat.mode 字符串对自定义返回 "Mode(27)" 无法识别)
const MODE_LABELS: Record<number, string> = {
  17: 'MANUAL (QSTAB)',
  27: 'AUTO (WIG_AUTO)',
  29: 'RECV (WIG_RECV)',
};

interface Telemetry {
  heartbeat?: { mode: string; custom_mode?: number; armed: boolean; ts: number };
  attitude?:  { roll: number; pitch: number; yaw: number };
  vfr?:       { airspeed: number; groundspeed: number; alt: number; climb: number; throttle: number };
  gps?:       { fix_type: number; sats: number; hdop: number | null };
  rc?:        number[];
  servo?:     number[];
  battery?:   { voltage: number; current: number | null; remaining: number; consumed_mah?: number };
  lastMsgMs?: number;
}

interface Stats { pullCount: number; pullTotal: number; pushCount: number; }

export function Gcs() {
  const { params, setParam } = useStore();
  const [url, setUrl] = useState(gcs.getUrl());
  const [connected, setConnected] = useState(false);
  const [tlm, setTlm] = useState<Telemetry>({});
  const [log, setLog] = useState<Array<{ sev: number; text: string; ts: number }>>([]);
  const [stats, setStats] = useState<Stats>({ pullCount: 0, pullTotal: 0, pushCount: 0 });
  const [syncMode, setSyncMode] = useState<'none' | 'pulling' | 'pushing'>('none');
  // P7.8: liveK 改订阅 NAMED_VALUE_FLOAT (lua mixer 5Hz 推, 真实 K_eff = (K_base+drift)×ramp+boost×BST × cap)
  const [liveK, setLiveK] = useState<Record<GroupKey, number>>({ KS:0, KDF:0, KT:0, KRD:0 });
  const [liveLayer, setLiveLayer] = useState(0);
  const [livePhase, setLivePhase] = useState<string>('—');
  const [liveQTrim, setLiveQTrim] = useState<number | undefined>(undefined);  // P7.8γ: lua 5Hz 推, 实时 Q_TRIM_PITCH
  const logRef = useRef<HTMLDivElement>(null);
  const logAutoScrollRef = useRef<boolean>(true);  // 用户滚到底 → true, 上滚 → false

  useEffect(() => {
    setConnected(gcs.isConnected());
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'status') setConnected(m.connected);
      else if (m.type === 'heartbeat') setTlm(t => ({ ...t, heartbeat: { ...m, ts: Date.now() }, lastMsgMs: Date.now() }));
      else if (m.type === 'attitude') setTlm(t => ({ ...t, attitude: m, lastMsgMs: Date.now() }));
      else if (m.type === 'vfr_hud')  setTlm(t => ({ ...t, vfr: m, lastMsgMs: Date.now() }));
      else if (m.type === 'gps')      setTlm(t => ({ ...t, gps: m, lastMsgMs: Date.now() }));
      else if (m.type === 'rc')       setTlm(t => ({ ...t, rc: m.channels, lastMsgMs: Date.now() }));
      else if (m.type === 'servo')    setTlm(t => ({ ...t, servo: m.channels, lastMsgMs: Date.now() }));
      else if (m.type === 'battery')  setTlm(t => ({ ...t, battery: { voltage: m.voltage, current: m.current, remaining: m.remaining, consumed_mah: m.consumed_mah }, lastMsgMs: Date.now() }));
      else if (m.type === 'named_float') {
        if      (m.name === 'K_KS')  setLiveK(k => ({ ...k, KS:  m.value }));
        else if (m.name === 'K_KDF') setLiveK(k => ({ ...k, KDF: m.value }));
        else if (m.name === 'K_KT')  setLiveK(k => ({ ...k, KT:  m.value }));
        else if (m.name === 'K_KRD') setLiveK(k => ({ ...k, KRD: m.value }));
        else if (m.name === 'LAYER') setLiveLayer(m.value);
        else if (m.name === 'QTRIM') setLiveQTrim(m.value);
      }
      else if (m.type === 'statustext') {
        setLog(l => [...l.slice(-199), { sev: m.severity, text: m.text, ts: Date.now() }]);
        const phMatch = m.text.match(/WIG_AUTO phase\s*[→\->]+\s*(\w+)/);
        if (phMatch) setLivePhase(phMatch[1]);
      }
      // param 由 App-level listener 统一写 store, 这里只看到累计计数
      else if (m.type === 'param') setStats(s => ({ ...s, pullCount: s.pullCount + 1, pullTotal: m.count }));
      else if (m.type === 'error') setLog(l => [...l.slice(-199), { sev: 2, text: '❌ ' + m.msg, ts: Date.now() }]);
    });
    return () => { off(); };
  }, []);

  // smart auto-scroll: 只在用户已在底部时跟新, 上滚停留
  useEffect(() => {
    if (logRef.current && logAutoScrollRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);
  const onLogScroll = () => {
    if (!logRef.current) return;
    const el = logRef.current;
    // 距底 5px 内算"在底部" (sub-pixel tolerance)
    logAutoScrollRef.current = (el.scrollTop + el.clientHeight) >= (el.scrollHeight - 5);
  };

  const connect = () => { gcs.setUrl(url); gcs.connect(); };
  const disconnect = () => gcs.disconnect();

  const pullAll = async () => {
    if (syncMode !== 'none') return;
    setStats({ pullCount: 0, pullTotal: 0, pushCount: 0 });
    setSyncMode('pulling');
    const keys = Object.keys(DEFAULT_PARAMS).filter(k => !SYNC_SKIP_RE.test(k));
    const r = await gcs.pullParams(keys, (g, t) => setStats(s => ({ ...s, pullCount: g, pullTotal: t })));
    setLog(l => [...l.slice(-199), {
      sev: r.timedOut ? 4 : 6,
      text: r.timedOut ? `⚠ 拉取超时 收 ${r.got}/${keys.length}, 缺 ${r.missing.length}` : `✓ 拉取 ${r.got} 个参数`,
      ts: Date.now(),
    }]);
    setSyncMode('none');
  };

  const pushAll = async () => {
    if (syncMode !== 'none') return;
    setStats(s => ({ ...s, pushCount: 0 }));
    setSyncMode('pushing');
    const map: Record<string, number> = {};
    for (const k of Object.keys(DEFAULT_PARAMS)) {
      if (k in params && !SYNC_SKIP_RE.test(k)) map[k] = params[k];
    }
    const r = await gcs.pushParams(map, (s, t) => setStats(st => ({ ...st, pushCount: s, pullTotal: t })));
    setLog(l => [...l.slice(-199), {
      sev: r.timedOut ? 4 : 6,
      text: r.timedOut ? `⚠ 推送超时 ack ${r.acked}/${Object.keys(map).length}` : `✓ 已保存 ${r.acked} 个参数`,
      ts: Date.now(),
    }]);
    setSyncMode('none');
  };

  const armed = tlm.heartbeat?.armed ?? false;
  const sevColor = (s: number) => s <= 2 ? 'text-err' : s <= 4 ? 'text-warn' : s <= 6 ? 'text-fg' : 'text-fg-dim';
  const healthy = connected && tlm.lastMsgMs && (Date.now() - tlm.lastMsgMs < 3000);

  // ─── P7.8: 拨杆解码 mode-aware (ch6=ArduPlane FLTMODE, ch7 语义跟 mode 走) ───
  const liveRcCh = (tlm as any).rc as number[] | undefined;
  const liveSpd = healthy ? (tlm.vfr?.groundspeed ?? 0) : null;
  // mode 数字 (heartbeat.custom_mode, mode 字符串对 27/29 自定义会返回 "Mode(27)" 无法识别)
  const modeNum = tlm.heartbeat?.custom_mode ?? null;
  const ch6Pwm = liveRcCh ? (liveRcCh[5] ?? 1500) : 1500;
  const ch7Pwm = liveRcCh ? (liveRcCh[6] ?? 1500) : 1500;
  const ch2Pwm = liveRcCh ? (liveRcCh[1] ?? 1500) : 1500;
  // ch7 解码: MANUAL → phase, AUTO → profile (armed 边沿 latch)
  const ch7Label = (() => {
    if (modeNum == null) return '— (无 mode)';
    const tier = ch7Pwm < 1300 ? 'low' : ch7Pwm <= 1700 ? 'mid' : 'high';
    if (modeNum === 17) return tier === 'low' ? 'TAXI' : tier === 'mid' ? 'TRANS' : 'CRUISE';
    if (modeNum === 27) return tier === 'low' ? 'MATRIX' : tier === 'mid' ? 'TURN' : 'CRUISE';
    if (modeNum === 29) return 'n/a';
    return '?';
  })();
  // P7.8γ: pitchBase 优先用 liveQTrim (lua 5Hz 推送的实时 Q_TRIM_PITCH ramp 后值),
  // 没收到 NVF 时 fallback phase 推断 (旧路径). 修 phase 切换 ramp 中 body 显示错的 bug.
  const pitchBase = useMemo(() => {
    if (liveQTrim !== undefined) return liveQTrim;  // 真值: lua 推的 ramp 后实时 trim
    const bp1 = params.MSK_BPCH_G1 ?? 5;
    const bp2 = params.MSK_BPCH_G2 ?? 11;
    if (modeNum === 17) {  // MANUAL: ch7 直选 phase. P7.9.4: CRUISE 跟 TRANS 同 base_pitch (G2)
      const tier = ch7Pwm < 1300 ? 1 : ch7Pwm <= 1700 ? 2 : 3;
      return tier === 1 ? bp1 : bp2;
    }
    if (modeNum === 27) {  // AUTO: phase 由状态机定, 跟 wig_auto STATUSTEXT 取 — Tuner 这边用 livePhase
      if (livePhase.startsWith('FLOAT') || livePhase === 'IDLE') return bp1;
      // P7.9.4: TRANS/DECEL/CRUISE/TURN 都用 G2
      return bp2;
    }
    if (modeNum === 29) return bp1;  // RECV 固定锁 TAXI
    return bp1;
  }, [liveQTrim, modeNum, ch7Pwm, livePhase, params.MSK_BPCH_G1, params.MSK_BPCH_G2]);

  const pitchStick = useMemo(() => {
    // stick_input = (pwm-1500)/500, [-1, +1]
    const stickIn = (ch2Pwm - 1500) / 500;
    // mode_qstabilize.cpp:96-100 — 正/负 stick 各看 PTCH_LIM_MAX / -PTCH_LIM_MIN, 跟 Q_A_ANGLE_MAX 取小
    // Q_A_ANGLE_MAX 在 AC_AttitudeControl::lean_angle_max_cd 内 clamp [5°, 80°]
    const qAngleMax = Math.max(5, Math.min(80, params.Q_A_ANGLE_MAX ?? 15));
    const ptchMax = params.PTCH_LIM_MAX_DEG ?? 5;
    const ptchMin = params.PTCH_LIM_MIN_DEG ?? -5;
    const limit = stickIn >= 0
      ? Math.min(ptchMax, qAngleMax)
      : Math.min(-ptchMin, qAngleMax);
    return stickIn * limit;
  }, [ch2Pwm, params.Q_A_ANGLE_MAX, params.PTCH_LIM_MAX_DEG, params.PTCH_LIM_MIN_DEG]);

  // MAVLink ATTITUDE.pitch 在 Quadplane VTOL view 模式下 = view.pitch = ahrs.pitch − Q_TRIM_PITCH
  // (ArduPlane GCS_MAVLink_Plane.cpp:144-148, show_vtol_view() 为 true 时用 ahrs_view->pitch)
  // 所以加回 pitchBase (= Q_TRIM_PITCH ramp 后值) 才是真实 body 绝对角度
  const pitchTargetFull = pitchBase + pitchStick;
  const pitchView = tlm.attitude?.pitch;       // view frame, 已减 Q_TRIM_PITCH
  const pitchActual = (pitchView !== undefined) ? (pitchView + pitchBase) : undefined;
  // ΔP = actual_body - target_body = view - stick (相同结果两种表达, view frame 等价)
  const pitchErr = (pitchView !== undefined) ? (pitchView - pitchStick) : undefined;
  // P7.9.4: MSK_P_EMRG_DEG 撤了 (三层级警告随 G3 一起删). 阈值固定 1.5° err / 0.75° warn.
  const P_ERR_THRESHOLD = 1.5;
  const pitchErrColor: 'ok'|'warn'|'err'|undefined = (pitchErr === undefined) ? undefined
    : Math.abs(pitchErr) >= P_ERR_THRESHOLD ? 'err'
    : Math.abs(pitchErr) >= P_ERR_THRESHOLD / 2 ? 'warn'
    : 'ok';
  // Tgt 始终显示 "base+stick" 拆解格式 (即使 stick=0 也显示 "+0.0°")
  const pitchTgtDisplay = pitchBase.toFixed(1) + '°' +
    (pitchStick >= 0 ? '+' : '') + pitchStick.toFixed(1) + '°';
  // P7.8: liveK 走 useState 订阅 NAMED_VALUE_FLOAT (上面 useEffect 拿). 不本地算 MSK_K*_G* (撤了).
  const liveTotalThrust = MOTORS.reduce((s, m) => s + (liveK[m.group] ?? 0) * SINGLE_MOTOR_MAX_N, 0);
  const liveTW = liveTotalThrust / VEHICLE_WEIGHT_N;

  const totalParams = Object.keys(DEFAULT_PARAMS).filter(k => !SYNC_SKIP_RE.test(k)).length;

  return (
    <div className="grid grid-cols-12 gap-2 auto-rows-min">
      {/* ═══ 行 1: 连接 + 全部遥测 + 操作 + 同步 (一字横排, 高度统一) ═══ */}
      <div className="card col-span-12 py-2">
        <div className="flex items-center gap-3 flex-wrap">
          {/* 连接区 */}
          <div className="flex items-center gap-1.5">
            {healthy ? <Wifi size={14} className="text-ok"/> : connected ? <Wifi size={14} className="text-warn"/> : <WifiOff size={14} className="text-fg-dim"/>}
            <span className="val-mono text-[11px] w-12">
              {!connected ? '未连接' : healthy ? '在线' : '无数据'}
            </span>
            <input value={url} onChange={e => setUrl(e.target.value)}
                   className="input val-mono text-[10px] py-0.5 w-44" disabled={connected}
                   placeholder="ws://127.0.0.1:8765" />
            {!connected
              ? <button className="btn btn-primary text-[10px] py-0.5 px-2" onClick={connect}>连接</button>
              : <button className="btn btn-warn text-[10px] py-0.5 px-2" onClick={disconnect}>断开</button>}
          </div>

          {/* 遥测格 */}
          <div className="flex items-center gap-1 ml-2">
            <TlmCell label="Mode" val={modeNum != null ? (MODE_LABELS[modeNum] || `mode ${modeNum}`) : '—'}
                     color={modeNum === 29 ? 'err' : modeNum === 27 ? 'warn' : modeNum === 17 ? 'ok' : undefined} />
            <TlmCell label="Armed" val={armed ? 'ARMED' : 'OFF'} color={armed ? 'err' : 'ok'} />
            <TlmCell label="GPS" val={tlm.gps ? `${tlm.gps.fix_type}/${tlm.gps.sats}★` : '—'} />
            <TlmCell label="HDOP" val={tlm.gps && tlm.gps.hdop !== null ? tlm.gps.hdop.toFixed(1) : '—'} />
            <TlmCell label="Body"  val={pitchActual !== undefined ? pitchActual.toFixed(1)+'°' : '—'} />
            <TlmCell label="View"  val={pitchView   !== undefined ? (pitchView>=0?'+':'')+pitchView.toFixed(1)+'°' : '—'} color={pitchErrColor} />
            <TlmCell label="Tgt"   val={pitchTgtDisplay} />
            <TlmCell label="Roll"  val={tlm.attitude ? tlm.attitude.roll.toFixed(0)+'°' : '—'} />
            <TlmCell label="地速" val={tlm.vfr ? tlm.vfr.groundspeed.toFixed(1) : '—'} highlight />
            <TlmCell label="油门" val={tlm.vfr ? tlm.vfr.throttle+'%' : '—'} />
          </div>

          <div className="flex-1"/>

          {/* Arm / Reboot / 同步 一组 */}
          <div className="flex items-center gap-1">
            {!armed ? (
              <button className="btn btn-primary text-[10px] py-0.5 px-2" onClick={() => gcs.arm()} disabled={!connected}>
                <Unlock size={11} className="inline mr-0.5"/>Arm
              </button>
            ) : (
              <button className="btn btn-warn text-[10px] py-0.5 px-2" onClick={() => gcs.disarm()} disabled={!connected}>
                <Lock size={11} className="inline mr-0.5"/>Disarm
              </button>
            )}
            <button className="btn text-[10px] py-0.5 px-2"
                    onClick={() => { if (confirm('重启飞控?')) gcs.reboot(); }}
                    disabled={!connected}>
              <RefreshCcw size={11} className="inline mr-0.5"/>Reboot
            </button>
            <span className="w-px h-4 bg-line mx-1"/>
            <button className="btn text-[10px] py-0.5 px-2"
                    onClick={pullAll} disabled={!connected || syncMode !== 'none'}>
              <Download size={11} className="inline mr-0.5"/>
              {syncMode === 'pulling' ? `${stats.pullCount}/${stats.pullTotal || '?'}` : `拉取(${totalParams})`}
            </button>
            <button className="btn btn-primary text-[10px] py-0.5 px-2"
                    onClick={pushAll} disabled={!connected || syncMode !== 'none' || armed}>
              <Upload size={11} className="inline mr-0.5"/>
              {syncMode === 'pushing' ? `${stats.pushCount}` : '保存'}
            </button>
          </div>
        </div>
      </div>

      {/* ═══ 行 2: 实时 K + 力平衡 + 电池 ═══ */}
      <div className="card col-span-4 py-2">
        <div className="flex items-center gap-2 mb-1.5">
          <TrendingUp size={12} className="text-accent"/>
          <span className="card-title mb-0 text-[11px]">实时 K 值</span>
          <span className="text-[10px] text-fg-dim ml-auto">
            {liveSpd != null ? `FC ${liveSpd.toFixed(1)} m/s` : 'UI 调试'}
          </span>
        </div>
        <div className="space-y-1">
          {(['KS','KDF','KT','KRD'] as GroupKey[]).map(g => (
            <div key={g} className="flex items-center gap-2">
              <span className="val-mono text-[10px] w-8" style={{ color: GROUP_COLORS[g] }}>{g}</span>
              <span className="text-fg-mute text-[9px] w-14 truncate">{GROUP_LABELS[g]}</span>
              <div className="h-1.5 bg-panel-2 rounded overflow-hidden flex-1">
                <div className="h-full transition-all" style={{ width: (liveK[g]*100)+'%', background: GROUP_COLORS[g] }} />
              </div>
              <span className="val-mono text-[10px] w-9 text-right">{(liveK[g]*100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card col-span-3 py-2">
        <div className="card-title text-[11px] mb-1.5">力平衡</div>
        <div className="grid grid-cols-2 gap-1.5 text-center">
          <div className="bg-panel-2 rounded py-1">
            <div className="text-[8px] text-fg-mute">总推力</div>
            <div className="val-mono text-[13px]">{liveTotalThrust.toFixed(0)}<span className="text-fg-dim text-[8px] ml-0.5">N</span></div>
          </div>
          <div className="bg-panel-2 rounded py-1">
            <div className="text-[8px] text-fg-mute">机重</div>
            <div className="val-mono text-[13px]">{VEHICLE_WEIGHT_N}<span className="text-fg-dim text-[8px] ml-0.5">N</span></div>
          </div>
          <div className="bg-panel-2 rounded py-1">
            <div className="text-[8px] text-fg-mute">T/W</div>
            <div className={'val-mono text-[13px] ' + (liveTW < 1 ? 'text-err' : liveTW < 1.5 ? 'text-warn' : 'text-ok')}>{liveTW.toFixed(2)}</div>
          </div>
          <div className="bg-panel-2 rounded py-1">
            <div className="text-[8px] text-fg-mute">富余</div>
            <div className={'val-mono text-[13px] ' + (liveTotalThrust-VEHICLE_WEIGHT_N < 0 ? 'text-err' : liveTotalThrust-VEHICLE_WEIGHT_N < 20 ? 'text-warn' : 'text-ok')}>
              {liveTotalThrust-VEHICLE_WEIGHT_N >= 0 ? '+' : ''}{(liveTotalThrust-VEHICLE_WEIGHT_N).toFixed(0)}<span className="text-fg-dim text-[8px] ml-0.5">N</span>
            </div>
          </div>
        </div>
      </div>

      {/* 电池 (battery 1) */}
      <div className="card col-span-5 py-2">
        <div className="card-title text-[11px] mb-1.5 flex items-center gap-1.5">
          <span>电池 1</span>
          {!tlm.battery && <span className="text-[9px] text-fg-dim font-normal">(无数据)</span>}
        </div>
        {tlm.battery ? (() => {
          const b = tlm.battery;
          const v = b.voltage;
          const cells6 = v / 6;  // 6S 默认
          const cellOk = cells6 >= 3.7;
          const cellWarn = cells6 >= 3.5 && cells6 < 3.7;
          const power = b.current ? (v * b.current) : null;
          return (
            <div className="grid grid-cols-4 gap-1.5 text-center">
              <div className="bg-panel-2 rounded py-1">
                <div className="text-[8px] text-fg-mute">电压</div>
                <div className={'val-mono text-[13px] ' + (cellOk ? 'text-ok' : cellWarn ? 'text-warn' : 'text-err')}>
                  {v.toFixed(1)}<span className="text-fg-dim text-[8px] ml-0.5">V</span>
                </div>
                <div className="text-[8px] text-fg-dim">{cells6.toFixed(2)} V/cell · 6S</div>
              </div>
              <div className="bg-panel-2 rounded py-1">
                <div className="text-[8px] text-fg-mute">电流</div>
                <div className="val-mono text-[13px]">
                  {b.current !== null ? b.current.toFixed(1) : '—'}<span className="text-fg-dim text-[8px] ml-0.5">A</span>
                </div>
                {power !== null && <div className="text-[8px] text-fg-dim">{power.toFixed(0)} W</div>}
              </div>
              <div className="bg-panel-2 rounded py-1">
                <div className="text-[8px] text-fg-mute">已用</div>
                <div className="val-mono text-[13px]">{b.consumed_mah ?? 0}<span className="text-fg-dim text-[8px] ml-0.5">mAh</span></div>
              </div>
              <div className="bg-panel-2 rounded py-1">
                <div className="text-[8px] text-fg-mute">剩余</div>
                <div className={'val-mono text-[13px] ' + (b.remaining < 0 ? 'text-fg-dim' : b.remaining < 20 ? 'text-err' : b.remaining < 40 ? 'text-warn' : 'text-ok')}>
                  {b.remaining < 0 ? '—' : b.remaining + '%'}
                </div>
                {b.remaining >= 0 && (
                  <div className="h-1 mt-0.5 mx-1 bg-bg-100 rounded overflow-hidden">
                    <div className={'h-full transition-all ' + (b.remaining < 20 ? 'bg-err' : b.remaining < 40 ? 'bg-warn' : 'bg-ok')}
                         style={{ width: b.remaining + '%' }} />
                  </div>
                )}
              </div>
            </div>
          );
        })() : (
          <div className="text-[10px] text-fg-dim text-center py-3">未连或无电池遥测</div>
        )}
      </div>

      {/* ═══ 行 3: RC 通道 (与 SERVO 同列布局对称) ═══ */}
      <div className="card col-span-6 py-2">
        <div className="card-title text-[11px] mb-1.5 flex items-center gap-1.5">
          <span>RC 通道 (1-12)</span>
          {!tlm.rc && <span className="text-[9px] text-fg-dim font-normal">(无 RC)</span>}
        </div>
        <div className="grid grid-cols-3 gap-x-3 gap-y-1">
          {Array.from({ length: 12 }, (_, i) => {
            const v = tlm.rc?.[i] ?? 0;
            // RC 范围 800-2200 (兼容飞控扩展), 映射 0-100%
            const pct = v > 0 ? Math.max(0, Math.min(100, (v - 800) / 14)) : 0;
            // 标注用途, 跟 MSK_*_CH 参数对齐
            const role = i === 5 ? 'Mode'   // ch6
                       : i === 6 ? '档位'   // ch7
                       : i === 7 ? '预检'   // ch8
                       : i === 8 ? 'Auto'   // ch9
                       : i === 11 ? 'RTL'   // ch12
                       : '';
            const label = role ? `CH${i+1} ${role}` : `CH${i+1}`;
            return (
              <div key={i} className="flex items-center gap-1.5">
                <span className="text-[9px] text-fg-dim w-14 shrink-0 truncate">{label}</span>
                <div className="h-1.5 bg-panel-2 rounded overflow-hidden flex-1 min-w-0">
                  <div className="h-full bg-accent" style={{ width: pct + '%' }} />
                </div>
                <span className="val-mono text-[9px] w-9 text-right">{v || '—'}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* SERVO 输出 (按功能名显示) */}
      <div className="card col-span-6 py-2">
        <div className="card-title text-[11px] mb-1.5 flex items-center gap-1.5">
          <span>SERVO 输出 (按功能)</span>
          <span className="text-[9px] text-fg-dim font-normal">12 EDF + 7 倾转舵</span>
          {!tlm.servo && <span className="text-[9px] text-fg-dim font-normal">(无)</span>}
        </div>
        <div className="grid grid-cols-3 gap-x-3 gap-y-1">
          {([
            // [SERVO 物理通道 idx (0-based), 功能名, 'M'|'T']
            [0,  'SL1',     'M'],
            [1,  'SL2',     'M'],
            [2,  'SR1',     'M'],
            [3,  'SR2',     'M'],
            [4,  'DFL',     'M'],
            [5,  'DFR',     'M'],
            [6,  'TL1',     'M'],
            [7,  'TL2',     'M'],
            [8,  'TR1',     'M'],
            [9,  'TR2',     'M'],
            [10, 'RDL',     'M'],
            [11, 'RDR',     'M'],
            [12, 'DFL 倾',  'T'],
            [13, 'DFR 倾',  'T'],
            [14, 'TL1 倾',  'T'],
            [15, 'TR1 倾',  'T'],
            [16, 'RDL 倾',  'T'],
            [17, 'RDR 倾',  'T'],
            [18, 'S 组 倾', 'T'],
          ] as const).map(([idx, name, group]) => {
            const v = tlm.servo?.[idx] ?? 0;
            // 电机 (M) 800-2200, 倾转舵 (T) 500-2500
            const pct = v <= 0 ? 0 : group === 'M'
              ? Math.max(0, Math.min(100, (v - 800) / 14))
              : Math.max(0, Math.min(100, (v - 500) / 20));
            const color = group === 'M' ? 'bg-accent' : 'bg-ks';
            return (
              <div key={idx} className="flex items-center gap-1.5">
                <span className="text-[9px] text-fg-dim w-14 shrink-0 truncate">{name}</span>
                <div className="h-1.5 bg-panel-2 rounded overflow-hidden flex-1 min-w-0">
                  <div className={'h-full ' + color} style={{ width: pct + '%' }} />
                </div>
                <span className="val-mono text-[9px] w-9 text-right">{v || '—'}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══ 行 3: STATUSTEXT 占满 ═══ */}
      <div className="card col-span-12 py-2">
        <div className="flex items-center mb-1">
          <Terminal size={12} className="mr-1.5" />
          <span className="card-title text-[11px] mb-0">STATUSTEXT 日志</span>
          <span className="text-[9px] text-fg-dim ml-2">MSK CHK / K 心跳 / tilt saturation</span>
          {armed && <span className="ml-auto text-[9px] text-warn">⚠ FC 已 armed, 禁推参数</span>}
        </div>
        <div ref={logRef} onScroll={onLogScroll} className="bg-bg-100 border border-line rounded p-1.5 h-40 overflow-auto text-[10px] font-mono space-y-0.5">
          {log.length === 0 && <div className="text-fg-dim">暂无消息</div>}
          {log.map((l, i) => (
            <div key={i} className={sevColor(l.sev)}>
              <span className="text-fg-dim">[{new Date(l.ts).toLocaleTimeString()}]</span>{' '}
              {l.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TlmCell({ label, val, color, highlight }: { label: string; val: string; color?: 'ok'|'warn'|'err'; highlight?: boolean }) {
  const cls = color === 'ok' ? 'text-ok' : color === 'warn' ? 'text-warn' : color === 'err' ? 'text-err' :
              highlight ? 'text-accent' : 'text-fg';
  return (
    <div className="bg-panel-2 rounded px-1.5 py-0.5 text-center min-w-[44px]">
      <div className="text-[8px] text-fg-mute leading-none">{label}</div>
      <div className={'val-mono text-[11px] leading-tight ' + cls}>{val}</div>
    </div>
  );
}
