// 动态 geometry — Lua geometry.lua 的 TS 镜像. 公式必须保持一致.
// tilt 角度 → 实际 pitch/roll/yaw 系数 (cos/sin 分解).

import type { GroupKey } from './types';

export interface AxisCoeffs {
  pitch: number;
  roll: number;
  yaw: number;
}

export type MotorId =
  | 'SL1' | 'SL2' | 'SR1' | 'SR2'
  | 'DFL' | 'DFR'
  | 'TL1' | 'TL2' | 'TR1' | 'TR2'
  | 'RDL' | 'RDR';

const DEG2RAD = Math.PI / 180.0;

/**
 * 动态 geometry: 根据 tilt 角度算 effective 轴贡献.
 * 与 scripts-plane/geometry.lua 同步.
 *
 * @param motorId - 12 motor ID
 * @param tiltDeg - 当前 tilt 舵机角度 (机体系)
 *                  - DFL/DFR/TL1/TR1: 中立 0°, ±60° 对称
 *                  - SL/SR (S_GROUP 控制): 中立 45°, 0..90°
 *                  - RDL/RDR: 0..30° 单向
 *                  - 其他无 tilt motor: 此参数被忽略
 * @param base - { pitch, roll, yaw } base coefficients (motor 在 tilt 中立位的轴贡献)
 * @returns 修正后 effective coefficients
 */
export function dynamicGeometry(motorId: MotorId, tiltDeg: number, base: AxisCoeffs): AxisCoeffs {
  const p = base.pitch ?? 0;
  const r = base.roll ?? 0;
  const y = base.yaw ?? 0;

  // DFL/DFR: pitch ~ cos, yaw ~ sin × side
  if (motorId === 'DFL' || motorId === 'DFR') {
    const side = motorId === 'DFR' ? 1 : -1;
    const rad = tiltDeg * DEG2RAD;
    return {
      pitch: p * Math.cos(rad),
      roll: r,
      yaw: y + p * Math.sin(rad) * side,
    };
  }

  // SL/SR (S_GROUP 控制): tiltDeg 是用户偏移 (0 = 中立)
  if (motorId === 'SL1' || motorId === 'SL2' || motorId === 'SR1' || motorId === 'SR2') {
    const side = motorId.startsWith('SR') ? 1 : -1;
    const rad = tiltDeg * DEG2RAD;
    return {
      pitch: p * Math.cos(rad),
      roll: r,
      yaw: y + p * Math.sin(rad) * side,
    };
  }

  // TL1/TR1: 主 yaw, tilt 改 pitch
  if (motorId === 'TL1' || motorId === 'TR1') {
    const side = motorId === 'TR1' ? 1 : -1;
    const rad = tiltDeg * DEG2RAD;
    return {
      pitch: p + y * Math.sin(rad) * (-side),
      roll: r,
      yaw: y * Math.cos(rad),
    };
  }

  // RDL/RDR: 0..30° 兼容 v8 旧线性插值
  if (motorId === 'RDL' || motorId === 'RDR') {
    const t = Math.max(0, Math.min(1, tiltDeg / 30.0));
    return {
      pitch: -0.5 * t,
      roll: r,
      yaw: y * (1.0 - 0.2 * t),
    };
  }

  // 静态 (SL2/SR2/TL2/TR2)
  return { pitch: p, roll: r, yaw: y };
}

/**
 * Helper: 给定 motor ID + 当前所有 tilt 角度, 返回 effective base.
 * 用于 motor 与 tilt servo 的关联查询.
 */
export function tiltForMotor(
  motorId: MotorId,
  tilts: Record<string, number>,
): number {
  switch (motorId) {
    case 'SL1': case 'SL2': case 'SR1': case 'SR2':
      return tilts.S_GROUP_TILT ?? 0;  // 用户视角 0 = 中立 (机械 45°)
    case 'DFL': return tilts.DFL ?? 0;
    case 'DFR': return tilts.DFR ?? 0;
    case 'TL1': return tilts.TL1 ?? 0;
    case 'TR1': return tilts.TR1 ?? 0;
    case 'RDL': return tilts.RDL ?? 0;
    case 'RDR': return tilts.RDR ?? 0;
    default: return 0;  // SL2/SR2/TL2/TR2: 无 tilt
  }
}
