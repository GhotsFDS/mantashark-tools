// v9 P4 LOG Analysis tab — BIN 离线分析 + step 检测 + PID 建议 + 一键应用
//
// 工作流: 输入 BIN 路径 (本地, mavbridge.py 解析) → analyze_log → 4 图 + 步阶 + 建议 → 应用
// 约束: 应用 PID 必须 disarmed + 双确认 + 备份 .parm
// 不引入 recharts (零新增 dep) — 用 inline SVG 画 LineChart

import { useState, useEffect, useMemo } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';
import { useStore } from '../../store/useStore';
import { Activity, FileSearch, AlertTriangle, Check, Download, Trash2 } from 'lucide-react';

// ─── inline SVG line chart (no recharts dep) ───
type Series = { label: string; color: string; data: number[]; yMin?: number; yMax?: number };
function LineChart({ title, t, series, height = 140, yLabel = '' }: {
  title: string; t: number[]; series: Series[]; height?: number; yLabel?: string;
}) {
  const w = 700, padL = 40, padR = 8, padT = 8, padB = 22;
  const innerW = w - padL - padR;
  const innerH = height - padT - padB;
  if (!t.length || !series.length) {
    return <div className="text-fg-dim text-[11px] p-3 border border-line rounded bg-panel">{title}: 无数据</div>;
  }
  const tMin = t[0], tMax = t[t.length - 1] || tMin + 1;
  const tRange = tMax - tMin || 1;
  const allY = series.flatMap(s => s.data);
  const yMin = series[0].yMin ?? Math.min(...allY);
  const yMax = series[0].yMax ?? Math.max(...allY);
  const yRange = (yMax - yMin) || 1;
  const xPx = (ts: number) => padL + ((ts - tMin) / tRange) * innerW;
  const yPx = (yv: number) => padT + (1 - (yv - yMin) / yRange) * innerH;
  const ticks = 4;

  return (
    <div className="border border-line rounded bg-panel">
      <div className="text-[11px] text-fg-dim px-2 pt-1.5">{title}</div>
      <svg width="100%" viewBox={`0 0 ${w} ${height}`} className="block" preserveAspectRatio="none">
        {/* grid */}
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const yv = yMin + (yRange * i) / ticks;
          const py = yPx(yv);
          return (
            <g key={i}>
              <line x1={padL} y1={py} x2={w - padR} y2={py} stroke="#2a2a2a" strokeWidth="0.5" />
              <text x={padL - 4} y={py + 3} textAnchor="end" fontSize="9" fill="#888">{yv.toFixed(2)}</text>
            </g>
          );
        })}
        {/* x ticks */}
        {Array.from({ length: 5 }, (_, i) => {
          const tv = tMin + (tRange * i) / 4;
          const px = xPx(tv);
          return (
            <g key={i}>
              <line x1={px} y1={padT} x2={px} y2={height - padB} stroke="#2a2a2a" strokeWidth="0.5" />
              <text x={px} y={height - 8} textAnchor="middle" fontSize="9" fill="#888">{tv.toFixed(1)}s</text>
            </g>
          );
        })}
        {/* series */}
        {series.map((s) => {
          const path = s.data.map((y, i) => {
            const ti = Math.min(i, t.length - 1);
            return `${i === 0 ? 'M' : 'L'} ${xPx(t[ti]).toFixed(1)} ${yPx(y).toFixed(1)}`;
          }).join(' ');
          return <path key={s.label} d={path} stroke={s.color} strokeWidth="1.2" fill="none" />;
        })}
        {/* legend */}
        <g transform={`translate(${padL + 4}, ${padT + 4})`}>
          {series.map((s, idx) => (
            <g key={s.label} transform={`translate(${idx * 80}, 0)`}>
              <rect width="10" height="2" y="3" fill={s.color} />
              <text x="14" y="8" fontSize="9" fill="#ccc">{s.label}</text>
            </g>
          ))}
        </g>
        {yLabel && <text x="6" y={padT + innerH / 2} textAnchor="middle" fontSize="9" fill="#666"
          transform={`rotate(-90, 6, ${padT + innerH / 2})`}>{yLabel}</text>}
      </svg>
    </div>
  );
}

