// 默认参数. 和 scripts-plane/mixer.lua / tilt_driver.lua / guard.lua / preflight.lua 对齐.
import type { ParamSet } from './types';

export const DEFAULT_PARAMS: ParamSet = {
  // ═══ MSK_ (mixer, key=81) ═══
  MSK_V1: 4.0,  MSK_V2: 8.0,  MSK_V3: 14.0,  MSK_V_MAX: 20.0,
  MSK_GEAR_CH: 7,                                 // v7 三档开关 RC 通道
  MSK_AUTO_CH: 9,                                 // Auto/Manual RC 通道 (>1500=Auto)
  MSK_MODE_CH: 6,                                 // NOGPS/GPS RC 通道 (>1500=GPS)
  // 动态 Q_TRIM_PITCH 目标 (deg) — gear 切换时 guard 平滑过渡到对应值
  // NOGPS 模式: 按档位 G1/G2/G3 离散值
  MSK_TRIM_G1: 5.0,                               // gear=1 慢速
  MSK_TRIM_G2: 8.0,                               // gear=2 驼峰
  MSK_TRIM_G3: 11.0,                              // gear=3 巡航 (LOG158 优化值)
  // GPS 模式: 5 点 PCHIP 速度曲线 (V0/V1/V2/V3/V_MAX 共用 K 曲线断点)
  MSK_TRIM0: 4.0,                                 // V0 静止 (geffect)
  MSK_TRIM1: 5.0,                                 // V1 慢速
  MSK_TRIM2: 8.0,                                 // V2 驼峰
  MSK_TRIM3: 10.0,                                // V3 巡航低
  MSK_TRIM4: 11.0,                                // V_MAX 巡航高
  // RTL 返航模式 (RC12)
  MSK_RTL_CH:  12,                                // RTL RC 通道 (>1500 触发)
  MSK_RTL_LVL: 0.30,                              // RTL 时 KS+KT 油门系数
  // LOG164 优化版 (V_max=11.32, 巡航 V=10.04 pitch+17°, 实测无慢速段, 起步加速快).
  // 调整: V0/V1 加大快冲驼峰, V_MAX 段回落主动减速保稳定 (防过驼峰后失控).
  MSK_KS0:  0.70, MSK_KS1:  0.75, MSK_KS2:  0.55, MSK_KS3:  0.10, MSK_KS4:  0.05,  // V_MAX 减以保稳
  MSK_KDF0: 0.80, MSK_KDF1: 0.90, MSK_KDF2: 0.65, MSK_KDF3: 0.08, MSK_KDF4: 0.05,
  MSK_KT0:  0.50, MSK_KT1:  0.55, MSK_KT2:  0.85, MSK_KT3:  0.65, MSK_KT4:  0.50,  // KT0/1 抬高快加速, KT_MAX 回落
  MSK_KRD0: 0.65, MSK_KRD1: 0.70, MSK_KRD2: 0.85, MSK_KRD3: 0.25, MSK_KRD4: 0.20,

  // ═══ TLT_ (tilt_driver, key=82) ═══
  TLT_CPL_SDF_K:   0.30,
  TLT_CPL_EN:      1,                              // 0=关 不补偿, 1=开 反向补偿默认
  TLT_PWM_PER_DEG: 11.11,   // 90° 舵机 @ 1000-2000μs 标准值
  TLT_T1_DEG:      15.0,
  // LMIN/LMAX 是 *偏移量* offset = abs - 45 (中立 0). 范围 -180..+180, |LMIN|+|LMAX|≤180.
  TLT_DFL_ZERO:  1500, TLT_DFL_DIR:  1, TLT_DFL_LMIN: -45, TLT_DFL_LMAX:  45,
  TLT_DFR_ZERO:  1500, TLT_DFR_DIR: -1, TLT_DFR_LMIN: -45, TLT_DFR_LMAX:  45,
  TLT_TL1_ZERO:  1500, TLT_TL1_DIR:  1, TLT_TL1_LMIN: -15, TLT_TL1_LMAX:  15,
  TLT_TR1_ZERO:  1500, TLT_TR1_DIR: -1, TLT_TR1_LMIN: -15, TLT_TR1_LMAX:  15,
  TLT_RDL_ZERO:  1500, TLT_RDL_DIR:  1, TLT_RDL_LMIN: -30, TLT_RDL_LMAX:   0,
  TLT_RDR_ZERO:  1500, TLT_RDR_DIR: -1, TLT_RDR_LMIN: -30, TLT_RDR_LMAX:   0,
  TLT_SGRP_ZERO: 1500, TLT_SGRP_DIR: 1, TLT_SGRP_LMIN:-45, TLT_SGRP_LMAX:  45,

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
  // 绝对物理角度 (0=垂直水面, 45=中立, 90=水平水面).
  // 默认基于 LOG164 飞过的 TILT_V1/V2/V3 = 0°/15°/30° (v7 偏移度) → abs = 45°/60°/75°.
  // V0=0 V1=4 V2=8 V3=14 V_MAX=20.
  //   水面静止 (V0): 全中立 abs=45 (gear=1 NOGPS 用)
  //   驼峰 (V1):     DF 偏抬头 60° (gear=2 NOGPS), RD 满下吹抬尾 (15°), S 强力抬头 90°
  //   过驼峰 (V2):   DF 75° 半水平推, RD 渐回 30°, S 60°
  //   巡航 (V3):     DF 75° 全水平推 (LOG164 巡航 11 m/s pitch+17°), S 中立 45°
  //   V_MAX:         保持巡航值 (盘旋 / 速度上限)
  TLTC_DFL_K0:  45, TLTC_DFL_K1:  60, TLTC_DFL_K2:  75, TLTC_DFL_K3:  75, TLTC_DFL_K4:  75,
  TLTC_DFR_K0:  45, TLTC_DFR_K1:  60, TLTC_DFR_K2:  75, TLTC_DFR_K3:  75, TLTC_DFR_K4:  75,
  TLTC_TL1_K0:  45, TLTC_TL1_K1:  45, TLTC_TL1_K2:  45, TLTC_TL1_K3:  45, TLTC_TL1_K4:  45,
  TLTC_TR1_K0:  45, TLTC_TR1_K1:  45, TLTC_TR1_K2:  45, TLTC_TR1_K3:  45, TLTC_TR1_K4:  45,
  TLTC_RDL_K0:  45, TLTC_RDL_K1:  15, TLTC_RDL_K2:  30, TLTC_RDL_K3:  45, TLTC_RDL_K4:  45,
  TLTC_RDR_K0:  45, TLTC_RDR_K1:  15, TLTC_RDR_K2:  30, TLTC_RDR_K3:  45, TLTC_RDR_K4:  45,
  TLTC_SGRP_K0: 45, TLTC_SGRP_K1: 90, TLTC_SGRP_K2: 60, TLTC_SGRP_K3: 45, TLTC_SGRP_K4: 45,

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
  // PRE_OVR_<ID>: 实时预览覆盖 (Tuner 拖滑杆推送, Lua 主循环读). −1 = 不覆盖.
  PRE_OVR_DFL:  -1, PRE_OVR_DFR:  -1,
  PRE_OVR_TL1:  -1, PRE_OVR_TR1:  -1,
  PRE_OVR_RDL:  -1, PRE_OVR_RDR:  -1,
  PRE_OVR_SGRP: -1,
};

