// 默认参数. 镜像 scripts/main.lua + scripts/modules/{mixer,tilt_driver}.lua 注册的参数.
// v9 P1 大瘦身: 删 v8 PCHIP 25 K + 4 V + MSK_GEAR/AUTO/MODE_CH + MSK_TRIM_* + MSK_RTL_* +
// MGEO_* (36) + TLTC_* (35) + GRD_* + PRE_* (44 个 → 0). v9 P1 仅 4 K + 32 TLT.
import type { ParamSet } from './types';

export const DEFAULT_PARAMS: ParamSet = {
  // ═══ MSK_ v9 P4 三档 K (12 个) — 用户实测预设 2026-04-29 ═══
  MSK_KS_G1:  0.50, MSK_KDF_G1: 0.30, MSK_KT_G1: 0.50, MSK_KRD_G1: 0.30,
  MSK_KS_G2:  0.50, MSK_KDF_G2: 0.50, MSK_KT_G2: 0.50, MSK_KRD_G2: 0.50,
  MSK_KS_G3:  0.20, MSK_KDF_G3: 0.20, MSK_KT_G3: 0.85, MSK_KRD_G3: 0.20,
  // ═══ v9 P3.1 G3 PID 速度环参数 ═══
  MSK_V_TGT:  9.0,   // G3 目标速度 m/s
  MSK_V_PI_P: 0.05,  // P 增益 (m/s err -> thr_cap correction)
  MSK_V_PI_I: 0.02,  // I 增益
  MSK_V_PI_D: 0.0,   // D 项 (用 V_actual 微分, 防 target 跳变. 默认 0, 振荡时调)
  // ═══ v9 P3.2/P3.4 tilt ATC + V 反馈 ═══
  MSK_FB_EN:   1.0,   // tilt ATC 反馈总开关 (v9 P4: G1/G2/G3 三档都启用; 0=全关)
  MSK_FB_P_SC: 5.0,   // pitch bias scale (°/ATC unit)
  MSK_FB_R_SC: 12.0,  // roll bias scale — 12 = 全杆 ±12°, 配 TL1/TR1 LMIN=25 双侧对称
  MSK_FB_V_SC: 8.0,   // RD V 反馈 scale (°/m/s err, 姿态稳态时 G3 启用, 朝 90° 助推)
  // v9 P3.4 base_pitch 切档 ramp 速率 (°/s, 0=阶跃)
  MSK_TRIM_RATE: 3.0,
  // v9 P3.5/P3.6 三层级加速
  MSK_KT_LIM:     1.0,  // KT 撞上限 (Layer 1→2 转换). 浮点比较加 0.95 迟滞
  MSK_L2_SGRP_RT: 5.0,  // Layer 2 SGRP 改平 rate (°/s, 实飞调)
  MSK_L2_RD_RT:   3.0,  // Layer 2 RDL/RDR 改平 rate (°/s, 实飞调)
  MSK_K_DRFT_RT:  0.01, // P3.7 K_drift 学习 rate (/s, 默认 0.01, 实飞调; 0=关学习)
  // v9 P4 摸黑 tilt drift 学习 (G3 5s 持续 pitch 偏 → SGRP/DF/RD drift 累加)
  MSK_TLT_DRFT_R: 0.005, // tilt drift 学习 rate (°/s, 默认 0.005 比 K 慢半; 0=关)
  MSK_TLT_DRFT_M: 15.0,  // tilt drift 上限 (°, 默认 ±15)
  // v9 P4 tilt 带宽分级 (DF 惯量小快, S 整组桁架慢, T/RD 中等)
  MSK_TLT_R_DF:   60.0,  // DFL/DFR rate (°/s, 快, 主姿态高带宽 pitch)
  MSK_TLT_R_S:    12.0,  // S_GROUP_TILT rate (°/s, 慢, 大舵机拖 4 EDF)
  MSK_TLT_R_T:    35.0,  // TL1/TR1 rate (°/s, 中, roll 主致动)
  MSK_TLT_R_RD:   30.0,  // RDL/RDR rate (°/s, 中, 低头力矩 + 助推)
  // v9 P4 ATC 反馈死区 (norm < dead → tilt 不动, KT 差动仍工作)
  MSK_FB_R_DEAD:  0.1,   // roll 死区 (norm 单位, 0.1 ≈ 5° 姿态误差以内不动 tilt)
  MSK_FB_P_DEAD:  0.0,   // pitch 死区 (默认 0 不开, pitch 大部分时间需主动调)
  // v9 P3.8 三档 base_pitch (°, ch7 切档时 Q_TRIM_PITCH ramp 目标)
  MSK_BPCH_G1: 5,    // G1 慢滑: 浮筒承重自然
  MSK_BPCH_G2: 11,   // G2 抬头建气垫
  MSK_BPCH_G3: 8,    // G3 巡航: 翼面 0° AoA
  // v9 P3.9 thr_cap 限幅可调 (台架静态扭矩测试用)
  MSK_THR_CHECK: 0.30,  // ch6 中档限幅
  MSK_THR_TEST:  0.33,  // ch6 高档限幅 (1/3 推力, 防台架失控)
  // v9 P4 vmix: 速度三段连续混合 G1↔G2↔G3
  MSK_VMIX_EN:  1,     // 0=离散三档 (老 P3.10), 1=连续 vmix (P4 默认)
  MSK_VMIX_TAU: 0.5,   // V LPF 时间常数 (s, 防 GPS 抖)
  MSK_VMIX_LO:  3.0,   // V→α 三段映射: V<LO → α=0 (G1)
  MSK_VMIX_MID: 6.5,   // V=MID → α=0.5 (G2 锚点)
  MSK_VMIX_HI:  10.0,  // V>HI → α=1 (G3)
  // v9 P4 实战: GROUP_BOOST 4 K. G3 PID 速度 demand 在 4 组分配权重
  // 设计: T 主前推=1.0, S 副 0.5, RD 副 0.5, DF 不参与=0
  MSK_BST_KS:  0.5,    // KS boost 比例 (0..1)
  MSK_BST_KDF: 0.0,    // KDF boost 比例 (建议 0, DF 主姿态)
  MSK_BST_KT:  1.0,    // KT boost 比例 (建议 1.0, 巡航主推全承担)
  MSK_BST_KRD: 0.5,    // KRD boost 比例 (0..1)
  // v9 P4 实战 (设计 X): G3 速度控制 — ch10 旋钮命令加速度, ch3 lua override=1900 锁满
  MSK_V_MIN:        5.0,   // V_TGT 绝对下限 m/s
  MSK_V_MAX:       14.0,   // V_TGT 绝对上限 m/s
  MSK_V_DRIVE_MIN:  9.0,   // G3 入档 V_TGT 兜底 (破驼峰必须 ≥ 9 m/s)
  MSK_V_ACC_MAX:    2.0,   // ch10 满杆加速度 m/s² (推杆 1s V_TGT +2 m/s)
  MSK_V_DEADZONE:  50,     // ch10 中位死区 PWM ±50 (维持 V_TGT 不动)
  // v9 P4 修关键: DF tilt ATC 系数 + Layer 2 emergency 阈值
  MSK_FB_P_SC_DF:  75,     // DF tilt ATC 反馈系数 (默认 1.5× FB_P_SC, DF 优先抬头)
  MSK_P_EMRG_DEG:  1.5,    // Layer 2 emergency 阈值 °, vehicle pitch 偏 target 这么多就让 ATC 接管 S/RD
  // v9 P4 暴露之前硬编码的 5 个关键阈值
  MSK_BST_SAT_HI:  0.95,   // Layer 1→2 进入 (boost 撞顶阈值)
  MSK_BST_SAT_LO:  0.85,   // Layer 2→1 退出 hysteresis
  MSK_V_INT_LIM:   10.0,   // PID I 项 cap (anti-windup)
  MSK_G3_RAMP_MS:  1500,   // G2→G3 boost 渐进时长 ms
  MSK_DRFT_TIME:   5.0,    // drift 学习触发持续时长 s

  // ═══ MSK2_ (key=84) — 副表 6 个 (主表满 63 后追加) ═══
  MSK2_DRFT_DZ:    0.2,    // pitch demand 死区 (>该值才学 drift)
  MSK2_DRFT_KS_R:  1.0,    // KS K drift 学率因子
  MSK2_DRFT_KDF_R: 0.5,    // KDF K drift 学率因子
  MSK2_DRFT_KT_R:  0.3,    // KT K drift 学率因子 (跟 G3 boost 撞, 抑)
  MSK2_DRFT_KRD_R: 0.0,    // KRD K drift 学率因子 (sign 反向, 默认关)
  MSK2_KRAMP_MS:   1000,   // vmix=0 切档 K 表 ramp 时长 ms

  // ═══ TLT_ (tilt_driver, key=82) — 32+7=39 ═══
  TLT_CPL_SDF_K:   0.30,
  TLT_CPL_EN:      1,
  TLT_PWM_PER_DEG: 11.11,
  // ZERO/DIR/LMIN/LMAX × 7 — v9 P3.10 实测标定 (2026-04-29 台架校准)
  TLT_DFL_ZERO:  1526, TLT_DFL_DIR:  1, TLT_DFL_LMIN: -45, TLT_DFL_LMAX:  45,
  TLT_DFR_ZERO:  1585, TLT_DFR_DIR: -1, TLT_DFR_LMIN: -45, TLT_DFR_LMAX:  45,
  // TL1/TR1 非对称包络 (用户标定): abs 70°-135° (中位 90°, +45° 上 / -20° 下)
  TLT_TL1_ZERO:  1373, TLT_TL1_DIR: -1, TLT_TL1_LMIN:  25, TLT_TL1_LMAX:  90,
  TLT_TR1_ZERO:  1373, TLT_TR1_DIR: -1, TLT_TR1_LMIN:  25, TLT_TR1_LMAX:  90,
  TLT_RDL_ZERO:  1202, TLT_RDL_DIR: -1, TLT_RDL_LMIN:  -5, TLT_RDL_LMAX:  45,
  TLT_RDR_ZERO:  1233, TLT_RDR_DIR: -1, TLT_RDR_LMIN:  -5, TLT_RDR_LMAX:  45,
  TLT_SGRP_ZERO: 1549, TLT_SGRP_DIR: 1, TLT_SGRP_LMIN:-45, TLT_SGRP_LMAX:  30,
  // PRV × 7 — Tuner 实时预览覆盖 abs°. -1=不覆盖走默认 45°. 拖滑杆推送, lua 主循环读
  TLT_DFL_PRV:  -1, TLT_DFR_PRV:  -1,
  TLT_TL1_PRV:  -1, TLT_TR1_PRV:  -1,
  TLT_RDL_PRV:  -1, TLT_RDR_PRV:  -1,
  TLT_SGRP_PRV: -1,
  // v9 P4 实测三档倾转 abs° (2026-04-29 台架校准, 跟标定 ZERO 配套, RDL/RDR LMAX=45° 顶 90° 物理上限)
  // DFL/DFR G2 = 10 (而非 0): 给 S→DF 解耦补偿留头空间. S G2 abs 60° 时
  // 补偿要 -4.5°, DF G2=0 (LMIN) 钳死补偿失败. G2=10 让 servo 能下到 abs 5.5°
  TLT_DFL_G1:   0, TLT_DFL_G2:  10, TLT_DFL_G3:  30,
  TLT_DFR_G1:   0, TLT_DFR_G2:  10, TLT_DFR_G3:  30,
  TLT_TL1_G1:  90, TLT_TL1_G2:  90, TLT_TL1_G3:  90,
  TLT_TR1_G1:  90, TLT_TR1_G2:  90, TLT_TR1_G3:  90,
  TLT_RDL_G1:  90, TLT_RDL_G2:  90, TLT_RDL_G3:  40,
  TLT_RDR_G1:  90, TLT_RDR_G2:  90, TLT_RDR_G3:  40,
  TLT_SGRP_G1: 45, TLT_SGRP_G2: 60, TLT_SGRP_G3: 70,
  // v9 P2 平滑速率
  TLT_RATE: 30.0,

  // ═══ PRE_ (preflight, key=85) — 地面预检 5 个参数 ═══
  PRE_CH:     8,     // 预检通道 (1-16, ch8 高位 + disarmed 激活)
  PRE_PWM:    1100,  // 怠速 PWM (1000-2000)
  PRE_STOP:   1000,  // 停转 PWM
  PRE_GRP_MS: 2000,  // 每子步 ms (4 阶段时序)
  PRE_SWING:  15,    // tilt 扫描 ±° 幅度
};

