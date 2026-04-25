// 默认参数. 和 scripts-plane/mixer.lua / tilt_driver.lua / guard.lua / preflight.lua 对齐.
import type { ParamSet } from './types';

export const DEFAULT_PARAMS: ParamSet = {
  // ═══ MSK_ (mixer, key=81) ═══
  MSK_V1: 4.0,  MSK_V2: 8.0,  MSK_V3: 14.0,  MSK_V_MAX: 20.0,
  MSK_KS0:  0.70, MSK_KS1:  0.70, MSK_KS2:  0.55, MSK_KS3:  0.10, MSK_KS4:  0.10,
  MSK_KDF0: 0.80, MSK_KDF1: 0.90, MSK_KDF2: 0.65, MSK_KDF3: 0.08, MSK_KDF4: 0.08,
  MSK_KT0:  0.40, MSK_KT1:  0.40, MSK_KT2:  0.85, MSK_KT3:  0.65, MSK_KT4:  0.65,
  MSK_KRD0: 0.65, MSK_KRD1: 0.70, MSK_KRD2: 0.85, MSK_KRD3: 0.25, MSK_KRD4: 0.25,

  // ═══ TLT_ (tilt_driver, key=82) ═══
  TLT_CPL_SDF_K:   0.30,
  TLT_PWM_PER_DEG: 11.11,   // 90° 舵机 @ 1000-2000μs 标准值
  TLT_T1_DEG:      15.0,
  TLT_DFL_ZERO:  1500, TLT_DFL_DIR:  1, TLT_DFL_LMIN: -90, TLT_DFL_LMAX: 90,
  TLT_DFR_ZERO:  1500, TLT_DFR_DIR: -1, TLT_DFR_LMIN: -90, TLT_DFR_LMAX: 90,
  TLT_TL1_ZERO:  1500, TLT_TL1_DIR:  1, TLT_TL1_LMIN: -15, TLT_TL1_LMAX: 15,
  TLT_TR1_ZERO:  1500, TLT_TR1_DIR: -1, TLT_TR1_LMIN: -15, TLT_TR1_LMAX: 15,
  TLT_RDL_ZERO:  1500, TLT_RDL_DIR:  1, TLT_RDL_LMIN:   0, TLT_RDL_LMAX: 30,
  TLT_RDR_ZERO:  1500, TLT_RDR_DIR: -1, TLT_RDR_LMIN:   0, TLT_RDR_LMAX: 30,
  TLT_SGRP_ZERO: 1500, TLT_SGRP_DIR: 1, TLT_SGRP_LMIN:  0, TLT_SGRP_LMAX: 90,

  // ═══ MGEO_ (mixer geometry, key=83) — 12 motor × pitch/roll/yaw = 36 ═══
  MGEO_SL1_P: 0.5, MGEO_SL1_R:  0.3, MGEO_SL1_Y: 0,
  MGEO_SL2_P: 0.5, MGEO_SL2_R:  0.3, MGEO_SL2_Y: 0,
  MGEO_SR1_P: 0.5, MGEO_SR1_R: -0.3, MGEO_SR1_Y: 0,
  MGEO_SR2_P: 0.5, MGEO_SR2_R: -0.3, MGEO_SR2_Y: 0,
  MGEO_DFL_P: 0.5, MGEO_DFL_R: 0,    MGEO_DFL_Y: 0,
  MGEO_DFR_P: 0.5, MGEO_DFR_R: 0,    MGEO_DFR_Y: 0,
  MGEO_TL1_P: 0,   MGEO_TL1_R: 0,    MGEO_TL1_Y:  0.5,
  MGEO_TL2_P: 0,   MGEO_TL2_R: 0,    MGEO_TL2_Y:  0.36,
  MGEO_TR1_P: 0,   MGEO_TR1_R: 0,    MGEO_TR1_Y: -0.5,
  MGEO_TR2_P: 0,   MGEO_TR2_R: 0,    MGEO_TR2_Y: -0.36,
  MGEO_RDL_P: 0,   MGEO_RDL_R: 0,    MGEO_RDL_Y:  0.25,
  MGEO_RDR_P: 0,   MGEO_RDR_R: 0,    MGEO_RDR_Y: -0.25,

  // ═══ TLTC_ (tilt curve, 7 路 × 5 控制点 K, V 共用 MSK_V*) = 35 ═══
  // 用户视角 (0 = 中立). 5 控制点对应 V0=0, V1, V2, V3, V_MAX (与 K 曲线共享 V).
  // 与 phases.lua 默认对齐 (STATIONARY/TAXI/CUSHION/GROUND_EFFECT/V_MAX).
  TLTC_DFL_K0: 0,  TLTC_DFL_K1: 0,  TLTC_DFL_K2: 10, TLTC_DFL_K3: 5,  TLTC_DFL_K4: 0,
  TLTC_DFR_K0: 0,  TLTC_DFR_K1: 0,  TLTC_DFR_K2: 10, TLTC_DFR_K3: 5,  TLTC_DFR_K4: 0,
  TLTC_TL1_K0: 0,  TLTC_TL1_K1: 0,  TLTC_TL1_K2: 0,  TLTC_TL1_K3: 0,  TLTC_TL1_K4: 0,
  TLTC_TR1_K0: 0,  TLTC_TR1_K1: 0,  TLTC_TR1_K2: 0,  TLTC_TR1_K3: 0,  TLTC_TR1_K4: 0,
  TLTC_RDL_K0: 0,  TLTC_RDL_K1: 30, TLTC_RDL_K2: 15, TLTC_RDL_K3: 0,  TLTC_RDL_K4: 0,
  TLTC_RDR_K0: 0,  TLTC_RDR_K1: 30, TLTC_RDR_K2: 15, TLTC_RDR_K3: 0,  TLTC_RDR_K4: 0,
  TLTC_SGRP_K0: 0, TLTC_SGRP_K1: 45, TLTC_SGRP_K2: 15, TLTC_SGRP_K3: 0, TLTC_SGRP_K4: 0,

  // ═══ 布局位置 (用户可拖拽保存, 覆盖 actuators.ts 默认) ═══
  // 约定 (Y 取反后匹配用户偏好): -Y 前 (wide wings 在下), +Y 后 (chassis 在上)
  LAY_SL1_X: -0.20, LAY_SL1_Y: -0.79, LAY_SL2_X: -0.11, LAY_SL2_Y: -0.79,
  LAY_SR1_X:  0.11, LAY_SR1_Y: -0.79, LAY_SR2_X:  0.20, LAY_SR2_Y: -0.79,
  LAY_DFL_X: -0.29, LAY_DFL_Y: -0.80, LAY_DFR_X:  0.29, LAY_DFR_Y: -0.80,
  LAY_TL1_X: -0.52, LAY_TL1_Y: -0.28, LAY_TL2_X: -0.42, LAY_TL2_Y: -0.05,
  LAY_TR1_X:  0.52, LAY_TR1_Y: -0.28, LAY_TR2_X:  0.42, LAY_TR2_Y: -0.05,
  LAY_RDL_X: -0.15, LAY_RDL_Y:  0.50, LAY_RDR_X:  0.15, LAY_RDR_Y:  0.50,

  // ═══ GRD_ (guard, key=84) ═══
  GRD_TRIM_RATE: 0.5,
  GRD_PIT_WARN:  20.0,
  GRD_ROL_WARN:  25.0,

  // ═══ PRE_ (preflight, key=85) ═══
  PRE_CH:     8,
  PRE_PWM:    1100,
  PRE_STOP:   1000,
  PRE_GRP_MS: 2000,
  PRE_SWING:  10,
};

