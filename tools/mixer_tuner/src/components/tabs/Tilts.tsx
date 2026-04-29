import React from 'react';
import { TiltPanel } from '../common/TiltPanel';
import { NumInput } from '../common/NumInput';
import { TILTS } from '../../lib/actuators';
import { useStore } from '../../store/useStore';
import { gcs } from '../../lib/gcs';
import { DEFAULT_PARAMS } from '../../lib/defaults';

export function Tilts() {
  const { params, setParam, setTiltPreview, globalPreviewMode, setGlobalPreviewMode } = useStore();
  const cplOn = (params.TLT_CPL_EN ?? 1) >= 0.5;
  // 实时推送 helper (本地 store + 飞控参数同步)
  const pushParam = (k: string, v: number) => {
    setParam(k, v);
    if (gcs.isConnected()) gcs.setParam(k, v);
  };

  // 全局预览开/关. 关闭时: 7 路 TLT_*_PRV=-1, 滑块回各路 G1 默认 (下水初始位).
  // 用 gcs.pushParams 30ms 错峰, 防 mavbridge 拥塞.
  const togglePreview = (on: boolean) => {
    setGlobalPreviewMode(on);
    if (!on) {
      const batch: Record<string, number> = {};
      for (const t of TILTS) {
        const ovrKey = `TLT_${t.alias}_PRV`;
        const g1Key  = `TLT_${t.alias}_G1`;
        // 优先用 store 实测值, 否则用 DEFAULT_PARAMS (各路 G1 默认不一致, 不能写死 45)
        const g1Val  = params[g1Key] ?? DEFAULT_PARAMS[g1Key] ?? 45;
        setParam(ovrKey, -1);
        batch[ovrKey] = -1;
        setTiltPreview(t.id, g1Val);
      }
      if (gcs.isConnected()) gcs.pushParams(batch);
    }
  };

  return (
    <div className="space-y-3">
      {/* 全局 */}
      <div className="card">
        <div className="flex items-center mb-2">
          <span className="card-title mb-0 flex-1">全局参数 (实时推 FC)</span>
          <label className="flex items-center gap-1.5 text-[11px] cursor-pointer select-none">
            <input type="checkbox"
                   checked={globalPreviewMode}
                   onChange={e => togglePreview(e.target.checked)}
                   className="accent-accent" />
            <span className={globalPreviewMode ? 'text-accent' : 'text-fg-dim'}>
              全局预览模式 {globalPreviewMode ? '· LIVE (拖滑块覆盖 FC)' : '(关 = 释放预览, FC 跟档位 G1/G2/G3)'}
            </span>
          </label>
        </div>
        <div className="grid grid-cols-5 gap-4">
          <GlobalField label="PWM per ° (统一)" k="TLT_PWM_PER_DEG" unit="μs/°" step={0.01} pushParam={pushParam} />
          {/* S→DF 耦合 ON/OFF + K 系数 */}
          <div>
            <div className="label mb-1">S→DF 软解耦补偿</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => pushParam('TLT_CPL_EN', cplOn ? 0 : 1)}
                className={'btn flex-1 ' + (cplOn ? 'btn-primary' : '')}
                title="0=不补偿 (S 转动机械带 DFL/DFR); 1=反向补偿 (DFL/DFR 看似独立)">
                {cplOn ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="text-[9px] text-fg-dim mt-1">{cplOn ? '反向补偿 DFL/DFR' : '关闭补偿'}</div>
          </div>
          <GlobalField label="耦合 K 系数" k="TLT_CPL_SDF_K" unit="" step={0.05} min={0} max={1} pushParam={pushParam} disabled={!cplOn} />
          <div>
            <div className="label mb-1">全局 PWM 范围</div>
            <div className="input opacity-70 val-mono">500 .. 2500 μs</div>
            <div className="text-[9px] text-fg-dim mt-1">需 SERVOx_MIN=500 / SERVOx_MAX=2500</div>
          </div>
        </div>
      </div>

      {/* 7 tilt 面板 */}
      <div className="grid grid-cols-3 gap-3">
        {TILTS.map(t => <TiltPanel key={t.id} t={t} />)}
      </div>

      <div className="card">
        <div className="card-title">说明</div>
        <ul className="text-[10px] text-fg-mute space-y-1 ml-4 list-disc">
          <li><b>ZERO</b>: 舵臂物理 0° 对应的 PWM. 装机后松开舵臂锁定螺丝, 手动调到机械中立, 读当前 PWM 写入.</li>
          <li><b>DIR</b>: 命令 +30° 时舵机应转到哪一侧. 装反 → 改 -1. 镜像对默认 +1/-1.</li>
          <li><b>PWM/°</b>: 90° 舵机在 1000-2000μs 下理论 11.11, 实测 8.33 保守 (留余量).</li>
          <li>最终 PWM = <b>ZERO + DIR × PWM_PER_DEG × 目标角度</b>, 硬 clamp 到 [500, 2500]</li>
          <li>tilt_driver.lua 会额外对 DFL/DFR 做 S→DF 反向耦合补偿 (基于 TLT_CPL_SDF_K × S_GROUP_TILT)</li>
        </ul>
      </div>
    </div>
  );
}

function GlobalField({ label, k, unit, step, min, max, pushParam, disabled }: any) {
  const { params } = useStore();
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className="flex items-center gap-1.5">
        <NumInput value={params[k] ?? 0}
                  step={step} min={min} max={max}
                  disabled={disabled}
                  onCommit={v => pushParam(k, v)}
                  className={'input flex-1 val-mono ' + (disabled ? 'opacity-50' : '')} />
        {unit && <span className="text-[10px] text-fg-dim">{unit}</span>}
      </div>
    </div>
  );
}
