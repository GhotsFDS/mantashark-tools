import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { pchip5 } from '../../lib/pchip';
import { useStore } from '../../store/useStore';
import type { GroupKey, TiltAlias } from '../../lib/types';
import { GROUP_COLORS, GROUP_LABELS } from '../../lib/actuators';

type CurveMode = 'k' | 'tilt';

interface SeriesDef {
  id: string;
  label: string;
  desc?: string;
  color: string;
  paramKey: (i: number) => string;  // index 0..4
}

interface Props {
  effectiveSpeed: number;
  height?: number;
  mode?: CurveMode;
  showAll?: boolean;
}

const VBAR_H = 30;
const PADDING = { top: VBAR_H + 10, right: 50, bottom: 28, left: 40 };

// 7 路 tilt 颜色
const TILT_COLORS: Record<TiltAlias, string> = {
  SGRP: '#58b4ff',
  DFL:  '#ffa657',
  DFR:  '#f5a524',
  TL1:  '#7ee787',
  TR1:  '#56d364',
  RDL:  '#ff7b72',
  RDR:  '#f85149',
};

const TILT_LABELS: Record<TiltAlias, string> = {
  SGRP: 'S 组斜吹',
  DFL: 'DF 左前',
  DFR: 'DF 右前',
  TL1: 'T 左 1',
  TR1: 'T 右 1',
  RDL: 'RD 左',
  RDR: 'RD 右',
};

const TILT_ALIASES: TiltAlias[] = ['SGRP', 'DFL', 'DFR', 'TL1', 'TR1', 'RDL', 'RDR'];
const K_KEYS: GroupKey[] = ['KS', 'KDF', 'KT', 'KRD'];

type Drag =
  | { kind: 'pt'; sid: string; idx: number }
  | { kind: 'v'; idx: 1 | 2 | 3 }
  | null;

type Hover =
  | { kind: 'pt'; sid: string; idx: number }
  | { kind: 'v'; idx: 1 | 2 | 3 }
  | null;

