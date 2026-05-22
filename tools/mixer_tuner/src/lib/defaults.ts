// 默认参数. 镜像 scripts/main.lua + scripts/modules/{mixer,tilt_driver,wig_*}.lua 注册.
// v9 P7.9.4 (2026-05-17 update) — 撤 ramp/BST/Layer/drift/WIGK 整表
//   撤: MSK_BST_* / MSK_KT_LIM / MSK_L2_* / MSK_K_DRFT_RT / MSK_DRFT_TIME (Layer/drift)
//        MSK_BST_SAT_HI/LO / MSK_G3_RAMP_MS / MSK_P_EMRG_DEG (老 V_PI)
//        MSK_V_TGT (用 WIGA_V_TGT) / MSK_V_DRIVE_MIN / MSK_V_ACC_MAX / MSK_V_DEADZONE
//        MSK_BPCH_G3 (CRUISE 读 G2)
//        MSK2_DRFT_* / KRAMP_MS / P5_KS_RT (drift)
//        WIGA_FAC_SCL / CRUISE_MODE / TRANS_STRAT (mode/strat)
//        WIGA_V_OK_W / PITCH_OK_W / ROLL_OK_W / KTC_OK_W (容忍, 合并 L1/L2)
//        WIGA_P_ENV_W / P_RECV_W / R_RECV_W / RATE_TH (改 L1_*/L2_BODY 命名)
//        WIGA_TX_KT_INI/MS / V_PI / TRIM_MS / ENT_MS / V_RAT / BTRIM/STRIM/S_AMP/S_MS/B_CYC (旧 TRANS_A/B/C)
//        WIGA_FV_* / RV_* / DF_GOAL/LMIN/LMAX / TRN_HDG / MTX_DUR / TRN_DUR (cruise 双模式 + profile)
//        WIGA_DEC_A_MS/B_MS/C_MS/V_A/V_B (3 段 DECEL, 合并单一 DECEL_MS)
//        WIGA_SIM_V_RAMP/P_RAMP/R_RAMP / WIGA_TAXI_CAP (simulation)
//        整套 WIGK_* (K_base 内置 wig_control)
//   加: WIGA_L1_BODY/RATE/MMS/CH3/R_PWM/HOLD/REC_W/REC_MS (Layer 1 软减油)
//        WIGA_L2_BODY (Layer 2 硬截)
//        WIGA_TX_DUR/V_OK/TO_MS (新 TRANSITION phase)
//        WIGA_CMAX_MS (限时巡航)
//        WIGA_DECEL_MS/V_OFF (单一 DECEL)
//        WIGA_HDG_KI/I_LIM/HOLD_EN (yaw P+I+D, HOLD_EN 改 WIGA_ 命名)
import type { ParamSet } from './types';

