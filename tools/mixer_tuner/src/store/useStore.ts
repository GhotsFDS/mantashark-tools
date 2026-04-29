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
  setCurveMode: (m: 'k' | 'tilt' | 'joint') => void;
  setMergeLR: (v: boolean) => void;
  setTab: (t: string) => void;
  setTiltPreview: (id: TiltId, v: number) => void;
  setGlobalPreviewMode: (v: boolean) => void;
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
  simulateArmed: false,                            // 默认 false: 未连接 FC 时允许离线预览; 连接后由 heartbeat 实时驱动
  selectedCurve: 'KS',
  selectedTiltCurve: 'SGRP',
  curveMode: 'k',
  mergeLR: true,                                   // 默认合并左右
  currentTab: 'gcs',
  // 默认全 45° (绝对物理角度 = 中立)
  tiltPreview: { DFL:45, DFR:45, TL1:45, TR1:45, RDL:45, RDR:45, S_GROUP_TILT:45 },
  globalPreviewMode: false,                              // 默认关 (下水初始状态, 全部 G1 默认位)
  analysisRdTilt: 45,
  analysisSGroup: 45,
  analysisDfTarget: 55,                                  // 中立稍偏水平
  analysisTilts: { DFL:45, DFR:45, TL1:45, TR1:45, RDL:45, RDR:45, S_GROUP_TILT:45 },
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
      setMergeLR: (v) => set({ mergeLR: v }),
      setTab: (t) => set({ currentTab: t }),

      setTiltPreview: (id, v) => set(s => ({ tiltPreview: { ...s.tiltPreview, [id]: v } })),

      setGlobalPreviewMode: (v) => set({ globalPreviewMode: v }),

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
    {
      name: 'mantashark-tuner-v9',
      // Bumping version: 旧的 persisted state 会被 migrate() 处理. 改 schema 时 +1 强制清旧坏数据.
      version: 7,
      migrate: (persisted: any, version: number) => {
        // v3 之前: selectedCurve 可能存了非法值导致崩溃 → 重置 UI 状态.
        // v4: simulateArmed 默认值改 false (旧的 true 会卡住调参 UI 显示"已 armed").
        // v5: 加 globalPreviewMode (默认 false, 下水初始状态)
        // v6: DEFAULT_PARAMS 加 5 个 PRE_* 等新 key, 强制把缺的 key 用 default 补齐
        if (!persisted || version < 3) {
          persisted = {
            ...(persisted || {}),
            selectedCurve: 'KS',
            selectedTiltCurve: 'SGRP',
            curveMode: 'k',
            currentTab: 'gcs',
          };
        }
        if (!persisted || version < 4) {
          persisted = { ...(persisted || {}), simulateArmed: false };
        }
        if (!persisted || version < 5) {
          persisted = { ...(persisted || {}), globalPreviewMode: false };
        }
        if (!persisted || version < 6) {
          // 把 DEFAULT_PARAMS 缺失的 key 全部补回 (老 localStorage params 缺了新加的就显示不出)
          // 已存在的 key 保留用户值, 不覆盖
          persisted = {
            ...persisted,
            params: { ...DEFAULT_PARAMS, ...(persisted?.params || {}) },
          };
        }
        if (!persisted || version < 7) {
          // v7: 严格清 store, 只保留 DEFAULT_PARAMS 里有的 key (删旧 schema 残留:
          // 4 老 K MSK_KS/KDF/KT/KRD, MSK_GEAR_CH/AUTO_CH/MODE_CH/RTL_CH, MSK_V1/V2/V3/V_MAX,
          // GRD_*/MGEO_*/TLTC_* 等等). 缺的 key 用 default 补。
          if (persisted.params) {
            const cleaned: Record<string, number> = {};
            for (const k of Object.keys(DEFAULT_PARAMS)) {
              cleaned[k] = (k in persisted.params) ? persisted.params[k] : DEFAULT_PARAMS[k];
            }
            persisted.params = cleaned;
          }
        }
        return persisted;
      },
      // 校验阀: 加载时检查关键枚举字段, 任一非法直接重置该字段, 不让坏值传到 React.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const K_KEYS = ['KS','KDF','KT','KRD'];
        const TILT_ALIASES_OK = ['SGRP','DFL','DFR','TL1','TR1','RDL','RDR'];
        const MODES_OK = ['k','tilt','joint'];
        const TABS_OK = ['gcs','profile','tilts','geometry','force','preflight','params'];
        const PHASES_OK = ['STATIONARY','TAXI','CUSHION','GROUND_EFFECT','EMERGENCY'];
        if (!K_KEYS.includes(state.selectedCurve as string))         state.selectedCurve = 'KS';
        if (!TILT_ALIASES_OK.includes(state.selectedTiltCurve as string)) state.selectedTiltCurve = 'SGRP';
        if (!MODES_OK.includes(state.curveMode as string))           state.curveMode = 'k';
        if (!TABS_OK.includes(state.currentTab))                     state.currentTab = 'gcs';
        if (!PHASES_OK.includes(state.currentPhase as string))       state.currentPhase = 'STATIONARY';
      },
    },
  ),
);

// 紧急重置: 用户加 ?reset=1 进 URL → 清持久化, 刷新即恢复全默认
if (typeof window !== 'undefined') {
  const sp = new URLSearchParams(window.location.search);
  if (sp.get('reset') === '1') {
    try { localStorage.removeItem('mantashark-tuner-v9'); } catch {}
    sp.delete('reset');
    const q = sp.toString();
    window.location.replace(window.location.pathname + (q ? '?' + q : ''));
  }
  // 全局兜底: 任意 React 渲染抛错时清持久化 + 刷新
  (window as any).__mskResetStore = () => {
    try { localStorage.removeItem('mantashark-tuner-v9'); } catch {}
    location.reload();
  };
}

export { PHASES };
