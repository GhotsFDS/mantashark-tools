import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useStore } from './store/useStore';
import { evalCurve } from './lib/pchip';
import { gcs, GcsMessage } from './lib/gcs';
import { quantize, DEFAULT_PARAMS, SYNC_SKIP_RE } from './lib/defaults';
import type { GroupKey } from './lib/types';
import { Wifi, WifiOff } from 'lucide-react';
import { Waves, Sliders, Grid3x3, PlayCircle, Settings, PlugZap } from 'lucide-react';
import { FlightProfile } from './components/tabs/FlightProfile';
import { Tilts } from './components/tabs/Tilts';
import { Geometry } from './components/tabs/Geometry';
import { Preflight } from './components/tabs/Preflight';
import { Params } from './components/tabs/Params';
import { Gcs } from './components/tabs/Gcs';

// v9 P3.6: GCS / 飞行配置 (3 档) / 舵机标定 / 预检 / 参数
const TABS = [
  { id: 'gcs',       label: 'GCS',          Icon: PlugZap },
  { id: 'profile',   label: '飞行配置',     Icon: Waves },
  { id: 'tilts',     label: '舵机标定',     Icon: Sliders },
  { id: 'preflight', label: '预检',         Icon: PlayCircle },
  { id: 'params',    label: '参数',         Icon: Settings },
];

