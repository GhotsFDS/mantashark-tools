// 默认参数. 镜像 scripts/main.lua + scripts/modules/{mixer,tilt_driver,servo_orchestrator,preflight}.lua 注册.
// v9 P6 单一 servo 出口架构 (2026-05-12 update).
//   撤: TLT_*_G1/G2/G3 (单一 GOAL 替代) / TLT_RATE / MSK_TLT_R_* / MSK_TLT_DRFT_* / PRE_CH/PWM/STOP
//   加: TLT_*_GOAL (单一) / TLT_*_BW (per-servo 带宽倍率) / MSK2_PO_NORM
import type { ParamSet } from './types';

export const DEFAULT_PARAMS: ParamSet = {
  // ═══ MSK_ (key=81) — K 表 G1/G2/G3 三档 (用户实测预设 2026-04-29) ═══
  MSK_KS_G1:  0.50, MSK_KDF_G1: 0.30, MSK_KT_G1: 0.50, MSK_KRD_G1: 0.30,
  MSK_KS_G2:  0.50, MSK_KDF_G2: 0.50, MSK_KT_G2: 0.50, MSK_KRD_G2: 0.50,
  MSK_KS_G3:  0.20, MSK_KDF_G3: 0.20, MSK_KT_G3: 0.85, MSK_KRD_G3: 0.20,
  // G3 PID 速度环
  MSK_V_TGT:  9.0,   // G3 目标速度 m/s
  MSK_V_PI_P: 0.05,
  MSK_V_PI_I: 0.02,
  MSK_V_PI_D: 0.0,
  // ATC fb 系数 (v9 P6.2 动态 SC 后, 这些不再决定 swing 比例, 但仍是兼容字段)
  MSK_FB_EN:   1.0,
  MSK_FB_P_SC: 150.0,    // P6: 实飞预设值 (boot 时强制 set)
  MSK_FB_R_SC:  50.0,
  MSK_FB_P_SC_DF: 225.0,
  MSK_FB_V_SC: 8.0,      // RD V 反馈 (老逻辑, P6 仍兼容)
  MSK_FB_R_DEAD: 0.0,    // P5j 撤滤波后默认 0
  MSK_FB_P_DEAD: 0.0,
  // base_pitch ramp (P5k 后默认 99°/s ≈ 阶跃)
  MSK_TRIM_RATE: 99.0,
  // 三层级加速 (Layer 1 KT correction / Layer 2 STATUSTEXT 警告)
  MSK_KT_LIM:     1.0,
  MSK_L2_SGRP_RT: 5.0,
  MSK_L2_RD_RT:   3.0,
  MSK_K_DRFT_RT:  0.01,
  // 三档 base_pitch (Q_TRIM_PITCH 切档目标)
  MSK_BPCH_G1: 5,     // G1 慢滑
  MSK_BPCH_G2: 11,    // G2 抬头建气垫
  MSK_BPCH_G3: 8,     // G3 巡航
  // thr_cap 限幅
  MSK_THR_CHECK: 0.30,
  MSK_THR_TEST:  0.33,
  // vmix 速度连续混合
  MSK_VMIX_EN:  1,
  MSK_VMIX_TAU: 0.5,
  MSK_VMIX_LO:  3.0,
  MSK_VMIX_MID: 6.5,
  MSK_VMIX_HI:  10.0,
  // GROUP_BOOST: G3 PID 速度 demand 在 4 组分配权重
  MSK_BST_KS:  0.5,
  MSK_BST_KDF: 0.0,
  MSK_BST_KT:  1.0,
  MSK_BST_KRD: 0.5,
  // G3 V_TGT 控制 (ch10 加速度命令 + ch3 lua override 锁满)
  MSK_V_MIN:        5.0,
  MSK_V_MAX:       14.0,
  MSK_V_DRIVE_MIN:  9.0,
  MSK_V_ACC_MAX:    2.0,
  MSK_V_DEADZONE:  50,
  MSK_P_EMRG_DEG:  1.5,
  // Layer 1↔2 滞回 + anti-windup + G2→G3 ramp + drift time
  MSK_BST_SAT_HI:  0.95,
  MSK_BST_SAT_LO:  0.85,
  MSK_V_INT_LIM:   10.0,
  MSK_G3_RAMP_MS:  0,        // P5k 撤 ramp, 阶跃
  MSK_DRFT_TIME:   5.0,

  // ═══ MSK2_ (key=84) — 副表 ═══
  MSK2_DRFT_DZ:    0.10,
  MSK2_DRFT_KS_R:  1.0,
  MSK2_DRFT_KDF_R: 0.5,
  MSK2_DRFT_KT_R:  0.3,
  MSK2_DRFT_KRD_R: 0.0,
  MSK2_KRAMP_MS:   1000,
  MSK2_P5_KS_RT:   0.05,     // P5 KS K 升力守恒 drift 学率
  MSK2_PO_NORM:    0.5,      // v9 P6.2 ATC po 归一化基准

  // ═══ TLT_ (key=82) — tilt servo ═══
  TLT_CPL_SDF_K:   1.0,      // v9 P6: 物理刚体真值 (旧 0.3 是欠补偿)
  TLT_CPL_EN:      1,
  TLT_PWM_PER_DEG: 11.11,
  // 校准 ZERO/DIR/LMIN/LMAX × 7 (实测以飞控 EEPROM 为准, 这里只是 fallback)
  TLT_DFL_ZERO:  1483, TLT_DFL_DIR:  1, TLT_DFL_LMIN: -45, TLT_DFL_LMAX:  35,
  TLT_DFR_ZERO:  1719, TLT_DFR_DIR: -1, TLT_DFR_LMIN: -45, TLT_DFR_LMAX:  35,
  TLT_TL1_ZERO:  1411, TLT_TL1_DIR: -1, TLT_TL1_LMIN:  45, TLT_TL1_LMAX:  65,
  TLT_TR1_ZERO:  1694, TLT_TR1_DIR: -1, TLT_TR1_LMIN:  45, TLT_TR1_LMAX:  65,
  TLT_RDL_ZERO:  1172, TLT_RDL_DIR: -1, TLT_RDL_LMIN:   5, TLT_RDL_LMAX:  45,
  TLT_RDR_ZERO:  1224, TLT_RDR_DIR: -1, TLT_RDR_LMIN:   5, TLT_RDR_LMAX:  45,
  TLT_SGRP_ZERO: 1622, TLT_SGRP_DIR: 1, TLT_SGRP_LMIN:-45, TLT_SGRP_LMAX:  30,
  // PRV (Tuner 实时预览, ≥0=覆盖, -1=禁用)
  TLT_DFL_PRV:  -1, TLT_DFR_PRV:  -1,
  TLT_TL1_PRV:  -1, TLT_TR1_PRV:  -1,
  TLT_RDL_PRV:  -1, TLT_RDR_PRV:  -1,
  TLT_SGRP_PRV: -1,
  // v9 P5l 撤 G1/G2/G3 三档, 单一 GOAL
  TLT_DFL_GOAL:  40,    // 默认 40° (双向 swing 中点), 当主升力时改 0
  TLT_DFR_GOAL:  40,
  TLT_TL1_GOAL:  90,
  TLT_TR1_GOAL:  90,
  TLT_RDL_GOAL:  90,
  TLT_RDR_GOAL:  90,
  TLT_SGRP_GOAL: 50,
  // v9 P6.3 per-servo 带宽倍率 (大=快). DF 4.0=4x SGRP
  TLT_DFL_BW:  4.0,
  TLT_DFR_BW:  4.0,
  TLT_TL1_BW:  1.0,
  TLT_TR1_BW:  1.0,
  TLT_RDL_BW:  1.0,
  TLT_RDR_BW:  1.0,
  TLT_SGRP_BW: 1.0,

  // ═══ PRE_ (preflight, key=85) — v9 P6 简化 ═══
  PRE_GRP_MS: 2000,  // 每 sweep sub-step ms
  PRE_SWING:  15,    // tilt 扫描 ±° 幅度

  // ═══ WIGA_ (key=86) — v9 P7 WIG_AUTO phase machine + 2 mode + 2 strategy ═══
  // A. Mode 选择 (armed 边沿 latch)
  WIGA_CRUISE_MODE: 0,    // 0=FRONT_VENT (前出气), 1=REAR_VENT (后出气)
  WIGA_TRANS_STRAT: 0,    // 0=STEADY (慢推), 1=BURST (速推)
  WIGA_FAC_SCL:     0,    // 0=不动 motor factor, 1=按 mode 改 KS/KDF 权重
  WIGA_V_CH10_EN:   0,    // 0=GCS 静态, 1=ch10 动态 PWM 映射
  WIGA_PREFLT_REQ:  1,    // 0=GCS 跳过 preflight, 1=必须
  // B. V 控制
  WIGA_V_TGT:       7.0,  // cruise 目标 V (LOG65 实证 baseline)
  WIGA_V_OK_W:      0.7,  // V tolerance
  // C. 姿态阈值
  WIGA_PITCH_OK_W:  2.0,
  WIGA_ROLL_OK_W:   5.0,
  WIGA_KTC_OK_W:    2.0,
  WIGA_P_ENV_W:     15.0,
  WIGA_P_RECV_W:    30.0,
  WIGA_R_RECV_W:    40.0,
  WIGA_RATE_TH:     30.0,
  WIGA_RATE_MMS:    300,
  // D. FLOAT_TAXI
  WIGA_TAXI_DUR:    10000,
  WIGA_TAXI_CAP:    0.30,
  // E. TRANSITION 共享
  WIGA_TX_TO_MS:    8000,   // timeout
  WIGA_TX_KT_INI:   0.3,
  WIGA_TX_KT_MS:    1500,
  WIGA_TX_V_PI:     5.0,
  WIGA_TX_TRIM_MS:  2000,
  WIGA_TX_ENT_MS:   3000,
  // F. Strategy over-pitch
  WIGA_TX_BTRIM:    12,
  WIGA_TX_STRIM:    10,
  // G. STEADY 判据
  WIGA_TX_S_AMP:    3.0,
  WIGA_TX_S_MS:     1000,
  // H. BURST 判据
  WIGA_TX_B_CYC:    3,
  // I. CRUISE FV
  WIGA_FV_KS_GOAL:  35,
  WIGA_FV_KS_LMIN:  0,
  WIGA_FV_KS_LMAX:  70,
  WIGA_FV_TRIM:     10,
  // J. CRUISE RV
  WIGA_RV_KS_GOAL:  55,
  WIGA_RV_KS_LMIN:  40,
  WIGA_RV_KS_LMAX:  70,
  WIGA_RV_TRIM:     8,
  // K. DF 共用
  WIGA_DF_GOAL:     40,
  WIGA_DF_LMIN:     0,
  WIGA_DF_LMAX:     80,
  // L. Yaw P+D
  WIGA_HDG_KP:      45,
  WIGA_HDG_KD:      10,
  WIGA_TRN_HDG:     180,
  // M. Profile
  WIGA_MTX_DUR:     30000,
  WIGA_TRN_DUR:     15000,
  // N. DECEL
  WIGA_DEC_A_MS:    3000,
  WIGA_DEC_B_MS:    3000,
  WIGA_DEC_C_MS:    2000,
  WIGA_DEC_V_A:     4.0,
  WIGA_DEC_V_B:     2.0,
  // O. SIM 虚拟传感器 (SITL phase chain 测试用)
  WIGA_SIM_EN:      0,
  WIGA_SIM_V:       0,
  WIGA_SIM_PITCH:   0,
  WIGA_SIM_ROLL:    0,
  WIGA_SIM_V_RAMP:  0,
};