export const PARAM_PREFIXES = ['MSK', 'TLT', 'PRE'] as const;

// ═══ 两套预设: 飞行 / 地测台架 (Params tab 一键切换) ═══
// 共享: K 表 / 倾转表 / SERVO 标定 (实测调过的) — 都不在预设里, 用户自己 tune
// 预设只切 ATC PID 增益 + tilt ATC scale + ANGLE_MAX
export const PRESET_FLIGHT: Record<string, number> = {
  // ArduPlane Q ATC 标准增益 (实飞用)
  Q_A_ANGLE_MAX: 10,    // stick 满偏 ±10° (温和)
  Q_A_ANG_RLL_P: 4.5,   // 角度环 P
  Q_A_ANG_PIT_P: 4.5,
  Q_A_RAT_RLL_P: 0.135, // 角速度环 P
  Q_A_RAT_PIT_P: 0.135,
  // Lua tilt ATC 反馈 scale (温和)
  MSK_FB_R_SC: 5,
  MSK_FB_P_SC: 5,
  // thr_cap 限幅 (实飞 TEST 不用, 但保留 default 防误)
  MSK_THR_CHECK: 0.30,
  MSK_THR_TEST:  0.60,  // 实飞测试满推 60%
};

export const PRESET_BENCH: Record<string, number> = {
  // 高增益: stick 满偏 → motor 100 PWM Δ + tilt 200+ PWM Δ (台架观察 ATC 反馈方向)
  Q_A_ANGLE_MAX: 30,    // stick 满偏 ±30° → ATC target err 大 3x
  Q_A_ANG_RLL_P: 8.0,   // 角度环 P × 1.8
  Q_A_ANG_PIT_P: 8.0,
  Q_A_RAT_RLL_P: 0.40,  // 角速度环 P × 3
  Q_A_RAT_PIT_P: 0.40,
  // Lua tilt ATC 反馈 scale 高 (满偏 25° = 277 PWM ≥ 200 ✓)
  MSK_FB_R_SC: 25,
  MSK_FB_P_SC: 25,
  // thr_cap 限幅 1/3 (台架防失控)
  MSK_THR_CHECK: 0.30,
  MSK_THR_TEST:  0.33,
};

