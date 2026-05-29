// 动态 geometry — Lua geometry.lua 的 TS 镜像. 公式必须保持一致.
// 输入: 绝对物理角度 abs_deg (0=垂直水面, 45=中立, 90=水平水面).

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
export const NEUTRAL_ABS_DEG = 45.0;

/**
 * 动态 geometry: 根据绝对物理角度算 effective 轴贡献.
 *
 * @param motorId  - 12 motor ID
 * @param absDeg   - 绝对物理角度 (0=垂直水面, 45=中立, 90=水平水面)
 * @param base     - { pitch, roll, yaw } base coefficients (motor 中立位 abs=45° 时的轴贡献)
 * @returns 修正后 effective coefficients
 */
export function dynamicGeometry(motorId: MotorId, absDeg: number, base: AxisCoeffs): AxisCoeffs {
  const p = base.pitch ?? 0;
  const r = base.roll ?? 0;
  const y = base.yaw ?? 0;
  const offset = (absDeg ?? NEUTRAL_ABS_DEG) - NEUTRAL_ABS_DEG;
  const rad = offset * DEG2RAD;

  // DFL/DFR: pitch ~ cos, yaw ~ sin × side
  if (motorId === 'DFL' || motorId === 'DFR') {
    const side = motorId === 'DFR' ? 1 : -1;
    return {
      pitch: p * Math.cos(rad),
      roll: r,
      yaw: y + p * Math.sin(rad) * side,
    };
  }

  // SL/SR (S_GROUP 控制)
  if (motorId === 'SL1' || motorId === 'SL2' || motorId === 'SR1' || motorId === 'SR2') {
    const side = motorId.startsWith('SR') ? 1 : -1;
    return {
      pitch: p * Math.cos(rad),
      roll: r,
      yaw: y + p * Math.sin(rad) * side,
    };
  }

  // TL1/TR1: 主 yaw, tilt 改 pitch
  if (motorId === 'TL1' || motorId === 'TR1') {
    const side = motorId === 'TR1' ? 1 : -1;
    return {
      pitch: p + y * Math.sin(rad) * (-side),
      roll: r,
      yaw: y * Math.cos(rad),
    };
  }

  // RDL/RDR: abs ∈ 15..45° (单向). abs=45 t=0 (中立), abs=15 t=1 (满下吹).
  if (motorId === 'RDL' || motorId === 'RDR') {
    const t = Math.max(0, Math.min(1, (NEUTRAL_ABS_DEG - (absDeg ?? NEUTRAL_ABS_DEG)) / 30.0));
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
 * Helper: 给定 motor ID + 当前所有 tilt 角度 (abs_deg), 返回该 motor 看到的 abs_deg.
 */
export function tiltForMotor(
  motorId: MotorId,
  tilts: Record<string, number>,
): number {
  switch (motorId) {
    case 'SL1': case 'SL2': case 'SR1': case 'SR2':
      return tilts.S_GROUP_TILT ?? NEUTRAL_ABS_DEG;
    case 'DFL': return tilts.DFL ?? NEUTRAL_ABS_DEG;
    case 'DFR': return tilts.DFR ?? NEUTRAL_ABS_DEG;
    case 'TL1': return tilts.TL1 ?? NEUTRAL_ABS_DEG;
    case 'TR1': return tilts.TR1 ?? NEUTRAL_ABS_DEG;
    case 'RDL': return tilts.RDL ?? NEUTRAL_ABS_DEG;
    case 'RDR': return tilts.RDR ?? NEUTRAL_ABS_DEG;
    default: return NEUTRAL_ABS_DEG;
  }
}
