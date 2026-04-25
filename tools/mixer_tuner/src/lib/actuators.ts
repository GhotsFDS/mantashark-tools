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

// 用户视角: 所有 tilt 0 = 中立 (PWM=ZERO=1500). 机械绝对角由 ZERO 标定决定.
// + 方向 = 趋向水平于地面, − 方向 = 趋向垂直于地面 (PWM 变化方向由 DIR 标定).
// 软限位 LMIN/LMAX 各自独立调, 但 |LMIN| + |LMAX| ≤ 180° (180° 舵机总行程上限).
export const TILTS: TiltConfig[] = [
  // S_GROUP 第一位: 主控装置 (DFL/DFR 都被 S 拖动, 看 S 状态最先)
  { id:'S_GROUP_TILT', alias:'SGRP', range:[-90, 90], servo_ch:19, is_group:true  },
  // DFL/DFR: 受 S→DF 软解耦补偿. 180° 舵机全行程
  { id:'DFL',          alias:'DFL',  range:[-90, 90], servo_ch:13, is_group:false },
  { id:'DFR',          alias:'DFR',  range:[-90, 90], servo_ch:14, is_group:false },
  // T1 实验性
  { id:'TL1',          alias:'TL1',  range:[-15, 15], servo_ch:15, is_group:false },
  { id:'TR1',          alias:'TR1',  range:[-15, 15], servo_ch:16, is_group:false },
  // RD 后斜下吹: 仅单向 (− 朝下吹)
  { id:'RDL',          alias:'RDL',  range:[-30,  0], servo_ch:17, is_group:false },
  { id:'RDR',          alias:'RDR',  range:[-30,  0], servo_ch:18, is_group:false },
];

export const TILT_IDS: TiltId[] = TILTS.map(t => t.id);

export const PHASES: PhaseName[] = ['STATIONARY', 'TAXI', 'CUSHION', 'GROUND_EFFECT', 'EMERGENCY'];

export const DEFAULT_PHASE_CONFIG: Record<PhaseName, PhaseConfig> = {
  STATIONARY:    { trim: 0,  tilts: { DFL:0, DFR:0, TL1:0, TR1:0, RDL:0,  RDR:0,  S_GROUP_TILT:0  } },
  TAXI:          { trim: 5,  tilts: { DFL:0, DFR:0, TL1:0, TR1:0, RDL:30, RDR:30, S_GROUP_TILT:45 } },
  CUSHION:       { trim: 9,  tilts: { DFL:10,DFR:10,TL1:0, TR1:0, RDL:15, RDR:15, S_GROUP_TILT:15 } },
  GROUND_EFFECT: { trim: 11, tilts: { DFL:5, DFR:5, TL1:0, TR1:0, RDL:0,  RDR:0,  S_GROUP_TILT:0  } },
  EMERGENCY:     { trim: 0,  tilts: { DFL:0, DFR:0, TL1:0, TR1:0, RDL:0,  RDR:0,  S_GROUP_TILT:0  } },
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