export default function App() {
  const { currentTab, setTab, currentSpeed, currentGear, currentPhase, params, simulateArmed, setParam, setSimulateArmed } = useStore();
  const [gcsConnected, setGcsConnected] = useState(false);
  const [gcsArmed, setGcsArmed] = useState<boolean | null>(null);
  const [liveRc, setLiveRc] = useState<number[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // ─── v9 通道语义 (CLAUDE.md 权威):
  //   ch7 g_mode 三档:  <1300 G1 慢滑 / 1300-1700 G2 抬头建气垫 / >1700 G3 巡航
  //   ch6 thr_cap 三档: <1300 IDLE 0% / 1300-1700 CHECK 30% / >1700 TEST 60%
  //   ch8 preflight 二态: >1700 + disarmed = 4 阶段地面预检
  const liveGear = liveRc ? (() => {
    const pwm = liveRc[6] ?? 1500;  // ch7 (1-indexed) = idx 6
    return pwm < 1300 ? 1 : pwm < 1700 ? 2 : 3;
  })() : null;
  const liveThrCap = liveRc ? (() => {
    const pwm = liveRc[5] ?? 1500;  // ch6 = idx 5
    return pwm < 1300 ? 'IDLE' : pwm < 1700 ? 'CHECK' : 'TEST';
  })() : null;
  // v9 P3.9: 预检触发改为 ch6 中档 (CHECK) + disarmed (跟 thr_cap 共位)
  const livePreflight = liveRc ? (liveThrCap === 'CHECK' && gcsArmed === false) : null;
  // ch12 二档开关 = ArduPlane GPS RTL 紧急返航 (RCx_OPTION = 4 RTL, ArduPlane 自带, 不走 lua)
  const liveRtl = liveRc ? (liveRc[11] ?? 1500) > 1700 : null;

  // 切换提示 (toast)
  const lastGear    = useRef<number | null>(null);
  const lastThrCap  = useRef<string | null>(null);
  const lastChk     = useRef<boolean | null>(null);
  const lastRtl     = useRef<boolean | null>(null);
  useEffect(() => {
    if (liveGear == null) return;
    if (lastGear.current !== null && lastGear.current !== liveGear) {
      const lbl = liveGear === 1 ? 'G1 慢滑' : liveGear === 2 ? 'G2 抬头建气垫' : 'G3 巡航';
      setToast(`档位切换 → ${lbl}`);
      setTimeout(() => setToast(null), 5000);
    }
    lastGear.current = liveGear;
  }, [liveGear]);
  useEffect(() => {
    if (liveThrCap == null) return;
    if (lastThrCap.current !== null && lastThrCap.current !== liveThrCap) {
      const map: Record<string,string> = { IDLE:'0% (停机)', CHECK:'30% (地检)', TEST:'60% (地测)' };
      setToast(`油门限幅 → ${liveThrCap} (${map[liveThrCap] || ''})`);
      setTimeout(() => setToast(null), 5000);
    }
    lastThrCap.current = liveThrCap;
  }, [liveThrCap]);
  useEffect(() => {
    if (livePreflight == null) return;
    if (lastChk.current !== null && lastChk.current !== livePreflight) {
      setToast(livePreflight ? '⚠ 预检激活 (ch6 中档 + disarmed)' : '预检关闭');
      setTimeout(() => setToast(null), 3000);
    }
    lastChk.current = livePreflight;
  }, [livePreflight]);
  useEffect(() => {
    if (liveRtl == null) return;
    if (lastRtl.current !== null && lastRtl.current !== liveRtl) {
      setToast(liveRtl ? '⚠ RTL 返航触发 (ch12 高位, ArduPlane 自动飞回 home)' : 'RTL 解除');
      setTimeout(() => setToast(null), 4000);
    }
    lastRtl.current = liveRtl;
  }, [liveRtl]);

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
      }
      else if (m.type === 'rc') setLiveRc(m.channels);
      else if (m.type === 'statustext') {
        if (/MSK (gear|mode|chk|thr|preflight|G[123])\b/i.test(m.text)) {
          setToast(m.text);
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

  const effectiveSpeed = useMemo(() => {
    if (currentGear === 1) return Math.min(currentSpeed, params.MSK_V1);
    if (currentGear === 2) return Math.min(currentSpeed, params.MSK_V2);
    return currentSpeed;
  }, [currentSpeed, currentGear, params.MSK_V1, params.MSK_V2]);

  const currentK = useMemo(() => {
    const groups: GroupKey[] = ['KS', 'KDF', 'KT', 'KRD'];
    const k: Record<GroupKey, number> = { KS:0, KDF:0, KT:0, KRD:0 };
    for (const g of groups) k[g] = evalCurve(g, effectiveSpeed, params);
    return k;
  }, [effectiveSpeed, params]);

  const panel = (() => {
    switch (currentTab) {
      case 'gcs':       return <Gcs currentK={currentK} effectiveSpeed={effectiveSpeed} />;
      case 'profile':   return <FlightProfile effectiveSpeed={effectiveSpeed} currentK={currentK} />;
      case 'tilts':     return <Tilts />;
      case 'geometry':  return <Geometry currentK={currentK} />;
      case 'preflight': return <Preflight />;
      case 'params':    return <Params />;
      default: return <Gcs currentK={currentK} effectiveSpeed={effectiveSpeed} />;
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
      {/* 常驻当前状态条 (v9: ch7 g_mode + ch6 thr_cap + ch8 preflight) */}
      <div className="bg-panel-2 border-b border-line px-4 py-1 flex items-center gap-3 text-[11px] shrink-0">
        <span className="text-fg-dim">当前状态:</span>
        <span className="val-mono">
          档位(ch7) <b className="text-accent">{liveGear ?? currentGear}{liveGear == null ? ' (UI)' : ''}</b>
          <span className="text-fg-dim ml-1">
            ({(liveGear ?? currentGear) === 1 ? 'G1 慢滑' : (liveGear ?? currentGear) === 2 ? 'G2 抬头建气垫' : 'G3 巡航'})
          </span>
        </span>
        <span className="text-fg-dim">|</span>
        <span className="val-mono">
          油门限幅(ch6) <b className={
            liveThrCap === null ? 'text-fg-dim'
            : liveThrCap === 'IDLE' ? 'text-err'
            : liveThrCap === 'CHECK' ? 'text-warn'
            : 'text-ok'
          }>
            {liveThrCap ?? '— (无 RC)'}
          </b>
          {liveThrCap && (
            <span className="text-fg-dim ml-1">
              ({liveThrCap === 'IDLE' ? '0% 停机' : liveThrCap === 'CHECK' ? '30% 地检' : '60% 地测'})
            </span>
          )}
        </span>
        {livePreflight && (
          <>
            <span className="text-fg-dim">|</span>
            <span className="val-mono text-warn animate-pulse">⚠ 预检激活 (ch6 中档 + disarmed)</span>
          </>
        )}
        {liveRtl && (
          <>
            <span className="text-fg-dim">|</span>
            <span className="val-mono text-err animate-pulse">⚠ RTL ACTIVE (ch12, GPS 自动返航)</span>
          </>
        )}
      </div>
      {/* Header */}
      <header className="bg-panel border-b border-line flex items-center gap-4 px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-accent to-ks flex items-center justify-center text-bg font-bold">M</div>
          <div>
            <div className="text-[13px] font-semibold text-fg">MantaShark Mixer Tuner</div>
            <div className="text-[10px] text-fg-dim">v9.0 · ArduPlane · 12 EDF + 7 tilt · PCHIP</div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-4 text-[11px]">
          <StatBox label="速度" val={`${currentSpeed.toFixed(1)} m/s`} />
          {/* 实时档位 (FC 真值优先, 离线 fallback Tuner UI 调试态) */}
          <StatBox label="档位">
            <span className={'chip chip-active text-[10px] ' + (liveGear ? 'border-ok' : '')}>
              {liveGear ?? currentGear}{liveGear == null ? ' (UI)' : ''}
            </span>
          </StatBox>
          <StatBox label="ThrCap">
            <span className={
              'chip text-[10px] ' +
              (liveThrCap === null ? ''
                : liveThrCap === 'IDLE' ? 'chip-active text-err'
                : liveThrCap === 'CHECK' ? 'chip-active text-warn'
                : 'chip-active text-ok')
            } title={liveThrCap === null ? '无 RC ch6' : liveThrCap === 'IDLE' ? '0% 停机' : liveThrCap === 'CHECK' ? '30% 地检' : '60% 地测'}>
              {liveThrCap ?? '— (无 RC)'}
            </span>
          </StatBox>
          {livePreflight && (
            <StatBox label="预检">
              <span className="chip chip-active text-warn text-[10px] animate-pulse" title="ch6 中档 + disarmed = 4 阶段地面预检">
                CHK
              </span>
            </StatBox>
          )}
          {liveRtl && (
            <StatBox label="RTL">
              <span className="chip chip-err text-[10px] animate-pulse" title="ch12 高位 = ArduPlane GPS 返航激活">
                ACTIVE
              </span>
            </StatBox>
          )}
          <StatBox label="Phase">
            <span className={
              'chip chip-active text-[10px] ' +
              (currentPhase === 'EMERGENCY' ? 'chip-err' : '')
            }>{currentPhase}</span>
          </StatBox>
          {/* 自动同步状态 (连 FC 后 1s 拉所有参数, 4s 自动消失) */}
          {autoSyncStatus && (
            <span className="val-mono text-[10px] px-2 py-1 rounded border border-accent text-accent fade-in">
              {autoSyncStatus}
            </span>
          )}
          {/* 常驻 GCS 连接指示 */}
          <button
            onClick={() => {
              if (gcsConnected) gcs.disconnect();
              else gcs.connect();
              setTab('gcs');
            }}
            className={
              'flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] transition-colors ' +
              (gcsConnected
                ? 'border-ok text-ok hover:bg-ok/10'
                : 'border-line text-fg-dim hover:text-fg hover:border-accent')
            }
            title={gcsConnected ? '点击断开 GCS' : '点击连接 mavbridge.py'}
          >
            {gcsConnected ? <Wifi size={12} /> : <WifiOff size={12} />}
            {gcsConnected ? (gcsArmed ? 'FC · ARMED' : 'FC · disarmed') : '连接 FC'}
          </button>
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
        <span>WIG · 10kg · 14×64mm EDF (12 active + 2 retired DM) · QF2822 2300KV</span>
        <span className="ml-auto">© MantaShark · Vue → React 重构 v9.0</span>
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