export const DEFAULT_PARAMS: ParamSet = {
  // ═══ MSK_ (key=81) — V_PI 速度环 + base_pitch ═══
  MSK_V_PI_P: 0.3,            // P7.9.20: 0.05→0.3 (LOG 223 0.1 太软 vc 只到 -0.295)
  MSK_V_PI_I: 0.02,
  MSK_V_PI_D: 0.0,
  MSK_V_INT_LIM: 5.0,
  MSK_TRIM_RATE: 99.0,        // base_pitch ramp °/s (≈阶跃)
  MSK_BPCH_G1: 4,             // TAXI base_pitch (LOG 190 实测)
  MSK_BPCH_G2: 10,            // TRANS base_pitch (抬头建气垫)
  MSK_BPCH_G3: 5,             // P7.9.20: CRUISE base_pitch 独立 (RV 偏平, 设计 5°)
  // P7.9.21: pitch V-scaling gain schedule
  MSK_PSC_EN:    1,           // 0=off / 1=on (high V 缩 pitch_out)
  MSK_PSC_V_LO:  5,           // V≤LO 满权威 m/s
  MSK_PSC_V_HI: 12,           // V≥HI scale=MIN m/s
  MSK_PSC_MIN: 0.3,           // 高速保留比例 0-1
  MSK_PSC_EXP: 1.0,           // 曲线 0.5-3 (1=linear)
  // P7.9.27: V_PI per-group 速度权重 (EN=0 时 boost 同 KT/KS, EN=1 用 W_KT/W_KS)
  MSK_V_W_EN:    0,           // 0=off (= P7.9.19 行为) / 1=on
  MSK_V_W_KT:  1.0,           // KT 速度权重 0-2
  MSK_V_W_KS:  1.0,           // KS 速度权重 0-2
  MSK_V_MIN:  3.0,            // ch10 V_TGT 映射下限
  MSK_V_MAX: 10.0,            // ch10 V_TGT 映射上限

  // ═══ MSK2_ (key=84) — 副表 ═══
  MSK2_PO_NORM: 0.5,          // orchestrator ATC fb 归一化

  // ═══ TLT_ (key=82) — tilt servo 校准 ═══
  TLT_CPL_SDF_K:   1.0,
  TLT_CPL_EN:      1,
  TLT_PWM_PER_DEG: 11.11,
  TLT_DFL_ZERO:  1483, TLT_DFL_DIR:  1, TLT_DFL_LMIN: -45, TLT_DFL_LMAX:  35,
  TLT_DFR_ZERO:  1719, TLT_DFR_DIR: -1, TLT_DFR_LMIN: -45, TLT_DFR_LMAX:  35,
  TLT_TL1_ZERO:  1411, TLT_TL1_DIR: -1, TLT_TL1_LMIN:  45, TLT_TL1_LMAX:  65,
  TLT_TR1_ZERO:  1694, TLT_TR1_DIR: -1, TLT_TR1_LMIN:  45, TLT_TR1_LMAX:  65,
  TLT_RDL_ZERO:  1172, TLT_RDL_DIR: -1, TLT_RDL_LMIN:   5, TLT_RDL_LMAX:  45,
  TLT_RDR_ZERO:  1224, TLT_RDR_DIR: -1, TLT_RDR_LMIN:   5, TLT_RDR_LMAX:  45,
  TLT_SGRP_ZERO: 1622, TLT_SGRP_DIR: 1, TLT_SGRP_LMIN:-45, TLT_SGRP_LMAX:  30,
  TLT_DFL_PRV:  -1, TLT_DFR_PRV:  -1,
  TLT_TL1_PRV:  -1, TLT_TR1_PRV:  -1,
  TLT_RDL_PRV:  -1, TLT_RDR_PRV:  -1,
  TLT_SGRP_PRV: -1,
  TLT_DFL_GOAL:  40, TLT_DFR_GOAL:  40,
  TLT_TL1_GOAL:  90, TLT_TR1_GOAL:  90,
  TLT_RDL_GOAL:  90, TLT_RDR_GOAL:  90,
  TLT_SGRP_GOAL: 50,
  TLT_DFL_BW: 4.0, TLT_DFR_BW: 4.0,
  TLT_TL1_BW: 1.0, TLT_TR1_BW: 1.0,
  TLT_RDL_BW: 1.0, TLT_RDR_BW: 1.0,
  TLT_SGRP_BW: 1.0,

  // ═══ WIGA_ (key=86) — AUTO + 全局 abort + GTEST ═══
  // A. V 控制
  WIGA_V_TGT:       6.0,      // CRUISE V_PI 目标速度 (LOG 190 实测平衡 5-8)
  WIGA_V_CH10_EN:   0,
  // B. Preflight
  WIGA_PREFLT_REQ:  1,
  WIGA_PRE_SPEED:  10,
  // C. FLOAT_TAXI
  WIGA_TAXI_DUR:    3000,
  WIGA_TAXI_THR_T:  0.50,
  // D. DECEL (单一 phase, P7.9 合并旧 A/B/C)
  WIGA_DEC_K_RATE:  0.0625,    // K_KT 每秒下降 (P7.9.13 撤 DECEL_MS)
  WIGA_DEC_CH3_RT:  0.112,     // ch3 归一化 /s (×1000=PWM/s)
  WIGA_DECEL_V_OFF: 2.0,
  // E. Layer 1 (软减油救稳) — |body|>15° + rate + 持续 → ch3 平滑减 50%
  WIGA_L1_BODY:    15,
  WIGA_L1_RATE:    20,
  WIGA_L1_MMS:    100,
  WIGA_L1_CH3:   1500,
  WIGA_L1_R_PWM:  500,
  WIGA_L1_HOLD:  1500,
  WIGA_L1_REC_W:  10,
  WIGA_L1_REC_MS: 500,
  // F. Layer 2 (硬截 disarm) — |body|>20° 单帧 → ABORT
  WIGA_L2_BODY:    20,
  WIGA_RATE_MMS:  300,        // L2 disarm 前缓冲 ms
  // G. Yaw P+I+D (慢校正)
  WIGA_HDG_P:    0.0056,       // P 归一化 (per °, 0.0056=180° 满杆) P7.9.13
  WIGA_HDG_I:   0.000278,      // I 归一化 (per °·s)
  WIGA_HDG_D:    0.0333,       // D 归一化 (per °/s)
  WIGA_HDG_I_LIM: 0.3,         // I norm 上限
  WIGA_HDG_HOLD_EN: 1,        // 0 = pilot 手控 ch4
  // H. TRANSITION (新跃迁 phase)
  WIGA_TX_K_RATE:   0.25,      // TRANSITION K frac /s (P7.9.13 替代 TX_DUR)
  WIGA_TX_CH3_RATE: 0.112,     // ch3 归一化 /s (×1000=PWM/s)
  WIGA_TX_V_OK:   5.0,        // 跃迁成功 V 阈值
  WIGA_TX_TO_MS: 8000,        // 跃迁超时 → DECEL
  // I. 限时巡航 (ch7<1300 armed latch 启用)
  WIGA_CMAX_MS: 0,      // 0=无限, >0=N ms 自动 DECEL
  // P7.9.20: 后出气巡航 RV (恢复 P7.9.4 砍掉的 FV/RV 切换)
  WIGA_RV_EN:    1,            // 0=FV (前出气) / 1=RV (后出气)
  WIGA_RV_SGRP: 60,            // RV SGRP body GOAL deg
  WIGA_RV_HALF: 10,            // RV ±tilt 范围 deg
  // P7.9.27: FV (前出气) 巡航也参数化, 之前只 RV 可调
  WIGA_FV_SGRP: 35,            // FV SGRP body GOAL deg (近垂直, 主升力)
  WIGA_FV_HALF: 10,            // FV ±tilt 范围 deg
  // J. GTEST 地面测试 (跟 cruise 独立)
  WIGA_GTEST_EN:    0,
  WIGA_GTEST_PH:    1,        // 1=FLOAT_TAXI 2=TRANSITION 3=CRUISE 4=DECEL
  WIGA_GTEST_CAP: 0.30,
  // K. SITL 虚拟传感器
  WIGA_SIM_EN:      0,
  WIGA_SIM_V:       0,
  WIGA_SIM_PITCH:   0,
  WIGA_SIM_ROLL:    0,

  // ═══ ATC 原生 (Quadplane PID + stick) ═══
  Q_A_RAT_RLL_P:  0.135,
  Q_A_RAT_RLL_I:  0.135,
  Q_A_RAT_RLL_D:  0.004,
  Q_A_RAT_PIT_P:  0.135,
  Q_A_RAT_PIT_I:  0.135,
  Q_A_RAT_PIT_D:  0.004,
  Q_A_ANG_RLL_P:  4.5,
  Q_A_ANG_PIT_P:  4.5,
  Q_A_ANGLE_MAX:  10,         // deg (P7.9: 10° 含 ±5° 微调)
  PTCH_LIM_MAX_DEG:  5,
  PTCH_LIM_MIN_DEG: -5,
  ROLL_LIMIT_DEG:    5,
  Q_M_THST_HOVER: 0.60,       // 跟 cruise 实际 PWM 接近 (旧 0.35 不符)

  // ─── 飞前检查用 ArduPilot 原生 params (store 启动时拉) ───
  SCR_ENABLE:       1,
  Q_FRAME_CLASS:    17,
  EK3_SRC1_YAW:     3,
  COMPASS_USE:      1,
  Q_A_RAT_YAW_P:    0.18,
  Q_A_RAT_YAW_I:    0.018,
  Q_A_RAT_YAW_D:    0,
  Q_A_ANG_YAW_P:    4.5,
  // P7.9.15: yaw setpoint shaping (ATC angle path 用, 跟 fork patch input_euler_angle_yaw 配)
  // 真名 (ArduPilot 实测): Q_A_INPUT_TC / Q_A_RATE_Y_MAX  (之前误用 ATC_INPUT_TC / ANG_VEL_YAW_MAX)
  Q_A_INPUT_TC:     0.2,     // setpoint 平滑常数 s (default 0.15-0.2)
  Q_A_RATE_Y_MAX:   75,      // yaw 角速度上限 °/s (0=不限, fc default 75)
};

