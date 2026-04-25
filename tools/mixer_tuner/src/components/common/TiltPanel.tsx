import React from 'react';
import { useStore } from '../../store/useStore';
import type { TiltConfig } from '../../lib/types';
import { AlertTriangle } from 'lucide-react';

interface Props {
  t: TiltConfig;
}

export function TiltPanel({ t }: Props) {
  const { params, tiltPreview, setParam, setTiltPreview } = useStore();
  const zeroKey = `TLT_${t.alias}_ZERO`;
  const dirKey  = `TLT_${t.alias}_DIR`;
  const lminKey = `TLT_${t.alias}_LMIN`;
  const lmaxKey = `TLT_${t.alias}_LMAX`;
  const zero = params[zeroKey];
  const dir = params[dirKey];
  const lmin = params[lminKey] ?? t.range[0];
  const lmax = params[lmaxKey] ?? t.range[1];
  const perDeg = params.TLT_PWM_PER_DEG;
  const preview = tiltPreview[t.id];
  const previewClamped = Math.max(lmin, Math.min(lmax, preview));
  const pwm = Math.max(500, Math.min(2500, Math.round(zero + dir * perDeg * previewClamped)));
  const saturated = pwm === 500 || pwm === 2500;
  const previewClipped = previewClamped !== preview;

  const sumAbs = Math.abs(lmin) + Math.abs(lmax);
  const sumAtLimit = sumAbs >= 180;

  const [flashMin, setFlashMin] = React.useState(false);
  const [flashMax, setFlashMax] = React.useState(false);

  // 软限位独立调, 但 |LMIN| + |LMAX| ≤ 180 (180° 舵机总行程)
  const handleLminChange = (raw: number) => {
    const clampedSign = Math.max(-180, Math.min(0, raw));
    const maxAbs = 180 - Math.abs(lmax);
    if (Math.abs(clampedSign) > maxAbs) {
      setParam(lminKey, -maxAbs);
      setFlashMin(true);
      setTimeout(() => setFlashMin(false), 300);
    } else {
      setParam(lminKey, clampedSign);
    }
  };

  const handleLmaxChange = (raw: number) => {
    const clampedSign = Math.max(0, Math.min(180, raw));
    const maxAbs = 180 - Math.abs(lmin);
    if (Math.abs(clampedSign) > maxAbs) {
      setParam(lmaxKey, maxAbs);
      setFlashMax(true);
      setTimeout(() => setFlashMax(false), 300);
    } else {
      setParam(lmaxKey, clampedSign);
    }
  };

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="card-title mb-0 flex-1">{t.id}</h3>
        {t.is_group && <span className="chip text-[9px]">组级</span>}
        <span className="text-[9px] text-fg-dim">SERVO{t.servo_ch}</span>
        <span className="text-[9px] text-fg-dim">[{lmin},{lmax}]°</span>
      </div>

      {/* ZERO (0° PWM) — 真机 500-2500 全行程 */}
      <div className="grid grid-cols-3 gap-2 mt-2">
        <div className="col-span-2">
          <div className="label mb-1">0° PWM (ZERO trim)</div>
          <input
            type="range"
            min={500} max={2500} step={1}
            value={zero}
            onChange={e => setParam(zeroKey, parseInt(e.target.value))}
            className="slider w-full"
          />
        </div>
        <div>
          <div className="label mb-1">μs</div>
          <input
            type="number" min={500} max={2500} step={1}
            value={zero}
            onChange={e => setParam(zeroKey, parseFloat(e.target.value) || 1500)}
            className="input w-full val-mono"
          />
        </div>
      </div>

      {/* 方向 */}
      <div className="grid grid-cols-2 gap-2 mt-3">
        <div>
          <div className="label mb-1">方向 (+ = 趋于水平)</div>
          <div className="flex">
            <button
              className={'btn flex-1 rounded-r-none ' + (dir === 1 ? 'btn-primary' : '')}
              onClick={() => setParam(dirKey, 1)}
            >+1 正</button>
            <button
              className={'btn flex-1 rounded-l-none border-l-0 ' + (dir === -1 ? 'btn-primary' : '')}
              onClick={() => setParam(dirKey, -1)}
            >−1 反</button>
          </div>
        </div>
        <div>
          <div className="label mb-1">角度 → PWM</div>
          <div className="input val-mono text-center">
            {perDeg.toFixed(2)} μs/°
          </div>
        </div>
      </div>

      {/* 软限位 LMIN/LMAX 独立双滑杆, 总和 ≤180° */}
      <div className="mt-3">
        <div className="flex items-center mb-1">
          <span className="label flex-1">软限位 (|LMIN|+|LMAX| ≤ 180°)</span>
          <span className={
            'val-mono text-[10px] ' +
            (sumAtLimit ? 'text-warn' : 'text-fg-dim')
          }>Σ={sumAbs}°</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className={'transition-all ' + (flashMin ? 'ring-1 ring-warn rounded' : '')}>
            <div className="flex items-center gap-1 mb-1">
              <span className="label">MIN (−)</span>
              <span className="val-mono ml-auto text-[10px]">{lmin}°</span>
            </div>
            <input
              type="range" min={-180} max={0} step={1}
              value={lmin}
              onChange={e => handleLminChange(parseInt(e.target.value))}
              className="slider w-full"
            />
          </div>
          <div className={'transition-all ' + (flashMax ? 'ring-1 ring-warn rounded' : '')}>
            <div className="flex items-center gap-1 mb-1">
              <span className="label">MAX (+)</span>
              <span className="val-mono ml-auto text-[10px]">{lmax}°</span>
            </div>
            <input
              type="range" min={0} max={180} step={1}
              value={lmax}
              onChange={e => handleLmaxChange(parseInt(e.target.value))}
              className="slider w-full"
            />
          </div>
        </div>
      </div>

      {/* 预览 ±180° (受软限位 clamp) */}
      <div className="mt-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="label">预览角度</span>
          {previewClipped && <span className="text-[9px] text-warn">⚠ clamped to [{lmin},{lmax}]</span>}
          <span className="val-mono ml-auto">
            {previewClamped > 0 ? '+' : ''}{previewClamped}°
          </span>
        </div>
        <input
          type="range" min={-180} max={180} step={1}
          value={preview}
          onChange={e => setTiltPreview(t.id, parseInt(e.target.value))}
          className="slider w-full"
        />
        <div className="flex justify-between text-[9px] text-fg-dim mt-0.5">
          <span>-180° (垂直)</span><span>0° (中立)</span><span>+180° (水平)</span>
        </div>
      </div>

      {/* 输出 PWM */}
      <div className={
        'mt-3 flex items-center gap-2 px-3 py-2 rounded ' +
        (saturated ? 'bg-warn/20 text-warn' : 'bg-panel-2 text-fg')
      }>
        {saturated && <AlertTriangle size={14} />}
        <span className="label flex-1">输出 PWM</span>
        <span className="val-mono text-[14px]">{pwm}</span>
        <span className="text-[10px] opacity-70">μs</span>
      </div>

      {saturated && (
        <div className="mt-1 text-[10px] text-warn">
          ⚠ 饱和: 撞到 pwm_range 边界 [500, 2500]. 检查 ZERO/DIR.
        </div>
      )}
    </div>
  );
}
