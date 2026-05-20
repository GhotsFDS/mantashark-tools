import React, { useState, useEffect, useRef } from 'react';
import { useStore } from './store/useStore';
import { gcs, GcsMessage } from './lib/gcs';
import { quantize, DEFAULT_PARAMS, SYNC_SKIP_RE } from './lib/defaults';
import { Wifi, WifiOff } from 'lucide-react';
import { Waves, Sliders, Grid3x3, Settings, PlugZap, FileSearch, Satellite, Bot, LineChart, MapPin } from 'lucide-react';
import { FlightProfile } from './components/tabs/FlightProfile';
import { Tilts } from './components/tabs/Tilts';
import { Geometry } from './components/tabs/Geometry';
import { Params } from './components/tabs/Params';
import { Gcs } from './components/tabs/Gcs';
import { LogAnalysis } from './components/tabs/LogAnalysis';
import { RtkSetup } from './components/tabs/RtkSetup';
import { Auto } from './components/tabs/Auto';
import { GroundTest } from './components/tabs/GroundTest';
import { Plot } from './components/tabs/Plot';
import { Map } from './components/tabs/Map';

// v9 P7.5: GCS / 模式配置 / 地面测试 / 控制律 / 舵机标定 / RTK / LOG 分析 / 参数
const TABS = [
  { id: 'gcs',       label: 'GCS',          Icon: PlugZap },
  { id: 'auto',      label: '模式配置',     Icon: Bot },
  { id: 'gtest',     label: '地面测试',     Icon: Grid3x3 },
  { id: 'profile',   label: '控制律',       Icon: Waves },
  { id: 'tilts',     label: '舵机标定',     Icon: Sliders },
  { id: 'plot',      label: '实时曲线',     Icon: LineChart },
  { id: 'map',       label: '航点地图',     Icon: MapPin },
  { id: 'rtk',       label: 'RTK',          Icon: Satellite },
  { id: 'loganalysis', label: 'LOG 分析',   Icon: FileSearch },
  { id: 'params',    label: '参数',         Icon: Settings },
];

// P7.8: ch6 走 ArduPlane FLTMODE_CH=6, lua 不读 ch6. mode 数字 = heartbeat.custom_mode
const MODE_LABELS: Record<number, string> = {
  17: 'MANUAL (QSTAB)',
  27: 'AUTO (WIG_AUTO)',
  29: 'RECV (WIG_RECV)',
};
const MODE_COLOR: Record<number, string> = {
  17: 'text-ok',
  27: 'text-accent',
  29: 'text-err',
};

