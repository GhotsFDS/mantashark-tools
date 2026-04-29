// FlightProfile Pull/Save 逻辑测试 — mock gcs, 不接真飞控
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { FlightProfile } from '../components/tabs/FlightProfile';
import { useStore } from '../store/useStore';
import { gcs } from '../lib/gcs';

// 把 gcs 模块整体 mock 掉, 控制 isConnected/pullParams/pushParams/on
vi.mock('../lib/gcs', () => {
  const listeners = new Set<(m: any) => void>();
  return {
    gcs: {
      isConnected: vi.fn(() => true),
      pullParams: vi.fn(),
      pushParams: vi.fn(),
      setParam: vi.fn(),
      on: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
      _emit: (m: any) => { for (const l of listeners) l(m); },
    },
  };
});

const initialPaste: Record<string, number> = {
  // 飞行配置 50 个 key 的 default snapshot (跟 lua mixer.lua / tilt_driver.lua 对齐)
  MSK_BPCH_G1: 5, MSK_BPCH_G2: 11, MSK_BPCH_G3: 8,
  MSK_KS_G1: 0.20, MSK_KS_G2: 0.40, MSK_KS_G3: 0.55,
  MSK_KDF_G1: 0.10, MSK_KDF_G2: 0.30, MSK_KDF_G3: 0.40,
  MSK_KT_G1: 0.30, MSK_KT_G2: 0.55, MSK_KT_G3: 0.85,
  MSK_KRD_G1: 0.05, MSK_KRD_G2: 0.20, MSK_KRD_G3: 0.30,
  TLT_DFL_G1: 60, TLT_DFL_G2: 30, TLT_DFL_G3: 45,
  TLT_DFR_G1: 60, TLT_DFR_G2: 30, TLT_DFR_G3: 45,
  TLT_TL1_G1: 90, TLT_TL1_G2: 90, TLT_TL1_G3: 90,
  TLT_TR1_G1: 90, TLT_TR1_G2: 90, TLT_TR1_G3: 90,
  TLT_RDL_G1: 30, TLT_RDL_G2: 90, TLT_RDL_G3: 15,
  TLT_RDR_G1: 30, TLT_RDR_G2: 90, TLT_RDR_G3: 15,
  TLT_SGRP_G1: 45, TLT_SGRP_G2: 60, TLT_SGRP_G3: 30,
  TLT_RATE: 30, MSK_TRIM_RATE: 3.0,
  MSK_FB_EN: 1, MSK_FB_P_SC: 5, MSK_FB_R_SC: 5, MSK_FB_V_SC: 8,
  MSK_KT_LIM: 1.0, MSK_L2_SGRP_RT: 5.0, MSK_L2_RD_RT: 3.0, MSK_K_DRFT_RT: 0.01,
  MSK_V_TGT: 9.0, MSK_V_PI_P: 0.05, MSK_V_PI_I: 0.02, MSK_V_PI_D: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  // 默认连接状态 true (前一个测试可能改成 false, 必须每次重置)
  (gcs.isConnected as any).mockReturnValue(true);
  // 把 50 个 key 写进 store, 当作"已从 FC 拉过"
  const setParam = useStore.getState().setParam;
  for (const [k, v] of Object.entries(initialPaste)) setParam(k, v);
});

