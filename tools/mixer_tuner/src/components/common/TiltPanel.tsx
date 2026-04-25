import React from 'react';
import { useStore } from '../../store/useStore';
import type { TiltConfig } from '../../lib/types';
import { TILT_NEUTRAL_ABS_DEG } from '../../lib/actuators';
import { gcs } from '../../lib/gcs';
import { AlertTriangle, X, Radio } from 'lucide-react';

interface Props {
  t: TiltConfig;
}

// 角度约定: 绝对物理角度 abs_deg (0=垂直水面, 45=中立, 90=水平水面).
// 仅 ZERO 标定是 PWM 量, 其他 (LMIN/LMAX/preview) 都是 abs_deg.
export function TiltPanel({ t }: Props) {
  const { params, tiltPreview, setParam, setTiltPreview, simulateArmed } = useStore();
  const ovrKey = `PRE_OVR_${t.alias}`;
  const ovrActive = (params[ovrKey] ?? -1) >= 0;
  const armedLock = simulateArmed;
  // 防止使用前的"先用后定义"
  const tiltAlias = t.alias;

  // 拖滑杆 → 写 store + 实时推送 PARAM_SET
  const setPreviewLive = (v: number) => {
    setTiltPreview(t.id, v);
    if (!armedLock) {
      setParam(ovrKey, v);
      gcs.setParam(ovrKey, v);
    }
  };

  const exitPreview = () => {
    setParam(ovrKey, -1);
    gcs.setParam(ovrKey, -1);
    // 滑杆回到曲线初始值 (V=0 时的 TLTC_*_K0)
    const k0 = params[`TLTC_${t.alias}_K0`] ?? TILT_NEUTRAL_ABS_DEG;
    setTiltPreview(t.id, k0);
  };

  // armed 切换时强制退出预览
  React.useEffect(() => {
    if (armedLock && ovrActive) {
      setParam(ovrKey, -1);
      gcs.setParam(ovrKey, -1);
    }
  }, [armedLock]);

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

  // abs_deg 转 PWM: offset = abs_deg − 45, pwm = ZERO + DIR × PER_DEG × offset
  const previewClamped = Math.max(lmin, Math.min(lmax, preview));
  const previewOffset = previewClamped - TILT_NEUTRAL_ABS_DEG;
  const pwm = Math.max(500, Math.min(2500, Math.round(zero + dir * perDeg * previewOffset)));
  const saturated = pwm === 500 || pwm === 2500;
  const previewClipped = previewClamped !== preview;

  const totalSpan = lmax - lmin;
  const spanAtLimit = totalSpan >= 180;

  const [flashMin, setFlashMin] = React.useState(false);
  const [flashMax, setFlashMax] = React.useState(false);

  // LMIN/LMAX 独立调, 但 LMAX − LMIN ≤ 180° (180° 舵机机械行程)
  const handleLminChange = (raw: number) => {
    const clamped = Math.max(0, Math.min(180, raw));
    if (clamped > lmax) {
      // LMIN 不能超过 LMAX
      setParam(lminKey, lmax);
      setFlashMin(true);
      setTimeout(() => setFlashMin(false), 300);
    } else if (lmax - clamped > 180) {
      // 总跨度 > 180°
      setParam(lminKey, lmax - 180);
      setFlashMin(true);
      setTimeout(() => setFlashMin(false), 300);
    } else {
      setParam(lminKey, clamped);
    }
  };

  const handleLmaxChange = (raw: number) => {
    const clamped = Math.max(0, Math.min(180, raw));
    if (clamped < lmin) {
      setParam(lmaxKey, lmin);
      setFlashMax(true);
      setTimeout(() => setFlashMax(false), 300);
    } else if (clamped - lmin > 180) {
      setParam(lmaxKey, lmin + 180);
      setFlashMax(true);
      setTimeout(() => setFlashMax(false), 300);
    } else {
      setParam(lmaxKey, clamped);
    }
  };

  const isAtNeutral = previewClamped === TILT_NEUTRAL_ABS_DEG;

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="card-title mb-0 flex-1">{t.id}</h3>
        {t.is_group && <span className="chip text-[9px]">组级</span>}
        <span className="text-[9px] text-fg-dim">SERVO{t.servo_ch}</span>
        <span className="text-[9px] text-fg-dim">[{lmin},{lmax}]°</span>
      </div>

      {/* ZERO (中立 PWM) — 真机 500-2500 全行程 */}
      <div className="grid grid-cols-3 gap-2 mt-2">
        <div className="col-span-2">
          <div className="label mb-1">中立 PWM (abs=45° 时输出)</div>
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
          <div className="label mb-1">DIR (abs↑ 时 PWM 方向)</div>
          <div className="flex">
            <button
              className={'btn flex-1 rounded-r-none ' + (dir === 1 ? 'btn-primary' : '')}
              onClick={() => setParam(dirKey, 1)}
            >+1 PWM↑</button>
            <button
              className={'btn flex-1 rounded-l-none border-l-0 ' + (dir === -1 ? 'btn-primary' : '')}
              onClick={() => setParam(dirKey, -1)}
            >−1 PWM↓</button>
          </div>
        </div>
        <div>
          <div className="label mb-1">μs/°</div>
          <div className="input val-mono text-center">
            {perDeg.toFixed(2)}
          </div>
        </div>
      </div>

      {/* 软限位 LMIN/LMAX 独立, 总跨度 ≤180° */}
      <div className="mt-3">
        <div className="flex items-center mb-1">
          <span className="label flex-1">软限位 abs (LMAX−LMIN ≤ 180°)</span>
          <span className={
            'val-mono text-[10px] ' +
            (spanAtLimit ? 'text-warn' : 'text-fg-dim')
          }>跨度={totalSpan}°</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className={'transition-all ' + (flashMin ? 'ring-1 ring-warn rounded' : '')}>
            <div className="flex items-center gap-1 mb-1">
              <span className="label">MIN (abs)</span>
              <span className="val-mono ml-auto text-[10px]">{lmin}°</span>
            </div>
            <input
              type="range" min={0} max={180} step={1}
              value={lmin}
              onChange={e => handleLminChange(parseInt(e.target.value))}
              className="slider w-full"
            />
          </div>
          <div className={'transition-all ' + (flashMax ? 'ring-1 ring-warn rounded' : '')}>
            <div className="flex items-center gap-1 mb-1">
              <span className="label">MAX (abs)</span>
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

      {/* 预览 abs_deg 0..180° — 拖动实时推送 PRE_OVR_{tiltAlias}, armed 时禁用 */}
      <div className="mt-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="label">预览角度 (abs)</span>
          {ovrActive && <span className="text-[9px] text-accent flex items-center gap-1"><Radio size={9} className="animate-pulse"/>LIVE</span>}
          {armedLock && <span className="text-[9px] text-warn">已 armed · 预览锁定</span>}
          {previewClipped && <span className="text-[9px] text-warn">⚠ clamped to [{lmin},{lmax}]</span>}
          {isAtNeutral && !ovrActive && <span className="text-[9px] text-ok">中立</span>}
          <span className="val-mono ml-auto">
            {previewClamped}°
          </span>
          {ovrActive && (
            <button onClick={exitPreview} title="退出预览, 回到曲线初始值"
                    className="text-[9px] text-fg-dim hover:text-warn flex items-center gap-0.5">
              <X size={10}/>退出
            </button>
          )}
        </div>
        <input
          type="range" min={0} max={180} step={1}
          value={preview}
          disabled={armedLock}
          onChange={e => setPreviewLive(parseInt(e.target.value))}
          className="slider w-full"
        />
        <div className="flex justify-between text-[9px] text-fg-dim mt-0.5">
          <span>0° 垂直</span>
          <span>45° 中立</span>
          <span>90° 水平</span>
          <span>180°</span>
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
