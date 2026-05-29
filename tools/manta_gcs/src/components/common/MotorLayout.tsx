import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MOTORS, GROUP_COLORS, SINGLE_MOTOR_MAX_N } from '../../lib/actuators';
import { MANTA_OUTLINE } from '../../lib/outline';

// 镜像对 (拖一个自动同步另一个: x 取反, y 相同)
const MIRROR_PAIRS: Record<string, string> = {
  DFL: 'DFR', DFR: 'DFL',
  SL1: 'SR2', SR2: 'SL1',
  SL2: 'SR1', SR1: 'SL2',
  TL1: 'TR1', TR1: 'TL1',
  TL2: 'TR2', TR2: 'TL2',
  RDL: 'RDR', RDR: 'RDL',
};
import type { GroupKey } from '../../lib/types';
import { useStore } from '../../store/useStore';
import { Move, Save, RotateCcw, Lock, Edit3 } from 'lucide-react';

interface Props {
  currentK: Record<GroupKey, number>;
  tiltAngle?: number;
  editable?: boolean;   // 是否启用拖拽模式 (Geometry 页启用)
  height?: number;
}

/**
 * 蝠鲨顶视图布局.
 * 约定: +Y 前 (蝠鲨头, 宽端), -Y 后 (尾, 窄端). +X 右.
 * Canvas Y 轴与机体系 +Y 相反 → front 画在上方.
 */