export function CurveEditor({ effectiveSpeed, height = 460, mode = 'k', showAll = true }: Props) {
  const { params, selectedCurve, selectedTiltCurve, setParam, setSelectedCurve,
          setSelectedTiltCurve, currentGear } = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);
  const [hover, setHover]       = useState<Hover>(null);
  const [dragging, setDragging] = useState<Drag>(null);
  const [size, setSize]         = useState({ w: 900, h: height });

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(es => {
      const w = Math.max(400, es[0].contentRect.width);
      setSize({ w, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  // ═══ 模式相关参数 ═══
  const series: SeriesDef[] = useMemo(() => {
    if (mode === 'k') {
      return K_KEYS.map(k => ({
        id: k,
        label: k,
        desc: GROUP_LABELS[k],
        color: GROUP_COLORS[k],
        paramKey: (i: number) => `MSK_${k}${i}`,
      }));
    }
    return TILT_ALIASES.map(a => ({
      id: a,
      label: a,
      desc: TILT_LABELS[a],
      color: TILT_COLORS[a],
      paramKey: (i: number) => `TLTC_${a}_K${i}`,
    }));
  }, [mode]);

  const yMin = mode === 'k' ? 0 : -180;
  const yMax = mode === 'k' ? 1.1 : 180;
  const yLabel = mode === 'k' ? 'K' : '°';
  const yStep = mode === 'k' ? 0.2 : 30;
  const ySnap = mode === 'k' ? 0.01 : 1;
  const yLabelFmt = mode === 'k'
    ? (v: number) => v.toFixed(2)
    : (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}`;

  const selectedSid = mode === 'k' ? selectedCurve : selectedTiltCurve;
  const setSelectedSid = (sid: string) => {
    if (mode === 'k') setSelectedCurve(sid as GroupKey);
    else setSelectedTiltCurve(sid as TiltAlias);
  };

  const Vs: number[] = [0, params.MSK_V1, params.MSK_V2, params.MSK_V3, params.MSK_V_MAX];

  const tx = useCallback((v: number) =>
    PADDING.left + (v / params.MSK_V_MAX) * (size.w - PADDING.left - PADDING.right),
    [params.MSK_V_MAX, size.w]);
  const ty = useCallback((y: number) => {
    const Hplot = size.h - PADDING.top - PADDING.bottom;
    const clamped = Math.max(yMin, Math.min(yMax, y));
    return (size.h - PADDING.bottom) - ((clamped - yMin) / (yMax - yMin)) * Hplot;
  }, [size.h, yMin, yMax]);

  const draw = useCallback(() => {
    const cv = canvasRef.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = size.w, H = size.h;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d')!; ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = '#0a0e14'; ctx.fillRect(0, 0, W, H);

    // ═══ 顶部速度轴 bar ═══
    ctx.fillStyle = '#1d232e';
    ctx.fillRect(PADDING.left, 2, W - PADDING.left - PADDING.right, VBAR_H);
    ctx.strokeStyle = '#2a3342'; ctx.lineWidth = 1;
    ctx.strokeRect(PADDING.left, 2, W - PADDING.left - PADDING.right, VBAR_H);
    ctx.fillStyle = '#5a6374'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    for (let v = 0; v <= params.MSK_V_MAX; v += 2) {
      const x = tx(v);
      ctx.beginPath(); ctx.moveTo(x, 2 + VBAR_H - 4); ctx.lineTo(x, 2 + VBAR_H); ctx.stroke();
      ctx.fillText(v.toFixed(0), x, 14);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8593a8'; ctx.font = '9px monospace';
    ctx.fillText('速度轴 V (拖 ◇ 改 V 断点)', PADDING.left + 4, VBAR_H + 2 - 4);

    const VBAR_Y = 2 + VBAR_H / 2;
    const vPoints = [
      { idx: 1, v: params.MSK_V1, label: 'V1' },
      { idx: 2, v: params.MSK_V2, label: 'V2' },
      { idx: 3, v: params.MSK_V3, label: 'V3' },
    ] as const;
    for (const p of vPoints) {
      const x = tx(p.v);
      const isHov = hover?.kind === 'v' && hover.idx === p.idx;
      const isDrag = dragging?.kind === 'v' && dragging.idx === p.idx;
      ctx.save();
      ctx.translate(x, VBAR_Y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = isHov || isDrag ? '#58b4ff' : '#8593a8';
      const s = isDrag ? 10 : (isHov ? 9 : 7);
      ctx.fillRect(-s/2, -s/2, s, s);
      ctx.strokeStyle = '#0a0e14'; ctx.lineWidth = 1.5; ctx.strokeRect(-s/2, -s/2, s, s);
      ctx.restore();
      ctx.fillStyle = isHov || isDrag ? '#58b4ff' : '#8593a8';
      ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(`${p.label}=${p.v.toFixed(1)}`, x, 2 + VBAR_H - 16);
    }
    for (const [x, lbl] of [[tx(0), 'V0=0'], [tx(params.MSK_V_MAX), `V_MAX=${params.MSK_V_MAX}`]] as const) {
      ctx.fillStyle = '#5a6374';
      ctx.fillRect(x - 3, VBAR_Y - 3, 6, 6);
      ctx.fillStyle = '#5a6374'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(lbl, x, 2 + VBAR_H - 16);
    }

    // ═══ 主绘图区 ═══
    const plotTop = PADDING.top;
    const plotBottom = H - PADDING.bottom;

    // Y grid
    ctx.strokeStyle = '#1d232e'; ctx.lineWidth = 1;
    for (let y = yMin; y <= yMax; y += yStep) {
      ctx.beginPath(); ctx.moveTo(PADDING.left, ty(y)); ctx.lineTo(W - PADDING.right, ty(y)); ctx.stroke();
    }
    // 0 线 (倾转模式特别加粗)
    if (mode === 'tilt') {
      ctx.strokeStyle = '#2a3342'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(PADDING.left, ty(0)); ctx.lineTo(W - PADDING.right, ty(0)); ctx.stroke();
    }
    for (let v = 0; v <= params.MSK_V_MAX; v += 2) {
      ctx.strokeStyle = '#1d232e'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tx(v), plotTop); ctx.lineTo(tx(v), plotBottom); ctx.stroke();
    }
    ctx.strokeStyle = '#58b4ff30'; ctx.setLineDash([4, 4]);
    for (const v of [params.MSK_V1, params.MSK_V2, params.MSK_V3]) {
      ctx.beginPath(); ctx.moveTo(tx(v), plotTop); ctx.lineTo(tx(v), plotBottom); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Y 轴标签
    ctx.fillStyle = '#5a6374'; ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    for (let y = yMin; y <= yMax; y += yStep) {
      ctx.fillText(yLabelFmt(y), PADDING.left - 6, ty(y) + 3);
    }
    ctx.textAlign = 'left';
    ctx.fillText(yLabel, 8, plotTop + 10);

    // 档位限速线 (仅 K 模式)
    if (mode === 'k') {
      const gv = currentGear === 1 ? params.MSK_V1 : currentGear === 2 ? params.MSK_V2 : null;
      if (gv) {
        ctx.strokeStyle = '#f5a524'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(tx(gv), plotTop); ctx.lineTo(tx(gv), plotBottom); ctx.stroke();
        ctx.fillStyle = '#f5a524'; ctx.font = '10px monospace';
        ctx.fillText(`档${currentGear} 限`, tx(gv) + 4, plotTop + 12);
      }
    }

    // 曲线
    const seriesToDraw = showAll ? series : series.filter(s => s.id === selectedSid);
    for (const sd of seriesToDraw) {
      const K = [
        params[sd.paramKey(0)] ?? 0,
        params[sd.paramKey(1)] ?? 0,
        params[sd.paramKey(2)] ?? 0,
        params[sd.paramKey(3)] ?? 0,
        params[sd.paramKey(4)] ?? 0,
      ];
      const isSelected = sd.id === selectedSid;

      if (isSelected && mode === 'k') {
        ctx.fillStyle = sd.color + '15';
        ctx.beginPath();
        ctx.moveTo(tx(0), ty(0));
        for (let i = 0; i <= 300; i++) {
          const v = (i / 300) * params.MSK_V_MAX;
          const y = pchip5(v, params.MSK_V1, params.MSK_V2, params.MSK_V3, params.MSK_V_MAX, K[0], K[1], K[2], K[3], K[4]);
          ctx.lineTo(tx(v), ty(Math.max(0, y)));
        }
        ctx.lineTo(tx(params.MSK_V_MAX), ty(0));
        ctx.closePath(); ctx.fill();
      }

      ctx.strokeStyle = sd.color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.globalAlpha = !showAll || isSelected ? 1 : 0.45;
      ctx.beginPath();
      for (let i = 0; i <= 400; i++) {
        const v = (i / 400) * params.MSK_V_MAX;
        const y = pchip5(v, params.MSK_V1, params.MSK_V2, params.MSK_V3, params.MSK_V_MAX, K[0], K[1], K[2], K[3], K[4]);
        if (i === 0) ctx.moveTo(tx(v), ty(y));
        else         ctx.lineTo(tx(v), ty(y));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 控制点
      for (let i = 0; i < 5; i++) {
        const px = tx(Vs[i]);
        const py = ty(K[i]);
        const isHov = hover?.kind === 'pt' && hover.sid === sd.id && hover.idx === i;
        const isDrag = dragging?.kind === 'pt' && dragging.sid === sd.id && dragging.idx === i;
        const r = isDrag ? 8 : (isHov ? 7 : (isSelected ? 6 : 5));

        if (isHov || isDrag) {
          ctx.fillStyle = sd.color + '40';
          ctx.beginPath(); ctx.arc(px, py, r + 5, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = sd.color;
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0a0e14'; ctx.lineWidth = 2; ctx.stroke();

        if (isHov || isDrag) {
          ctx.fillStyle = '#161b24';
          ctx.fillRect(px + 8, py - 20, 100, 16);
          ctx.strokeStyle = sd.color; ctx.lineWidth = 1;
          ctx.strokeRect(px + 8, py - 20, 100, 16);
          ctx.fillStyle = sd.color;
          ctx.font = '11px monospace'; ctx.textAlign = 'left';
          ctx.fillText(`${sd.label}[${i}] = ${yLabelFmt(K[i])}`, px + 12, py - 8);
        }
      }
    }

    // 当前速度游标
    ctx.strokeStyle = '#e8eef7'; ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(tx(effectiveSpeed), plotTop); ctx.lineTo(tx(effectiveSpeed), plotBottom); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e8eef7'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
    ctx.fillText(`${effectiveSpeed.toFixed(1)} m/s`, tx(effectiveSpeed) + 4, plotTop + 12);

    // 当前 Y 值点
    for (const sd of seriesToDraw) {
      const K = [
        params[sd.paramKey(0)] ?? 0,
        params[sd.paramKey(1)] ?? 0,
        params[sd.paramKey(2)] ?? 0,
        params[sd.paramKey(3)] ?? 0,
        params[sd.paramKey(4)] ?? 0,
      ];
      const y = pchip5(effectiveSpeed, params.MSK_V1, params.MSK_V2, params.MSK_V3, params.MSK_V_MAX, K[0], K[1], K[2], K[3], K[4]);
      ctx.fillStyle = sd.color;
      ctx.beginPath(); ctx.arc(tx(effectiveSpeed), ty(y), 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0a0e14'; ctx.lineWidth = 1; ctx.stroke();
    }
  }, [params, size, hover, dragging, selectedSid, effectiveSpeed, showAll, currentGear, tx, ty,
      mode, series, yMin, yMax, yStep, yLabel, yLabelFmt]);

  useEffect(() => { draw(); }, [draw]);

  const mouse = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top, W: r.width, H: r.height };
  };

  const findHit = (mx: number, my: number, W: number, _H: number): Hover => {
    if (my >= 2 && my <= 2 + VBAR_H && mx >= PADDING.left && mx <= W - PADDING.right) {
      for (const idx of [1, 2, 3] as const) {
        const v = params[`MSK_V${idx}`];
        const x = tx(v);
        if (Math.abs(mx - x) < 10) return { kind: 'v', idx };
      }
    }
    const seriesToHit = showAll ? series : series.filter(s => s.id === selectedSid);
    let best: Hover = null, bestD = 16;
    for (const sd of seriesToHit) {
      for (let i = 0; i < 5; i++) {
        const px = tx(Vs[i]);
        const py = ty(params[sd.paramKey(i)] ?? 0);
        const d = Math.hypot(px - mx, py - my);
        if (d < bestD) { best = { kind: 'pt', sid: sd.id, idx: i }; bestD = d; }
      }
    }
    return best;
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { mx, my, W, H } = mouse(e);
    if (dragging) {
      if (dragging.kind === 'pt') {
        const Hplot = H - PADDING.top - PADDING.bottom;
        const yRange = yMax - yMin;
        let y = yMin + ((H - PADDING.bottom - my) / Hplot) * yRange;
        y = Math.max(yMin, Math.min(yMax, Math.round(y / ySnap) * ySnap));
        const sd = series.find(s => s.id === dragging.sid);
        if (sd) setParam(sd.paramKey(dragging.idx), y);
      } else if (dragging.kind === 'v') {
        let v = ((mx - PADDING.left) / (W - PADDING.left - PADDING.right)) * params.MSK_V_MAX;
        const i = dragging.idx;
        const lo = i === 1 ? 0.1 : params[`MSK_V${i - 1}`] + 0.1;
        const hi = i === 3 ? params.MSK_V_MAX - 0.1 : params[`MSK_V${i + 1}`] - 0.1;
        v = Math.max(lo, Math.min(hi, Math.round(v * 10) / 10));
        setParam(`MSK_V${i}`, v);
      }
    } else {
      setHover(findHit(mx, my, W, H));
    }
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { mx, my, W, H } = mouse(e);
    const hit = findHit(mx, my, W, H);
    if (!hit) return;
    setDragging(hit);
    if (hit.kind === 'pt') setSelectedSid(hit.sid);
  };
  const onMouseUp   = () => setDragging(null);
  const onMouseLeave = () => { setDragging(null); setHover(null); };

  const cursor = hover ? (hover.kind === 'v' ? 'ew-resize' : 'ns-resize') : 'default';

  return (
    <div ref={wrapRef} style={{ width: '100%', position: 'relative' }}>
      <canvas
        ref={canvasRef}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        style={{ display: 'block', cursor, userSelect: 'none' }}
      />
      <div className="mt-2 flex items-center gap-3 text-[10px] text-fg-mute flex-wrap">
        {series.map(sd => (
          <button
            key={sd.id}
            onClick={() => setSelectedSid(sd.id)}
            className={
              'flex items-center gap-1.5 px-2 py-0.5 rounded transition-all cursor-pointer ' +
              (selectedSid === sd.id ? 'bg-panel-3 text-fg' : 'hover:text-fg')
            }
          >
            <span className="w-3 h-3 rounded-full inline-block" style={{ background: sd.color }} />
            <span className="font-semibold">{sd.label}</span>
            {sd.desc && <span className="opacity-70">{sd.desc}</span>}
          </button>
        ))}
        <span className="ml-auto opacity-60">圆点只能↕ 拖 · 顶部 ◇ 只能↔ 拖 V 断点</span>
      </div>
    </div>
  );
}
