// 默认参数. 镜像 scripts/main.lua + scripts/modules/{mixer,tilt_driver}.lua 注册的参数.
// v9 P1 大瘦身: 删 v8 PCHIP 25 K + 4 V + MSK_GEAR/AUTO/MODE_CH + MSK_TRIM_* + MSK_RTL_* +
// MGEO_* (36) + TLTC_* (35) + GRD_* + PRE_* (44 个 → 0). v9 P1 仅 4 K + 32 TLT.
import type { ParamSet } from './types';

export const DEFAULT_PARAMS: ParamSet = {
  // ═══ MSK_ (mixer, key=81) — v9 P1 旧 4 K (兼容保留, lua 不读) ═══
  MSK_KS:  0.70,
  MSK_KDF: 0.50,
  MSK_KT:  0.50,
  MSK_KRD: 0.50,
  // ═══ MSK_ v9 P2 三档 K (12 个) ═══
  MSK_KS_G1:  0.10, MSK_KDF_G1: 0.05, MSK_KT_G1: 0.18, MSK_KRD_G1: 0.05,
  MSK_KS_G2:  0.50, MSK_KDF_G2: 0.50, MSK_KT_G2: 0.50, MSK_KRD_G2: 0.50,
  MSK_KS_G3:  0.20, MSK_KDF_G3: 0.20, MSK_KT_G3: 0.85, MSK_KRD_G3: 0.20,
  // ═══ v9 P3.1 G3 PID 速度环参数 ═══
  MSK_V_TGT:  9.0,   // G3 目标速度 m/s
  MSK_V_PI_P: 0.05,  // P 增益 (m/s err -> thr_cap correction)
  MSK_V_PI_I: 0.02,  // I 增益
  MSK_V_PI_D: 0.0,   // D 项 (用 V_actual 微分, 防 target 跳变. 默认 0, 振荡时调)
  // ═══ v9 P3.2/P3.4 tilt ATC + V 反馈 ═══
  MSK_FB_EN:   1.0,   // 启用 (G1/G3 工作, G2 跃迁档跳过, 0 = 全关)
  MSK_FB_P_SC: 5.0,   // pitch bias scale (°/ATC unit)
  MSK_FB_R_SC: 5.0,   // roll bias scale
  MSK_FB_V_SC: 8.0,   // RD V 反馈 scale (°/m/s err, 姿态稳态时 G3 启用, 朝 90° 助推)
  // v9 P3.4 base_pitch 切档 ramp 速率 (°/s, 0=阶跃)
  MSK_TRIM_RATE: 3.0,
  // v9 P3.5/P3.6 三层级加速
  MSK_KT_LIM:     1.0,  // KT 撞上限 (Layer 1→2 转换). 浮点比较加 0.95 迟滞
  MSK_L2_SGRP_RT: 5.0,  // Layer 2 SGRP 改平 rate (°/s, 实飞调)
  MSK_L2_RD_RT:   3.0,  // Layer 2 RDL/RDR 改平 rate (°/s, 实飞调)
  MSK_K_DRFT_RT:  0.01, // P3.7 K_drift 学习 rate (/s, 默认 0.01, 实飞调; 0=关学习)
  // v9 P3.8 三档 base_pitch (°, ch7 切档时 Q_TRIM_PITCH ramp 目标)
  MSK_BPCH_G1: 5,    // G1 慢滑: 浮筒承重自然
  MSK_BPCH_G2: 11,   // G2 抬头建气垫
  MSK_BPCH_G3: 8,    // G3 巡航: 翼面 0° AoA

  // ═══ TLT_ (tilt_driver, key=82) — 32+7=39 ═══
  TLT_CPL_SDF_K:   0.30,
  TLT_CPL_EN:      1,
  TLT_PWM_PER_DEG: 11.11,
  // ZERO/DIR/LMIN/LMAX × 7 (LMIN/LMAX 是 *偏移量* offset = abs - 45; DIR 三态 ±1/0)
  TLT_DFL_ZERO:  1500, TLT_DFL_DIR:  1, TLT_DFL_LMIN: -45, TLT_DFL_LMAX:  45,
  TLT_DFR_ZERO:  1500, TLT_DFR_DIR: -1, TLT_DFR_LMIN: -45, TLT_DFR_LMAX:  45,
  TLT_TL1_ZERO:  1500, TLT_TL1_DIR:  0, TLT_TL1_LMIN: -45, TLT_TL1_LMAX: 135,
  TLT_TR1_ZERO:  1500, TLT_TR1_DIR:  0, TLT_TR1_LMIN: -45, TLT_TR1_LMAX: 135,
  TLT_RDL_ZERO:  1500, TLT_RDL_DIR:  0, TLT_RDL_LMIN: -45, TLT_RDL_LMAX:  90,
  TLT_RDR_ZERO:  1500, TLT_RDR_DIR:  0, TLT_RDR_LMIN: -45, TLT_RDR_LMAX:  90,
  TLT_SGRP_ZERO: 1500, TLT_SGRP_DIR: 0, TLT_SGRP_LMIN:-45, TLT_SGRP_LMAX:  45,
  // PRV × 7 — Tuner 实时预览覆盖 abs°. -1=不覆盖走默认 45°. 拖滑杆推送, lua 主循环读
  TLT_DFL_PRV:  -1, TLT_DFR_PRV:  -1,
  TLT_TL1_PRV:  -1, TLT_TR1_PRV:  -1,
  TLT_RDL_PRV:  -1, TLT_RDR_PRV:  -1,
  TLT_SGRP_PRV: -1,
  // v9 P2 三档倾转 abs° (7 路 × 3 档 = 21)
  TLT_DFL_G1:  75, TLT_DFL_G2:  15, TLT_DFL_G3:  45,
  TLT_DFR_G1:  75, TLT_DFR_G2:  15, TLT_DFR_G3:  45,
  TLT_TL1_G1:  90, TLT_TL1_G2:  90, TLT_TL1_G3:  90,
  TLT_TR1_G1:  90, TLT_TR1_G2:  90, TLT_TR1_G3:  90,
  TLT_RDL_G1:  90, TLT_RDL_G2: 120, TLT_RDL_G3:  15,
  TLT_RDR_G1:  90, TLT_RDR_G2: 120, TLT_RDR_G3:  15,
  TLT_SGRP_G1: 75, TLT_SGRP_G2: 30, TLT_SGRP_G3: 70,
  // v9 P2 平滑速率
  TLT_RATE: 30.0,
};

