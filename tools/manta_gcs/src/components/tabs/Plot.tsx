// Real-time multi-curve plot. SVG-rendered, no external deps.
// Subscribes to mavbridge WS messages (attitude / vfr_hud / named_float).
import { useEffect, useRef, useState } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';

// 8 colors (差异明显, 不依赖 dark/light mode)
const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b',
                '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];

// 曲线定义 (key → label, unit)
const SERIES = [
  { k: 'V_ACT',  label: 'V_act',  unit: 'm/s' },
  { k: 'V_TGT',  label: 'V_tgt',  unit: 'm/s' },
  { k: 'V_ERR',  label: 'V_err',  unit: 'm/s' },
  { k: 'V_COR',  label: 'V_cor',  unit: '' },
  { k: 'pitch',  label: 'pitch',  unit: '°' },
  { k: 'roll',   label: 'roll',   unit: '°' },
  { k: 'yaw',    label: 'yaw',    unit: '°' },
  { k: 'K_KS',   label: 'K_KS',   unit: '' },
  { k: 'K_KDF',  label: 'K_KDF',  unit: '' },
  { k: 'K_KT',   label: 'K_KT',   unit: '' },
  { k: 'K_KRD',  label: 'K_KRD',  unit: '' },
  { k: 'PHASE',  label: 'phase',  unit: '0..6' },
  { k: 'QTRIM',  label: 'Q_TRIM', unit: '°' },
];

type Point = { t: number; v: number };

const STORAGE_KEY = 'mantashark_plot_selected_v1';
const DEFAULT_SELECTED = ['V_ACT', 'V_TGT', 'pitch', 'K_KT'];