// ═══ ATC 原生参数白名单 (控制律 tab pull/push 用) ═══
export const ATC_NATIVE_KEYS: string[] = [
  'Q_A_RAT_RLL_P', 'Q_A_RAT_RLL_I', 'Q_A_RAT_RLL_D',
  'Q_A_RAT_PIT_P', 'Q_A_RAT_PIT_I', 'Q_A_RAT_PIT_D',
  'Q_A_RAT_YAW_P', 'Q_A_RAT_YAW_I', 'Q_A_RAT_YAW_D',
  'Q_A_ANG_RLL_P', 'Q_A_ANG_PIT_P', 'Q_A_ANG_YAW_P', 'Q_A_ANGLE_MAX',
  'PTCH_LIM_MAX_DEG', 'PTCH_LIM_MIN_DEG', 'ROLL_LIMIT_DEG',
  'Q_M_THST_HOVER',
  'Q_A_INPUT_TC', 'Q_A_RATE_Y_MAX',
];

// P7.9.4: 撤 'WIGK' (整表撤了), 留 MSK / TLT / WIGA
export const PARAM_PREFIXES = ['MSK', 'TLT', 'WIGA'] as const;

// 两套预设 (Params tab 一键切换)
export const PRESET_FLIGHT: Record<string, number> = {
  Q_A_ANGLE_MAX: 10,
  Q_A_ANG_RLL_P: 4.5,
  Q_A_ANG_PIT_P: 4.5,
  Q_A_RAT_RLL_P: 0.135,
  Q_A_RAT_PIT_P: 0.135,
};