export const PARAM_PREFIXES = ['MSK', 'TLT'] as const;

// 拉取/推送时跳过的参数 (TLT_*_PRV 是 transient 预览, 不参与 SAVE/LOAD .parm)
export const SYNC_SKIP_RE = /^TLT_.*_PRV$/;

// ArduPilot PARAM_VALUE 是 float32 → JS double 转换会出 4.000000095... 之类浮点噪声.
// 按参数 step 量化 + toFixed 截位, 把 noise 砍掉.
export function quantize(key: string, value: number): number {
  if (!Number.isFinite(value)) return value;
  const step = paramRange(key).step ?? 0.01;
  if (step <= 0) return value;
  const decimals = Math.max(0, Math.min(8, -Math.floor(Math.log10(step) - 1e-9)));
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

export const PARAM_RANGES: Record<string, { min?: number; max?: number; step?: number }> = {
  TLT_CPL_SDF_K:   { min: 0, max: 1, step: 0.05 },
  TLT_CPL_EN:      { min: 0, max: 1, step: 1 },
  TLT_PWM_PER_DEG: { min: 1, max: 30, step: 0.01 },
};

export function paramRange(key: string) {
  const r = PARAM_RANGES[key];
  if (r) return r;
  if (/^MSK_K(S|DF|T|RD)(_G[123])?$/.test(key)) return { min: 0, max: 1, step: 0.01 };
  if (/^MSK_V_TGT$/.test(key))  return { min: 1, max: 30, step: 0.1 };
  if (/^MSK_V_PI_[PID]$/.test(key)) return { min: 0, max: 1, step: 0.01 };
  if (/^MSK_FB_EN$/.test(key))     return { min: 0, max: 1, step: 1 };
  if (/^MSK_FB_[PR]_SC$/.test(key)) return { min: 0, max: 30, step: 0.5 };
  if (/^MSK_FB_V_SC$/.test(key))    return { min: 0, max: 30, step: 0.5 };
  if (/^MSK_TRIM_RATE$/.test(key))  return { min: 0, max: 30, step: 0.5 };
  if (/^MSK_KT_LIM$/.test(key))     return { min: 0.5, max: 1.0, step: 0.01 };
  if (/^MSK_L2_(SGRP|RD)_RT$/.test(key)) return { min: 0.5, max: 30, step: 0.5 };
  if (/^MSK_K_DRFT_RT$/.test(key))  return { min: 0, max: 0.1, step: 0.001 };
  if (/^MSK_BPCH_G[123]$/.test(key)) return { min: 0, max: 20, step: 0.5 };
  if (/^TLT_.*_ZERO$/.test(key)) return { min: 500, max: 2500, step: 1 };
  if (/^TLT_.*_DIR$/.test(key))  return { min: -1, max: 1, step: 1 };  // 三态 -1/0/+1
  if (/^TLT_.*_LMIN$/.test(key)) return { min: -180, max: 0, step: 1 };
  if (/^TLT_.*_LMAX$/.test(key)) return { min: 0, max: 180, step: 1 };
  if (/^TLT_.*_PRV$/.test(key))  return { min: -1, max: 180, step: 1 };
  if (/^TLT_.*_G[123]$/.test(key)) return { min: 0, max: 180, step: 1 };
  if (/^TLT_RATE$/.test(key))      return { min: 5, max: 90, step: 1 };
  return { step: 0.01 };
}

// ═══ 参数中文说明 ═══
export const PARAM_LABELS: Record<string, string> = {
  MSK_KS:  'S 斜吹组 油门系数 (0..1)',
  MSK_KDF: 'DF 前下吹组 油门系数 (0..1)',
  MSK_KT:  'T 后推组 油门系数 (0..1)',
  MSK_KRD: 'RD 后斜吹组 油门系数 (0..1)',

  TLT_CPL_SDF_K:    'S→DF 软解耦补偿系数 (0..1)',
  TLT_CPL_EN:       'S→DF 软解耦总开关 (0=关 不补偿, 1=开 反向补偿默认)',
  TLT_PWM_PER_DEG:  '舵机角度→PWM 斜率 (μs/°), 90° 舵 ≈11.11',

  TLT_DFL_ZERO: 'DFL 中立 PWM (abs=45° 时输出)', TLT_DFL_DIR: 'DFL 方向 (+1/0/−1, 0=锁定永远 ZERO)',
  TLT_DFR_ZERO: 'DFR 中立 PWM',                  TLT_DFR_DIR: 'DFR 方向 (+1/0/−1)',
  TLT_TL1_ZERO: 'TL1 中立 PWM',                  TLT_TL1_DIR: 'TL1 方向 (+1/0/−1)',
  TLT_TR1_ZERO: 'TR1 中立 PWM',                  TLT_TR1_DIR: 'TR1 方向 (+1/0/−1)',
  TLT_RDL_ZERO: 'RDL 中立 PWM',                  TLT_RDL_DIR: 'RDL 方向 (+1/0/−1)',
  TLT_RDR_ZERO: 'RDR 中立 PWM',                  TLT_RDR_DIR: 'RDR 方向 (+1/0/−1)',
  TLT_SGRP_ZERO:'S 组中立 PWM',                  TLT_SGRP_DIR:'S 组方向 (+1/0/−1)',

  TLT_DFL_LMIN: 'DFL 软限位 offset 下界 (°)',   TLT_DFL_LMAX: 'DFL 软限位 offset 上界 (°)',
  TLT_DFR_LMIN: 'DFR 软限位 offset 下界',       TLT_DFR_LMAX: 'DFR 软限位 offset 上界',
  TLT_TL1_LMIN: 'TL1 软限位 offset 下界',       TLT_TL1_LMAX: 'TL1 软限位 offset 上界',
  TLT_TR1_LMIN: 'TR1 软限位 offset 下界',       TLT_TR1_LMAX: 'TR1 软限位 offset 上界',
  TLT_RDL_LMIN: 'RDL 软限位 offset 下界',       TLT_RDL_LMAX: 'RDL 软限位 offset 上界',
  TLT_RDR_LMIN: 'RDR 软限位 offset 下界',       TLT_RDR_LMAX: 'RDR 软限位 offset 上界',
  TLT_SGRP_LMIN:'S 组软限位 offset 下界',       TLT_SGRP_LMAX:'S 组软限位 offset 上界',

  TLT_DFL_PRV:  'DFL 实时预览 abs° (−1=不覆盖)', TLT_DFR_PRV:  'DFR 预览覆盖',
  TLT_TL1_PRV:  'TL1 预览覆盖',                   TLT_TR1_PRV:  'TR1 预览覆盖',
  TLT_RDL_PRV:  'RDL 预览覆盖',                   TLT_RDR_PRV:  'RDR 预览覆盖',
  TLT_SGRP_PRV: 'S 组预览覆盖',
};

export function paramLabel(key: string): string | undefined {
  return PARAM_LABELS[key];
}