// 拉取/推送时跳过的参数:
//   TLT_*_PRV (7) — 实时预览, 重启 lua 重置 -1, 跨会话不持久化
//   (老 4 K MSK_KS/KDF/KT/KRD 已从 DEFAULT_PARAMS 删除)
export const SYNC_SKIP_RE = /^TLT_.*_PRV$/;

// ArduPilot PARAM_VALUE 是 float32 → JS double 转换会出 4.000000095... 之类浮点噪声.
// 按参数 step 量化 + toFixed 截位, 把 noise 砍掉.
export function quantize(key: string, value: number): number {
  if (!Number.isFinite(value)) return value;
  const step = paramRange(key).step ?? 0.01;
  if (step <= 0) return value;
  // ceil(-log10(step)) 避免整数边界 bug: log10(0.01)=-2 精确, ceil(2)=2 ✓
  const decimals = Math.max(0, Math.min(8, Math.ceil(-Math.log10(step))));
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
  if (/^MSK_TLT_DRFT_R$/.test(key)) return { min: 0, max: 0.05, step: 0.001 };
  if (/^MSK_TLT_DRFT_M$/.test(key)) return { min: 0, max: 30, step: 0.5 };
  if (/^MSK_TLT_R_(DF|S|T|RD)$/.test(key)) return { min: 5, max: 120, step: 1 };
  if (/^MSK_FB_[RP]_DEAD$/.test(key)) return { min: 0, max: 0.5, step: 0.01 };
  if (/^MSK_BPCH_G[123]$/.test(key)) return { min: 0, max: 20, step: 0.5 };
  if (/^MSK_THR_(CHECK|TEST)$/.test(key)) return { min: 0, max: 1, step: 0.01 };
  // v9 P4 vmix
  if (/^MSK_VMIX_EN$/.test(key))  return { min: 0, max: 1, step: 1 };
  if (/^MSK_VMIX_TAU$/.test(key)) return { min: 0.05, max: 5, step: 0.05 };
  if (/^MSK_VMIX_(LO|MID|HI)$/.test(key)) return { min: 0, max: 30, step: 0.1 };
  // v9 P4 实战: GROUP_BOOST 4 K + V 范围
  if (/^MSK_BST_K(S|DF|T|RD)$/.test(key)) return { min: 0, max: 1, step: 0.01 };
  if (/^MSK_V_(MIN|MAX|DRIVE_MIN)$/.test(key)) return { min: 0, max: 30, step: 0.1 };
  if (/^MSK_V_ACC_MAX$/.test(key)) return { min: 0, max: 10, step: 0.1 };
  if (/^MSK_V_DEADZONE$/.test(key)) return { min: 0, max: 200, step: 1 };
  if (/^MSK_FB_P_SC_DF$/.test(key)) return { min: 0, max: 200, step: 1 };
  if (/^MSK_P_EMRG_DEG$/.test(key)) return { min: 0.1, max: 10, step: 0.1 };
  if (/^MSK_BST_SAT_(HI|LO)$/.test(key)) return { min: 0.5, max: 1.0, step: 0.01 };
  if (/^MSK_V_INT_LIM$/.test(key)) return { min: 1, max: 50, step: 0.5 };
  if (/^MSK_G3_RAMP_MS$/.test(key)) return { min: 0, max: 5000, step: 100 };
  if (/^MSK_DRFT_TIME$/.test(key)) return { min: 0.5, max: 30, step: 0.5 };
  // ═ MSK2_ 副表 6 个 ═
  if (/^MSK2_DRFT_DZ$/.test(key))     return { min: 0, max: 1, step: 0.01 };
  if (/^MSK2_DRFT_K(S|DF|T|RD)_R$/.test(key)) return { min: 0, max: 2, step: 0.05 };
  if (/^MSK2_KRAMP_MS$/.test(key))    return { min: 0, max: 5000, step: 50 };
  if (/^TLT_.*_ZERO$/.test(key)) return { min: 500, max: 2500, step: 1 };
  if (/^TLT_.*_DIR$/.test(key))  return { min: -1, max: 1, step: 1 };  // 三态 -1/0/+1
  if (/^TLT_.*_LMIN$/.test(key)) return { min: -180, max: 0, step: 1 };
  if (/^TLT_.*_LMAX$/.test(key)) return { min: 0, max: 180, step: 1 };
  if (/^TLT_.*_PRV$/.test(key))  return { min: -1, max: 180, step: 1 };
  if (/^TLT_.*_G[123]$/.test(key)) return { min: 0, max: 180, step: 1 };
  if (/^TLT_RATE$/.test(key))      return { min: 5, max: 90, step: 1 };
  // ═ PRE_ 地面预检 5 个 ═
  if (/^PRE_CH$/.test(key))      return { min: 1, max: 16, step: 1 };       // RC 通道
  if (/^PRE_PWM$/.test(key))     return { min: 1000, max: 2000, step: 1 };  // 怠速 PWM
  if (/^PRE_STOP$/.test(key))    return { min: 900, max: 1500, step: 1 };
  if (/^PRE_GRP_MS$/.test(key))  return { min: 500, max: 10000, step: 100 };
  if (/^PRE_SWING$/.test(key))   return { min: 5, max: 30, step: 1 };
  return { step: 0.01 };
}