export const PARAM_PREFIXES = ['MSK', 'TLT', 'GRD', 'PRE', 'LAY', 'MGEO', 'TLTC'] as const;

// 拉取/推送时跳过的参数 (PRE_OVR_* 是 transient 预览, 不参与同步)
export const SYNC_SKIP_RE = /^PRE_OVR_/;

// ArduPilot PARAM_VALUE 是 float32 → JS double 转换会出 4.000000095... 之类浮点噪声.
// 按参数 step 量化 + toFixed 截位, 把 noise 砍掉.
export function quantize(key: string, value: number): number {
  if (!Number.isFinite(value)) return value;
  const step = paramRange(key).step ?? 0.01;
  if (step <= 0) return value;
  // step 的有效小数位数 (0.01 → 2, 0.1 → 1, 1 → 0, 0.05 → 2)
  const decimals = Math.max(0, Math.min(8, -Math.floor(Math.log10(step) - 1e-9)));
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

// 参数取值范围提示 (用于表单校验)
export const PARAM_RANGES: Record<string, { min?: number; max?: number; step?: number }> = {
  MSK_V1: { min: 0.1, max: 20, step: 0.1 },
  MSK_V2: { min: 0.1, max: 20, step: 0.1 },
  MSK_V3: { min: 0.1, max: 30, step: 0.1 },
  MSK_V_MAX: { min: 1, max: 50, step: 0.5 },
  TLT_CPL_SDF_K: { min: 0, max: 1, step: 0.05 },
  TLT_CPL_EN:    { min: 0, max: 1, step: 1 },
  MSK_RTL_LVL:   { min: 0, max: 1, step: 0.05 },
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
  if (/^TLT_.*_LMIN$/.test(key)) return { min: -180, max: 0, step: 1 };
  if (/^TLT_.*_LMAX$/.test(key)) return { min: 0, max: 180, step: 1 };
  if (/^MGEO_.*_[PRY]$/.test(key)) return { min: -1, max: 1, step: 0.05 };
  if (/^TLTC_.*_K[0-4]$/.test(key)) return { min: 0, max: 180, step: 1 };
  if (/^PRE_OVR_/.test(key)) return { min: -1, max: 180, step: 1 };
  return { step: 0.01 };
}

// ═══ 参数中文说明 (用于 Params tab 旁注 / tooltip) ═══
export const PARAM_LABELS: Record<string, string> = {
  // ─── MSK_ 速度断点 + K 曲线 ───
  MSK_V1:    '速度断点 V1 (m/s) — 档1 速度上限',
  MSK_V2:    '速度断点 V2 (m/s) — 档2 速度上限 (驼峰)',
  MSK_V3:    '速度断点 V3 (m/s) — 巡航高速',
  MSK_V_MAX: '最大速度 (m/s) — 曲线末端',
  MSK_GEAR_CH:'三档开关 RC 通道 (PWM<1300=档1, <1700=档2, ≥1700=档3)',
  MSK_AUTO_CH:'Auto/Manual RC 通道 (PWM>1500=Auto 摇杆放大, ≤1500=Manual 线性)',
  MSK_MODE_CH:'NOGPS/GPS RC 通道 (PWM>1500=GPS 真速插曲线, ≤1500=NOGPS 按 gear 取 K{gear-1} 固定档)',
  MSK_TRIM_G1:'NOGPS 档1 慢速 Q_TRIM_PITCH (°), guard 0.5°/s 平滑',
  MSK_TRIM_G2:'NOGPS 档2 驼峰 Q_TRIM_PITCH (°)',
  MSK_TRIM_G3:'NOGPS 档3 巡航 Q_TRIM_PITCH (°), LOG158 优化 11°',
  MSK_TRIM0:  'GPS 速度曲线 T0 V0 静止时目标俯仰 (°)',
  MSK_TRIM1:  'GPS 速度曲线 T1 V1 慢速时目标俯仰 (°)',
  MSK_TRIM2:  'GPS 速度曲线 T2 V2 驼峰时目标俯仰 (°)',
  MSK_TRIM3:  'GPS 速度曲线 T3 V3 巡航低速 (°)',
  MSK_TRIM4:  'GPS 速度曲线 T4 V_MAX 巡航高速 (°)',
  MSK_RTL_CH: 'RTL 返航 RC 通道 (>1500 触发, 仅 KS+KT 低油门, 优先级最高)',
  MSK_RTL_LVL:'RTL 时 KS+KT 油门系数 (0..1, 默认 0.30 缓慢前进)',
  // KS/KDF/KT/KRD 五点
  MSK_KS0: 'S 斜吹 V0 油门系数',  MSK_KS1: 'S 斜吹 V1 油门系数',  MSK_KS2: 'S 斜吹 V2',  MSK_KS3: 'S 斜吹 V3',  MSK_KS4: 'S 斜吹 V_MAX',
  MSK_KDF0:'DF 前下吹 V0',         MSK_KDF1:'DF 前下吹 V1',         MSK_KDF2:'DF 前下吹 V2',MSK_KDF3:'DF 前下吹 V3',MSK_KDF4:'DF 前下吹 V_MAX',
  MSK_KT0: 'T 后推 V0',            MSK_KT1: 'T 后推 V1',            MSK_KT2: 'T 后推 V2',  MSK_KT3: 'T 后推 V3',  MSK_KT4: 'T 后推 V_MAX',
  MSK_KRD0:'RD 后斜吹 V0',          MSK_KRD1:'RD 后斜吹 V1',          MSK_KRD2:'RD 后斜吹 V2',MSK_KRD3:'RD 后斜吹 V3',MSK_KRD4:'RD 后斜吹 V_MAX',

  // ─── TLT_ 倾转舵标定 (PWM 量) ───
  TLT_CPL_SDF_K:    'S→DF 软解耦补偿系数 (0..1)',
  TLT_CPL_EN:       'S→DF 软解耦总开关 (0=关 不补偿允许 S 拖 DF, 1=开 反向补偿默认)',
  TLT_PWM_PER_DEG:  '舵机角度→PWM 斜率 (μs/°), 90° 舵 ≈11.11',
  TLT_DFL_ZERO: 'DFL 中立 PWM (abs=45° 时输出)',  TLT_DFL_DIR: 'DFL 方向 (+1 或 −1, abs↑ 时 PWM↑↓)',
  TLT_DFR_ZERO: 'DFR 中立 PWM',                   TLT_DFR_DIR: 'DFR 方向',
  TLT_TL1_ZERO: 'TL1 中立 PWM',                   TLT_TL1_DIR: 'TL1 方向',
  TLT_TR1_ZERO: 'TR1 中立 PWM',                   TLT_TR1_DIR: 'TR1 方向',
  TLT_RDL_ZERO: 'RDL 中立 PWM',                   TLT_RDL_DIR: 'RDL 方向',
  TLT_RDR_ZERO: 'RDR 中立 PWM',                   TLT_RDR_DIR: 'RDR 方向',
  TLT_SGRP_ZERO:'S 组中立 PWM',                    TLT_SGRP_DIR:'S 组方向',
  TLT_DFL_LMIN: 'DFL 软限位 abs 下界 (°)', TLT_DFL_LMAX: 'DFL 软限位 abs 上界 (°)',
  TLT_DFR_LMIN: 'DFR 软限位 abs 下界',     TLT_DFR_LMAX: 'DFR 软限位 abs 上界',
  TLT_TL1_LMIN: 'TL1 软限位 abs 下界',     TLT_TL1_LMAX: 'TL1 软限位 abs 上界',
  TLT_TR1_LMIN: 'TR1 软限位 abs 下界',     TLT_TR1_LMAX: 'TR1 软限位 abs 上界',
  TLT_RDL_LMIN: 'RDL 软限位 abs 下界',     TLT_RDL_LMAX: 'RDL 软限位 abs 上界',
  TLT_RDR_LMIN: 'RDR 软限位 abs 下界',     TLT_RDR_LMAX: 'RDR 软限位 abs 上界',
  TLT_SGRP_LMIN:'S 组软限位 abs 下界',     TLT_SGRP_LMAX:'S 组软限位 abs 上界',

  // ─── MGEO_ motor 几何系数 ───
  MGEO_SL1_P:'SL1 pitch 基础系数', MGEO_SL1_R:'SL1 roll',           MGEO_SL1_Y:'SL1 yaw',
  MGEO_SL2_P:'SL2 pitch',          MGEO_SL2_R:'SL2 roll',           MGEO_SL2_Y:'SL2 yaw',
  MGEO_SR1_P:'SR1 pitch',          MGEO_SR1_R:'SR1 roll',           MGEO_SR1_Y:'SR1 yaw',
  MGEO_SR2_P:'SR2 pitch',          MGEO_SR2_R:'SR2 roll',           MGEO_SR2_Y:'SR2 yaw',
  MGEO_DFL_P:'DFL pitch (中立位)', MGEO_DFL_R:'DFL roll',           MGEO_DFL_Y:'DFL yaw',
  MGEO_DFR_P:'DFR pitch (中立位)', MGEO_DFR_R:'DFR roll',           MGEO_DFR_Y:'DFR yaw',
  MGEO_TL1_P:'TL1 pitch',          MGEO_TL1_R:'TL1 roll',           MGEO_TL1_Y:'TL1 yaw (主)',
  MGEO_TL2_P:'TL2 pitch',          MGEO_TL2_R:'TL2 roll',           MGEO_TL2_Y:'TL2 yaw',
  MGEO_TR1_P:'TR1 pitch',          MGEO_TR1_R:'TR1 roll',           MGEO_TR1_Y:'TR1 yaw (主)',
  MGEO_TR2_P:'TR2 pitch',          MGEO_TR2_R:'TR2 roll',           MGEO_TR2_Y:'TR2 yaw',
  MGEO_RDL_P:'RDL pitch (中立位)', MGEO_RDL_R:'RDL roll',           MGEO_RDL_Y:'RDL yaw',
  MGEO_RDR_P:'RDR pitch (中立位)', MGEO_RDR_R:'RDR roll',           MGEO_RDR_Y:'RDR yaw',

  // ─── TLTC_ 倾转曲线 ───
  TLTC_DFL_K0:'DFL@V0 abs°',  TLTC_DFL_K1:'DFL@V1 abs°',  TLTC_DFL_K2:'DFL@V2 abs°',  TLTC_DFL_K3:'DFL@V3 abs°',  TLTC_DFL_K4:'DFL@V_MAX abs°',
  TLTC_DFR_K0:'DFR@V0',        TLTC_DFR_K1:'DFR@V1',        TLTC_DFR_K2:'DFR@V2',        TLTC_DFR_K3:'DFR@V3',        TLTC_DFR_K4:'DFR@V_MAX',
  TLTC_TL1_K0:'TL1@V0',        TLTC_TL1_K1:'TL1@V1',        TLTC_TL1_K2:'TL1@V2',        TLTC_TL1_K3:'TL1@V3',        TLTC_TL1_K4:'TL1@V_MAX',
  TLTC_TR1_K0:'TR1@V0',        TLTC_TR1_K1:'TR1@V1',        TLTC_TR1_K2:'TR1@V2',        TLTC_TR1_K3:'TR1@V3',        TLTC_TR1_K4:'TR1@V_MAX',
  TLTC_RDL_K0:'RDL@V0',        TLTC_RDL_K1:'RDL@V1',        TLTC_RDL_K2:'RDL@V2',        TLTC_RDL_K3:'RDL@V3',        TLTC_RDL_K4:'RDL@V_MAX',
  TLTC_RDR_K0:'RDR@V0',        TLTC_RDR_K1:'RDR@V1',        TLTC_RDR_K2:'RDR@V2',        TLTC_RDR_K3:'RDR@V3',        TLTC_RDR_K4:'RDR@V_MAX',
  TLTC_SGRP_K0:'S 组@V0',      TLTC_SGRP_K1:'S 组@V1',       TLTC_SGRP_K2:'S 组@V2',      TLTC_SGRP_K3:'S 组@V3',       TLTC_SGRP_K4:'S 组@V_MAX',

  // ─── GRD_ guard ───
  GRD_TRIM_RATE:'Q_TRIM 推进率 (°/s)',
  GRD_PIT_WARN: '俯仰告警阈值 (°)',
  GRD_ROL_WARN: '横滚告警阈值 (°)',

  // ─── PRE_ preflight ───
  PRE_CH:     '预检 RC 通道 (1-16)',
  PRE_PWM:    '预检电机怠速 PWM (μs)',
  PRE_STOP:   '预检电机停转 PWM (μs)',
  PRE_GRP_MS: '预检每子步时长 (ms)',
  PRE_SWING:  'STAGE 1 tilt 摆动幅度 (相对中立, °)',
  PRE_OVR_DFL: 'DFL 实时预览覆盖 abs° (−1=不覆盖)', PRE_OVR_DFR: 'DFR 预览覆盖',
  PRE_OVR_TL1: 'TL1 预览覆盖',                       PRE_OVR_TR1: 'TR1 预览覆盖',
  PRE_OVR_RDL: 'RDL 预览覆盖',                       PRE_OVR_RDR: 'RDR 预览覆盖',
  PRE_OVR_SGRP:'S 组预览覆盖',
};

export function paramLabel(key: string): string | undefined {
  return PARAM_LABELS[key];
}
