// WebSocket 客户端, 连 mavbridge.py. 浏览器 ↔ FC MAVLink 桥.

export type GcsMessage =
  | { type: 'status'; connected: boolean; sys?: number; comp?: number; device?: string }
  | { type: 'heartbeat'; mode: string; custom_mode?: number; armed: boolean }
  | { type: 'attitude'; roll: number; pitch: number; yaw: number }
  | { type: 'vfr_hud'; airspeed: number; groundspeed: number; alt: number; climb: number; throttle: number }
  | { type: 'gps'; fix_type: number; sats: number; hdop: number | null; lat?: number; lon?: number; hdg?: number; yaw_deg?: number | null; alt_m?: number; vel_mps?: number | null; gps_id?: number }
  | { type: 'gps2'; fix_type: number; sats: number; hdop: number | null; yaw_deg?: number | null; alt_m?: number; vel_mps?: number | null; gps_id?: number }
  | { type: 'param'; name: string; value: number; index: number; count: number }
  | { type: 'statustext'; severity: number; text: string }
  | { type: 'rc'; channels: number[] }
  | { type: 'servo'; channels: number[] }
  | { type: 'named_float'; name: string; value: number }
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
  | { type: 'bench_profiles'; profiles: { key: string; name: string; desc: string; points: number }[] }
  | { type: 'bench_status'; msg?: string; error?: string; connected?: boolean; running?: boolean; force_ok?: number; curr_ok?: number; csv?: string; est_sec?: number; recording?: boolean; rec_path?: string; rec_rows?: number }
  | { type: 'bench_live'; force_g: Record<string, number | null>; lift_g: number; thrust_g: number; lift_N: number; thrust_N: number; roll_m: number; pitch_m: number; yaw_m: number; current: Record<string, number>; i_total: number; volt_L: number; volt_R: number; power: number; airspeed?: number; press_diff?: number; recording?: boolean; rec_rows?: number }
  | { type: 'bench_sample'; force_g: Record<string, number | null>; lift_g: number; thrust_g: number; lift_N: number; thrust_N: number; roll_m: number; pitch_m: number; yaw_m: number; current: Record<string, number>; i_total: number; volt_L: number; volt_R: number; power: number }
  | { type: 'bench_point'; idx: number; total: number; profile: string; label: string; angle_idx: number; angle_total: number; thr_pct: number; lift_g: number; thrust_g: number; lift_N: number; thrust_N: number; roll_m: number; pitch_m: number; yaw_m: number; volt_L: number; volt_R: number; i_total: number; power: number; elapsed_sec: number; remain_sec: number }
  | { type: 'bench_done'; profile: string; aborted: boolean; stopped?: boolean; csv: string }
  | { type: 'bench_estimate'; profile: string; total_angles: number; ladder_n: number; total_steps: number; est_sec: number; cfg_kind: 'angle' | 'fixed' | 'mixed'; n_sweep: number; n_fixed: number; detail: string }
  | { type: 'bench_ports'; ports?: { device: string; description: string }[]; error?: string }
  | { type: 'error'; msg: string };

type Listener = (m: GcsMessage) => void;