export const PARAM_PREFIXES = ['MSK', 'TLT', 'PRE', 'WIGA'] as const;

// ═══ 两套预设 (Params tab 一键切换) ═══
// 仅切 ATC PID 增益 + tilt ATC scale + ANGLE_MAX
export const PRESET_FLIGHT: Record<string, number> = {
  Q_A_ANGLE_MAX: 15,    // 实飞 ±15° (含 stick ±5° 微调)
  Q_A_ANG_RLL_P: 4.5,
  Q_A_ANG_PIT_P: 4.5,
  Q_A_RAT_RLL_P: 0.135,
  Q_A_RAT_PIT_P: 0.135,
  MSK_FB_R_SC:    50,   // P6 实飞预设值
  MSK_FB_P_SC:   150,
  MSK_FB_P_SC_DF: 225,
  MSK_THR_CHECK: 0.30,
  MSK_THR_TEST:  0.33,
};

export const PRESET_BENCH: Record<string, number> = {
  Q_A_ANGLE_MAX: 30,
  Q_A_ANG_RLL_P: 8.0,
  Q_A_ANG_PIT_P: 8.0,
  Q_A_RAT_RLL_P: 0.40,
  Q_A_RAT_PIT_P: 0.40,
  MSK_FB_R_SC:    25,
  MSK_FB_P_SC:   150,    // P5b 高 scale (台架反馈方向明显)
  MSK_FB_P_SC_DF: 225,
  MSK_THR_CHECK: 0.30,
  MSK_THR_TEST:  0.33,
};

