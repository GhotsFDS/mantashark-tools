import React from 'react';
import { TiltPanel } from '../common/TiltPanel';
import { TILTS } from '../../lib/actuators';
import { useStore } from '../../store/useStore';
import { gcs } from '../../lib/gcs';

export function Tilts() {
  const { params, setParam } = useStore();
  const cplOn = (params.TLT_CPL_EN ?? 1) >= 0.5;
  // 实时推送 helper (本地 store + 飞控参数同步)
  const pushParam = (k: string, v: number) => {
    setParam(k, v);
    if (gcs.isConnected()) gcs.setParam(k, v);
  };
  return (
    <div className="space-y-3">
      {/* 全局 */}
      <div className="card">
        <div className="card-title">全局参数 (实时推 FC)</div>
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
          <GlobalField label="T1 实验范围 ±" k="TLT_T1_DEG" unit="°" step={1} pushParam={pushParam} />
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
          <li>最终 PWM = <b>ZERO + DIR × PWM_PER_DEG × 目标角度</b>, 硬 clamp 到 [800, 2200]</li>
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
        <input
          type="number" step={step}
          min={min} max={max}
          value={params[k]}
          disabled={disabled}
          onChange={e => pushParam(k, parseFloat(e.target.value) || 0)}
          className={'input flex-1 val-mono ' + (disabled ? 'opacity-50' : '')}
        />
        {unit && <span className="text-[10px] text-fg-dim">{unit}</span>}
      </div>
    </div>
  );
}