// ═══ 参数中文说明 (固定 + pattern fallback, 覆盖所有 lua 注册参数) ═══
const TILT_NAME: Record<string, string> = {
  DFL: 'DFL 左前下吹', DFR: 'DFR 右前下吹',
  TL1: 'TL1 左 T1',    TR1: 'TR1 右 T1',
  RDL: 'RDL 左后斜',   RDR: 'RDR 右后斜',
  SGRP:'S 组中央桁架',
};
const GEAR_NAME: Record<string, string> = {
  G1: '档1 慢滑',
  G2: '档2 抬头建气垫',
  G3: '档3 巡航',
};

export const PARAM_LABELS: Record<string, string> = {
  // ═ MSK G3 PID 速度环 (4) ═
  MSK_V_TGT:  'G3 目标空速 m/s (lua 自动维持)',
  MSK_V_PI_P: 'G3 PID P 增益 (m/s 误差→油门)',
  MSK_V_PI_I: 'G3 PID I 增益 (积分)',
  MSK_V_PI_D: 'G3 PID D 增益 (阻尼, 0=关, 振荡时 0.05-0.1)',
  // ═ MSK ATC FB tilt 反馈 (4) ═
  MSK_FB_EN:   'tilt ATC 反馈 总开关 (0=关 1=开)',
  MSK_FB_P_SC: 'pitch ATC 反馈 scale (°/unit, 给 SGRP+RD)',
  MSK_FB_R_SC: 'roll ATC 反馈 scale (°/unit, 给 TL1/TR1)',
  MSK_FB_V_SC: 'RD V 反馈 scale (°/m/s err, G3 助推)',
  // ═ MSK base_pitch ramp (1) ═
  MSK_TRIM_RATE: 'base_pitch 切档过渡速率 °/s (0=阶跃)',
  // ═ MSK 三层级加速 (4) ═
  MSK_KT_LIM:     'KT 撞限阈值 (Layer1→2 转换, 迟滞 0.95×)',
  MSK_L2_SGRP_RT: 'Layer2 SGRP 改平 rate °/s',
  MSK_L2_RD_RT:   'Layer2 RDL/RDR 改平 rate °/s',
  MSK_K_DRFT_RT:  'K_drift 学习 rate /s (0=关, 0.005-0.02 学习)',
  MSK_TLT_DRFT_R: 'tilt drift 学习 rate °/s (摸黑高速段 SGRP/DF/RD)',
  MSK_TLT_DRFT_M: 'tilt drift 上限 ° (±值, 防发散)',
  MSK_TLT_R_DF:   'DFL/DFR 倾转 rate °/s (惯量小, 快带宽)',
  MSK_TLT_R_S:    'S 组倾转 rate °/s (整组桁架, 慢带宽)',
  MSK_TLT_R_T:    'TL1/TR1 倾转 rate °/s (roll 主致动, 中带宽)',
  MSK_TLT_R_RD:   'RDL/RDR 倾转 rate °/s (低头力矩, 中带宽)',
  MSK_FB_R_DEAD:  'roll ATC 反馈死区 (norm 0-1, 内 tilt 不动 KT 差动兜底)',
  MSK_FB_P_DEAD:  'pitch ATC 反馈死区 (默认 0 关, pitch 通常需主动调)',
  // ═ MSK base_pitch 三档 (3) ═
  MSK_BPCH_G1: '档1 base_pitch ° (慢滑, 浮筒承重自然)',
  MSK_BPCH_G2: '档2 base_pitch ° (抬头建气垫)',
  MSK_BPCH_G3: '档3 base_pitch ° (巡航 翼面 0° AoA)',
  // ═ MSK thr_cap 限幅可调 (台架静态扭矩测试) ═
  MSK_THR_CHECK: 'ch6 中档 thr_cap 限幅 (默认 0.30 = 30%)',
  MSK_THR_TEST:  'ch6 高档 thr_cap 限幅 (默认 0.33 = 1/3 推力, 台架静态测试用)',
  // ═ MSK vmix 速度连续混合 (P4) ═
  MSK_VMIX_EN:  'vmix 总开关 (1=连续 V→α 默认, 0=离散三档回退)',
  MSK_VMIX_TAU: 'V 估计 LPF 时间常数 s (防 GPS 抖)',
  MSK_VMIX_LO:  'V→α 三段映射: V<LO → α=0 (G1)',
  MSK_VMIX_MID: 'V=MID → α=0.5 (G2 锚点)',
  MSK_VMIX_HI:  'V>HI → α=1 (G3)',
  // ═ MSK GROUP_BOOST 加速分配 (4) ═
  MSK_BST_KS:  'KS boost 比例 (0..1, G3 PID 加速 demand 分配权重)',
  MSK_BST_KDF: 'KDF boost 比例 (建议 0, DF 主姿态不参与速度)',
  MSK_BST_KT:  'KT boost 比例 (建议 1.0, 巡航主推全承担)',
  MSK_BST_KRD: 'KRD boost 比例 (0..1, 副推+尾控)',
  // ═ MSK G3 速度控制 (设计 X, ch10 旋钮 + 加速度命令) ═
  MSK_V_MIN:        'V_TGT 绝对下限 m/s',
  MSK_V_MAX:        'V_TGT 绝对上限 m/s',
  MSK_V_DRIVE_MIN:  'G3 入档 V_TGT 兜底 m/s (破驼峰至少 9)',
  MSK_V_ACC_MAX:    'ch10 满杆加速度 m/s² (推杆 1s V_TGT +N)',
  MSK_V_DEADZONE:   'ch10 中位死区 PWM (维持 V_TGT 不变)',
  MSK_FB_P_SC_DF:   'DF tilt ATC 反馈系数 (默认 1.5× FB_P_SC, DF 主抬头优先)',
  MSK_P_EMRG_DEG:   'Layer 2 emergency 阈值 °, pitch 偏 target 这多就 ATC 接管 S/RD (LOG17 case 卡 -3.8° 因之前看 normalized output 0.3 永不触发)',
  MSK_BST_SAT_HI:   'Layer 1→2 进入阈值 (boost ≥ 这值进 Layer 2 加平), 默认 0.95 留 5% ATC 头空间',
  MSK_BST_SAT_LO:   'Layer 2→1 退出 hysteresis (boost < 这值退 Layer 2), 默认 0.85 防 0.95 边缘抖动',
  MSK_V_INT_LIM:    'G3 PID I 项绝对值 cap, 默认 10 (anti-windup 配合, 越大越积越久)',
  MSK_G3_RAMP_MS:   'G2→G3 boost 渐进时长 ms, 默认 1500 (1.5s 软启动, 防瞬态满推冲)',
  MSK_DRFT_TIME:    'drift 学习触发持续时长 s, 默认 5 (pitch_in 持续偏死区这么久才学)',
  // ═ MSK2_ 副表 6 (主表满 63 后追加) ═
  MSK2_DRFT_DZ:     'drift 触发死区 (|pitch_in| > 该值才学), 默认 0.2',
  MSK2_DRFT_KS_R:   'KS K drift 学率因子, 默认 1.0 (主升力, 全速学)',
  MSK2_DRFT_KDF_R:  'KDF K drift 学率因子, 默认 0.5 (主姿态, 半速学)',
  MSK2_DRFT_KT_R:   'KT K drift 学率因子, 默认 0.3 (跟 G3 boost 撞, 抑)',
  MSK2_DRFT_KRD_R:  'KRD K drift 学率因子, 默认 0.0 (sign 反向; 飞稳后改 0.5 打开)',
  MSK2_KRAMP_MS:    'vmix=0 切档 K 表 ramp 时长 ms, 默认 1000 (vmix=1 不用)',
  // ═ TLT 全局 (4) ═
  TLT_CPL_SDF_K:    'S→DF 软解耦补偿系数 (0..1)',
  TLT_CPL_EN:       'S→DF 软解耦总开关 (0=关 1=开默认)',
  TLT_PWM_PER_DEG:  '舵机 °→PWM 斜率 μs/°, 90° 舵 ≈11.11',
  TLT_RATE:         'tilt 平滑速率 °/s (切档过渡)',
};

