import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock WebSocket: 在 jsdom 里 WebSocket 是真的会去连 ws://, 测试要 mock
class MockWS {
  url: string;
  readyState: number = 1;                   // OPEN
  static instances: MockWS[] = [];
  sent: any[] = [];
  onopen: ((e?: any) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: any) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
  // 模拟 mavbridge 推 PARAM_VALUE 回流
  emitParam(name: string, value: number) {
    this.onmessage?.({ data: JSON.stringify({ type: 'param', name, value }) });
  }
}

(globalThis as any).WebSocket = MockWS;
(MockWS as any).OPEN = 1;
(MockWS as any).CLOSED = 3;

// 重新 import (避免单例污染)
async function freshGcs() {
  vi.resetModules();
  MockWS.instances = [];
  const m = await import('../lib/gcs');
  return m.gcs;
}

describe('gcs.pullParams / pushParams', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('pullParams: 全部 ack 时 resolve got=N, timedOut=false', async () => {
    const gcs = await freshGcs();
    gcs.connect('ws://localhost:1234');
    await vi.advanceTimersByTimeAsync(1);             // mock onopen 触发

    const promise = gcs.pullParams(['A', 'B', 'C']);
    // 50ms × 3 错峰发送
    await vi.advanceTimersByTimeAsync(200);
    const ws = MockWS.instances[0];
    expect(ws.sent.filter(m => m.type === 'param_read')).toHaveLength(3);

    // mavbridge 回流 3 个
    ws.emitParam('A', 1);
    ws.emitParam('B', 2);
    ws.emitParam('C', 3);
    const r = await promise;
    expect(r).toEqual({ got: 3, missing: [], timedOut: false });
  });

  it('pullParams: 部分 ack + timeout = timedOut=true', async () => {
    const gcs = await freshGcs();
    gcs.connect('ws://localhost:1234');
    await vi.advanceTimersByTimeAsync(1);

    const promise = gcs.pullParams(['A', 'B', 'C']);
    await vi.advanceTimersByTimeAsync(200);
    const ws = MockWS.instances[0];
    ws.emitParam('A', 1);                              // 只回 1 个
    await vi.advanceTimersByTimeAsync(60_000);          // 跑过动态 timeout (8s + 3×350=9s+)
    const r = await promise;
    expect(r.got).toBe(1);
    expect(r.missing).toEqual(['B', 'C']);
    expect(r.timedOut).toBe(true);
  });

  it('pullParams: 动态 timeout 跟 keys.length 成正比 (60 keys ≥ 29s)', async () => {
    const gcs = await freshGcs();
    gcs.connect('ws://localhost:1234');
    await vi.advanceTimersByTimeAsync(1);

    const keys = Array.from({ length: 60 }, (_, i) => `K${i}`);
    const promise = gcs.pullParams(keys);
    // 在 8s (旧默认) 时不 timeout
    await vi.advanceTimersByTimeAsync(8500);
    let resolved = false;
    promise.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);                     // 8s 时还没超时

    await vi.advanceTimersByTimeAsync(60_000);
    const r = await promise;
    expect(r.timedOut).toBe(true);
  });

  it('pushParams: 闭环 ack 计数, 60 keys 50ms 错峰', async () => {
    const gcs = await freshGcs();
    gcs.connect('ws://localhost:1234');
    await vi.advanceTimersByTimeAsync(1);

    const map = { X: 1, Y: 2 };
    const promise = gcs.pushParams(map);
    await vi.advanceTimersByTimeAsync(200);
    const ws = MockWS.instances[0];
    expect(ws.sent.filter(m => m.type === 'param_set')).toHaveLength(2);

    ws.emitParam('X', 1);
    ws.emitParam('Y', 2);
    const r = await promise;
    expect(r.acked).toBe(2);
    expect(r.timedOut).toBe(false);
  });

  it('未连接时 pull/push 立即 resolve missing=keys, timedOut=false', async () => {
    const gcs = await freshGcs();
    // 不 connect
    const r = await gcs.pullParams(['A', 'B']);
    expect(r).toEqual({ got: 0, missing: ['A', 'B'], timedOut: false });
  });
});