export const PRESET_BENCH: Record<string, number> = {
  Q_A_ANGLE_MAX: 30,
  Q_A_ANG_RLL_P: 8.0,
  Q_A_ANG_PIT_P: 8.0,
  Q_A_RAT_RLL_P: 0.40,
  Q_A_RAT_PIT_P: 0.40,
};

// 拉取/推送时跳过的参数 (TLT_*_PRV 实时预览, 不持久化)
export const SYNC_SKIP_RE = /^TLT_.*_PRV$/;

// param range + label + quantize helpers (Params/FlightProfile tab 用)
export function paramRange(key: string): { min: number; max: number; step: number } {
  // ─── MSK_ ───
  if (key.startsWith('MSK_BPCH_'))  return { min: -10, max: 20, step: 0.5 };
  if (key.startsWith('MSK_V_PI_'))  return { min: 0, max: 1, step: 0.005 };
  if (key === 'MSK_V_MIN' || key === 'MSK_V_MAX') return { min: 0, max: 25, step: 0.5 };
  if (key === 'MSK_V_INT_LIM')       return { min: 0, max: 50, step: 0.5 };
  if (key === 'MSK_TRIM_RATE')       return { min: 0, max: 200, step: 1 };
  if (key === 'MSK2_PO_NORM')        return { min: 0.1, max: 2.0, step: 0.05 };

  // ─── TLT_ ───
  if (key.endsWith('_BW'))           return { min: 0.1, max: 5.0, step: 0.1 };
  if (key === 'TLT_CPL_SDF_K')       return { min: 0, max: 2, step: 0.05 };
  if (key === 'TLT_CPL_EN')          return { min: 0, max: 1, step: 1 };
  if (key.endsWith('_ZERO'))         return { min: 500, max: 2500, step: 1 };
  if (key.endsWith('_DIR'))          return { min: -1, max: 1, step: 1 };
  if (key.endsWith('_LMIN') || key.endsWith('_LMAX')) return { min: -90, max: 90, step: 1 };
  if (key.endsWith('_PRV'))          return { min: -1, max: 180, step: 1 };
  if (key.endsWith('_GOAL'))         return { min: 0, max: 180, step: 1 };
  if (key === 'TLT_PWM_PER_DEG')     return { min: 1, max: 30, step: 0.1 };

  // ─── WIGA_ ───
  // V
  if (key === 'WIGA_V_TGT')          return { min: 0, max: 15, step: 0.1 };
  if (key === 'WIGA_V_CH10_EN' || key === 'WIGA_PREFLT_REQ' ||
      key === 'WIGA_SIM_EN' || key === 'WIGA_GTEST_EN' ||
      key === 'WIGA_HDG_HOLD_EN')
                                      return { min: 0, max: 1, step: 1 };
  if (key === 'WIGA_PRE_SPEED')      return { min: 1, max: 30, step: 0.5 };
  // FLOAT_TAXI
  if (key === 'WIGA_TAXI_DUR')       return { min: 0, max: 30000, step: 100 };
  if (key === 'WIGA_TAXI_THR_T')     return { min: 0, max: 1, step: 0.05 };
  // DECEL
  if (key === 'WIGA_DEC_K_RATE')     return { min: 0, max: 1, step: 0.005 };
  if (key === 'WIGA_DEC_CH3_RT')     return { min: 0, max: 2, step: 0.01 };
  if (key === 'WIGA_DECEL_V_OFF')    return { min: 0, max: 10, step: 0.1 };
  if (key === 'WIGA_TX_V_OK')        return { min: 0, max: 15, step: 0.1 };
  if (key === 'WIGA_TRN_HDG')        return { min: -180, max: 180, step: 1 };
  if (key === 'WIGA_TRN_DUR')        return { min: 0, max: 30000, step: 100 };
  if (key === 'WIGA_RV_EN')          return { min: 0, max: 1, step: 1 };
  if (key === 'WIGA_RV_SGRP')        return { min: 30, max: 90, step: 1 };
  if (key === 'WIGA_RV_HALF')        return { min: 0, max: 30, step: 1 };
  if (key === 'WIGA_FV_SGRP')        return { min: 0, max: 60, step: 1 };
  if (key === 'WIGA_FV_HALF')        return { min: 0, max: 30, step: 1 };
  if (key === 'MSK_V_W_EN')          return { min: 0, max: 1, step: 1 };
  if (key === 'MSK_V_W_KT')          return { min: 0, max: 2, step: 0.05 };
  if (key === 'MSK_V_W_KS')          return { min: 0, max: 2, step: 0.05 };
  if (key === 'MSK_BPCH_G3')         return { min: 0, max: 20, step: 1 };
  if (key === 'MSK_PSC_EN')          return { min: 0, max: 1, step: 1 };
  if (key === 'MSK_PSC_V_LO')        return { min: 0, max: 20, step: 0.5 };
  if (key === 'MSK_PSC_V_HI')        return { min: 0, max: 25, step: 0.5 };
  if (key === 'MSK_PSC_MIN')         return { min: 0.1, max: 1, step: 0.05 };
  if (key === 'MSK_PSC_EXP')         return { min: 0.5, max: 3, step: 0.1 };
  // Layer 1+2
  if (key === 'WIGA_L1_BODY' || key === 'WIGA_L2_BODY' || key === 'WIGA_L1_REC_W')
                                      return { min: 0, max: 90, step: 1 };
  if (key === 'WIGA_L1_RATE')        return { min: 0, max: 90, step: 1 };
  if (key === 'WIGA_L1_MMS' || key === 'WIGA_L1_REC_MS' || key === 'WIGA_RATE_MMS')
                                      return { min: 0, max: 5000, step: 50 };
  if (key === 'WIGA_L1_HOLD')        return { min: 500, max: 10000, step: 100 };
  if (key === 'WIGA_L1_CH3')         return { min: 1000, max: 2000, step: 10 };
  if (key === 'WIGA_L1_R_PWM')       return { min: 100, max: 2000, step: 50 };
  // Yaw P+I+D
  if (key === 'WIGA_HDG_P')          return { min: 0, max: 0.1, step: 0.0005 };
  if (key === 'WIGA_HDG_I')          return { min: 0, max: 0.01, step: 0.00005 };
  if (key === 'WIGA_HDG_D')          return { min: 0, max: 0.5, step: 0.001 };
  if (key === 'WIGA_HDG_I_LIM')      return { min: 0, max: 1, step: 0.05 };
  // TRANSITION
  if (key === 'WIGA_TX_TO_MS')       return { min: 500, max: 20000, step: 100 };
  if (key === 'WIGA_TX_K_RATE')      return { min: 0, max: 2, step: 0.01 };
  if (key === 'WIGA_TX_CH3_RATE')    return { min: 0, max: 2, step: 0.01 };
  if (key === 'WIGA_TX_V_OK')        return { min: 1, max: 15, step: 0.1 };
  // 限时巡航
  if (key === 'WIGA_CMAX_MS')  return { min: 0, max: 120000, step: 1000 };
  // GTEST
  if (key === 'WIGA_GTEST_PH')       return { min: 1, max: 4, step: 1 };
  if (key === 'WIGA_GTEST_CAP')      return { min: 0, max: 1, step: 0.05 };
  // SITL
  if (key === 'WIGA_SIM_V')          return { min: 0, max: 15, step: 0.1 };
  if (key === 'WIGA_SIM_PITCH' || key === 'WIGA_SIM_ROLL')
                                      return { min: -90, max: 90, step: 1 };

  // ─── ATC 原生 ───
  if (/^Q_A_RAT_(RLL|PIT|YAW)_(P|I)$/.test(key)) return { min: 0, max: 1, step: 0.005 };
  if (/^Q_A_RAT_(RLL|PIT|YAW)_D$/.test(key))     return { min: 0, max: 0.1, step: 0.0005 };
  if (/^Q_A_ANG_(RLL|PIT|YAW)_P$/.test(key))     return { min: 0, max: 12, step: 0.1 };
  if (key === 'Q_A_ANGLE_MAX')       return { min: 0, max: 45, step: 1 };
  if (key === 'Q_A_INPUT_TC')        return { min: 0, max: 1, step: 0.01 };
  if (key === 'Q_A_RATE_Y_MAX')      return { min: 0, max: 180, step: 1 };
  if (key === 'PTCH_LIM_MAX_DEG' || key === 'ROLL_LIMIT_DEG')
                                      return { min: 0, max: 90, step: 1 };
  if (key === 'PTCH_LIM_MIN_DEG')    return { min: -90, max: 0, step: 1 };
  if (key === 'Q_M_THST_HOVER')      return { min: 0.1, max: 0.8, step: 0.01 };

  if (key.startsWith('WIGA_'))       return { min: 0, max: 60000, step: 100 };
  return { min: -1000, max: 1000, step: 1 };
}

export function paramLabel(key: string): string {
  return key;
}

export function quantize(key: string, value: number): number {
  const r = paramRange(key);
  if (!isFinite(value)) return 0;
  const v = Math.max(r.min, Math.min(r.max, value));
  const q = Math.round(v / r.step) * r.step;
  return Math.round(q * 1e6) / 1e6;
}