// 拉取/推送时跳过的参数:
//   TLT_*_PRV (7) — 实时预览, 跨会话不持久化
export const SYNC_SKIP_RE = /^TLT_.*_PRV$/;

// param range + label + quantize helpers (Params/FlightProfile tab 用)
export function paramRange(key: string): { min: number; max: number; step: number } {
  if (/^MSK_K[SDT]?[FRT]?_G[123]$/.test(key)) return { min: 0, max: 1, step: 0.01 };
  if (key.startsWith('MSK_BPCH_'))   return { min: -10, max: 20, step: 0.5 };
  if (key.startsWith('MSK_V_PI_'))   return { min: 0, max: 1, step: 0.005 };
  if (key === 'MSK_V_TGT')            return { min: 0, max: 20, step: 0.5 };
  if (key === 'MSK_V_MIN' || key === 'MSK_V_MAX' || key === 'MSK_V_DRIVE_MIN')
                                       return { min: 0, max: 25, step: 0.5 };
  if (key === 'MSK_V_ACC_MAX')        return { min: 0, max: 10, step: 0.5 };
  if (key === 'MSK_V_DEADZONE')       return { min: 0, max: 200, step: 5 };
  if (key.startsWith('MSK_FB_'))      return { min: 0, max: 500, step: 1 };
  if (key.startsWith('MSK_BST_'))     return { min: 0, max: 1, step: 0.05 };
  if (key === 'MSK2_PO_NORM')         return { min: 0.1, max: 2.0, step: 0.05 };
  if (key.endsWith('_BW'))            return { min: 0.1, max: 10.0, step: 0.1 };
  if (key === 'TLT_CPL_SDF_K')        return { min: 0, max: 2, step: 0.05 };
  if (key === 'TLT_CPL_EN')           return { min: 0, max: 1, step: 1 };
  if (key.endsWith('_ZERO'))          return { min: 500, max: 2500, step: 1 };
  if (key.endsWith('_DIR'))           return { min: -1, max: 1, step: 1 };
  if (key.endsWith('_LMIN') || key.endsWith('_LMAX')) return { min: -90, max: 90, step: 1 };
  if (key.endsWith('_PRV'))           return { min: -1, max: 180, step: 1 };
  if (key.endsWith('_GOAL'))          return { min: 0, max: 180, step: 1 };
  if (key === 'TLT_PWM_PER_DEG')      return { min: 1, max: 30, step: 0.1 };
  if (key.startsWith('PRE_'))         return { min: 0, max: 5000, step: 50 };
  if (/_RT$|RATE/i.test(key))         return { min: 0, max: 200, step: 0.5 };
  if (/_MS$/i.test(key))              return { min: 0, max: 10000, step: 100 };
  if (key === 'MSK_KT_LIM' || key === 'MSK_BST_SAT_HI' || key === 'MSK_BST_SAT_LO')
                                       return { min: 0, max: 1, step: 0.01 };
  if (key === 'MSK_VMIX_EN' || key === 'MSK_FB_EN')
                                       return { min: 0, max: 1, step: 1 };
  if (key.startsWith('MSK_VMIX_'))    return { min: 0, max: 20, step: 0.1 };
  if (key.startsWith('MSK_THR_'))     return { min: 0, max: 1, step: 0.01 };
  if (key === 'MSK_P_EMRG_DEG')       return { min: 0, max: 10, step: 0.1 };
  if (key === 'MSK_V_INT_LIM')        return { min: 0, max: 50, step: 0.5 };
  if (key === 'MSK_DRFT_TIME')        return { min: 0, max: 30, step: 0.5 };
  if (key.startsWith('MSK2_DRFT_'))   return { min: 0, max: 2, step: 0.05 };
  // ═══ WIGA_ ranges (v9 P7) ═══
  if (key === 'WIGA_CRUISE_MODE')     return { min: 0, max: 1, step: 1 };
  if (key === 'WIGA_TRANS_STRAT')     return { min: 0, max: 1, step: 1 };
  if (key === 'WIGA_FAC_SCL' || key === 'WIGA_V_CH10_EN' ||
      key === 'WIGA_PREFLT_REQ' || key === 'WIGA_SIM_EN')
                                       return { min: 0, max: 1, step: 1 };
  if (key === 'WIGA_V_TGT' || key === 'WIGA_SIM_V' || key === 'WIGA_TX_V_PI' ||
      key === 'WIGA_DEC_V_A' || key === 'WIGA_DEC_V_B' || key === 'WIGA_V_OK_W')
                                       return { min: 0, max: 15, step: 0.1 };
  if (key === 'WIGA_SIM_V_RAMP')      return { min: -5, max: 10, step: 0.1 };
  if (key === 'WIGA_TRN_HDG')         return { min: -180, max: 180, step: 1 };
  if (key === 'WIGA_HDG_KP' || key === 'WIGA_HDG_KD')
                                       return { min: 1, max: 180, step: 1 };
  if (/^WIGA_(FV|RV)_KS_(GOAL|LMIN|LMAX)$/.test(key) ||
      /^WIGA_DF_(GOAL|LMIN|LMAX)$/.test(key))
                                       return { min: 0, max: 90, step: 1 };
  if (key === 'WIGA_FV_TRIM' || key === 'WIGA_RV_TRIM' ||
      key === 'WIGA_TX_BTRIM' || key === 'WIGA_TX_STRIM')
                                       return { min: -10, max: 25, step: 0.5 };
  if (/^WIGA_(PITCH|ROLL|P_ENV|P_RECV|R_RECV|SIM_PITCH|SIM_ROLL|KTC|TX_S_AMP|RATE_TH)/.test(key))
                                       return { min: 0, max: 90, step: 0.5 };
  if (key === 'WIGA_TAXI_CAP' || key === 'WIGA_TX_KT_INI')
                                       return { min: 0, max: 1, step: 0.05 };
  if (key === 'WIGA_TX_B_CYC')        return { min: 1, max: 10, step: 1 };
  if (key.startsWith('WIGA_'))        return { min: 0, max: 60000, step: 100 };  // ms fallback
  return { min: -1000, max: 1000, step: 1 };
}

export function paramLabel(key: string): string {
  // 简化: 直接返回 key, UI 已用 monospace 字体
  return key;
}

export function quantize(key: string, value: number): number {
  const r = paramRange(key);
  if (!isFinite(value)) return 0;
  const v = Math.max(r.min, Math.min(r.max, value));
  const q = Math.round(v / r.step) * r.step;
  return Math.round(q * 1e6) / 1e6;  // 防浮点尾巴
}
