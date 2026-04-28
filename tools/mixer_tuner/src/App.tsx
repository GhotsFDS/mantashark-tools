import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useStore } from './store/useStore';
import { evalCurve } from './lib/pchip';
import { gcs, GcsMessage } from './lib/gcs';
import { quantize } from './lib/defaults';
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

  // 实时 gear/auto/mode 从 RC 推算 (用 MSK_GEAR_CH/MSK_AUTO_CH/MSK_MODE_CH 配置的通道)
  const gearCh = Math.max(1, Math.floor(params.MSK_GEAR_CH ?? 7));
  const autoCh = Math.max(1, Math.floor(params.MSK_AUTO_CH ?? 9));
  const modeCh = Math.max(1, Math.floor(params.MSK_MODE_CH ?? 6));
  const liveGear = liveRc ? (() => {
    const pwm = liveRc[gearCh - 1] ?? 1500;
    return pwm < 1300 ? 1 : pwm < 1700 ? 2 : 3;
  })() : null;
  const liveAuto = liveRc ? (liveRc[autoCh - 1] ?? 1500) > 1500 : null;
  // 二段开关: NOGPS (≤1500) / GPS (>1500). v7 LOG164 简化版.
  const liveMode = liveRc ? (liveRc[modeCh - 1] ?? 1500) > 1500 : null;
  // RTL: ch12 PWM>1500 触发 (优先级最高)
  const rtlCh = Math.max(1, Math.floor(params.MSK_RTL_CH ?? 12));
  const liveRtl = liveRc ? (liveRc[rtlCh - 1] ?? 0) > 1500 : null;

  // 切换提示 (toast)
  const lastGear = useRef<number | null>(null);
  const lastAuto = useRef<boolean | null>(null);
  const lastMode = useRef<boolean | null>(null);
  const lastRtl = useRef<boolean | null>(null);
  useEffect(() => {
    if (liveGear == null) return;
    if (lastGear.current !== null && lastGear.current !== liveGear) {
      const lbl = liveGear === 1 ? 'V1 慢速' : liveGear === 2 ? 'V2 驼峰' : '全开';
      setToast(`档位切换 → ${liveGear} (${lbl})`);
      setTimeout(() => setToast(null), 5000);
    }
    lastGear.current = liveGear;
  }, [liveGear]);
  useEffect(() => {
    if (liveAuto == null) return;
    if (lastAuto.current !== null && lastAuto.current !== liveAuto) {
      setToast(`Auto 切换 → ${liveAuto ? 'Auto (摇杆放大)' : 'Manual (线性)'}`);
      setTimeout(() => setToast(null), 5000);
    }
    lastAuto.current = liveAuto;
  }, [liveAuto]);
  useEffect(() => {
    if (liveMode == null) return;
    if (lastMode.current !== null && lastMode.current !== liveMode) {
      setToast(`模式切换 → ${liveMode ? 'GPS (真速插曲线)' : 'NOGPS (按 gear 取 K{gear-1} 固定档)'}`);
      setTimeout(() => setToast(null), 5000);
    }
    lastMode.current = liveMode;
  }, [liveMode]);
  useEffect(() => {
    if (liveRtl == null) return;
    if (lastRtl.current !== null && lastRtl.current !== liveRtl) {
      setToast(liveRtl ? '⚠ RTL 触发 (KS+KT 低油门, 其他组关)' : 'RTL 解除');
      setTimeout(() => setToast(null), 3000);
    }
    lastRtl.current = liveRtl;
  }, [liveRtl]);

  // ─── App-level GCS listener: 保证不管哪个 tab 打开, PARAM_VALUE 都同步到 store ───
  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'status') setGcsConnected(m.connected);
      else if (m.type === 'heartbeat') {
        setGcsArmed(m.armed);
        // 连接 FC 时自动跟随真实 arming 状态 (未连接时保留 simulate 给离线预览)
        setSimulateArmed(m.armed);
      }
      else if (m.type === 'rc') setLiveRc(m.channels);
      else if (m.type === 'statustext') {
        // 飞控也会发 "MSK gear/auto/mode/RTL ..." 切换提示, 转 toast
        if (/MSK (gear|auto|mode)\s*->/i.test(m.text) || /MSK RTL/i.test(m.text)) {
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
      {/* 常驻当前模式状态条 (header 下方, 一直显示当前 mode/gear/auto/rtl) */}
      <div className="bg-panel-2 border-b border-line px-4 py-1 flex items-center gap-3 text-[11px] shrink-0">
        <span className="text-fg-dim">当前状态:</span>
        <span className="val-mono">
          模式 <b className={liveMode === null ? 'text-fg-dim' : liveMode ? 'text-ok' : 'text-warn'}>
            {liveMode === null ? '— (无 RC)' : liveMode ? 'GPS 真速插曲线' : 'NOGPS 固定 K{gear-1}'}
          </b>
        </span>
        <span className="text-fg-dim">|</span>
        <span className="val-mono">
          档位 <b className="text-accent">{liveGear ?? currentGear}{liveGear == null ? ' (UI)' : ''}</b>
          <span className="text-fg-dim ml-1">
            ({(liveGear ?? currentGear) === 1 ? 'V1 慢' : (liveGear ?? currentGear) === 2 ? 'V2 驼峰' : '全开'})
          </span>
        </span>
        <span className="text-fg-dim">|</span>
        <span className="val-mono">
          Auto <b className={liveAuto === null ? 'text-fg-dim' : liveAuto ? 'text-warn' : 'text-ok'}>
            {liveAuto === null ? '—' : liveAuto ? 'AUTO 摇杆放大' : 'MANUAL 线性'}
          </b>
        </span>
        {liveRtl && (
          <>
            <span className="text-fg-dim">|</span>
            <span className="val-mono text-err animate-pulse">⚠ RTL ACTIVE (KS+KT 低油门)</span>
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
          <StatBox label="Auto">
            <span className={
              'chip text-[10px] ' +
              (liveAuto === null ? '' : liveAuto ? 'chip-active text-warn' : 'chip-active text-ok')
            }>
              {liveAuto === null ? '— (无 RC)' : liveAuto ? 'AUTO' : 'MANUAL'}
            </span>
          </StatBox>
          <StatBox label="Mode">
            <span className={
              'chip text-[10px] ' +
              (liveMode === null ? '' : liveMode ? 'chip-active text-ok' : 'chip-active text-warn')
            } title={liveMode === null ? '无 RC' : liveMode ? 'GPS 真速插曲线' : 'NOGPS 按 gear 取 K{gear-1} 固定档'}>
              {liveMode === null ? '— (无 RC)' : liveMode ? 'GPS' : 'NOGPS'}
            </span>
          </StatBox>
          {liveRtl && (
            <StatBox label="RTL">
              <span className="chip chip-err text-[10px] animate-pulse" title="RTL 返航激活: KS+KT 低油门, 其他组关">
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
