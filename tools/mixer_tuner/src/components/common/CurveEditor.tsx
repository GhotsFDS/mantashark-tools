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
  paramKey: (i: number) => string;
  mirrorKey?: (i: number) => string;
  yAxis?: 'left' | 'right';
  absLimitAliases?: string[];   // tilt series: 计算软限位 abs 范围 (取多个 alias 交集)
}

interface Props {
  effectiveSpeed: number;
  height?: number;
  mode?: CurveMode;
  showAll?: boolean;
  restrictToIds?: string[];   // 只画这些 series id (joint 模式用)
}

// VBAR 加高分两行: 上行刻度数字, 下行 V 断点 label, 防重叠
const VBAR_H = 44;
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

export function CurveEditor({ effectiveSpeed, height = 460, mode = 'k', showAll = true, restrictToIds }: Props) {
  const { params, selectedCurve, selectedTiltCurve, setParam, setSelectedCurve,
          setSelectedTiltCurve, currentGear, mergeLR } = useStore();
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
    if (mode === 'joint') {
      const k = selectedCurve;
      const out: SeriesDef[] = [
        { id: k, label: k, desc: 'K (左轴)', color: GROUP_COLORS[k],
          paramKey: (i: number) => `MSK_${k}${i}`, yAxis: 'left' },
      ];
      // [series id, 主 alias, 限位 aliases]
      type TiltSpec = [string, string, string[]];
      const tiltGroup: Record<GroupKey, TiltSpec[]> = {
        KS:  [['SGRP', 'SGRP', ['SGRP']]],
        KDF: mergeLR
          ? [['DF', 'DFL', ['DFL','DFR']]]
          : [['DFL','DFL',['DFL']],['DFR','DFR',['DFR']]],
        KT:  mergeLR
          ? [['T1', 'TL1', ['TL1','TR1']]]
          : [['TL1','TL1',['TL1']],['TR1','TR1',['TR1']]],
        KRD: mergeLR
          ? [['RD', 'RDL', ['RDL','RDR']]]
          : [['RDL','RDL',['RDL']],['RDR','RDR',['RDR']]],
      };
      for (const [sid, mainAlias, limitAliases] of tiltGroup[k]) {
        const def: SeriesDef = {
          id: sid, label: sid, desc: '倾转 (右轴)',
          color: (TILT_COLORS as any)[sid] ?? TILT_COLORS.SGRP,
          paramKey: (i: number) => `TLTC_${mainAlias}_K${i}`,
          yAxis: 'right',
          absLimitAliases: limitAliases,
        };
        if (mergeLR && sid === 'DF') def.mirrorKey = (i: number) => `TLTC_DFR_K${i}`;
        if (mergeLR && sid === 'T1') def.mirrorKey = (i: number) => `TLTC_TR1_K${i}`;
        if (mergeLR && sid === 'RD') def.mirrorKey = (i: number) => `TLTC_RDR_K${i}`;
        out.push(def);
      }
      return out;
    }
    if (mergeLR) {
      return [
        { id: 'SGRP', label: 'S_GROUP', desc: 'S 组斜吹', color: TILT_COLORS.SGRP,
          paramKey: (i: number) => `TLTC_SGRP_K${i}`, absLimitAliases: ['SGRP'] },
        { id: 'DF',   label: 'DF',      desc: 'DF 前下吹 (L+R 联调)', color: TILT_COLORS.DFL,
          paramKey: (i: number) => `TLTC_DFL_K${i}`,
          mirrorKey: (i: number) => `TLTC_DFR_K${i}`,
          absLimitAliases: ['DFL','DFR'] },
        { id: 'T1',   label: 'T1',      desc: 'T 后推 (L+R 联调)', color: TILT_COLORS.TL1,
          paramKey: (i: number) => `TLTC_TL1_K${i}`,
          mirrorKey: (i: number) => `TLTC_TR1_K${i}`,
          absLimitAliases: ['TL1','TR1'] },
        { id: 'RD',   label: 'RD',      desc: 'RD 后斜下吹 (L+R 联调)', color: TILT_COLORS.RDL,
          paramKey: (i: number) => `TLTC_RDL_K${i}`,
          mirrorKey: (i: number) => `TLTC_RDR_K${i}`,
          absLimitAliases: ['RDL','RDR'] },
      ];
    }
    return TILT_ALIASES.map(a => ({
      id: a,
      label: a,
      desc: TILT_LABELS[a],
      color: TILT_COLORS[a],
      paramKey: (i: number) => `TLTC_${a}_K${i}`,
      absLimitAliases: [a],
    }));
  }, [mode, mergeLR, selectedCurve]);

  // 双轴常量 (joint 用)
  const AX = {
    left:  { yMin: 0, yMax: 1.1, yStep: 0.2, ySnap: 0.01, label: 'K',     fmt: (v:number) => v.toFixed(2) },
    right: { yMin: 0, yMax: 180, yStep: 30,  ySnap: 1,    label: '° abs', fmt: (v:number) => v.toFixed(0) },
  };
  const isJoint = mode === 'joint';

  // 默认主轴: K 模式 / 联调模式 → 左轴 K (0..1.1); 倾转模式 → 右轴 ° (0..180)
  const defaultAxis: 'left' | 'right' = (mode === 'k' || isJoint) ? 'left' : 'right';
  const yMin = defaultAxis === 'left' ? 0 : 0;
  const yMax = defaultAxis === 'left' ? 1.1 : 180;
  const yLabel = defaultAxis === 'left' ? 'K' : '° abs';
  const yStep = defaultAxis === 'left' ? 0.2 : 30;
  const ySnap = defaultAxis === 'left' ? 0.01 : 1;
  const yLabelFmt = defaultAxis === 'left'
    ? (v: number) => v.toFixed(2)
    : (v: number) => v.toFixed(0);

  // joint 模式 chip 选 K 组 (selectedCurve), 其他模式按各自 selected
  const selectedSid: string =
    mode === 'k' || isJoint ? selectedCurve : selectedTiltCurve;
  const setSelectedSid = (sid: string) => {
    if (mode === 'k' || isJoint) setSelectedCurve(sid as GroupKey);
    else setSelectedTiltCurve(sid as TiltAlias);
  };

  // 给 series 选轴 (单 mode 时 sd.yAxis 没设, 用 defaultAxis)
  const axisOf = (sd: SeriesDef) => sd.yAxis ?? defaultAxis;

  const Vs: number[] = [0, params.MSK_V1, params.MSK_V2, params.MSK_V3, params.MSK_V_MAX];

  const tx = useCallback((v: number) =>
    PADDING.left + (v / params.MSK_V_MAX) * (size.w - PADDING.left - PADDING.right),
    [params.MSK_V_MAX, size.w]);
  const tyAxis = useCallback((y: number, axis: 'left' | 'right') => {
    const a = AX[axis];
    const Hplot = size.h - PADDING.top - PADDING.bottom;
    const clamped = Math.max(a.yMin, Math.min(a.yMax, y));
    return (size.h - PADDING.bottom) - ((clamped - a.yMin) / (a.yMax - a.yMin)) * Hplot;
  }, [size.h]);
  const ty = useCallback((y: number) => tyAxis(y, defaultAxis), [tyAxis, defaultAxis]);

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
    // 上行: 整数刻度
    ctx.fillStyle = '#5a6374'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    for (let v = 0; v <= params.MSK_V_MAX; v += 2) {
      const x = tx(v);
      ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x, 18); ctx.stroke();
      ctx.fillText(v.toFixed(0), x, 12);
    }
    // 标题
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8593a8'; ctx.font = '9px monospace';
    ctx.fillText('V 轴 (◇拖)', PADDING.left + 2, 11);

    // 下行: V 断点 ◇ + label
    const VBAR_Y = 2 + VBAR_H - 12;       // 把 ◇ 放在下半部
    const VBAR_LABEL_Y = 2 + VBAR_H - 2;  // label 在 ◇ 下方
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
      ctx.fillText(`${p.label}=${p.v.toFixed(1)}`, x, VBAR_LABEL_Y);
    }
    for (const [x, lbl] of [[tx(0), 'V0=0'], [tx(params.MSK_V_MAX), `Vmax=${params.MSK_V_MAX}`]] as const) {
      ctx.fillStyle = '#5a6374';
      ctx.fillRect(x - 3, VBAR_Y - 3, 6, 6);
      ctx.fillStyle = '#5a6374'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(lbl, x, VBAR_LABEL_Y);
    }

    // ═══ 主绘图区 ═══
    const plotTop = PADDING.top;
    const plotBottom = H - PADDING.bottom;

    // Y grid (用主轴 = defaultAxis)
    ctx.strokeStyle = '#1d232e'; ctx.lineWidth = 1;
    for (let y = yMin; y <= yMax; y += yStep) {
      ctx.beginPath(); ctx.moveTo(PADDING.left, ty(y)); ctx.lineTo(W - PADDING.right, ty(y)); ctx.stroke();
    }
    // 中立线 (倾转模式 / 联调右轴 45° 加粗)
    if (mode === 'tilt' || isJoint) {
      const yMid = isJoint ? tyAxis(45, 'right') : ty(45);
      ctx.strokeStyle = '#56d36480'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(PADDING.left, yMid); ctx.lineTo(W - PADDING.right, yMid); ctx.stroke();
      ctx.fillStyle = '#56d364'; ctx.font = '9px monospace';
      // joint 模式下 45° 属于右轴, label 贴右轴; 倾转模式贴左
      if (isJoint) {
        ctx.textAlign = 'right';
        ctx.fillText('45° 中立', W - PADDING.right - 4, yMid - 3);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText('45° 中立', PADDING.left + 4, yMid - 3);
      }
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

    // 联调: 右 Y 轴 (倾转角)
    if (isJoint) {
      ctx.fillStyle = '#56d364'; ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      const ax = AX.right;
      for (let y = ax.yMin; y <= ax.yMax; y += ax.yStep) {
        ctx.fillText(ax.fmt(y), W - PADDING.right + 4, tyAxis(y, 'right') + 3);
      }
      ctx.fillText(ax.label, W - PADDING.right + 4, plotTop + 10);
    }

    // 倾转 series 软限位带 (右轴 / 倾转模式): 上下灰色禁区, 拖动会被 clamp
    let limitSeries: SeriesDef | null = null;
    if (isJoint) {
      // 联调: 显示右轴 (倾转) series 的限位; selectedSid 是 K 系, 这里取首个右轴 series
      limitSeries = series.find(s => s.absLimitAliases && (s.yAxis ?? defaultAxis) === 'right') ?? null;
    } else if (mode === 'tilt') {
      limitSeries = series.find(s => s.id === selectedSid && s.absLimitAliases) ?? null;
    }
    if (limitSeries) {
      const lim = tiltAbsLimit(limitSeries.absLimitAliases);
      const ax: 'left' | 'right' = limitSeries.yAxis ?? defaultAxis;
      const yTop = tyAxis(AX[ax].yMax, ax);
      const yHi  = tyAxis(lim.hi, ax);
      const yLo  = tyAxis(lim.lo, ax);
      const yBot = tyAxis(AX[ax].yMin, ax);
      ctx.fillStyle = '#ff7b7220';
      ctx.fillRect(PADDING.left, Math.min(yTop, yHi), W - PADDING.left - PADDING.right, Math.abs(yHi - yTop));
      ctx.fillRect(PADDING.left, Math.min(yLo, yBot), W - PADDING.left - PADDING.right, Math.abs(yBot - yLo));
      ctx.strokeStyle = '#ff7b7280'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(PADDING.left, yHi); ctx.lineTo(W - PADDING.right, yHi); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PADDING.left, yLo); ctx.lineTo(W - PADDING.right, yLo); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff7b72'; ctx.font = '9px monospace';
      // joint 模式: 限位线属右轴, label 贴右
      if (isJoint || ax === 'right') {
        ctx.textAlign = 'right';
        const xR = W - PADDING.right - 4;
        ctx.fillText(`max ${lim.hi}°`, xR, yHi - 2);
        ctx.fillText(`min ${lim.lo}°`, xR, yLo + 10);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(`max ${lim.hi}°`, PADDING.left + 4, yHi - 2);
        ctx.fillText(`min ${lim.lo}°`, PADDING.left + 4, yLo + 10);
      }
    }

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
    const seriesFiltered = restrictToIds ? series.filter(s => restrictToIds.includes(s.id)) : series;
    const seriesToDraw = showAll ? seriesFiltered : seriesFiltered.filter(s => s.id === selectedSid);
    for (const sd of seriesToDraw) {
      const K = [
        params[sd.paramKey(0)] ?? 0,
        params[sd.paramKey(1)] ?? 0,
        params[sd.paramKey(2)] ?? 0,
        params[sd.paramKey(3)] ?? 0,
        params[sd.paramKey(4)] ?? 0,
      ];
      const isSelected = sd.id === selectedSid;

      const ax = axisOf(sd);
      const tyy = (y: number) => tyAxis(y, ax);
      const axFmt = AX[ax].fmt;

      if (isSelected && mode === 'k') {
        ctx.fillStyle = sd.color + '15';
        ctx.beginPath();
        ctx.moveTo(tx(0), tyy(0));
        for (let i = 0; i <= 300; i++) {
          const v = (i / 300) * params.MSK_V_MAX;
          const y = pchip5(v, params.MSK_V1, params.MSK_V2, params.MSK_V3, params.MSK_V_MAX, K[0], K[1], K[2], K[3], K[4]);
          ctx.lineTo(tx(v), tyy(Math.max(0, y)));
        }
        ctx.lineTo(tx(params.MSK_V_MAX), tyy(0));
        ctx.closePath(); ctx.fill();
      }

      ctx.strokeStyle = sd.color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.globalAlpha = !showAll || isSelected ? 1 : 0.45;
      // 联调时倾转曲线虚线区分 (右轴)
      if (isJoint && ax === 'right') ctx.setLineDash([5, 3]);
      ctx.beginPath();
      for (let i = 0; i <= 400; i++) {
        const v = (i / 400) * params.MSK_V_MAX;
        const y = pchip5(v, params.MSK_V1, params.MSK_V2, params.MSK_V3, params.MSK_V_MAX, K[0], K[1], K[2], K[3], K[4]);
        if (i === 0) ctx.moveTo(tx(v), tyy(y));
        else         ctx.lineTo(tx(v), tyy(y));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 控制点
      for (let i = 0; i < 5; i++) {
        const px = tx(Vs[i]);
        const py = tyy(K[i]);
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
          // 自动判断: tooltip 默认右上, 末尾点 (px+108 超画布) 翻到左上
          const tooltipW = 100, tooltipH = 16;
          const fitsRight = px + 8 + tooltipW <= W - 4;
          const tx0 = fitsRight ? px + 8 : px - 8 - tooltipW;
          const ty0 = py - 20 < PADDING.top + 2 ? py + 8 : py - 20;
          ctx.fillStyle = '#161b24';
          ctx.fillRect(tx0, ty0, tooltipW, tooltipH);
          ctx.strokeStyle = sd.color; ctx.lineWidth = 1;
          ctx.strokeRect(tx0, ty0, tooltipW, tooltipH);
          ctx.fillStyle = sd.color;
          ctx.font = '11px monospace'; ctx.textAlign = 'left';
          ctx.fillText(`${sd.label}[${i}] = ${axFmt(K[i])}`, tx0 + 4, ty0 + 12);
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
      const axCur = axisOf(sd);
      ctx.fillStyle = sd.color;
      ctx.beginPath(); ctx.arc(tx(effectiveSpeed), tyAxis(y, axCur), 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0a0e14'; ctx.lineWidth = 1; ctx.stroke();
    }
  }, [params, size, hover, dragging, selectedSid, effectiveSpeed, showAll, restrictToIds, currentGear, tx, ty, tyAxis,
      mode, series, yMin, yMax, yStep, yLabel, yLabelFmt, isJoint]);

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
    const seriesFilteredHit = restrictToIds ? series.filter(s => restrictToIds.includes(s.id)) : series;
    const seriesToHit = showAll ? seriesFilteredHit : seriesFilteredHit.filter(s => s.id === selectedSid);
    let best: Hover = null, bestD = 16;
    for (const sd of seriesToHit) {
      const ax = axisOf(sd);
      for (let i = 0; i < 5; i++) {
        const px = tx(Vs[i]);
        const py = tyAxis(params[sd.paramKey(i)] ?? 0, ax);
        const d = Math.hypot(px - mx, py - my);
        if (d < bestD) { best = { kind: 'pt', sid: sd.id, idx: i }; bestD = d; }
      }
    }
    return best;
  };

  // 取 tilt series 的 abs 范围 (软限位 LMIN/LMAX 是 offset, 转 abs).
  // 多个 alias 取交集 (最严格), 任一参数缺失回退 ±180°.
  const tiltAbsLimit = (aliases?: string[]): { lo: number; hi: number } => {
    if (!aliases || aliases.length === 0) return { lo: -135, hi: 225 };  // 实际不限
    let lo = -180, hi = 180;
    for (const a of aliases) {
      const lmin = params[`TLT_${a}_LMIN`] ?? -180;
      const lmax = params[`TLT_${a}_LMAX`] ??  180;
      lo = Math.max(lo, lmin);
      hi = Math.min(hi, lmax);
    }
    return { lo: 45 + lo, hi: 45 + hi };
  };

  // 量化避免浮点尾噪 (按 series 所在轴 ySnap)
  const quantizeYAxis = (y: number, axis: 'left' | 'right'): number => {
    const sn = AX[axis].ySnap;
    const snapped = Math.round(y / sn) * sn;
    const decimals = sn >= 1 ? 0 : sn >= 0.1 ? 1 : sn >= 0.01 ? 2 : 3;
    return Number(snapped.toFixed(decimals));
  };
  const quantizeV = (v: number): number => Number((Math.round(v * 10) / 10).toFixed(1));

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { mx, my, W, H } = mouse(e);
    if (dragging) {
      if (dragging.kind === 'pt') {
        const sd = series.find(s => s.id === dragging.sid);
        const ax = sd ? axisOf(sd) : defaultAxis;
        const a = AX[ax];
        const Hplot = H - PADDING.top - PADDING.bottom;
        const yRange = a.yMax - a.yMin;
        let y = a.yMin + ((H - PADDING.bottom - my) / Hplot) * yRange;
        y = quantizeYAxis(y, ax);
        // 软限位 clamp (tilt series): LMIN/LMAX 是 offset → abs 范围
        if (sd && sd.absLimitAliases) {
          const lim = tiltAbsLimit(sd.absLimitAliases);
          y = Math.max(lim.lo, Math.min(lim.hi, y));
        }
        // 兜底: 轴范围
        y = Math.max(a.yMin, Math.min(a.yMax, y));
        if (sd) {
          setParam(sd.paramKey(dragging.idx), y);
          if (sd.mirrorKey) setParam(sd.mirrorKey(dragging.idx), y);
        }
      } else if (dragging.kind === 'v') {
        let v = ((mx - PADDING.left) / (W - PADDING.left - PADDING.right)) * params.MSK_V_MAX;
        const i = dragging.idx;
        const lo = i === 1 ? 0.1 : params[`MSK_V${i - 1}`] + 0.1;
        const hi = i === 3 ? params.MSK_V_MAX - 0.1 : params[`MSK_V${i + 1}`] - 0.1;
        v = Math.max(lo, Math.min(hi, quantizeV(v)));
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
    if (hit.kind === 'pt') {
      // joint 模式: 只有点 K 系 chip / K 控制点才切 selectedCurve.
      // 拖倾转控制点 (DFL/DFR/DF/T1/RD/SGRP 等) 不切组, 否则 selectedCurve 变成非法 GroupKey 导致崩溃.
      if (isJoint) {
        if ((K_KEYS as readonly string[]).includes(hit.sid)) {
          setSelectedCurve(hit.sid as GroupKey);
        }
      } else {
        setSelectedSid(hit.sid);
      }
    }
  };
  const onMouseUp   = () => setDragging(null);
  const onMouseLeave = () => { setHover(null); };  // 不要清 dragging — 用 document mouseup

  // 拖出 canvas 边界后释放 → 兜底取消拖动 (防止 stuck dragging state)
  useEffect(() => {
    if (!dragging) return;
    const onDocUp = () => setDragging(null);
    document.addEventListener('mouseup', onDocUp);
    return () => document.removeEventListener('mouseup', onDocUp);
  }, [dragging]);

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
        {/* joint 模式: chip 仅 K_KEYS (KS/KDF/KT/KRD), 切组同时换 K + 关联倾转 */}
        {(isJoint
          ? K_KEYS.map(k => ({ id: k as string, label: k, desc: GROUP_LABELS[k], color: GROUP_COLORS[k] }))
          : series
        ).map((sd: any) => (
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
        <span className="ml-auto opacity-60">
          {isJoint ? '左轴 K · 右轴 ° (虚线)' : '圆点只能↕ 拖 · 顶部 ◇ 只能↔ 拖 V 断点'}
        </span>
      </div>
    </div>
  );
}
