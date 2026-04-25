import React, { useMemo, useState, useEffect } from 'react';
import { useStore } from './store/useStore';
import { evalCurve } from './lib/pchip';
import { gcs, GcsMessage } from './lib/gcs';
import type { GroupKey } from './lib/types';
import { Wifi, WifiOff } from 'lucide-react';
import { Gauge, Waves, Sliders, Grid3x3, Scale, PlayCircle, Settings, PlugZap } from 'lucide-react';
import { Overview } from './components/tabs/Overview';
import { FlightProfile } from './components/tabs/FlightProfile';
import { Tilts } from './components/tabs/Tilts';
import { Geometry } from './components/tabs/Geometry';
import { Force } from './components/tabs/Force';
import { Preflight } from './components/tabs/Preflight';
import { Params } from './components/tabs/Params';
import { Gcs } from './components/tabs/Gcs';

const TABS = [
  { id: 'overview',  label: '总览',         Icon: Gauge },
  { id: 'profile',   label: '曲线 & 阶段',  Icon: Waves },
  { id: 'tilts',     label: '舵机标定',     Icon: Sliders },
  { id: 'geometry',  label: '几何 & 布局',  Icon: Grid3x3 },
  { id: 'force',     label: '力平衡',       Icon: Scale },
  { id: 'preflight', label: '预检',         Icon: PlayCircle },
  { id: 'gcs',       label: 'GCS',          Icon: PlugZap },
  { id: 'params',    label: '参数',         Icon: Settings },
];

export default function App() {
  const { currentTab, setTab, currentSpeed, currentGear, currentPhase, params, simulateArmed } = useStore();
  const [gcsConnected, setGcsConnected] = useState(false);
  const [gcsArmed, setGcsArmed] = useState<boolean | null>(null);

  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'status') setGcsConnected(m.connected);
      else if (m.type === 'heartbeat') setGcsArmed(m.armed);
    });
    return () => { off(); };
  }, []);

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
      case 'overview':  return <Overview currentK={currentK} effectiveSpeed={effectiveSpeed} />;
      case 'profile':   return <FlightProfile effectiveSpeed={effectiveSpeed} currentK={currentK} />;
      case 'tilts':     return <Tilts />;
      case 'geometry':  return <Geometry currentK={currentK} />;
      case 'force':     return <Force currentK={currentK} />;
      case 'preflight': return <Preflight />;
      case 'gcs':       return <Gcs />;
      case 'params':    return <Params />;
      default: return null;
    }
  })();

  return (
    <div className="h-full flex flex-col bg-bg">
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
          <StatBox label="档位" val={`${currentGear}`} />
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

      {/* Main */}
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