describe('FlightProfile Pull/Save', () => {
  it('初次渲染 dirty=0 (synced 快照与 store 一致), 按钮文案 "保存 (0)"', async () => {
    render(<FlightProfile />);
    // 等 useEffect 1.5s 把 synced 重置为当前 params (mock isConnected=true)
    await act(async () => { await new Promise(r => setTimeout(r, 1700)); });
    const saveBtn = screen.getByTitle(/把本地修改下发到飞控/);
    expect(saveBtn.textContent).toMatch(/保存\s*\(0\)/);
    expect(screen.getByText('与 FC 一致')).toBeInTheDocument();
  });

  it('改一个 K 值 → dirty=1, 状态显示 "未保存 1 项"', async () => {
    render(<FlightProfile />);
    await act(async () => { await new Promise(r => setTimeout(r, 1700)); });

    // 直接通过 store 改值 (模拟用户在 NumInput 提交)
    act(() => { useStore.getState().setParam('MSK_KT_G3', 0.90); });

    await waitFor(() => {
      expect(screen.getByText(/未保存\s*1\s*项/)).toBeInTheDocument();
    });
  });

  it('按拉取 → 调 gcs.pullParams 50 个 key, 进度回调更新文案', async () => {
    (gcs.pullParams as any).mockImplementation(async (_keys: string[], onProgress: any) => {
      onProgress?.(10, 50);
      onProgress?.(50, 50);
      return { got: 50, missing: [], timedOut: false };
    });
    render(<FlightProfile />);
    await act(async () => { await new Promise(r => setTimeout(r, 1700)); });

    const pullBtn = screen.getByTitle(/从飞控读取/);
    await act(async () => { fireEvent.click(pullBtn); });

    expect(gcs.pullParams).toHaveBeenCalledTimes(1);
    const calledKeys = (gcs.pullParams as any).mock.calls[0][0];
    expect(calledKeys.length).toBe(50);

    await waitFor(() => {
      expect(screen.getByText(/已拉取 50/)).toBeInTheDocument();
    });
  });

  it('按拉取超时 → 状态显示警告', async () => {
    (gcs.pullParams as any).mockResolvedValue({ got: 30, missing: ['x','y'], timedOut: true });
    render(<FlightProfile />);
    await act(async () => { await new Promise(r => setTimeout(r, 1700)); });

    fireEvent.click(screen.getByTitle(/从飞控读取/));
    await waitFor(() => {
      expect(screen.getByText(/拉取超时 30/)).toBeInTheDocument();
    });
  });

  it('保存只推 dirty 项 (没改的不推)', async () => {
    (gcs.pushParams as any).mockResolvedValue({ acked: 1, missing: [], timedOut: false });
    render(<FlightProfile />);
    await act(async () => { await new Promise(r => setTimeout(r, 1700)); });

    // 改 1 个值
    act(() => { useStore.getState().setParam('MSK_BPCH_G2', 12.5); });
    await waitFor(() => screen.getByText(/未保存\s*1\s*项/));

    fireEvent.click(screen.getByTitle(/把本地修改下发到飞控/));

    await waitFor(() => expect(gcs.pushParams).toHaveBeenCalledTimes(1));
    const pushedMap = (gcs.pushParams as any).mock.calls[0][0];
    expect(Object.keys(pushedMap)).toEqual(['MSK_BPCH_G2']);
    expect(pushedMap['MSK_BPCH_G2']).toBe(12.5);
  });

  it('保存部分 ack → 未 ack 的留在 dirty', async () => {
    (gcs.pushParams as any).mockResolvedValue({
      acked: 1, missing: ['MSK_KT_G3'], timedOut: false,
    });
    render(<FlightProfile />);
    await act(async () => { await new Promise(r => setTimeout(r, 1700)); });

    // 改 2 个值, 一个会 ack 一个不会
    act(() => {
      useStore.getState().setParam('MSK_BPCH_G2', 12.5);
      useStore.getState().setParam('MSK_KT_G3', 0.95);
    });
    await waitFor(() => screen.getByText(/未保存\s*2\s*项/));

    fireEvent.click(screen.getByTitle(/把本地修改下发到飞控/));

    await waitFor(() => {
      // 只剩 MSK_KT_G3 未 ack
      expect(screen.getByText(/未保存\s*1\s*项/)).toBeInTheDocument();
    });
  });

  it('未连接 FC 时按钮显示警告, 不调 gcs.pullParams', async () => {
    (gcs.isConnected as any).mockReturnValue(false);
    render(<FlightProfile />);
    await act(async () => { await new Promise(r => setTimeout(r, 100)); });

    fireEvent.click(screen.getByTitle(/从飞控读取/));
    await waitFor(() => {
      expect(screen.getByText(/未连接 FC/)).toBeInTheDocument();
    });
    expect(gcs.pullParams).not.toHaveBeenCalled();
  });

  it('保存按钮 dirty=0 时禁用', async () => {
    render(<FlightProfile />);
    await act(async () => { await new Promise(r => setTimeout(r, 1700)); });

    const saveBtn = screen.getByTitle(/把本地修改下发到飞控/) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    act(() => { useStore.getState().setParam('MSK_TRIM_RATE', 5); });
    await waitFor(() => expect(saveBtn.disabled).toBe(false));
  });

  it('FLIGHT_KEYS 数量恰好 50 (跟 lua mixer.lua 32 + tilt_driver.lua 22 减去无关项)', async () => {
    (gcs.pullParams as any).mockResolvedValue({ got: 50, missing: [], timedOut: false });
    render(<FlightProfile />);
    await act(async () => { await new Promise(r => setTimeout(r, 1700)); });

    fireEvent.click(screen.getByTitle(/从飞控读取/));
    await waitFor(() => expect(gcs.pullParams).toHaveBeenCalled());
    const calledKeys: string[] = (gcs.pullParams as any).mock.calls[0][0];
    expect(calledKeys.length).toBe(50);
    // 关键 key 都在 (回归保护: 漏 1 个 lua 永远收不到 PARAM_VALUE → 永远超时)
    for (const must of ['MSK_BPCH_G1','MSK_KT_G3','MSK_V_TGT','TLT_RATE','MSK_TRIM_RATE','MSK_K_DRFT_RT','TLT_SGRP_G3']) {
      expect(calledKeys).toContain(must);
    }
  });
});
