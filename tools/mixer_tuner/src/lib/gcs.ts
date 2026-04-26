// WebSocket 客户端, 连 mavbridge.py. 浏览器 ↔ FC MAVLink 桥.

export type GcsMessage =
  | { type: 'status'; connected: boolean; sys?: number; comp?: number; device?: string }
  | { type: 'heartbeat'; mode: string; armed: boolean }
  | { type: 'attitude'; roll: number; pitch: number; yaw: number }
  | { type: 'vfr_hud'; airspeed: number; groundspeed: number; alt: number; climb: number; throttle: number }
  | { type: 'gps'; fix_type: number; sats: number; hdop: number | null }
  | { type: 'param'; name: string; value: number; index: number; count: number }
  | { type: 'statustext'; severity: number; text: string }
  | { type: 'rc'; channels: number[] }
  | { type: 'servo'; channels: number[] }
  | { type: 'battery'; voltage: number; current: number | null; remaining: number; consumed_mah?: number; fallback?: boolean }
  | { type: 'pong'; ts: number }
  | { type: 'error'; msg: string };

type Listener = (m: GcsMessage) => void;

export class GcsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<Listener>();
  private reconnectTimer: number | null = null;
  public connected = false;
  public lastHeartbeatMs = 0;

  constructor(url = 'ws://127.0.0.1:8765') {
    this.url = url;
  }

  setUrl(url: string) {
    this.url = url;
    if (this.ws) this.disconnect();
  }

  getUrl() { return this.url; }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.emit({ type: 'error', msg: `连接失败: ${e}` });
      return;
    }
    this.ws.onopen = () => {
      this.connected = true;
      this.emit({ type: 'status', connected: true });
    };
    this.ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data) as GcsMessage;
        if (m.type === 'heartbeat') this.lastHeartbeatMs = Date.now();
        this.emit(m);
      } catch {}
    };
    this.ws.onerror = () => {
      this.emit({ type: 'error', msg: 'WS 错误 — mavbridge.py 未运行?' });
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.emit({ type: 'status', connected: false });
      this.ws = null;
    };
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.connected = false;
  }

  send(obj: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emit({ type: 'error', msg: '未连接' });
      return;
    }
    this.ws.send(JSON.stringify(obj));
  }

  readParam(name: string) { this.send({ type: 'param_read', name }); }
  readAllParams()           { this.send({ type: 'param_read_all' }); }
  setParam(name: string, value: number) { this.send({ type: 'param_set', name, value }); }
  arm()       { this.send({ type: 'arm' }); }
  disarm()    { this.send({ type: 'disarm' }); }
  reboot()    { this.send({ type: 'reboot' }); }
  ping()      { this.send({ type: 'ping' }); }

  isConnected() { return this.connected && this.ws?.readyState === WebSocket.OPEN; }

  // ─── 闭环拉取: 发 read, 等 PARAM_VALUE 回流, 进度回调, 静默超时 ───
  pullParams(
    keys: string[],
    onProgress?: (got: number, total: number) => void,
    timeoutMs = 8000,
  ): Promise<{ got: number; missing: string[]; timedOut: boolean }> {
    return new Promise((resolve) => {
      if (!this.isConnected()) {
        resolve({ got: 0, missing: keys, timedOut: false });
        this.emit({ type: 'error', msg: '未连接 mavbridge.py, 拉取取消' });
        return;
      }
      const remaining = new Set(keys);
      let got = 0;
      const off = this.on((m) => {
        if (m.type === 'param' && remaining.has(m.name)) {
          remaining.delete(m.name);
          got++;
          onProgress?.(got, keys.length);
          if (remaining.size === 0) finish(false);
        }
      });
      const finish = (timedOut: boolean) => {
        clearTimeout(timer);
        off();
        resolve({ got, missing: [...remaining], timedOut });
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      // 30ms/次 节流防 ws 拥塞
      keys.forEach((k, i) => setTimeout(() => this.readParam(k), i * 30));
    });
  }

  // ─── 闭环推送: setParam 后等 FC ack (PARAM_VALUE 回流) 或超时 ───
  pushParams(
    map: Record<string, number>,
    onProgress?: (sent: number, total: number) => void,
    timeoutMs = 8000,
  ): Promise<{ acked: number; missing: string[]; timedOut: boolean }> {
    return new Promise((resolve) => {
      if (!this.isConnected()) {
        resolve({ acked: 0, missing: Object.keys(map), timedOut: false });
        this.emit({ type: 'error', msg: '未连接 mavbridge.py, 推送取消' });
        return;
      }
      const keys = Object.keys(map);
      const remaining = new Set(keys);
      let acked = 0;
      const off = this.on((m) => {
        if (m.type === 'param' && remaining.has(m.name)) {
          remaining.delete(m.name);
          acked++;
          onProgress?.(acked, keys.length);
          if (remaining.size === 0) finish(false);
        }
      });
      const finish = (timedOut: boolean) => {
        clearTimeout(timer);
        off();
        resolve({ acked, missing: [...remaining], timedOut });
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      keys.forEach((k, i) =>
        setTimeout(() => this.setParam(k, map[k]), i * 30)
      );
    });
  }

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(m: GcsMessage) { for (const fn of this.listeners) fn(m); }
}

export const gcs = new GcsClient();