export function paramLabel(key: string): string | undefined {
  if (PARAM_LABELS[key]) return PARAM_LABELS[key];

  // ═ MSK G1/G2/G3 三档 K (12) ═
  let m = key.match(/^MSK_(KS|KDF|KT|KRD)_(G[123])$/);
  if (m) {
    const grp: Record<string,string> = { KS:'S 斜吹', KDF:'DF 前下吹', KT:'T 后推', KRD:'RD 后斜' };
    return `${GEAR_NAME[m[2]]} · ${grp[m[1]]}组 油门系数 (0..1)`;
  }

  // ═ TLT_<id>_(ZERO|DIR|LMIN|LMAX|PRV) (35) ═
  m = key.match(/^TLT_(DFL|DFR|TL1|TR1|RDL|RDR|SGRP)_(ZERO|DIR|LMIN|LMAX|PRV)$/);
  if (m) {
    const name = TILT_NAME[m[1]] ?? m[1];
    const fld: Record<string,string> = {
      ZERO: '中立 PWM (abs=45° 时输出)',
      DIR:  '方向 (+1/0/−1, 0=锁定永远 ZERO)',
      LMIN: '软限位 offset 下界 °',
      LMAX: '软限位 offset 上界 °',
      PRV:  '实时预览 abs° (−1=不覆盖, 拉滑杆覆盖)',
    };
    return `${name} ${fld[m[2]]}`;
  }

  // ═ TLT_<id>_G1/G2/G3 (21) ═
  m = key.match(/^TLT_(DFL|DFR|TL1|TR1|RDL|RDR|SGRP)_(G[123])$/);
  if (m) return `${GEAR_NAME[m[2]]} · ${TILT_NAME[m[1]] ?? m[1]} 倾转 abs°`;

  // ═ PRE_ 地面预检 (5) ═
  if (key === 'PRE_CH')     return '预检激活通道 (默认 ch8 高位 + disarmed)';
  if (key === 'PRE_PWM')    return '预检怠速 PWM (默认 1100, 1000-2000)';
  if (key === 'PRE_STOP')   return '预检停转 PWM (默认 1000)';
  if (key === 'PRE_GRP_MS') return '预检每子步时长 ms (默认 2000)';
  if (key === 'PRE_SWING')  return '预检 tilt 扫描 ±° 幅度 (默认 15)';

  return undefined;
}