export function MotorLayout({ currentK, tiltAngle = 0, editable = false, height = 560 }: Props) {
  const { params, setParam } = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 500, h: height });
  const [editing, setEditing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [stagedPos, setStagedPos] = useState<Record<string, { x: number; y: number }>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(es => {
      const w = Math.max(340, es[0].contentRect.width);
      setSize({ w, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  // 拿 position: 优先 stagedPos > params.LAY_* > MOTORS 默认
  const getPos = useCallback((id: string) => {
    if (stagedPos[id]) return stagedPos[id];
    const xKey = `LAY_${id}_X`, yKey = `LAY_${id}_Y`;
    if (params[xKey] !== undefined && params[yKey] !== undefined) {
      return { x: params[xKey], y: params[yKey] };
    }
    const m = MOTORS.find(m => m.id === id);
    return m ? { ...m.position } : { x: 0, y: 0 };
  }, [stagedPos, params]);

  const kmax = Math.max(currentK.KS, currentK.KDF, currentK.KT, currentK.KRD, 1e-6);
  const kn: Record<GroupKey, number> = {
    KS:  currentK.KS  / kmax,
    KDF: currentK.KDF / kmax,
    KT:  currentK.KT  / kmax,
    KRD: currentK.KRD / kmax,
  };

  const draw = useCallback(() => {
    const cv = canvasRef.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = size.w, H = size.h;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d')!; ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0a0e14'; ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H * 0.55;
    const sx = W * 0.92;
    const sy = H * 0.82;

    // 机体系 → canvas: canvasX = cx + Xbody * (sx/2); canvasY = cy - Ybody * (sy/2)

    // ═══ 蝠鲨轮廓 (来自 top.png 提取的真实边缘) ═══
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy - sy*0.15, 20, cx, cy, sx * 0.55);
    grad.addColorStop(0, '#1d232e');
    grad.addColorStop(1, '#0f141c');
    ctx.fillStyle = grad;
    ctx.strokeStyle = '#3a4558';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < MANTA_OUTLINE.length; i++) {
      const [bx, by] = MANTA_OUTLINE[i];
      const px = cx + bx * sx * 0.48;
      const py = cy - by * sy * 0.48;
      if (i === 0) ctx.moveTo(px, py);
      else         ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // 中轴线 + 横线
    ctx.strokeStyle = '#2a334260'; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy - sy * 0.5); ctx.lineTo(cx, cy + sy * 0.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - sx * 0.48, cy); ctx.lineTo(cx + sx * 0.48, cy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 方向标注 (-Y 前 wide wings 在下, +Y 后 chassis 在上)
    ctx.fillStyle = '#5a6374'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('后 +Y (chassis tail)', cx, cy - sy * 0.45);
    ctx.fillText('前 −Y (wide wings)', cx, cy + sy * 0.48 + 14);
    ctx.textAlign = 'right'; ctx.fillText('−X  左', cx - sx * 0.43, cy - 3);
    ctx.textAlign = 'left';  ctx.fillText('右  +X', cx + sx * 0.43, cy - 3);
    ctx.textAlign = 'center';

    // 编辑模式: 格子提示
    if (editing) {
      ctx.strokeStyle = '#58b4ff20';
      for (let i = -5; i <= 5; i++) {
        const yy = cy + i * sy * 0.09;
        if (yy >= 10 && yy <= H - 20) { ctx.beginPath(); ctx.moveTo(30, yy); ctx.lineTo(W-30, yy); ctx.stroke(); }
        const xx = cx + i * sx * 0.09;
        if (xx >= 30 && xx <= W - 30) { ctx.beginPath(); ctx.moveTo(xx, 10); ctx.lineTo(xx, H-20); ctx.stroke(); }
      }
    }

    // ═══ 电机点 ═══
    for (const m of MOTORS) {
      const p = getPos(m.id);
      const px = cx + p.x * sx * 0.48;
      const py = cy - p.y * sy * 0.48;
      const color = GROUP_COLORS[m.group];
      const pct = kn[m.group] ?? 0;
      const baseR = editing ? 11 : (9 + pct * 14);

      // 光晕 (非编辑模式)
      if (!editing) {
        const halo = ctx.createRadialGradient(px, py, baseR * 0.3, px, py, baseR * 2);
        halo.addColorStop(0, color + '55');
        halo.addColorStop(1, color + '00');
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(px, py, baseR * 2, 0, Math.PI * 2); ctx.fill();
      }

      // 拖拽环
      if (editing) {
        ctx.strokeStyle = dragId === m.id ? '#58b4ff' : color + '80';
        ctx.lineWidth = dragId === m.id ? 3 : 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(px, py, baseR + 4, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }

      // 主圆
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(px, py, baseR, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0a0e14'; ctx.lineWidth = 2.5; ctx.stroke();

      // Tilt 箭头 (仅 RDL/RDR 跟 tiltAngle)
      if (!editing && (m.id === 'RDL' || m.id === 'RDR')) {
        const len = baseR * 1.8;
        const rad = (tiltAngle * Math.PI / 180);
        const ay = py + Math.cos(rad) * len;
        ctx.strokeStyle = '#e8eef7'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, ay); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px, ay); ctx.lineTo(px - 4, ay - 6); ctx.lineTo(px + 4, ay - 6); ctx.closePath();
        ctx.fillStyle = '#e8eef7'; ctx.fill();
      }

      // 标签
      ctx.fillStyle = editing ? '#e8eef7' : '#e8eef7';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(m.id, px, py - baseR - 6);
      if (!editing) {
        ctx.fillStyle = '#0a0e14'; ctx.font = 'bold 10px monospace';
        ctx.fillText(`${(pct*100).toFixed(0)}`, px, py + 3);
      } else {
        ctx.fillStyle = '#8593a8'; ctx.font = '8px monospace';
        ctx.fillText(`(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`, px, py + baseR + 12);
      }
    }

    // 底部总推力
    if (!editing) {
      let totalN = 0;
      for (const m of MOTORS) totalN += (kn[m.group] ?? 0) * SINGLE_MOTOR_MAX_N;
      ctx.fillStyle = '#8593a8'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
      ctx.fillText(`Σ 满油门总推力 ${totalN.toFixed(0)} N · 机重 98 N · T/W ${(totalN/98).toFixed(2)}`,
                   cx, H - 8);
    }
  }, [kn, size, tiltAngle, editing, dragId, getPos]);

  useEffect(() => { draw(); }, [draw]);

  // ═══ 拖拽交互 ═══
  const mousePos = (e: React.MouseEvent) => {
    const cv = canvasRef.current!;
    const r = cv.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top, W: r.width, H: r.height };
  };

  const canvasToBody = (mx: number, my: number, W: number, H: number) => {
    const cx = W / 2, cy = H * 0.55;
    const sx = W * 0.92 * 0.48, sy = H * 0.82 * 0.48;
    return { x: (mx - cx) / sx, y: -(my - cy) / sy };
  };

  const findMotor = (mx: number, my: number, W: number, H: number): string | null => {
    const cx = W / 2, cy = H * 0.55;
    const sx = W * 0.92, sy = H * 0.82;
    let best: string | null = null, bestD = 20;
    for (const m of MOTORS) {
      const p = getPos(m.id);
      const px = cx + p.x * sx * 0.48;
      const py = cy - p.y * sy * 0.48;
      const d = Math.hypot(px - mx, py - my);
      if (d < bestD) { best = m.id; bestD = d; }
    }
    return best;
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!editing) return;
    const { mx, my, W, H } = mousePos(e);
    const id = findMotor(mx, my, W, H);
    if (id) setDragId(id);
  };
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!editing || !dragId) return;
    const { mx, my, W, H } = mousePos(e);
    const body = canvasToBody(mx, my, W, H);
    body.x = Math.max(-1, Math.min(1, Math.round(body.x * 100) / 100));
    body.y = Math.max(-1, Math.min(1, Math.round(body.y * 100) / 100));
    setStagedPos(p => {
      const updates: Record<string, { x: number; y: number }> = { ...p, [dragId]: body };
      // 镜像对: x 取反, y 同
      const pair = MIRROR_PAIRS[dragId];
      if (pair) updates[pair] = { x: -body.x, y: body.y };
      return updates;
    });
    setDirty(true);
  };
  const onMouseUp = () => setDragId(null);

  const save = () => {
    const updates: Record<string, number> = {};
    for (const [id, p] of Object.entries(stagedPos)) {
      updates[`LAY_${id}_X`] = p.x;
      updates[`LAY_${id}_Y`] = p.y;
    }
    for (const k of Object.keys(updates)) setParam(k, updates[k]);
    setStagedPos({});
    setDirty(false);
  };
  const reset = () => {
    // 恢复默认 (MOTORS hardcoded)
    for (const m of MOTORS) {
      setParam(`LAY_${m.id}_X`, m.position.x);
      setParam(`LAY_${m.id}_Y`, m.position.y);
    }
    setStagedPos({});
    setDirty(false);
  };
  const cancel = () => { setStagedPos({}); setDirty(false); };

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{ display: 'block', cursor: editing ? (dragId ? 'grabbing' : 'grab') : 'default' }}
      />
      {editable && (
        <div className="flex items-center gap-2 mt-2">
          {!editing ? (
            <button className="btn flex-1" onClick={() => setEditing(true)}>
              <Edit3 size={12} className="inline mr-1" /> 编辑电机位置
            </button>
          ) : (
            <>
              <button className="btn btn-primary" onClick={save} disabled={!dirty}>
                <Save size={12} className="inline mr-1" /> 保存 {dirty ? `(${Object.keys(stagedPos).length})` : ''}
              </button>
              <button className="btn" onClick={cancel} disabled={!dirty}>取消</button>
              <button className="btn btn-warn ml-auto" onClick={reset}>
                <RotateCcw size={12} className="inline mr-1" /> 重置默认
              </button>
              <button className="btn" onClick={() => { if (dirty) save(); setEditing(false); }}>
                <Lock size={12} className="inline mr-1" /> 完成
              </button>
            </>
          )}
        </div>
      )}
      {editing && (
        <div className="text-[10px] text-fg-mute mt-1">
          拖拽任意电机到真实位置. 坐标系已翻: <b>+Y 后 (narrow tail)</b>, <b>-Y 前 (wide wings)</b>. 保存到 LAY_* 参数.
        </div>
      )}
    </div>
  );
}
