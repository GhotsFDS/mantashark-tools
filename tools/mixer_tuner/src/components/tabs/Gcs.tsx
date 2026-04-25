import React, { useEffect, useState, useRef } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';
import { useStore } from '../../store/useStore';
import { Wifi, WifiOff, PlugZap, Upload, Download, Lock, Unlock, RefreshCcw, Terminal } from 'lucide-react';
import { DEFAULT_PARAMS } from '../../lib/defaults';

interface Telemetry {
  heartbeat?: { mode: string; armed: boolean; ts: number };
  attitude?:  { roll: number; pitch: number; yaw: number };
  vfr?:       { airspeed: number; groundspeed: number; alt: number; climb: number; throttle: number };
  gps?:       { fix_type: number; sats: number; hdop: number | null };
  rc?:        number[];
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
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setConnected(gcs.isConnected());
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'status') setConnected(m.connected);
      else if (m.type === 'heartbeat') setTlm(t => ({ ...t, heartbeat: { ...m, ts: Date.now() }, lastMsgMs: Date.now() }));
      else if (m.type === 'attitude') setTlm(t => ({ ...t, attitude: m, lastMsgMs: Date.now() }));
      else if (m.type === 'vfr_hud')  setTlm(t => ({ ...t, vfr: m, lastMsgMs: Date.now() }));
      else if (m.type === 'gps')      setTlm(t => ({ ...t, gps: m, lastMsgMs: Date.now() }));
      else if (m.type === 'rc')       setTlm(t => ({ ...t, rc: m.channels, lastMsgMs: Date.now() }));
      else if (m.type === 'statustext') setLog(l => [...l.slice(-199), { sev: m.severity, text: m.text, ts: Date.now() }]);
      // param 由 App-level listener 统一写 store, 这里只看到累计计数
      else if (m.type === 'param') setStats(s => ({ ...s, pullCount: s.pullCount + 1, pullTotal: m.count }));
      else if (m.type === 'error') setLog(l => [...l.slice(-199), { sev: 2, text: '❌ ' + m.msg, ts: Date.now() }]);
    });
    return () => { off(); };
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const connect = () => { gcs.setUrl(url); gcs.connect(); };
  const disconnect = () => gcs.disconnect();

  const pullAll = async () => {
    if (syncMode !== 'none') return;
    setStats({ pullCount: 0, pullTotal: 0, pushCount: 0 });
    setSyncMode('pulling');
    const keys = Object.keys(DEFAULT_PARAMS).filter(k => !/^PRE_OVR_/.test(k));
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
      if (k in params && !/^PRE_OVR_/.test(k)) map[k] = params[k];
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

  return (
    <div className="grid grid-cols-12 gap-3">
      {/* 连接 */}
      <div className="card col-span-4">
        <div className="card-title flex items-center gap-2">
          <PlugZap size={14} />连接
        </div>
        <div className="flex items-center gap-2 mb-3">
          {healthy ? <Wifi size={18} className="text-ok" /> : connected ? <Wifi size={18} className="text-warn" /> : <WifiOff size={18} className="text-fg-dim" />}
          <div className="flex-1">
            <div className="val-mono text-[13px]">
              {!connected ? '未连接' : healthy ? '在线' : '连上但无数据'}
            </div>
            <div className="text-[10px] text-fg-dim">mavbridge.py @ {url}</div>
          </div>
        </div>
        <div className="flex gap-2 mb-2">
          <input value={url} onChange={e => setUrl(e.target.value)}
                 className="input flex-1 val-mono text-[10px]" disabled={connected} />
        </div>
        <div className="flex gap-2">
          {!connected ? (
            <button className="btn btn-primary flex-1" onClick={connect}>连接</button>
          ) : (
            <button className="btn btn-warn flex-1" onClick={disconnect}>断开</button>
          )}
        </div>
        <div className="text-[9px] text-fg-dim mt-2">
          launch.sh 自动起 <code className="text-accent">mavbridge.py</code>. 手动: <code>python3 mavbridge.py</code>
        </div>
      </div>

      {/* 遥测 */}
      <div className="card col-span-5">
        <div className="card-title">实时遥测</div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <TlmCell label="Mode" val={tlm.heartbeat?.mode ?? '—'} />
          <TlmCell label="Armed" val={armed ? 'ARMED' : 'DISARMED'} color={armed ? 'warn' : 'ok'} />
          <TlmCell label="GPS Fix" val={tlm.gps ? `${tlm.gps.fix_type} (${tlm.gps.sats}★)` : '—'} />
          <TlmCell label="Pitch"  val={tlm.attitude ? tlm.attitude.pitch.toFixed(1)+'°' : '—'} />
          <TlmCell label="Roll"   val={tlm.attitude ? tlm.attitude.roll.toFixed(1)+'°' : '—'} />
          <TlmCell label="Yaw"    val={tlm.attitude ? tlm.attitude.yaw.toFixed(0)+'°' : '—'} />
          <TlmCell label="地速"   val={tlm.vfr ? tlm.vfr.groundspeed.toFixed(1)+' m/s' : '—'} highlight />
          <TlmCell label="气速"   val={tlm.vfr ? tlm.vfr.airspeed.toFixed(1)+' m/s' : '—'} />
          <TlmCell label="油门"   val={tlm.vfr ? tlm.vfr.throttle+' %' : '—'} />
        </div>
        {tlm.rc && (
          <>
            <div className="card-section">RC 通道 (CH1-8)</div>
            <div className="grid grid-cols-8 gap-1">
              {tlm.rc.map((v, i) => (
                <div key={i} className="text-center">
                  <div className="text-[9px] text-fg-dim">CH{i+1}</div>
                  <div className="val-mono text-[10px]">{v}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 操作 */}
      <div className="card col-span-3">
        <div className="card-title">Arm / Reboot</div>
        <div className="space-y-2">
          {!armed ? (
            <button className="btn btn-primary w-full" onClick={() => gcs.arm()} disabled={!connected}>
              <Unlock size={12} className="inline mr-1" /> Arm
            </button>
          ) : (
            <button className="btn btn-warn w-full" onClick={() => gcs.disarm()} disabled={!connected}>
              <Lock size={12} className="inline mr-1" /> Disarm
            </button>
          )}
          <button className="btn w-full" onClick={() => {
            if (confirm('重启飞控 (FC reboot)?')) gcs.reboot();
          }} disabled={!connected}>
            <RefreshCcw size={12} className="inline mr-1" /> Reboot FC
          </button>
        </div>
      </div>

      {/* 参数同步 */}
      <div className="card col-span-6">
        <div className="card-title">参数同步 — {Object.keys(DEFAULT_PARAMS).length} 个 MSK_/TLT_/GRD_/PRE_/MGEO_/TLTC_</div>
        <div className="flex gap-2 mb-3">
          <button className="btn btn-primary flex-1" onClick={pullAll} disabled={!connected || syncMode !== 'none'}>
            <Download size={12} className="inline mr-1" />
            从 FC 拉取 {syncMode === 'pulling' && `(${stats.pullCount}/${stats.pullTotal || '?'})`}
          </button>
          <button className="btn btn-primary flex-1" onClick={pushAll} disabled={!connected || syncMode !== 'none' || armed}>
            <Upload size={12} className="inline mr-1" />
            推送到 FC {syncMode === 'pushing' && `(${stats.pushCount})`}
          </button>
        </div>
        {armed && (
          <div className="text-[10px] text-warn mb-2">⚠ 飞控已解锁, 禁止推送参数. 先 Disarm.</div>
        )}
        <div className="text-[10px] text-fg-mute space-y-0.5">
          <div>• 拉取: 发 param_read × {Object.keys(DEFAULT_PARAMS).length} 路, ~{(Object.keys(DEFAULT_PARAMS).length*0.05).toFixed(1)}s 完成 (filter MSK/TLT/GRD/PRE/MGEO/TLTC)</div>
          <div>• 推送: PARAM_SET × {Object.keys(DEFAULT_PARAMS).length}, FC 会 ACK 回 PARAM_VALUE (覆盖本地值)</div>
          <div>• 慢速串口 (57600) 用全量 param_request_list 太慢, 本工具走命名读</div>
        </div>
      </div>

      {/* STATUSTEXT 日志 */}
      <div className="card col-span-6">
        <div className="card-title flex items-center gap-2">
          <Terminal size={14} />STATUSTEXT 日志 (Lua send_text + FC 系统消息)
        </div>
        <div ref={logRef} className="bg-bg-100 border border-line rounded p-2 h-48 overflow-auto text-[10px] font-mono space-y-0.5">
          {log.length === 0 && <div className="text-fg-dim">暂无消息 · 连接后 FC 的 STATUSTEXT 会在这里显示</div>}
          {log.map((l, i) => (
            <div key={i} className={sevColor(l.sev)}>
              <span className="text-fg-dim">[{new Date(l.ts).toLocaleTimeString()}]</span>{' '}
              <span className="text-fg-dim">[{l.sev}]</span>{' '}
              {l.text}
            </div>
          ))}
        </div>
        <div className="text-[9px] text-fg-dim mt-1">
          重点看: MSK CHK (预检) · MSK K: (1Hz 心跳) · MSK tilt saturation (舵机饱和)
        </div>
      </div>
    </div>
  );
}

function TlmCell({ label, val, color, highlight }: { label: string; val: string; color?: 'ok'|'warn'|'err'; highlight?: boolean }) {
  const cls = color === 'ok' ? 'text-ok' : color === 'warn' ? 'text-warn' : color === 'err' ? 'text-err' :
              highlight ? 'text-accent' : 'text-fg';
  return (
    <div className="bg-panel-2 rounded p-2 text-center">
      <div className="text-[9px] text-fg-mute">{label}</div>
      <div className={'val-mono text-[13px] ' + cls}>{val}</div>
    </div>
  );
}
