import React from 'react';
import { useStore } from '../../store/useStore';
import type { TiltConfig } from '../../lib/types';
import { TILT_NEUTRAL_ABS_DEG } from '../../lib/actuators';
import { gcs } from '../../lib/gcs';
import { AlertTriangle, X, Radio } from 'lucide-react';

interface Props {
  t: TiltConfig;
}

// 角度约定:
//   显示/调试 用绝对物理角度 abs_deg (0=垂直水面, 45=中立, 90=水平水面)
//   软限位 LMIN/LMAX 是 *偏移量* offset = abs - 45 (范围 -180..+180, |LMIN|+|LMAX|≤180°)
//   ZERO/DIR/PER_DEG 是 PWM 标定. PWM = ZERO + DIR × PER_DEG × clamped_offset
// 软限位不映射到 500-2500, 仅做 offset 截断, 输出 PWM 是真实物理值. 超限锁限位 PWM.
export function TiltPanel({ t }: Props) {
  const { params, tiltPreview, setParam, setTiltPreview, simulateArmed } = useStore();
  const zeroKey = `TLT_${t.alias}_ZERO`;
  const dirKey  = `TLT_${t.alias}_DIR`;
  const lminKey = `TLT_${t.alias}_LMIN`;   // 偏移量下界 (≤0 一般)
  const lmaxKey = `TLT_${t.alias}_LMAX`;   // 偏移量上界 (≥0 一般)
  const ovrKey  = `PRE_OVR_${t.alias}`;
  const zero = params[zeroKey];
  const dir = params[dirKey];
  const lminOff = params[lminKey] ?? -45;
  const lmaxOff = params[lmaxKey] ?? 45;
  const perDeg = params.TLT_PWM_PER_DEG;

  // preview store 是 abs_deg
  const previewAbs = tiltPreview[t.id];
  const previewOffsetRaw = previewAbs - TILT_NEUTRAL_ABS_DEG;
  // 用偏移量 clamp
  const clampedOffset = Math.max(lminOff, Math.min(lmaxOff, previewOffsetRaw));
  const clampedAbs = TILT_NEUTRAL_ABS_DEG + clampedOffset;
  // PWM 真实算 (不映射到 500-2500), 但仍硬 clamp 到伺服安全范围
  const pwmRaw = Math.round(zero + dir * perDeg * clampedOffset);
  const pwm = Math.max(500, Math.min(2500, pwmRaw));
  const hwSat = pwm !== pwmRaw;          // 限位内但 PWM 硬撞 500/2500 — 标定错误
  const offsetClipped = clampedOffset !== previewOffsetRaw;
  const ovrActive = (params[ovrKey] ?? -1) >= 0;
  const armedLock = simulateArmed;

  // 标定参数实时推送: 拖 ZERO/DIR/LMIN/LMAX 时立刻飞控生效, 用户能看到 servo 实时调
  const pushParam = (key: string, val: number) => {
    setParam(key, val);
    if (gcs.isConnected()) gcs.setParam(key, val);
  };

  // 拖滑杆 → store + 实时推送 PRE_OVR_<alias>
  const setPreviewLive = (absDeg: number) => {
    setTiltPreview(t.id, absDeg);
    if (!armedLock) {
      setParam(ovrKey, absDeg);
      gcs.setParam(ovrKey, absDeg);
    }
  };

  const exitPreview = () => {
    setParam(ovrKey, -1);
    gcs.setParam(ovrKey, -1);
    const k0 = params[`TLTC_${t.alias}_K0`] ?? TILT_NEUTRAL_ABS_DEG;
    setTiltPreview(t.id, k0);
  };

  React.useEffect(() => {
    if (armedLock && ovrActive) {
      setParam(ovrKey, -1);
      gcs.setParam(ovrKey, -1);
    }
  }, [armedLock]);

  const totalSpan = Math.abs(lminOff) + Math.abs(lmaxOff);
  const spanAtLimit = totalSpan >= 180;

  const [flashMin, setFlashMin] = React.useState(false);
  const [flashMax, setFlashMax] = React.useState(false);

  // |LMIN| + |LMAX| ≤ 180°. LMIN ≤ 0, LMAX ≥ 0.
  const handleLminChange = (raw: number) => {
    let v = Math.max(-180, Math.min(0, raw));
    if (Math.abs(v) + Math.abs(lmaxOff) > 180) {
      v = -(180 - Math.abs(lmaxOff));
      setFlashMin(true); setTimeout(() => setFlashMin(false), 300);
    }
    pushParam(lminKey, v);
  };
  const handleLmaxChange = (raw: number) => {
    let v = Math.max(0, Math.min(180, raw));
    if (Math.abs(lminOff) + Math.abs(v) > 180) {
      v = 180 - Math.abs(lminOff);
      setFlashMax(true); setTimeout(() => setFlashMax(false), 300);
    }
    pushParam(lmaxKey, v);
  };

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="card-title mb-0 flex-1">{t.id}</h3>
        {t.is_group && <span className="chip text-[9px]">组级</span>}
        <span className="text-[9px] text-fg-dim">SERVO{t.servo_ch}</span>
        <span className="text-[9px] text-fg-dim">[{lminOff>0?'+':''}{lminOff},{lmaxOff>0?'+':''}{lmaxOff}]°</span>
      </div>

      {/* ZERO PWM */}
      <div className="grid grid-cols-3 gap-2 mt-2">
        <div className="col-span-2">
          <div className="label mb-1">中立 PWM (abs=45° 时输出)</div>
          <input type="range" min={500} max={2500} step={1}
                 value={zero}
                 onChange={e => pushParam(zeroKey, parseInt(e.target.value))}
                 className="slider w-full" />
        </div>
        <div>
          <div className="label mb-1">μs</div>
          <input type="number" min={500} max={2500} step={1}
                 value={zero}
                 onChange={e => pushParam(zeroKey, parseFloat(e.target.value) || 1500)}
                 className="input w-full val-mono" />
        </div>
      </div>

      {/* 方向 + PER_DEG */}
      <div className="grid grid-cols-2 gap-2 mt-3">
        <div>
          <div className="label mb-1">DIR (offset+ 时 PWM 方向)</div>
          <div className="flex">
            <button className={'btn flex-1 rounded-r-none ' + (dir === 1 ? 'btn-primary' : '')}
                    onClick={() => pushParam(dirKey, 1)}>+1 PWM↑</button>
            <button className={'btn flex-1 rounded-l-none border-l-0 ' + (dir === -1 ? 'btn-primary' : '')}
                    onClick={() => pushParam(dirKey, -1)}>−1 PWM↓</button>
          </div>
        </div>
        <div>
          <div className="label mb-1">μs/°</div>
          <div className="input val-mono text-center">{perDeg.toFixed(2)}</div>
        </div>
      </div>

      {/* 软限位 (偏移角度, |LMIN|+|LMAX| ≤180°) */}
      <div className="mt-3">
        <div className="flex items-center mb-1">
          <span className="label flex-1">软限位 (offset, |LMIN|+|LMAX| ≤ 180°)</span>
          <span className={'val-mono text-[10px] ' + (spanAtLimit ? 'text-warn' : 'text-fg-dim')}>
            Σ={totalSpan}°
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className={'transition-all ' + (flashMin ? 'ring-1 ring-warn rounded' : '')}>
            <div className="flex items-center gap-1 mb-1">
              <span className="label">LMIN (−)</span>
              <span className="val-mono ml-auto text-[10px]">{lminOff}°</span>
            </div>
            <input type="range" min={-180} max={0} step={1}
                   value={lminOff}
                   onChange={e => handleLminChange(parseInt(e.target.value))}
                   className="slider w-full" />
          </div>
          <div className={'transition-all ' + (flashMax ? 'ring-1 ring-warn rounded' : '')}>
            <div className="flex items-center gap-1 mb-1">
              <span className="label">LMAX (+)</span>
              <span className="val-mono ml-auto text-[10px]">{lmaxOff>0?'+':''}{lmaxOff}°</span>
            </div>
            <input type="range" min={0} max={180} step={1}
                   value={lmaxOff}
                   onChange={e => handleLmaxChange(parseInt(e.target.value))}
                   className="slider w-full" />
          </div>
        </div>
        <div className="text-[9px] text-fg-dim mt-1">
          实际 abs 范围 [{TILT_NEUTRAL_ABS_DEG + lminOff}, {TILT_NEUTRAL_ABS_DEG + lmaxOff}]°
        </div>
      </div>

      {/* 预览滑杆 (主显 abs, 括号显示偏移量) */}
      <div className="mt-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="label">预览角度</span>
          {ovrActive && <span className="text-[9px] text-accent flex items-center gap-1">
            <Radio size={9} className="animate-pulse"/>LIVE</span>}
          {armedLock && <span className="text-[9px] text-warn">已 armed · 锁定</span>}
          {offsetClipped && <span className="text-[9px] text-warn">⚠ 撞软限</span>}
          <span className="val-mono ml-auto">
            {clampedAbs}°
            <span className="text-fg-dim text-[10px] ml-1">
              ({clampedOffset >= 0 ? '+' : ''}{clampedOffset}°)
            </span>
          </span>
          {ovrActive && (
            <button onClick={exitPreview} title="退出预览, 回到曲线初始值"
                    className="text-[9px] text-fg-dim hover:text-warn flex items-center gap-0.5">
              <X size={10}/>退出
            </button>
          )}
        </div>
        <input type="range" min={0} max={180} step={1}
               value={previewAbs}
               disabled={armedLock}
               onChange={e => setPreviewLive(parseInt(e.target.value))}
               className="slider w-full" />
        <div className="flex justify-between text-[9px] text-fg-dim mt-0.5">
          <span>0° 垂直</span>
          <span>45° 中立</span>
          <span>90° 水平</span>
          <span>180°</span>
        </div>
      </div>

      {/* 输出 PWM (真实物理值, 撞软限锁限位 PWM) */}
      <div className={
        'mt-3 flex items-center gap-2 px-3 py-2 rounded ' +
        (hwSat ? 'bg-warn/20 text-warn' : offsetClipped ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-fg')
      }>
        {hwSat && <AlertTriangle size={14} />}
        <span className="label flex-1">输出 PWM</span>
        <span className="val-mono text-[14px]">{pwm}</span>
        <span className="text-[10px] opacity-70">μs</span>
      </div>

      {hwSat && (
        <div className="mt-1 text-[10px] text-warn">
          ⚠ PWM 撞 [500,2500] 硬限位. 检查 ZERO/DIR/PER_DEG 标定 (软限位前已饱和).
        </div>
      )}
      {offsetClipped && !hwSat && (
        <div className="mt-1 text-[10px] text-fg-dim">
          ↑ 已锁在软限位边界, PWM 不再变化 (实际 offset {clampedOffset}°).
        </div>
      )}
    </div>
  );
}