export default function App() {
  const { currentTab, setTab, params, setParam, setSimulateArmed } = useStore();
  const [gcsConnected, setGcsConnected] = useState(false);
  const [gcsArmed, setGcsArmed] = useState<boolean | null>(null);
  const [liveRc, setLiveRc] = useState<number[] | null>(null);
  const [liveMode, setLiveMode] = useState<number | null>(null);
  const [livePhase, setLivePhase] = useState<string>('—');
  const [toast, setToast] = useState<string | null>(null);
  // v9 P4 RTK 状态: GPS1 + GPS2 (双头 C-RTK2 HP)
  const [liveGps, setLiveGps] = useState<{ fix_type: number; sats: number; yaw_deg: number | null; vel_mps: number | null } | null>(null);
  const [liveGps2, setLiveGps2] = useState<{ fix_type: number; sats: number; yaw_deg: number | null } | null>(null);

  // P7.8 拨杆解码 (mode 走 heartbeat.custom_mode, ch7 语义跟 mode 走)
  // ch12 二档开关 = ArduPlane GPS RTL 紧急返航 (RCx_OPTION = 4 RTL, ArduPlane 自带, 不走 lua)
  const liveRtl = liveRc ? (liveRc[11] ?? 1500) > 1700 : null;
  const livePreflight = liveRc ? ((liveRc[7] ?? 1500) > 1700 && gcsArmed === false) : null;
  const ch7Label = (() => {
    if (!liveRc || liveMode == null) return null;
    const pwm = liveRc[6] ?? 1500;
    const tier = pwm < 1300 ? 'low' : pwm <= 1700 ? 'mid' : 'high';
    if (liveMode === 17) return tier === 'low' ? 'TAXI' : tier === 'mid' ? 'TRANS' : 'CRUISE';
    if (liveMode === 27) return (tier === 'low' ? 'MATRIX' : tier === 'mid' ? 'TURN' : 'CRUISE');
    return '—';
  })();

  // 切换提示 (toast) — mode / phase / RTL / preflight
  const lastMode = useRef<number | null>(null);
  const lastRtl  = useRef<boolean | null>(null);
  const lastChk  = useRef<boolean | null>(null);
  useEffect(() => {
    if (liveMode == null) return;
    if (lastMode.current !== null && lastMode.current !== liveMode) {
      setToast(`Mode 切换 → ${MODE_LABELS[liveMode] || liveMode}`);
      setTimeout(() => setToast(null), 5000);
    }
    lastMode.current = liveMode;
  }, [liveMode]);
  useEffect(() => {
    if (liveRtl == null) return;
    if (lastRtl.current !== null && lastRtl.current !== liveRtl) {
      setToast(liveRtl ? '⚠ RTL 返航触发 (ch12 高位, ArduPlane 自动飞回 home)' : 'RTL 解除');
      setTimeout(() => setToast(null), 4000);
    }
    lastRtl.current = liveRtl;
  }, [liveRtl]);
  useEffect(() => {
    if (livePreflight == null) return;
    if (lastChk.current !== null && lastChk.current !== livePreflight) {
      setToast(livePreflight ? '⚠ 预检激活 (ch8 高位 + disarmed)' : '预检关闭');
      setTimeout(() => setToast(null), 3000);
    }
    lastChk.current = livePreflight;
  }, [livePreflight]);

  // ─── App-level GCS listener: 保证不管哪个 tab 打开, PARAM_VALUE 都同步到 store ───
  const [autoSyncStatus, setAutoSyncStatus] = useState<string | null>(null);
  const autoSyncedRef = useRef(false);  // 同 ws session 只自动 pull 一次
  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'status') {
        setGcsConnected(m.connected);
        if (!m.connected) autoSyncedRef.current = false;  // 重连允许重新 pull
      }
      else if (m.type === 'heartbeat') {
        setGcsArmed(m.armed);
        setSimulateArmed(m.armed);
        if (typeof m.custom_mode === 'number') setLiveMode(m.custom_mode);
      }
      else if (m.type === 'rc') setLiveRc(m.channels);
      else if (m.type === 'gps') setLiveGps({
        fix_type: m.fix_type, sats: m.sats,
        yaw_deg: m.yaw_deg ?? null, vel_mps: m.vel_mps ?? null,
      });
      else if (m.type === 'gps2') setLiveGps2({
        fix_type: m.fix_type, sats: m.sats, yaw_deg: m.yaw_deg ?? null,
      });
      else if (m.type === 'statustext') {
        // P7.8: WIG_AUTO phase → 状态机推 toast + 更新 livePhase
        const phMatch = m.text.match(/WIG_AUTO phase\s*[→\->]+\s*(\w+)/);
        if (phMatch) {
          setLivePhase(phMatch[1]);
          setToast(`Phase → ${phMatch[1]}`);
          setTimeout(() => setToast(null), 3000);
        }
        // WIG dispatcher: X → Y (mode 切换)
        if (/WIG dispatcher:/i.test(m.text)) {
          setToast(m.text.replace(/^WIG /, ''));
          setTimeout(() => setToast(null), 3000);
        }
      }
      else if (m.type === 'param') {
        if (m.name in params) setParam(m.name, quantize(m.name, m.value));
      }
    });
    return () => { off(); };
  }, [params, setParam]);

  // ─── 连接 FC 后自动 pullAll: 第一次 heartbeat 后 1s 触发 (等 mavbridge 跟 FC 握手稳定)
  // ──  保证切到 Tilts/FlightProfile/Params 时 store 里是真 FC 值, 不是 default ───
  useEffect(() => {
    if (!gcsConnected || autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    const t = setTimeout(async () => {
      const keys = Object.keys(DEFAULT_PARAMS).filter(k => !SYNC_SKIP_RE.test(k));
      setAutoSyncStatus(`同步飞控参数 0/${keys.length}`);
      const r = await gcs.pullParams(keys, (g, total) =>
        setAutoSyncStatus(`同步飞控参数 ${g}/${total}`));
      setAutoSyncStatus(r.timedOut
        ? `⚠ 同步超时 ${r.got}/${keys.length}, 缺 ${r.missing.length}`
        : `✓ 已同步 ${r.got} 个参数`);
      setTimeout(() => setAutoSyncStatus(null), 4000);
    }, 1000);
    return () => clearTimeout(t);
  }, [gcsConnected]);

  const panel = (() => {
    switch (currentTab) {
      case 'gcs':       return <Gcs />;
      case 'auto':      return <Auto />;
      case 'gtest':     return <GroundTest />;
      case 'profile':   return <FlightProfile />;
      case 'tilts':     return <Tilts />;
      case 'geometry':  return <Geometry />;
      case 'plot':      return <Plot />;
      case 'map':       return <Map />;
      case 'rtk':       return <RtkSetup />;
      case 'loganalysis': return <LogAnalysis />;
      case 'params':    return <Params />;
      default: return <Gcs />;
    }
  })();

  return (
    <div className="h-full flex flex-col bg-bg relative">
      {/* 模式切换 toast (右下角浮动, 不遮挡 header/tabs, 5s 自动消失) */}
      {toast && (
        <div className="fixed bottom-8 right-4 z-50 bg-accent text-bg px-3 py-1.5 rounded shadow-lg val-mono text-[12px] fade-in pointer-events-none">
          {toast}
        </div>
      )}
      {/* P7.8 常驻顶部状态条: 连接 / Mode (ch6) / Phase / ch7 / Armed / 预检 / RTL */}
      <div className="bg-panel-2 border-b border-line px-4 py-1.5 flex items-center gap-3 text-[11px] shrink-0">
        <button
          onClick={() => { gcsConnected ? gcs.disconnect() : gcs.connect(); }}
          className={
            'flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] transition-colors ' +
            (gcsConnected
              ? 'border-ok text-ok hover:bg-ok/10'
              : 'border-line text-fg-dim hover:text-fg hover:border-accent')
          }
          title={gcsConnected ? '断开 mavbridge' : '连接 mavbridge.py'}
        >
          {gcsConnected ? <Wifi size={12}/> : <WifiOff size={12}/>}
          {gcsConnected ? '在线' : '离线'}
        </button>
        <span className="text-fg-dim">|</span>
        <span className="val-mono">
          Mode(ch6) <b className={liveMode != null ? (MODE_COLOR[liveMode] || 'text-accent') : 'text-fg-dim'}>
            {liveMode != null ? (MODE_LABELS[liveMode] || `mode ${liveMode}`) : '— (无 FC)'}
          </b>
        </span>
        {liveMode != null && ch7Label && (
          <span className="val-mono">
            <span className="text-fg-dim">ch7→</span><b className="text-accent">{ch7Label}</b>
          </span>
        )}
        {livePhase !== '—' && liveMode === 27 && (
          <span className="val-mono">
            <span className="text-fg-dim">Phase</span> <b className="text-accent">{livePhase}</b>
          </span>
        )}
        <span className="val-mono">
          <span className="text-fg-dim">Armed</span> <b className={gcsArmed ? 'text-err' : 'text-ok'}>
            {gcsArmed === null ? '—' : gcsArmed ? '● ARMED' : '○ off'}
          </b>
        </span>
        {livePreflight && (
          <span className="val-mono text-warn animate-pulse">⚠ 预检激活 (ch8 高 + disarmed)</span>
        )}
        {liveRtl && (
          <span className="val-mono text-err animate-pulse">⚠ RTL (ch12)</span>
        )}
      </div>
      {/* Header */}
      <header className="bg-panel border-b border-line flex items-center gap-4 px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-accent to-ks flex items-center justify-center text-bg font-bold">M</div>
          <div>
            <div className="text-[13px] font-semibold text-fg">MantaShark 地面站</div>
            <div className="text-[10px] text-fg-dim">v9 P7.8 · ArduPlane · 12 EDF + 7 tilt · FLTMODE_CH=6</div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-4 text-[11px]">
          {/* P7.8: gear/ThrCap/Phase StatBox 撤了, 状态条接管. header 只留 RTK + 同步指示 */}
          {liveGps && (
            <StatBox label="RTK">
              <span
                className={'chip chip-active text-[10px] ' + (
                  liveGps.fix_type >= 6 ? 'text-ok' :
                  liveGps.fix_type === 5 ? 'text-warn' :
                  liveGps.fix_type >= 3 ? '' :
                  'text-err'
                )}
                title={
                  `GPS1 fix=${['NoGPS','NoFix','2D','3D','DGPS','RTK_Float','RTK_Fixed','Static','PPP'][liveGps.fix_type] || '?'} ` +
                  `sats=${liveGps.sats}` +
                  (liveGps.yaw_deg !== null ? ` yaw=${liveGps.yaw_deg.toFixed(1)}°` : ' (无 yaw)') +
                  (liveGps2 ? ` | GPS2 sats=${liveGps2.sats} fix=${liveGps2.fix_type}` : '')
                }
              >
                {['NoGPS','NoFix','2D','3D','DGPS','Float','Fixed','Static','PPP'][liveGps.fix_type] || '?'}
                {liveGps.yaw_deg !== null && <span className="text-fg-dim ml-1">{liveGps.yaw_deg.toFixed(0)}°</span>}
              </span>
            </StatBox>
          )}
          {autoSyncStatus && (
            <span className="val-mono text-[10px] px-2 py-1 rounded border border-accent text-accent fade-in">
              {autoSyncStatus}
            </span>
          )}
        </div>
      </header>

      {/* Tabs */}
      <nav className="bg-panel-2 border-b border-line flex shrink-0">
        {TABS.map(t => {
          const Icon = t.Icon;
          const active = currentTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                'flex items-center gap-2 px-4 py-2.5 text-[12px] cursor-pointer border-b-2 transition-all ' +
                (active
                  ? 'text-accent border-accent bg-bg/40'
                  : 'text-fg-mute border-transparent hover:text-fg hover:bg-panel-3/50')
              }
            >
              <Icon size={14} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Main: 直接用 grid 布局, 不走 ScaledCanvas (用户反馈 16:9 缩放更怪) */}
      <main className="flex-1 overflow-auto p-4 fade-in" key={currentTab}>
        {panel}
      </main>

      {/* Footer */}
      <footer className="bg-panel border-t border-line px-4 py-2 flex items-center gap-3 text-[10px] text-fg-dim shrink-0">
        <span>WIG · 10kg · 12×64mm EDF · QF2822 2300KV · 7 倾转 (CAN-PWM)</span>
        <span className="ml-auto">© MantaShark · v9 P7.8</span>
      </footer>
    </div>
  );
}

function StatBox({ label, val, children }: { label: string; val?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-fg-dim">{label}</span>
      {val && <span className="val-mono text-fg">{val}</span>}
      {children}
    </div>
  );
}
