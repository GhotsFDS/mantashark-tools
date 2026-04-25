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

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(m: GcsMessage) { for (const fn of this.listeners) fn(m); }
}

export const gcs = new GcsClient();
