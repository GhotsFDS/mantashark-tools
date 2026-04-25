export type GroupKey = 'KS' | 'KDF' | 'KT' | 'KRD';
export type TiltId = 'DFL' | 'DFR' | 'TL1' | 'TR1' | 'RDL' | 'RDR' | 'S_GROUP_TILT';
export type TiltAlias = 'DFL' | 'DFR' | 'TL1' | 'TR1' | 'RDL' | 'RDR' | 'SGRP';
export type PhaseName = 'STATIONARY' | 'TAXI' | 'CUSHION' | 'GROUND_EFFECT' | 'EMERGENCY';

export interface MotorEntry {
  id: string;
  group: GroupKey;
  position: { x: number; y: number };  // 机体系, +y 前, +x 右
  geometry?: { pitch: number; roll: number; yaw: number };
  geometry_dynamic?: boolean;
  geometry_at_tilt_0?: { pitch: number; roll: number; yaw: number };
  geometry_at_tilt_30?: { pitch: number; roll: number; yaw: number };
  tilt_servo_ch?: number;
  tilt_range?: [number, number];
}

export interface TiltConfig {
  id: TiltId;
  alias: TiltAlias;
  range: [number, number];
  servo_ch: number;
  is_group: boolean;
}

export interface PhaseConfig {
  trim: number;
  tilts: Record<TiltId, number>;
}

export type ParamSet = Record<string, number>;

export interface AppState {
  params: ParamSet;
  phaseConfig: Record<PhaseName, PhaseConfig>;
  currentSpeed: number;
  currentGear: 1 | 2 | 3;
  currentPhase: PhaseName;
  phaseAutoSync: boolean;
  simulateArmed: boolean;
  selectedCurve: GroupKey;
  selectedTiltCurve: TiltAlias;
  curveMode: 'k' | 'tilt';
  tiltPreview: Record<TiltId, number>;
  analysisRdTilt: number;
  analysisSGroup: number;
  analysisDfTarget: number;
  analysisTilts: Record<TiltId, number>;   // 7 路 tilt 分析滑杆
  currentTab: string;
}