// ─── main tab ───
type AnalysisData = {
  rows_read: number;
  duration_s: number;
  traces: Record<string, Record<string, number[]>>;
  steps: { pitch: any[]; throttle: any[] };
  metrics: { pitch: any[]; throttle: any[] };
  suggestions: {
    pitch: { diagnosis: string[]; suggested: Record<string, { cur: number; new: number; pct_change: number }> };
    roll: { diagnosis: string[]; suggested: Record<string, any> };
  };
  tilt?: {
    error?: string;
    channels?: Record<string, {
      avg_lag_deg: number; max_lag_deg: number;
      osc_freq_hz: number; sat_lo_pct: number; sat_hi_pct: number;
      overshoot_deg: number; group: string;
    }>;
    warnings?: string[];
  };
};

export function LogAnalysis() {
  const { params } = useStore();
  const [path, setPath] = useState<string>('');
  const [recent, setRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('logAnalysisRecent') || '[]'); } catch { return []; }
  });
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; msg: string }>({ pct: 0, msg: '' });
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalysisData | null>(null);
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);  // 0=未点 / 1=点了一次 / 2=确认
  const [applyResult, setApplyResult] = useState<string | null>(null);

  // 监听 WS 回调
  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'log_analysis_progress') {
        setProgress({ pct: m.pct, msg: m.msg || '' });
      } else if (m.type === 'log_analysis_done') {
        setAnalyzing(false);
        if (m.error) {
          setError(m.error);
          setData(null);
        } else if (m.data) {
          setData(m.data);
          setError(null);
          // 添加到最近用过的列表
          if (path && !recent.includes(path)) {
            const next = [path, ...recent].slice(0, 5);
            setRecent(next);
            localStorage.setItem('logAnalysisRecent', JSON.stringify(next));
          }
        }
      } else if (m.type === 'pid_apply_done') {
        setApplyResult(`✓ 已写入 ${m.count} 个参数 (Save 按钮持久化到 EEPROM)`);
        setConfirmStep(0);
      } else if (m.type === 'pid_apply_err') {
        setApplyResult(`✗ ${m.name}: ${m.err}`);
      }
    });
    return () => { off(); };
  }, [path, recent]);

  const onAnalyze = () => {
    if (!path.trim()) { setError('请输入 BIN 路径'); return; }
    if (!gcs.isConnected()) { setError('未连 mavbridge.py — 先连 GCS'); return; }
    setError(null);
    setData(null);
    setAnalyzing(true);
    setProgress({ pct: 5, msg: '解析 BIN...' });
    // 把当前 PID 参数从 store 抽出来
    const cur: Record<string, number> = {};
    ['Q_A_RAT_PIT_P', 'Q_A_RAT_PIT_I', 'Q_A_RAT_PIT_D',
     'Q_A_RAT_RLL_P', 'Q_A_RAT_RLL_I', 'Q_A_RAT_RLL_D',
     'Q_A_ANG_PIT_P', 'Q_A_ANG_RLL_P',
     'MSK_V_PI_P', 'MSK_V_PI_I', 'MSK_V_PI_D'].forEach(k => {
      if (params[k] !== undefined) cur[k] = params[k];
    });
    gcs.analyzeLog(path.trim(), cur);
  };

  const onApply = () => {
    if (!data) return;
    if (confirmStep < 2) { setConfirmStep((s) => (s + 1) as 0 | 1 | 2); return; }
    // step 2: 真应用. 备份 + 写 FC.
    const allSugg = { ...data.suggestions.pitch.suggested, ...data.suggestions.roll.suggested };
    const toApply: Record<string, number> = {};
    for (const [k, v] of Object.entries(allSugg)) {
      toApply[k] = (v as any).new;
    }
    if (Object.keys(toApply).length === 0) { setApplyResult('无建议改动'); setConfirmStep(0); return; }
    // 备份 (浏览器 localStorage, 包当前快照)
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = { ts, params: Object.fromEntries(
      Object.keys(allSugg).map(k => [k, params[k] ?? null])
    )};
    try {
      const all = JSON.parse(localStorage.getItem('pidBackups') || '[]');
      all.unshift(backup);
      localStorage.setItem('pidBackups', JSON.stringify(all.slice(0, 20)));
    } catch {}
    setApplyResult('备份已存 localStorage, 写 FC 中...');
    gcs.applyPids(toApply);
  };

  // ─── 渲染 ───
  const armed = useStore.getState().simulateArmed; // 简化: 用 simulateArmed (主 App 跟 FC 同步)
  const totalSugg = data ? Object.keys({ ...data.suggestions.pitch.suggested, ...data.suggestions.roll.suggested }).length : 0;
  const pitchTraces = data?.traces['MSK4'];

  // 准备图数据
  const chartPitch = useMemo<{ t: number[]; series: Series[] } | null>(() => {
    if (!pitchTraces) return null;
    return {
      t: pitchTraces.t || [],
      series: [
        { label: 'pitch_actual (rad)', color: '#3b82f6', data: pitchTraces.pa || [] },
        { label: 'pitch_base (deg/10)', color: '#10b981', data: (pitchTraces.pb || []).map(v => v / 10) },
        { label: 'ATC pitch_out', color: '#f59e0b', data: pitchTraces.po || [] },
      ],
    };
  }, [pitchTraces]);
  const chartRoll = useMemo<{ t: number[]; series: Series[] } | null>(() => {
    if (!pitchTraces) return null;
    return {
      t: pitchTraces.t || [],
      series: [
        { label: 'roll_actual (rad)', color: '#3b82f6', data: pitchTraces.ra || [] },
        { label: 'ATC roll_out', color: '#f59e0b', data: pitchTraces.ro || [] },
      ],
    };
  }, [pitchTraces]);
  const vTraces = data?.traces['MSK5'];
  const chartV = useMemo<{ t: number[]; series: Series[] } | null>(() => {
    if (!vTraces) return null;
    return {
      t: vTraces.t || [],
      series: [
        { label: 'V target (m/s)', color: '#8b5cf6', data: vTraces.vt || [] },
        { label: 'V actual (m/s)', color: '#3b82f6', data: vTraces.va || [] },
        { label: 'KT corr', color: '#f59e0b', data: vTraces.ko || [] },
      ],
    };
  }, [vTraces]);
  const lrnTraces = data?.traces['MSK6'];
  const chartDrift = useMemo<{ t: number[]; series: Series[] } | null>(() => {
    if (!lrnTraces) return null;
    return {
      t: lrnTraces.t || [],
      series: [
        { label: 'KS drift', color: '#3b82f6', data: lrnTraces.KSD || [] },
        { label: 'KDF drift', color: '#10b981', data: lrnTraces.KDD || [] },
        { label: 'KT drift', color: '#f59e0b', data: lrnTraces.KTD || [] },
        { label: 'TS drift (°/15)', color: '#ef4444', data: (lrnTraces.TS || []).map(v => v / 15) },
      ],
    };
  }, [lrnTraces]);

  return (
    <div className="flex flex-col gap-3">
      {/* 输入区 */}
      <div className="bg-panel border border-line rounded p-3">
        <div className="flex items-center gap-2 mb-2">
          <FileSearch size={14} className="text-accent" />
          <span className="text-[12px] font-bold">LOG 离线分析 (BIN 文件)</span>
          <span className="text-[10px] text-fg-dim ml-auto">
            mavbridge.py 用 pymavlink 本地解析, 不上传
          </span>
        </div>
        <div className="flex gap-2 items-stretch">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/fusha/MantaShark/LOGS/00000XXX.BIN"
            className="flex-1 bg-bg border border-line rounded px-3 py-1.5 text-[12px] font-mono"
            disabled={analyzing}
          />
          <button
            onClick={onAnalyze}
            disabled={analyzing || !gcs.isConnected()}
            className="px-4 py-1.5 bg-accent text-bg rounded text-[12px] font-bold hover:bg-accent/80 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {analyzing ? `分析中 ${progress.pct}%` : '分析'}
          </button>
        </div>
        {recent.length > 0 && !analyzing && (
          <div className="flex gap-1 mt-2 flex-wrap">
            <span className="text-[10px] text-fg-dim self-center">最近:</span>
            {recent.map((p) => (
              <button key={p} onClick={() => setPath(p)}
                className="text-[10px] px-2 py-0.5 rounded border border-line hover:border-accent hover:text-accent">
                {p.split('/').pop()}
              </button>
            ))}
            <button onClick={() => { setRecent([]); localStorage.removeItem('logAnalysisRecent'); }}
              className="text-[10px] px-1 text-fg-dim hover:text-err"><Trash2 size={10}/></button>
          </div>
        )}
        {analyzing && (
          <div className="mt-2 h-1.5 bg-bg rounded overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${progress.pct}%` }} />
          </div>
        )}
        {error && (
          <div className="mt-2 px-2 py-1 bg-err/10 border border-err rounded text-[11px] text-err flex items-center gap-1">
            <AlertTriangle size={12} /> {error}
          </div>
        )}
      </div>

      {/* 数据概要 */}
      {data && (
        <div className="grid grid-cols-4 gap-2 text-[11px]">
          <div className="bg-panel border border-line rounded p-2">
            <div className="text-fg-dim">数据行</div>
            <div className="font-mono text-fg">{data.rows_read.toLocaleString()}</div>
          </div>
          <div className="bg-panel border border-line rounded p-2">
            <div className="text-fg-dim">时长</div>
            <div className="font-mono text-fg">{data.duration_s.toFixed(1)}s</div>
          </div>
          <div className="bg-panel border border-line rounded p-2">
            <div className="text-fg-dim">pitch step</div>
            <div className="font-mono text-fg">{data.steps.pitch.length}</div>
          </div>
          <div className="bg-panel border border-line rounded p-2">
            <div className="text-fg-dim">throttle step</div>
            <div className="font-mono text-fg">{data.steps.throttle.length}</div>
          </div>
        </div>
      )}

      {/* 4 图 */}
      {data && (
        <div className="grid grid-cols-2 gap-2">
          {chartPitch && <LineChart title="MSK4 Pitch (50Hz)" t={chartPitch.t} series={chartPitch.series} />}
          {chartRoll && <LineChart title="MSK4 Roll (50Hz)" t={chartRoll.t} series={chartRoll.series} />}
          {chartV && <LineChart title="MSK5 V loop (10Hz)" t={chartV.t} series={chartV.series} />}
          {chartDrift && <LineChart title="MSK6 Drift learning (1Hz)" t={chartDrift.t} series={chartDrift.series} />}
        </div>
      )}

      {/* PID 建议 + 应用 */}
      {data && (
        <div className="bg-panel border border-line rounded p-3">
          <div className="flex items-center gap-2 mb-2">
            <Activity size={14} className="text-accent" />
            <span className="text-[12px] font-bold">PID 建议引擎</span>
            {totalSugg > 0 && (
              <span className="text-[10px] px-2 py-0.5 bg-warn/20 text-warn rounded ml-auto">
                {totalSugg} 项可改
              </span>
            )}
          </div>
          {/* 诊断输出 */}
          <div className="font-mono text-[11px] text-fg-dim whitespace-pre-wrap mb-2">
            {[...data.suggestions.pitch.diagnosis, ...data.suggestions.roll.diagnosis].join('\n')}
          </div>
          {/* 建议表 */}
          {totalSugg > 0 && (
            <table className="w-full text-[11px] border border-line">
              <thead className="bg-panel-2 text-fg-dim">
                <tr>
                  <th className="text-left px-2 py-1">参数</th>
                  <th className="text-right px-2 py-1">当前</th>
                  <th className="text-right px-2 py-1">建议</th>
                  <th className="text-right px-2 py-1">变化</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries({ ...data.suggestions.pitch.suggested, ...data.suggestions.roll.suggested }).map(([k, v]) => {
                  const big = Math.abs((v as any).pct_change) > 50;
                  return (
                    <tr key={k} className="border-t border-line">
                      <td className="px-2 py-1 font-mono">{k}</td>
                      <td className="text-right px-2 py-1 font-mono text-fg-dim">{(v as any).cur.toFixed(4)}</td>
                      <td className="text-right px-2 py-1 font-mono text-accent">{(v as any).new.toFixed(4)}</td>
                      <td className={`text-right px-2 py-1 font-mono ${big ? 'text-warn' : ''}`}>
                        {(v as any).pct_change >= 0 ? '+' : ''}{(v as any).pct_change}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {/* 一键应用 */}
          {totalSugg > 0 && (
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={onApply}
                disabled={armed}
                className={
                  'px-4 py-2 rounded text-[12px] font-bold transition-colors ' +
                  (armed
                    ? 'bg-bg border border-err text-err cursor-not-allowed'
                    : confirmStep === 0
                      ? 'bg-panel-2 border border-accent text-accent hover:bg-accent hover:text-bg'
                      : confirmStep === 1
                        ? 'bg-warn text-bg hover:bg-warn/80 animate-pulse'
                        : 'bg-err text-bg hover:bg-err/80')
                }
              >
                {armed ? '⚠ 必须 disarmed' :
                 confirmStep === 0 ? '应用 PID 建议' :
                 confirmStep === 1 ? '⚠ 再点确认' : '执行写 FC'}
              </button>
              {confirmStep > 0 && (
                <button onClick={() => setConfirmStep(0)}
                  className="px-2 py-2 rounded text-[11px] text-fg-dim border border-line hover:text-fg">
                  取消
                </button>
              )}
              {applyResult && (
                <span className={`text-[11px] ${applyResult.startsWith('✓') ? 'text-ok' : applyResult.startsWith('✗') ? 'text-err' : 'text-fg-dim'} flex items-center gap-1`}>
                  {applyResult.startsWith('✓') && <Check size={12}/>}
                  {applyResult}
                </span>
              )}
              <span className="ml-auto text-[10px] text-fg-dim">
                <Download size={10} className="inline mr-1"/>备份存 localStorage
              </span>
            </div>
          )}
        </div>
      )}

      {/* Tilt 通道分析 (MSK7 commanded vs actual) */}
      {data?.tilt?.channels && Object.keys(data.tilt.channels).length > 0 && (
        <div className="bg-panel border border-line rounded p-3">
          <div className="text-[12px] font-bold mb-2">Tilt 通道动态 (MSK7)</div>
          <div className="font-mono text-[11px] text-fg-dim whitespace-pre-wrap mb-2">
            {data.tilt.warnings?.join('\n')}
          </div>
          <table className="w-full text-[11px] border border-line">
            <thead className="bg-panel-2 text-fg-dim">
              <tr>
                <th className="px-2 py-1 text-left">通道</th>
                <th className="px-2 py-1 text-left">组</th>
                <th className="px-2 py-1 text-right">avg lag</th>
                <th className="px-2 py-1 text-right">max lag</th>
                <th className="px-2 py-1 text-right">振荡 freq</th>
                <th className="px-2 py-1 text-right">过冲</th>
                <th className="px-2 py-1 text-right">饱和 lo</th>
                <th className="px-2 py-1 text-right">饱和 hi</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.tilt.channels).map(([name, m]) => (
                <tr key={name} className="border-t border-line font-mono">
                  <td className="px-2 py-1">{name}</td>
                  <td className="px-2 py-1 text-fg-dim">{m.group}</td>
                  <td className={`text-right px-2 py-1 ${m.avg_lag_deg > 5 ? 'text-warn' : ''}`}>{m.avg_lag_deg}°</td>
                  <td className="text-right px-2 py-1 text-fg-dim">{m.max_lag_deg}°</td>
                  <td className={`text-right px-2 py-1 ${m.osc_freq_hz > 2 ? 'text-warn' : ''}`}>{m.osc_freq_hz}Hz</td>
                  <td className={`text-right px-2 py-1 ${m.overshoot_deg > 5 ? 'text-warn' : ''}`}>{m.overshoot_deg}°</td>
                  <td className={`text-right px-2 py-1 ${m.sat_lo_pct > 20 ? 'text-warn' : ''}`}>{m.sat_lo_pct}%</td>
                  <td className={`text-right px-2 py-1 ${m.sat_hi_pct > 20 ? 'text-warn' : ''}`}>{m.sat_hi_pct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* step events 列表 */}
      {data && data.metrics.pitch.length > 0 && (
        <div className="bg-panel border border-line rounded p-3">
          <div className="text-[12px] font-bold mb-2">Pitch Step Events ({data.metrics.pitch.length})</div>
          <table className="w-full text-[11px] border border-line">
            <thead className="bg-panel-2 text-fg-dim">
              <tr>
                <th className="px-2 py-1 text-left">t (s)</th>
                <th className="px-2 py-1 text-right">Δ (°)</th>
                <th className="px-2 py-1 text-right">rise</th>
                <th className="px-2 py-1 text-right">overshoot</th>
                <th className="px-2 py-1 text-right">settling</th>
                <th className="px-2 py-1 text-right">freq</th>
                <th className="px-2 py-1 text-center">饱和?</th>
              </tr>
            </thead>
            <tbody>
              {data.metrics.pitch.map((m: any, i: number) => (
                <tr key={i} className="border-t border-line font-mono">
                  <td className="px-2 py-1">{m.t_start?.toFixed(2) ?? '-'}</td>
                  <td className="text-right px-2 py-1">{m.delta_deg ?? '-'}</td>
                  <td className={`text-right px-2 py-1 ${m.rise_time_s > 1.5 ? 'text-warn' : ''}`}>{m.rise_time_s ?? '-'}s</td>
                  <td className={`text-right px-2 py-1 ${m.overshoot_pct > 25 ? 'text-warn' : ''}`}>{m.overshoot_pct ?? '-'}%</td>
                  <td className={`text-right px-2 py-1 ${m.settling_time_s > 2.5 ? 'text-warn' : ''}`}>{m.settling_time_s ?? '-'}s</td>
                  <td className={`text-right px-2 py-1 ${m.dom_freq_hz > 3 ? 'text-warn' : ''}`}>{m.dom_freq_hz ?? '-'}Hz</td>
                  <td className="text-center px-2 py-1">{m.saturated ? '⚠' : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