export const PARAM_PREFIXES = ['MSK', 'TLT', 'GRD', 'PRE', 'LAY', 'MGEO', 'TLTC'] as const;

// 参数取值范围提示 (用于表单校验)
export const PARAM_RANGES: Record<string, { min?: number; max?: number; step?: number }> = {
  MSK_V1: { min: 0.1, max: 20, step: 0.1 },
  MSK_V2: { min: 0.1, max: 20, step: 0.1 },
  MSK_V3: { min: 0.1, max: 30, step: 0.1 },
  MSK_V_MAX: { min: 1, max: 50, step: 0.5 },
  TLT_CPL_SDF_K: { min: 0, max: 1, step: 0.05 },
  TLT_PWM_PER_DEG: { min: 1, max: 30, step: 0.01 },
  PRE_PWM: { min: 900, max: 1500, step: 10 },
  PRE_STOP: { min: 800, max: 1200, step: 10 },
  PRE_GRP_MS: { min: 500, max: 10000, step: 100 },
  PRE_SWING: { min: 1, max: 30, step: 1 },
};

// K / V 参数默认 range
export function paramRange(key: string) {
  const r = PARAM_RANGES[key];
  if (r) return r;
  if (/^MSK_K/.test(key)) return { min: 0, max: 1, step: 0.01 };
  if (/^TLT_.*_ZERO$/.test(key)) return { min: 500, max: 2500, step: 1 };
  if (/^TLT_.*_DIR$/.test(key)) return { min: -1, max: 1, step: 2 };
  if (/^TLT_.*_LMIN$/.test(key)) return { min: -180, max: 180, step: 1 };
  if (/^TLT_.*_LMAX$/.test(key)) return { min: -180, max: 180, step: 1 };
  if (/^MGEO_.*_[PRY]$/.test(key)) return { min: -1, max: 1, step: 0.05 };
  if (/^TLTC_.*_K[0-4]$/.test(key)) return { min: -180, max: 180, step: 1 };
  return { step: 0.01 };
}