export function Plot() {
  // 数据 buffer (ref, 不触发 re-render)
  const bufRef = useRef<Record<string, Point[]>>({});
  // 勾选状态
  const [selected, setSelected] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return new Set(JSON.parse(raw));
    } catch {}
    return new Set(DEFAULT_SELECTED);
  });
  const [windowS, setWindowS] = useState<number>(60);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // 5Hz 节流 re-render
  const [tick, setTick] = useState(0);

  // persist selected
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...selected])); } catch {}
  }, [selected]);

  // 节流 re-render (5Hz)
  useEffect(() => {
    const id = setInterval(() => {
      if (!pausedRef.current) setTick(t => t + 1);
    }, 200);
    return () => clearInterval(id);
  }, []);

  // WebSocket subscribe
  useEffect(() => {
    const push = (k: string, v: number) => {
      if (pausedRef.current) return;
      if (!Number.isFinite(v)) return;
      const t = Date.now() / 1000;
      let arr = bufRef.current[k];
      if (!arr) { arr = []; bufRef.current[k] = arr; }
      arr.push({ t, v });
      // trim 老数据 (超 window × 1.2 留 buffer)
      const cutoff = t - windowS * 1.2;
      while (arr.length && arr[0].t < cutoff) arr.shift();
    };
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'attitude') {
        // mavbridge.py:309 已 math.degrees() 转过, 这里直接用 deg
        push('pitch', (m as any).pitch);
        push('roll',  (m as any).roll);
        const yaw = (m as any).yaw;
        push('yaw',   yaw < 0 ? yaw + 360 : yaw);
      } else if (m.type === 'vfr_hud') {
        push('V_ACT', (m as any).airspeed);
      } else if (m.type === 'named_float') {
        push((m as any).name, (m as any).value);
      }
    });
    return () => { off(); };
  }, [windowS]);

  // 容器尺寸
  const W = 900, H = 420;
  const M = { top: 10, right: 10, bot: 30, left: 50 };
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bot;

  // hover crosshair state (鼠标 SVG 内位置)
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    if (sx < M.left || sx > M.left + innerW) { setHover(null); return; }
    const t = t0 + ((sx - M.left) / innerW) * windowS;
    setHover({ x: sx, t });
  };
  const onMouseLeave = () => setHover(null);

  // 在 hover.t 时刻每条曲线最近的值
  const valueAt = (k: string, t: number): number | null => {
    const arr = bufRef.current[k];
    if (!arr || arr.length === 0) return null;
    // 二分找最近点 (升序)
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t < t) lo = mid + 1; else hi = mid;
    }
    const cand = lo > 0 && Math.abs(arr[lo - 1].t - t) < Math.abs(arr[lo].t - t)
      ? arr[lo - 1] : arr[lo];
    return Math.abs(cand.t - t) < 1.0 ? cand.v : null;   // 1s 内才显示
  };

  // 时间轴 (now-windowS .. now)
  const now = Date.now() / 1000;
  const t0 = now - windowS;

  // Y 轴: 在所有 selected 曲线上算 min/max
  let yMin = Infinity, yMax = -Infinity;
  selected.forEach(k => {
    const arr = bufRef.current[k];
    if (!arr) return;
    for (const p of arr) {
      if (p.t < t0) continue;
      if (p.v < yMin) yMin = p.v;
      if (p.v > yMax) yMax = p.v;
    }
  });
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (yMax === yMin) { yMax = yMin + 1; }
  const yPad = (yMax - yMin) * 0.1;
  yMin -= yPad; yMax += yPad;

  // 缩放
  const xOf = (t: number) => M.left + ((t - t0) / windowS) * innerW;
  const yOf = (v: number) => M.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  // 渲染每条曲线的 polyline
  const renderLine = (k: string, idx: number) => {
    const arr = bufRef.current[k];
    if (!arr || arr.length < 2) return null;
    const pts: string[] = [];
    for (const p of arr) {
      if (p.t < t0) continue;
      pts.push(`${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)}`);
    }
    if (pts.length < 2) return null;
    return (
      <polyline key={k}
        points={pts.join(' ')}
        fill="none"
        stroke={COLORS[idx % COLORS.length]}
        strokeWidth={1.5}
        strokeLinejoin="round"
        opacity={0.9}
      />
    );
  };

  // Y 轴刻度 (5 段)
  const yTicks: number[] = [];
  for (let i = 0; i <= 5; i++) {
    yTicks.push(yMin + (yMax - yMin) * i / 5);
  }
  // X 轴刻度 (秒, -windowS, -windowS×0.75, ..., 0)
  const xTicks: number[] = [];
  for (let i = 0; i <= 4; i++) {
    xTicks.push(t0 + windowS * i / 4);
  }

  // 当前最新值
  const latest: Record<string, number> = {};
  selected.forEach(k => {
    const arr = bufRef.current[k];
    if (arr && arr.length) latest[k] = arr[arr.length - 1].v;
  });

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">实时曲线</div>

      {/* 控制条 */}
      <div className="flex flex-wrap gap-3 items-center p-2 bg-bg-2 rounded border border-line/40">
        <label className="text-xs">
          时窗:
          <select
            className="ml-1 bg-bg-2 border border-line/40 rounded px-2 py-0.5 text-xs"
            value={windowS}
            onChange={e => setWindowS(parseInt(e.target.value, 10))}
          >
            <option value={30}>30s</option>
            <option value={60}>60s</option>
            <option value={120}>120s</option>
            <option value={300}>5min</option>
          </select>
        </label>
        <button
          className={`px-3 py-1 text-xs rounded border ${paused ? 'bg-accent/20 border-accent' : 'border-line/40'}`}
          onClick={() => setPaused(p => !p)}
        >
          {paused ? '▶ 继续' : '⏸ 暂停'}
        </button>
        <button
          className="px-3 py-1 text-xs rounded border border-line/40 hover:bg-bg-1"
          onClick={() => { bufRef.current = {}; setTick(t => t + 1); }}
        >
          🗑 清缓存
        </button>
        <span className="text-[10px] text-fg-dim ml-auto">
          {paused ? '已暂停' : `5Hz 滑动, ${tick} 帧`}
        </span>
      </div>

      {/* 勾选区 */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-2 p-2 bg-bg-2 rounded border border-line/40">
        {SERIES.map((s, i) => {
          const checked = selected.has(s.k);
          const color = checked ? COLORS[[...selected].indexOf(s.k) % COLORS.length] : '#666';
          return (
            <label key={s.k} className="text-xs flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={checked}
                onChange={e => {
                  setSelected(prev => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(s.k); else next.delete(s.k);
                    return next;
                  });
                }}
              />
              <span className="inline-block w-2 h-2 rounded" style={{ background: color }} />
              <span className={checked ? 'text-fg' : 'text-fg-dim'}>
                {s.label}{s.unit ? ` (${s.unit})` : ''}
              </span>
              {checked && Number.isFinite(latest[s.k]) && (
                <span className="text-fg-dim ml-auto">{latest[s.k].toFixed(2)}</span>
              )}
            </label>
          );
        })}
      </div>

      {/* 图表 */}
      <div className="bg-bg-2 rounded border border-line/40 p-2 overflow-x-auto">
        <svg
          ref={svgRef}
          width={W} height={H} viewBox={`0 0 ${W} ${H}`}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          style={{ cursor: 'crosshair' }}
        >
          {/* 网格 + Y 刻度 */}
          {yTicks.map((y, i) => (
            <g key={'y' + i}>
              <line
                x1={M.left} y1={yOf(y)}
                x2={M.left + innerW} y2={yOf(y)}
                stroke="#3a3a3a" strokeWidth={0.5}
                strokeDasharray={i === 0 || i === 5 ? '' : '2,3'}
              />
              <text x={M.left - 5} y={yOf(y) + 3}
                fill="#888" fontSize="10" textAnchor="end" fontFamily="monospace">
                {y.toFixed(y > 100 ? 0 : 1)}
              </text>
            </g>
          ))}
          {/* X 刻度 */}
          {xTicks.map((t, i) => (
            <g key={'x' + i}>
              <line
                x1={xOf(t)} y1={M.top}
                x2={xOf(t)} y2={M.top + innerH}
                stroke="#3a3a3a" strokeWidth={0.5} strokeDasharray="2,3"
              />
              <text x={xOf(t)} y={H - M.bot + 14}
                fill="#888" fontSize="10" textAnchor="middle" fontFamily="monospace">
                {(t - now).toFixed(0)}s
              </text>
            </g>
          ))}
          {/* 数据 polyline */}
          {[...selected].map((k, idx) => renderLine(k, idx))}

          {/* hover crosshair: 垂直线 + 各曲线值 dots + 时间标 */}
          {hover && (() => {
            const selArr = [...selected];
            const items = selArr
              .map((k, idx) => ({ k, idx, v: valueAt(k, hover.t) }))
              .filter(it => it.v !== null) as { k: string; idx: number; v: number }[];
            const tipX = hover.x > W * 0.7 ? hover.x - 130 : hover.x + 10;
            const tipY = M.top + 4;
            const tipH = items.length * 14 + 18;
            return (
              <g>
                <line x1={hover.x} y1={M.top} x2={hover.x} y2={M.top + innerH}
                  stroke="#fff" strokeWidth={0.7} strokeDasharray="3,2" opacity={0.6} />
                {items.map(it => (
                  <circle key={'dot' + it.k} cx={hover.x} cy={yOf(it.v)} r={3}
                    fill={COLORS[it.idx % COLORS.length]} stroke="#000" strokeWidth={0.5} />
                ))}
                {/* tooltip */}
                <rect x={tipX - 4} y={tipY - 2}
                  width={130} height={tipH} fill="#0a0e14" opacity={0.85}
                  stroke="#2a2a2a" strokeWidth={1} rx={3} />
                <text x={tipX} y={tipY + 10} fill="#888" fontSize="10" fontFamily="monospace">
                  t = {(hover.t - now).toFixed(1)}s
                </text>
                {items.map((it, i) => {
                  const s = SERIES.find(s => s.k === it.k);
                  return (
                    <g key={'tip' + it.k}>
                      <rect x={tipX} y={tipY + 16 + i * 14 - 7} width={6} height={6}
                        fill={COLORS[it.idx % COLORS.length]} />
                      <text x={tipX + 10} y={tipY + 16 + i * 14}
                        fill="#fff" fontSize="11" fontFamily="monospace">
                        {s?.label}: {it.v.toFixed(2)}{s?.unit ? ' ' + s.unit : ''}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })()}
        </svg>
      </div>
    </div>
  );
}
