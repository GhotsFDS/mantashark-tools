import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store/useStore';

describe('useStore (zustand)', () => {
  beforeEach(() => {
    // 测试间重置 store 到默认 (避免测试相互污染)
    useStore.getState().resetDefaults();
    useStore.setState({ globalPreviewMode: false });
  });

  it('setGlobalPreviewMode 切换状态', () => {
    expect(useStore.getState().globalPreviewMode).toBe(false);
    useStore.getState().setGlobalPreviewMode(true);
    expect(useStore.getState().globalPreviewMode).toBe(true);
    useStore.getState().setGlobalPreviewMode(false);
    expect(useStore.getState().globalPreviewMode).toBe(false);
  });

  it('setTiltPreview 仅改单舵机, 其他不变', () => {
    useStore.getState().setTiltPreview('DFL', 60);
    const tp = useStore.getState().tiltPreview;
    expect(tp.DFL).toBe(60);
    expect(tp.DFR).toBe(45);                 // 默认未变
    expect(tp.S_GROUP_TILT).toBe(45);
  });

  it('setParam 仅改单参数', () => {
    useStore.getState().setParam('MSK_BPCH_G1', 7);
    expect(useStore.getState().params.MSK_BPCH_G1).toBe(7);
    expect(useStore.getState().params.MSK_BPCH_G2).toBe(11);  // 默认未变
  });

  it('setParams 批量 merge (不覆盖未提供的 key)', () => {
    useStore.getState().setParams({ MSK_BPCH_G1: 6, MSK_BPCH_G3: 9 });
    const p = useStore.getState().params;
    expect(p.MSK_BPCH_G1).toBe(6);
    expect(p.MSK_BPCH_G3).toBe(9);
    expect(p.MSK_BPCH_G2).toBe(11);
  });

  it('resetDefaults 恢复全默认', () => {
    useStore.getState().setParam('MSK_BPCH_G1', 99);
    expect(useStore.getState().params.MSK_BPCH_G1).toBe(99);
    useStore.getState().resetDefaults();
    expect(useStore.getState().params.MSK_BPCH_G1).toBe(5);
  });
});
