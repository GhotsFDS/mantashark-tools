// Zustand store with persist.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppState, GroupKey, PhaseName, TiltId, TiltAlias } from '../lib/types';
import { DEFAULT_PARAMS } from '../lib/defaults';
import { DEFAULT_PHASE_CONFIG, PHASES } from '../lib/actuators';

interface Actions {
  setParam: (k: string, v: number) => void;
  setParams: (p: Record<string, number>) => void;
  setSpeed: (v: number) => void;
  setGear: (g: 1 | 2 | 3) => void;
  setPhase: (p: PhaseName) => void;
  setPhaseAutoSync: (v: boolean) => void;
  setSimulateArmed: (v: boolean) => void;
  setSelectedCurve: (c: GroupKey) => void;
  setSelectedTiltCurve: (c: TiltAlias) => void;
  setCurveMode: (m: 'k' | 'tilt') => void;
  setTab: (t: string) => void;
  setTiltPreview: (id: TiltId, v: number) => void;
  setPhaseConfig: (p: PhaseName, field: 'trim' | TiltId, v: number) => void;
  setAnalysisRdTilt: (v: number) => void;
  setAnalysisSGroup: (v: number) => void;
  setAnalysisDfTarget: (v: number) => void;
  setAnalysisTilt: (id: TiltId, v: number) => void;
  resetDefaults: () => void;
  autoUpdatePhase: () => void;
}

const INITIAL: AppState = {
  params: { ...DEFAULT_PARAMS },
  phaseConfig: JSON.parse(JSON.stringify(DEFAULT_PHASE_CONFIG)),
  currentSpeed: 0,
  currentGear: 3,
  currentPhase: 'STATIONARY',
  phaseAutoSync: true,
  simulateArmed: true,
  selectedCurve: 'KS',
  selectedTiltCurve: 'SGRP',
  curveMode: 'k',
  currentTab: 'overview',
  tiltPreview: { DFL:0, DFR:0, TL1:0, TR1:0, RDL:0, RDR:0, S_GROUP_TILT:0 },
  analysisRdTilt: 0,
  analysisSGroup: 0,
  analysisDfTarget: 10,
  analysisTilts: { DFL:0, DFR:0, TL1:0, TR1:0, RDL:0, RDR:0, S_GROUP_TILT:0 },
};

export const useStore = create<AppState & Actions>()(
  persist(
    (set, get) => ({
      ...INITIAL,

      setParam: (k, v) => set(s => ({ params: { ...s.params, [k]: v } })),
      setParams: (p) => set(s => ({ params: { ...s.params, ...p } })),

      setSpeed: (v) => {
        set({ currentSpeed: v });
        get().autoUpdatePhase();
      },
      setGear: (g) => set({ currentGear: g }),
      setPhase: (p) => set({ currentPhase: p }),
      setPhaseAutoSync: (v) => { set({ phaseAutoSync: v }); if (v) get().autoUpdatePhase(); },
      setSimulateArmed: (v) => { set({ simulateArmed: v }); get().autoUpdatePhase(); },
      setSelectedCurve: (c) => set({ selectedCurve: c }),
      setSelectedTiltCurve: (c) => set({ selectedTiltCurve: c }),
      setCurveMode: (m) => set({ curveMode: m }),
      setTab: (t) => set({ currentTab: t }),

      setTiltPreview: (id, v) => set(s => ({ tiltPreview: { ...s.tiltPreview, [id]: v } })),

      setPhaseConfig: (p, field, v) => set(s => {
        const pc = { ...s.phaseConfig };
        if (field === 'trim') pc[p] = { ...pc[p], trim: v };
        else pc[p] = { ...pc[p], tilts: { ...pc[p].tilts, [field]: v } };
        return { phaseConfig: pc };
      }),

      setAnalysisRdTilt:   (v) => set({ analysisRdTilt: v }),
      setAnalysisSGroup:   (v) => set({ analysisSGroup: v }),
      setAnalysisDfTarget: (v) => set({ analysisDfTarget: v }),
      setAnalysisTilt:     (id, v) => set(s => ({ analysisTilts: { ...s.analysisTilts, [id]: v } })),

      resetDefaults: () => set({
        params: { ...DEFAULT_PARAMS },
        phaseConfig: JSON.parse(JSON.stringify(DEFAULT_PHASE_CONFIG)),
      }),

      autoUpdatePhase: () => {
        const s = get();
        if (!s.phaseAutoSync) return;
        if (!s.simulateArmed) { set({ currentPhase: 'STATIONARY' }); return; }
        const spd = s.currentSpeed;
        const V1 = s.params.MSK_V1, V2 = s.params.MSK_V2;
        const prev = s.currentPhase;
        let next: PhaseName = prev;
        if (prev === 'STATIONARY' && spd > 0.5) next = 'TAXI';
        else if (prev === 'TAXI') {
          if (spd < 0.3) next = 'STATIONARY';
          else if (spd > V1 - 0.5) next = 'CUSHION';
        } else if (prev === 'CUSHION') {
          if (spd < V1 - 1.5) next = 'TAXI';
          else if (spd > V2 - 0.5) next = 'GROUND_EFFECT';
        } else if (prev === 'GROUND_EFFECT') {
          if (spd < V2 - 1.5) next = 'CUSHION';
        }
        if (next !== prev) set({ currentPhase: next });
      },
    }),
    { name: 'mantashark-tuner-v9' },
  ),
);

export { PHASES };