export class GcsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<Listener>();
  private reconnectTimer: number | null = null;
  public connected = false;
  public lastHeartbeatMs = 0;
  // 纯 raw 架构: mavbridge 发 {type:'mav', mt, f}, 解析在此 (旧 mavbridge if/elif 移来)
  private _servoBuf = new Array(24).fill(0);
  private _batV = 0; private _batI: number | null = null; private _batRem = 0; private _batMah = 0;
  // GCS 自主请求的遥测流 (msgid → hz). 加信号/改频率只改这里, 不碰 mavbridge.
  private _streams: Record<number, number> = {
    30: 25,   // ATTITUDE
    74: 5,    // VFR_HUD
    24: 2,    // GPS_RAW_INT
    124: 2,   // GPS2_RAW
    1: 2,     // SYS_STATUS (battery fallback)
    147: 2,   // BATTERY_STATUS
    65: 10,   // RC_CHANNELS
    36: 10,   // SERVO_OUTPUT_RAW
    251: 5,   // NAMED_VALUE_FLOAT (lua live: K_eff / heading-hold he/yo)
  };

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
      // GCS 自主请求所需遥测流 (纯 raw 架构, mavbridge 不再写死)
      this.requestStreams();
    };
    this.ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(ev.data);
        if (raw && raw.type === 'mav') {
          // 纯 raw MAVLink → 翻译成 curated 事件 (旧 mavbridge if/elif 逻辑)
          const ms = this.translateMav(raw.mt, raw.f || {});
          for (const m of ms) {
            if (m.type === 'heartbeat') this.lastHeartbeatMs = Date.now();
            this.emit(m);
          }
          return;
        }
        // 非遥测 (status / mission_* / rtk_* / log_analysis_* / pong) 原样透传
        const m = raw as GcsMessage;
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

  // GCS 自主请求遥测流 (纯 raw 架构). 改 _streams 即可加信号/改频率, 不碰 mavbridge.
  requestStreams() {
    for (const [msgid, hz] of Object.entries(this._streams)) {
      this.send({ type: 'set_msg_interval', msgid: Number(msgid), hz });
    }
  }
  // 运行时调单条流频率 (e.g. yaw tune 面板要更高 NVF 率)
  setStreamRate(msgid: number, hz: number) {
    this._streams[msgid] = hz;
    this.send({ type: 'set_msg_interval', msgid, hz });
  }

  // 把 raw MAVLink {mt, f} 翻译成现有 curated 事件 (旧 mavbridge if/elif 移来, tab 不动)
  private translateMav(mt: string, f: any): GcsMessage[] {
    const D = 180 / Math.PI;
    switch (mt) {
      case 'HEARTBEAT': {
        const cm = Number(f.custom_mode || 0);
        const MODE_NAMES: Record<number, string> = { 17: 'QSTABILIZE', 27: 'WIG_AUTO', 29: 'WIG_RECV' };
        return [{ type: 'heartbeat', mode: MODE_NAMES[cm] || `Mode(${cm})`,
          custom_mode: cm, armed: (Number(f.base_mode || 0) & 128) !== 0 }];
      }
      case 'ATTITUDE':
        return [{ type: 'attitude', roll: f.roll * D, pitch: f.pitch * D, yaw: f.yaw * D }];
      case 'VFR_HUD':
        return [{ type: 'vfr_hud', airspeed: f.airspeed, groundspeed: f.groundspeed,
          alt: f.alt, climb: f.climb, throttle: f.throttle }];
      case 'GPS_RAW_INT': {
        const yc = Number(f.yaw || 0);
        return [{ type: 'gps', fix_type: f.fix_type, sats: f.satellites_visible,
          hdop: f.eph !== 65535 ? f.eph / 100 : null,
          lat: f.lat, lon: f.lon, hdg: f.cog || 0,
          yaw_deg: yc && yc !== 0 ? yc / 100 : null,
          alt_m: f.alt ? f.alt / 1000 : 0,
          vel_mps: f.vel !== 65535 ? f.vel / 100 : null, gps_id: 1 }];
      }
      case 'GPS2_RAW': {
        const yc = Number(f.yaw || 0);
        return [{ type: 'gps2', fix_type: f.fix_type, sats: f.satellites_visible,
          hdop: f.eph !== 65535 ? f.eph / 100 : null,
          yaw_deg: yc && yc !== 0 ? yc / 100 : null,
          alt_m: f.alt ? f.alt / 1000 : 0,
          vel_mps: f.vel !== 65535 ? f.vel / 100 : null, gps_id: 2 }];
      }
      case 'PARAM_VALUE': {
        let name = String(f.param_id || '').replace(/\0+$/, '');
        return [{ type: 'param', name, value: Number(f.param_value),
          index: f.param_index, count: f.param_count }];
      }
      case 'STATUSTEXT':
        return [{ type: 'statustext', severity: f.severity,
          text: String(f.text || '').replace(/\0+$/, '') }];
      case 'RC_CHANNELS': {
        const ch = [];
        for (let i = 1; i <= 12; i++) ch.push(Number(f[`chan${i}_raw`] || 0));
        return [{ type: 'rc', channels: ch }];
      }
      case 'SERVO_OUTPUT_RAW': {
        const base = Number(f.port || 0) * 16;
        for (let i = 0; i < 16; i++) {
          if (base + i < 24) {
            const v = Number(f[`servo${i + 1}_raw`] || 0);
            this._servoBuf[base + i] = v === 65535 ? 0 : v;
          }
        }
        return [{ type: 'servo', channels: [...this._servoBuf] }];
      }
      case 'NAMED_VALUE_FLOAT':
        return [{ type: 'named_float', name: String(f.name || '').replace(/\0+$/, ''),
          value: Number(f.value) }];
      case 'BATTERY_STATUS': {
        if (Number(f.id) !== 0) return [];
        const cells = (f.voltages || []).slice(0, 10).filter((c: number) => c !== 65535);
        if (cells.length) this._batV = cells.reduce((a: number, b: number) => a + b, 0) / 1000;
        if (f.current_battery >= 0) this._batI = f.current_battery / 100;
        if (f.battery_remaining >= 0) this._batRem = Math.trunc(f.battery_remaining);
        if (f.current_consumed >= 0) this._batMah = Math.trunc(f.current_consumed);
        return [{ type: 'battery', voltage: this._batV, current: this._batI,
          remaining: this._batRem, consumed_mah: this._batMah }];
      }
      case 'SYS_STATUS': {
        if (f.voltage_battery > 0) this._batV = f.voltage_battery / 1000;
        if (f.current_battery >= 0) this._batI = f.current_battery / 100;
        if (f.battery_remaining >= 0) this._batRem = Math.trunc(f.battery_remaining);
        return [{ type: 'battery', voltage: this._batV, current: this._batI,
          remaining: this._batRem, consumed_mah: this._batMah, fallback: true }];
      }
      default:
        return [];  // 未关心的 msg 丢弃 (新信号要用时在此加 case 或走 named_float)
    }
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
  // v9 P7: 切 ArduPilot custom mode (WIG_AUTO=27 / WIG_RECV=29 / QSTAB=17)
  setMode(mode: number) { this.send({ type: 'set_mode', mode }); }
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

  // ─── 台架动力测试 ───
  benchProfiles() { this.send({ type: 'bench_profiles' }); }
  benchListPorts() { this.send({ type: 'bench_list_ports' }); }
  benchConnect(force_port: string, curr_port: string, baud = 115200) {
    this.send({ type: 'bench_connect', force_port, curr_port, baud });
  }
  benchDisconnect() { this.send({ type: 'bench_disconnect' }); }
  benchTare() { this.send({ type: 'bench_tare' }); }
  benchCal(cal: Record<number, number>) { this.send({ type: 'bench_cal', cal }); }
  benchStart(profile: string, thr_min = 0.5, thr_max = 0.8, step = 0.1, hold = 3.0, ramp = 1.5, ang_step = 15,
             rest = 0, ge_plate = 'na', mount_deg = 0, note = '') {
    this.send({ type: 'bench_start', profile, thr_min, thr_max, step, hold, ramp, ang_step, rest, ge_plate, mount_deg, note });
  }
  benchEstimate(profile: string, thr_min: number, thr_max: number, step: number, hold: number, ramp: number, ang_step: number, rest = 0) {
    this.send({ type: 'bench_estimate', profile, thr_min, thr_max, step, hold, ramp, ang_step, rest });
  }
  benchStop() { this.send({ type: 'bench_stop' }); }
  benchAbort() { this.send({ type: 'bench_abort' }); }
  // 副翼被动记录 (只读测力+空速, 不驱动电机)
  benchRecordStart(pitch_deg: number, ail_diff: string, note = '') {
    this.send({ type: 'bench_record_start', pitch_deg, ail_diff, note });
  }
  benchRecordStop() { this.send({ type: 'bench_record_stop' }); }

  isConnected() { return this.connected && this.ws?.readyState === WebSocket.OPEN; }

  // ─── 闭环拉取: 发 read, 等 PARAM_VALUE 回流, 进度回调, 静默超时 ───
  // timeoutMs 默认动态: 8s base + 350ms/key (低速数传 SiK 57600 留余量, 60 keys ≈ 29s).
  // 调用方传 0 则用 default, 传非 0 自定义.
  pullParams(
    keys: string[],
    onProgress?: (got: number, total: number) => void,
    timeoutMs?: number,
  ): Promise<{ got: number; missing: string[]; timedOut: boolean }> {
    const baseT = timeoutMs && timeoutMs > 0 ? timeoutMs : Math.max(8000, 8000 + keys.length * 350);
    return new Promise((resolve) => {
      if (!this.isConnected()) {
        resolve({ got: 0, missing: keys, timedOut: false });
        this.emit({ type: 'error', msg: '未连接 mavbridge.py, 拉取取消' });
        return;
      }
      const remaining = new Set(keys);
      let got = 0;
      let retryRound = 0;
      const MAX_RETRY = 3;   // USB ACM 链路 burst 时 fc UART output queue 偶发 drop, retry missing
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
      // 第一轮 + retry 用同一个 long timer 兜底
      const timer = setTimeout(() => finish(true), baseT + MAX_RETRY * 2500);
      const sendBatch = (batch: string[]) => {
        // 50ms/次 节流防 ws 拥塞 + fc UART output queue overflow (低速 SiK 实测安全间隔)
        batch.forEach((k, i) => setTimeout(() => this.readParam(k), i * 50));
      };
      const retryMissing = () => {
        if (remaining.size === 0 || retryRound >= MAX_RETRY) {
          if (remaining.size === 0) finish(false);
          return;
        }
        retryRound++;
        sendBatch([...remaining]);
        // 给本轮 missing 2.5s 收回 (50ms × max 50 keys + buffer)
        setTimeout(retryMissing, 2500);
      };
      sendBatch(keys);
      // 第一轮发完后给 max(baseT/2, 4s) 等收, 之后开始 retry missing
      setTimeout(retryMissing, Math.max(baseT - MAX_RETRY * 2500, 4000));
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
