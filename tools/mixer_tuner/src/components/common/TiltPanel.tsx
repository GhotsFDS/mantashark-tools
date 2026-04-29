import React from 'react';
import { useStore } from '../../store/useStore';
import type { TiltConfig } from '../../lib/types';
import { TILT_NEUTRAL_ABS_DEG } from '../../lib/actuators';
import { gcs } from '../../lib/gcs';
import { AlertTriangle, Radio } from 'lucide-react';

interface Props {
  t: TiltConfig;
}

// 角度约定:
//   显示/调试 用绝对物理角度 abs_deg (0=垂直水面, 45=中立, 90=水平水面)
//   软限位 LMIN/LMAX 是 *偏移量* offset = abs - 45, 各自范围 -180..+180.
// 重要: 软限位是 *运行时工作限位* (工况避机身吹气 + G 限制), 不是机械限位.
//   - 0 偏移 (= abs 45°) 是中立标准, 但不一定在限位内 (区间可以是 [+10,+30] 这种不含 0 的)
//   - 物理标准: LMIN ≤ LMAX, 区间宽度 LMAX-LMIN ≤ 180° (单舵机最大行程)
//   - 预检 ±10° 扫描走 PRE_SWING, 不受软限位约束
//   ZERO/DIR/PER_DEG 是 PWM 标定. PWM = ZERO + DIR × PER_DEG × clamped_offset
// 软限位不映射到 500-2500, 仅做 offset 截断, 输出 PWM 是真实物理值. 超限锁限位 PWM.
export function TiltPanel({ t }: Props) {
  const { params, tiltPreview, setParam, setTiltPreview, simulateArmed, globalPreviewMode } = useStore();
  const zeroKey = `TLT_${t.alias}_ZERO`;
  const dirKey  = `TLT_${t.alias}_DIR`;
  const lminKey = `TLT_${t.alias}_LMIN`;   // 偏移量下界 (任意, LMIN ≤ LMAX)
  const lmaxKey = `TLT_${t.alias}_LMAX`;   // 偏移量上界 (任意, 区间不一定跨 0)
  const ovrKey  = `TLT_${t.alias}_PRV`;
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

  // 拖滑杆 → store + 实时推送 TLT_*_PRV (仅当全局预览模式开 + 未 armed).
  // 50ms 节流防 ws 拥塞 (slider drag 50+/秒).
  const lastPushRef = React.useRef<number>(0);
  const setPreviewLive = (absDeg: number) => {
    setTiltPreview(t.id, absDeg);
    if (!armedLock && globalPreviewMode) {
      setParam(ovrKey, absDeg);
      const now = performance.now();
      if (now - lastPushRef.current >= 50) {
        gcs.setParam(ovrKey, absDeg);
        lastPushRef.current = now;
      }
    }
  };

  React.useEffect(() => {
    if (armedLock && ovrActive) {
      setParam(ovrKey, -1);
      gcs.setParam(ovrKey, -1);
    }
  }, [armedLock]);

  const totalSpan = lmaxOff - lminOff;             // 区间宽度 (= LMAX - LMIN, ≥0)
  const spanAtLimit = totalSpan >= 180;

  const [flashMin, setFlashMin] = React.useState(false);
  const [flashMax, setFlashMax] = React.useState(false);

  // ZERO 数字输入: local state + onBlur/Enter/箭头键 才 push, 防中间值让舵机突变
  // isFocused ref: 用户正在编辑期间 GCS 推 PARAM_VALUE 不要覆盖 draft (race lock)
  const zeroFocusedRef = React.useRef(false);
  const [zeroDraft, setZeroDraft] = React.useState<string>(String(zero));
  const [flashZero, setFlashZero] = React.useState<'ok' | 'bad' | null>(null);
  React.useEffect(() => {
    if (!zeroFocusedRef.current) setZeroDraft(String(zero));
  }, [zero]);
  const commitZero = () => {
    const v = parseInt(zeroDraft, 10);
    if (!isNaN(v) && v >= 500 && v <= 2500) {
      if (v !== zero) {
        pushParam(zeroKey, v);
        setFlashZero('ok'); setTimeout(() => setFlashZero(null), 300);
      }
    } else {
      setZeroDraft(String(zero));
      setFlashZero('bad'); setTimeout(() => setFlashZero(null), 400);
    }
  };

  // 软限位 = 运行时工作区间. 必须 LMIN ≤ LMAX, 区间宽度 LMAX-LMIN ≤ 180°.
  // 区间可以不含 0 偏移 (例 [+10,+30] 表示工况禁止舵机回中立, 防吹机身).
  const handleLminChange = (raw: number) => {
    let v = Math.max(-180, Math.min(180, raw));
    if (v > lmaxOff) {
      v = lmaxOff;
      setFlashMin(true); setTimeout(() => setFlashMin(false), 300);
    }
    if (lmaxOff - v > 180) {
      v = lmaxOff - 180;
      setFlashMin(true); setTimeout(() => setFlashMin(false), 300);
    }
    pushParam(lminKey, v);
  };
  const handleLmaxChange = (raw: number) => {
    let v = Math.max(-180, Math.min(180, raw));
    if (v < lminOff) {
      v = lminOff;
      setFlashMax(true); setTimeout(() => setFlashMax(false), 300);
    }
    if (v - lminOff > 180) {
      v = lminOff + 180;
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
          <div className="label mb-1">μs (回车/失焦/↑↓推)</div>
          <input type="number" min={500} max={2500} step={1}
                 inputMode="numeric"
                 value={zeroDraft}
                 onChange={e => setZeroDraft(e.target.value)}
                 onFocus={() => { zeroFocusedRef.current = true; }}
                 onBlur={() => { zeroFocusedRef.current = false; commitZero(); }}
                 onKeyDown={e => {
                   if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                   else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') setTimeout(commitZero, 0);
                 }}
                 className={'input w-full val-mono transition-all ' +
                            (flashZero === 'bad' ? 'ring-1 ring-warn rounded' :
                             flashZero === 'ok'  ? 'ring-1 ring-accent rounded' : '')} />
        </div>
      </div>

      {/* 方向 (三态: +1 / 0 锁 / -1) + PER_DEG */}
      <div className="grid grid-cols-2 gap-2 mt-3">
        <div>
          <div className="label mb-1">DIR (0=锁定永远 ZERO PWM)</div>
          <div className="flex">
            <button className={'btn flex-1 rounded-r-none ' + (dir === 1 ? 'btn-primary' : '')}
                    onClick={() => pushParam(dirKey, 1)}>+1 ↑</button>
            <button className={'btn flex-1 rounded-none border-l-0 border-r-0 ' + (dir === 0 ? 'btn-primary' : '')}
                    onClick={() => pushParam(dirKey, 0)}
                    title="锁定: 不响应任何指令, PWM 永远 = ZERO (用于未校准舵机安全锁)">0 锁</button>
            <button className={'btn flex-1 rounded-l-none ' + (dir === -1 ? 'btn-primary' : '')}
                    onClick={() => pushParam(dirKey, -1)}>−1 ↓</button>
          </div>
        </div>
        <div>
          <div className="label mb-1">μs/°</div>
          <div className="input val-mono text-center">{perDeg.toFixed(2)}</div>
        </div>
      </div>

      {/* 软限位 (运行时工作区间, LMIN ≤ LMAX, 区间宽度 ≤180°. 区间可不含 0 偏移) */}
      <div className="mt-3">
        <div className="flex items-center mb-1">
          <span className="label flex-1">软限位 (offset, 运行工况区间)</span>
          <span className={'val-mono text-[10px] ' + (spanAtLimit ? 'text-warn' : 'text-fg-dim')}>
            Δ={totalSpan}°
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className={'transition-all ' + (flashMin ? 'ring-1 ring-warn rounded' : '')}>
            <div className="flex items-center gap-1 mb-1">
              <span className="label">下界 LMIN</span>
              <span className="val-mono ml-auto text-[10px]">{lminOff>0?'+':''}{lminOff}°</span>
            </div>
            <input type="range" min={-180} max={180} step={1}
                   value={lminOff}
                   onChange={e => handleLminChange(parseInt(e.target.value))}
                   className="slider w-full" />
          </div>
          <div className={'transition-all ' + (flashMax ? 'ring-1 ring-warn rounded' : '')}>
            <div className="flex items-center gap-1 mb-1">
              <span className="label">上界 LMAX</span>
              <span className="val-mono ml-auto text-[10px]">{lmaxOff>0?'+':''}{lmaxOff}°</span>
            </div>
            <input type="range" min={-180} max={180} step={1}
                   value={lmaxOff}
                   onChange={e => handleLmaxChange(parseInt(e.target.value))}
                   className="slider w-full" />
          </div>
        </div>
        <div className="text-[9px] text-fg-dim mt-1">
          实际 abs 工作范围 [{TILT_NEUTRAL_ABS_DEG + lminOff}, {TILT_NEUTRAL_ABS_DEG + lmaxOff}]°
          {(lminOff > 0 || lmaxOff < 0) && <span className="text-accent ml-1">· 不含中立 45°</span>}
        </div>
      </div>

      {/* 预览滑杆 (主显 abs, 括号显示偏移量). 实际机械轴 0-135°, 全局开关在 Tilts 顶部. */}
      <div className="mt-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="label">预览角度</span>
          {ovrActive && globalPreviewMode && <span className="text-[9px] text-accent flex items-center gap-1">
            <Radio size={9} className="animate-pulse"/>LIVE</span>}
          {!globalPreviewMode && <span className="text-[9px] text-fg-dim">全局预览关</span>}
          {armedLock && <span className="text-[9px] text-warn">已 armed · 锁定</span>}
          {offsetClipped && <span className="text-[9px] text-warn">⚠ 撞软限</span>}
          <span className="val-mono ml-auto">
            {clampedAbs}°
            <span className="text-fg-dim text-[10px] ml-1">
              ({clampedOffset >= 0 ? '+' : ''}{clampedOffset}°)
            </span>
          </span>
        </div>
        <input type="range" min={0} max={135} step={1}
               value={previewAbs}
               disabled={armedLock || !globalPreviewMode}
               onChange={e => setPreviewLive(parseInt(e.target.value))}
               className="slider w-full" />
        <div className="flex justify-between text-[9px] text-fg-dim mt-0.5">
          <span>0° 垂直</span>
          <span>45° 中立</span>
          <span>90° 水平</span>
          <span>135°</span>
        </div>
      </div>

      {/* 输出 PWM (真实物理值, 撞软限锁限位 PWM) */}
      <div className={
        'mt-3 flex items-center gap-2 px-3 py-2 rounded ' +
        ((hwSat || offsetClipped) ? 'bg-warn/20 text-warn' : 'bg-panel-2 text-fg')
      }>
        {(hwSat || offsetClipped) && <AlertTriangle size={14} />}
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
        <div className="mt-1 text-[10px] text-warn">
          ⚠ 拖出软限位 [{lminOff}°, +{lmaxOff}°], 已截断到 offset={clampedOffset}°. 实际 PWM 锁限位.
        </div>
      )}
    </div>
  );
}
