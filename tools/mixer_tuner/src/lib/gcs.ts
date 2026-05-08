// WebSocket 客户端, 连 mavbridge.py. 浏览器 ↔ FC MAVLink 桥.

export type GcsMessage =
  | { type: 'status'; connected: boolean; sys?: number; comp?: number; device?: string }
  | { type: 'heartbeat'; mode: string; armed: boolean }
  | { type: 'attitude'; roll: number; pitch: number; yaw: number }
  | { type: 'vfr_hud'; airspeed: number; groundspeed: number; alt: number; climb: number; throttle: number }
  | { type: 'gps'; fix_type: number; sats: number; hdop: number | null; yaw_deg?: number | null; alt_m?: number; vel_mps?: number | null; gps_id?: number }
  | { type: 'gps2'; fix_type: number; sats: number; hdop: number | null; yaw_deg?: number | null; alt_m?: number; vel_mps?: number | null; gps_id?: number }
  | { type: 'param'; name: string; value: number; index: number; count: number }
  | { type: 'statustext'; severity: number; text: string }
  | { type: 'rc'; channels: number[] }
  | { type: 'servo'; channels: number[] }
  | { type: 'battery'; voltage: number; current: number | null; remaining: number; consumed_mah?: number; fallback?: boolean }
  | { type: 'pong'; ts: number }
  | { type: 'log_analysis_progress'; pct: number; msg?: string }
  | { type: 'log_analysis_done'; data?: any; error?: string }
  | { type: 'pid_apply_done'; count: number }
  | { type: 'pid_apply_err'; name: string; err: string }
  | { type: 'rtk_status'; connected?: boolean; port?: string; baud?: number; svin_started?: boolean; min_dur?: number; acc_mm?: number; injecting?: boolean; fixed_pos_started?: boolean; lat?: number; lon?: number; alt?: number; ntrip?: boolean; host?: string; mountpoint?: string; note?: string; error?: string }
  | { type: 'rtk_svin'; dur: number; acc_mm: number; obs: number; valid: boolean; active: boolean }
  | { type: 'rtk_inject'; frames: number; bytes: number; msg_types: Record<string, number>; bps_in?: number; bps_useful?: number }
  | { type: 'rtk_ports'; ports?: { device: string; description: string; manufacturer: string; vid: number | null; pid: number | null }[]; error?: string }
  | { type: 'rtk_sourcetable'; entries?: { mountpoint: string; identifier: string; format: string; format_details: string; carrier: string; nav_system: string; country: string }[]; error?: string }
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
  // ArduPilot MAV_CMD_DO_MOTOR_TEST (绕过 Q_M_PWM disarmed=0, 不需 arm 也能让 ESC 真转)
  // motor: 1-12 (motor_instance), throttlePct: 0-100 (PCT type=1), timeoutSec: 1-10
  motorTest(motor: number, throttlePct: number, timeoutSec: number) {
    this.send({ type: 'motor_test', motor, value: throttlePct, timeout: timeoutSec });
  }
  motorTestStop() { this.send({ type: 'motor_test_stop' }); }
  ping()      { this.send({ type: 'ping' }); }
  // v9 P4: BIN 离线分析 (本地路径, mavbridge.py 用 pymavlink 解析)
  analyzeLog(path: string, currentParams: Record<string, number>) {
    this.send({ type: 'analyze_log', path, current_params: currentParams });
  }
  // v9 P4: 批量应用 PID 建议 (前端必须先 disarmed + 双确认 + 备份)
  applyPids(params: Record<string, number>) {
    this.send({ type: 'pid_apply', params });
  }
  // v9 P4 RTK: 9PS Survey-In + RTCM 注入控制
  rtkListPorts() { this.send({ type: 'rtk_list_ports' }); }
  rtkConnect(port: string, baud = 115200) { this.send({ type: 'rtk_connect', port, baud }); }
  rtkDisconnect() { this.send({ type: 'rtk_disconnect' }); }
  rtkSurveyStart(min_dur = 60, acc_mm = 2500) { this.send({ type: 'rtk_survey_start', min_dur, acc_mm }); }
  rtkSurveyStop() { this.send({ type: 'rtk_survey_stop' }); }
  rtkInject(on: boolean) { this.send({ type: 'rtk_inject', on }); }
  rtkFixedPos(lat: number, lon: number, alt: number, acc_mm = 100) {
    this.send({ type: 'rtk_fixed_pos', lat, lon, alt, acc_mm });
  }
  rtkNtripConnect(host: string, port: number, mountpoint: string, user = '', password = '', v1 = false) {
    this.send({ type: 'rtk_ntrip_connect', host, port, mountpoint, user, password, v1 });
  }
  rtkNtripDisconnect() { this.send({ type: 'rtk_ntrip_disconnect' }); }
  rtkNtripSourcetable(host: string, port: number) {
    this.send({ type: 'rtk_ntrip_sourcetable', host, port });
  }

  isConnected() { return this.connected && this.ws?.readyState === WebSocket.OPEN; }

  // ─── 闭环拉取: 发 read, 等 PARAM_VALUE 回流, 进度回调, 静默超时 ───
  // timeoutMs 默认动态: 8s base + 350ms/key (低速数传 SiK 57600 留余量, 60 keys ≈ 29s).
  // 调用方传 0 则用 default, 传非 0 自定义.
  pullParams(
    keys: string[],
    onProgress?: (got: number, total: number) => void,
    timeoutMs?: number,
  ): Promise<{ got: number; missing: string[]; timedOut: boolean }> {
    const t = timeoutMs && timeoutMs > 0 ? timeoutMs : Math.max(8000, 8000 + keys.length * 350);
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
      const timer = setTimeout(() => finish(true), t);
      // 50ms/次 节流防 ws 拥塞 + 数传链路 buffer overflow (低速 SiK 实测安全间隔)
      keys.forEach((k, i) => setTimeout(() => this.readParam(k), i * 50));
    });
  }

  // ─── 闭环推送: setParam 后等 FC ack (PARAM_VALUE 回流) 或超时 ───
  // timeoutMs 默认动态: 8s base + 350ms/key. 跟 pullParams 一致.
  pushParams(
    map: Record<string, number>,
    onProgress?: (sent: number, total: number) => void,
    timeoutMs?: number,
  ): Promise<{ acked: number; missing: string[]; timedOut: boolean }> {
    const keys = Object.keys(map);
    const t = timeoutMs && timeoutMs > 0 ? timeoutMs : Math.max(8000, 8000 + keys.length * 350);
    return new Promise((resolve) => {
      if (!this.isConnected()) {
        resolve({ acked: 0, missing: keys, timedOut: false });
        this.emit({ type: 'error', msg: '未连接 mavbridge.py, 推送取消' });
        return;
      }
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
      const timer = setTimeout(() => finish(true), t);
      keys.forEach((k, i) =>
        setTimeout(() => this.setParam(k, map[k]), i * 50)
      );
    });
  }

  on(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(m: GcsMessage) { for (const fn of this.listeners) fn(m); }
}

export const gcs = new GcsClient();
