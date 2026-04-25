// 镜像 scripts-plane/actuators.lua ACTUATORS, 用于布局/几何分析.

import type { MotorEntry, TiltConfig, TiltId, PhaseConfig, PhaseName } from './types';

export const MOTORS: MotorEntry[] = [
  { id:'SL1', group:'KS',  geometry:{pitch:0.5, roll: 0.3, yaw:0},    position:{x:-0.20, y:-0.79}, tilt_servo_ch: undefined },
  { id:'SL2', group:'KS',  geometry:{pitch:0.5, roll: 0.3, yaw:0},    position:{x:-0.11, y:-0.79} },
  { id:'SR1', group:'KS',  geometry:{pitch:0.5, roll:-0.3, yaw:0},    position:{x: 0.11, y:-0.79} },
  { id:'SR2', group:'KS',  geometry:{pitch:0.5, roll:-0.3, yaw:0},    position:{x: 0.20, y:-0.79} },
  { id:'DFL', group:'KDF', geometry:{pitch:0.5, roll: 0,   yaw:0},    position:{x:-0.29, y:-0.80}, tilt_servo_ch: 13,
    tilt_range:[-60, 60] },
  { id:'DFR', group:'KDF', geometry:{pitch:0.5, roll: 0,   yaw:0},    position:{x: 0.29, y:-0.80}, tilt_servo_ch: 14,
    tilt_range:[-60, 60] },
  { id:'TL1', group:'KT',  geometry:{pitch:0,   roll: 0,   yaw: 0.5}, position:{x:-0.52, y:-0.28}, tilt_servo_ch: 15 },
  { id:'TL2', group:'KT',  geometry:{pitch:0,   roll: 0,   yaw: 0.36},position:{x:-0.42, y:-0.05} },
  { id:'TR1', group:'KT',  geometry:{pitch:0,   roll: 0,   yaw:-0.5}, position:{x: 0.52, y:-0.28}, tilt_servo_ch: 16 },
  { id:'TR2', group:'KT',  geometry:{pitch:0,   roll: 0,   yaw:-0.36},position:{x: 0.42, y:-0.05} },
  { id:'RDL', group:'KRD', geometry_dynamic:true,
    geometry_at_tilt_0 :{pitch: 0,    roll:0, yaw: 0.25},
    geometry_at_tilt_30:{pitch:-0.5,  roll:0, yaw: 0.2 },
    position:{x:-0.15, y: 0.50}, tilt_servo_ch: 17 },
  { id:'RDR', group:'KRD', geometry_dynamic:true,
    geometry_at_tilt_0 :{pitch: 0,    roll:0, yaw:-0.25},
    geometry_at_tilt_30:{pitch:-0.5,  roll:0, yaw:-0.2 },
    position:{x: 0.15, y: 0.50}, tilt_servo_ch: 18 },
];

// 角度约定: 绝对物理角度 abs_deg (0°=垂直水面 / 45°=中立 / 90°=水平水面).
// 所有 motor 中立位都装到相对水面 45°. 上电后默认全部停在 45° (PWM=ZERO=1500).
// 软限位 LMIN/LMAX 都是绝对角度 (0..180), 总跨度 LMAX-LMIN ≤ 180° (舵机机械行程).
export const TILTS: TiltConfig[] = [
  // S_GROUP 主控 (DFL/DFR 都被 S 拖动, 看 S 状态最先). 全行程 0..90 (垂直 → 水平)
  { id:'S_GROUP_TILT', alias:'SGRP', range:[ 0, 90], servo_ch:19, is_group:true  },
  // DFL/DFR: 受 S→DF 软解耦补偿. 全行程 0..90
  { id:'DFL',          alias:'DFL',  range:[ 0, 90], servo_ch:13, is_group:false },
  { id:'DFR',          alias:'DFR',  range:[ 0, 90], servo_ch:14, is_group:false },
  // T1 实验性: 中立 ±15°
  { id:'TL1',          alias:'TL1',  range:[30, 60], servo_ch:15, is_group:false },
  { id:'TR1',          alias:'TR1',  range:[30, 60], servo_ch:16, is_group:false },
  // RD 后斜下吹: 单向 (15..45°, 中立 → 满下吹)
  { id:'RDL',          alias:'RDL',  range:[15, 45], servo_ch:17, is_group:false },
  { id:'RDR',          alias:'RDR',  range:[15, 45], servo_ch:18, is_group:false },
];

export const TILT_NEUTRAL_ABS_DEG = 45.0;

export const TILT_IDS: TiltId[] = TILTS.map(t => t.id);

export const PHASES: PhaseName[] = ['STATIONARY', 'TAXI', 'CUSHION', 'GROUND_EFFECT', 'EMERGENCY'];

// 阶段默认 tilt 角度 (abs_deg, 45° = 中立). 与 phases.lua PHASE_CONFIG 对齐.
export const DEFAULT_PHASE_CONFIG: Record<PhaseName, PhaseConfig> = {
  STATIONARY:    { trim: 5,  tilts: { DFL:45, DFR:45, TL1:45, TR1:45, RDL:45, RDR:45, S_GROUP_TILT:45 } },
  TAXI:          { trim: 5,  tilts: { DFL:45, DFR:45, TL1:45, TR1:45, RDL:15, RDR:15, S_GROUP_TILT:90 } },
  CUSHION:       { trim: 9,  tilts: { DFL:55, DFR:55, TL1:45, TR1:45, RDL:30, RDR:30, S_GROUP_TILT:60 } },
  GROUND_EFFECT: { trim: 11, tilts: { DFL:50, DFR:50, TL1:45, TR1:45, RDL:45, RDR:45, S_GROUP_TILT:45 } },
  EMERGENCY:     { trim: 0,  tilts: { DFL:45, DFR:45, TL1:45, TR1:45, RDL:45, RDR:45, S_GROUP_TILT:45 } },
};

export const GROUP_COLORS: Record<string, string> = {
  KS:  '#58b4ff',
  KDF: '#ffa657',
  KT:  '#7ee787',
  KRD: '#ff7b72',
};

export const GROUP_LABELS: Record<string, string> = {
  KS:  'S 斜吹',
  KDF: 'DF 前下吹',
  KT:  'T 后推',
  KRD: 'RD 后斜下吹',
};

// 单涵道满推 N @ 6S 满电 (QF2822 2300KV 64mm)
export const SINGLE_MOTOR_MAX_N = 23.25;
export const VEHICLE_WEIGHT_N = 98;
