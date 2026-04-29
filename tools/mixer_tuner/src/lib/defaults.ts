// 默认参数. 镜像 scripts/main.lua + scripts/modules/{mixer,tilt_driver}.lua 注册的参数.
// v9 P1 大瘦身: 删 v8 PCHIP 25 K + 4 V + MSK_GEAR/AUTO/MODE_CH + MSK_TRIM_* + MSK_RTL_* +
// MGEO_* (36) + TLTC_* (35) + GRD_* + PRE_* (44 个 → 0). v9 P1 仅 4 K + 32 TLT.
import type { ParamSet } from './types';

export const DEFAULT_PARAMS: ParamSet = {
  // ═══ MSK_ v9 P2 三档 K (12 个) — 老 4 K (MSK_KS/KDF/KT/KRD) 已删, lua 不读 ═══
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
  // v9 P3.9 thr_cap 限幅可调 (台架静态扭矩测试用)
  MSK_THR_CHECK: 0.30,  // ch6 中档限幅
  MSK_THR_TEST:  0.33,  // ch6 高档限幅 (1/3 推力, 防台架失控)

  // ═══ TLT_ (tilt_driver, key=82) — 32+7=39 ═══
  TLT_CPL_SDF_K:   0.30,
  TLT_CPL_EN:      1,
  TLT_PWM_PER_DEG: 11.11,
  // ZERO/DIR/LMIN/LMAX × 7 — v9 P3.10 实测标定 (2026-04-29 台架校准)
  TLT_DFL_ZERO:  1526, TLT_DFL_DIR:  1, TLT_DFL_LMIN: -45, TLT_DFL_LMAX:  45,
  TLT_DFR_ZERO:  1585, TLT_DFR_DIR: -1, TLT_DFR_LMIN: -45, TLT_DFR_LMAX:  45,
  TLT_TL1_ZERO:  1373, TLT_TL1_DIR: -1, TLT_TL1_LMIN:  45, TLT_TL1_LMAX:  75,
  TLT_TR1_ZERO:  1373, TLT_TR1_DIR: -1, TLT_TR1_LMIN:  45, TLT_TR1_LMAX:  75,
  TLT_RDL_ZERO:  1202, TLT_RDL_DIR: -1, TLT_RDL_LMIN:  -5, TLT_RDL_LMAX:  45,
  TLT_RDR_ZERO:  1233, TLT_RDR_DIR: -1, TLT_RDR_LMIN:  -5, TLT_RDR_LMAX:  45,
  TLT_SGRP_ZERO: 1549, TLT_SGRP_DIR: 1, TLT_SGRP_LMIN:-45, TLT_SGRP_LMAX:  30,
  // PRV × 7 — Tuner 实时预览覆盖 abs°. -1=不覆盖走默认 45°. 拖滑杆推送, lua 主循环读
  TLT_DFL_PRV:  -1, TLT_DFR_PRV:  -1,
  TLT_TL1_PRV:  -1, TLT_TR1_PRV:  -1,
  TLT_RDL_PRV:  -1, TLT_RDR_PRV:  -1,
  TLT_SGRP_PRV: -1,
  // v9 P3.10 实测三档倾转 abs° (2026-04-29 台架校准, 跟标定 ZERO 配套)
  TLT_DFL_G1:   0, TLT_DFL_G2:   0, TLT_DFL_G3:  30,
  TLT_DFR_G1:   0, TLT_DFR_G2:   0, TLT_DFR_G3:  30,
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
  if (/^MSK_BPCH_G[123]$/.test(key)) return { min: 0, max: 20, step: 0.5 };
  if (/^MSK_THR_(CHECK|TEST)$/.test(key)) return { min: 0, max: 1, step: 0.01 };
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
  // ═ MSK base_pitch 三档 (3) ═
  MSK_BPCH_G1: '档1 base_pitch ° (慢滑, 浮筒承重自然)',
  MSK_BPCH_G2: '档2 base_pitch ° (抬头建气垫)',
  MSK_BPCH_G3: '档3 base_pitch ° (巡航 翼面 0° AoA)',
  // ═ MSK thr_cap 限幅可调 (台架静态扭矩测试) ═
  MSK_THR_CHECK: 'ch6 中档 thr_cap 限幅 (默认 0.30 = 30%)',
  MSK_THR_TEST:  'ch6 高档 thr_cap 限幅 (默认 0.33 = 1/3 推力, 台架静态测试用)',
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
