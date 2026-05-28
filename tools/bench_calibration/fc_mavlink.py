"""Flight controller MAVLink wrapper for bench testing.

Responsibilities:
- Connect to FC via serial (USB ttyACM* or telemetry ttyUSB*)
- Set MSAK_BENCH_* params (PARAM_SET + ACK check)
- Listen STATUSTEXT (bench_test.lua reports status via gcs:send_text)
- Read SERVO_OUTPUT_RAW (12 motors + 7 tilt servo PWM)
- Heartbeat keep-alive (防 SITL/FC 失联)
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from pymavlink import mavutil


@dataclass
class ServoState:
    t_pc: float
    pwm: list[int] = field(default_factory=lambda: [0] * 32)   # channels 1..32
    # pwm[0..15] = ch1-16 (port=0), pwm[16..31] = ch17-32 (port=1)


@dataclass
class BatteryState:
    t_pc: float = 0.0
    voltage_v: float = 0.0    # 电池电压 V
    current_a: float = 0.0    # 电流 A
    remaining_pct: int = -1   # 剩余 % (-1 未知)
    consumed_mah: float = 0.0 # 累计消耗 mAh


class FCMavlink:
    def __init__(self, port: str, baud: int = 115200):
        self.port = port
        self.baud = baud
        self.master = None
        self._sys = 0
        self._comp = 0
        self._stop_flag = threading.Event()
        self._listener_thread: Optional[threading.Thread] = None
        self._statustext_buf: deque = deque(maxlen=200)   # (t, severity, text)
        self._servo_latest: Optional[ServoState] = None
        self._battery_latest: BatteryState = BatteryState()
        self._param_cache: dict[str, float] = {}
        self._lock = threading.Lock()

    def connect(self, timeout: float = 15.0):
        # Auto detect serial vs udp/tcp
        if self.port.startswith(('udp:', 'tcp:')):
            self.master = mavutil.mavlink_connection(self.port, dialect='ardupilotmega')
        else:
            self.master = mavutil.mavlink_connection(self.port, baud=self.baud,
                                                     dialect='ardupilotmega')
        self.master.wait_heartbeat(timeout=timeout)
        self._sys = self.master.target_system
        self._comp = self.master.target_component
        # Send our heartbeat back (keep connection alive)
        self._send_heartbeat()
        # Request data streams
        self.master.mav.request_data_stream_send(
            self._sys, self._comp,
            mavutil.mavlink.MAV_DATA_STREAM_ALL, 10, 1)
        # Start listener thread
        self._stop_flag.clear()
        self._listener_thread = threading.Thread(target=self._listener_loop, daemon=True)
        self._listener_thread.start()
        return True

    def close(self):
        if self._listener_thread:
            self._stop_flag.set()
            self._listener_thread.join(timeout=1.0)
        if self.master:
            self.master.close()

    def _send_heartbeat(self):
        if self.master is None:
            return
        self.master.mav.heartbeat_send(
            mavutil.mavlink.MAV_TYPE_GCS,
            mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)

    def _listener_loop(self):
        last_hb = 0
        while not self._stop_flag.is_set():
            now = time.time()
            if now - last_hb > 2.0:
                self._send_heartbeat()
                last_hb = now
            msg = self.master.recv_match(blocking=False, timeout=0.1)
            if msg is None:
                continue
            t = msg.get_type()
            if t == 'STATUSTEXT':
                txt = msg.text if hasattr(msg, 'text') else ''
                with self._lock:
                    self._statustext_buf.append((time.time(), int(msg.severity), txt))
            elif t == 'SERVO_OUTPUT_RAW':
                # port 字段决定通道 base offset: port=0 → ch1-16, port=1 → ch17-32
                port = getattr(msg, 'port', 0)
                base = port * 16
                with self._lock:
                    if self._servo_latest is None:
                        self._servo_latest = ServoState(t_pc=time.time())
                    # 单次消息含 16 个 slot, 写入 [base..base+15]
                    for i in range(1, 17):
                        fld = f'servo{i}_raw'
                        if hasattr(msg, fld):
                            idx = base + i - 1
                            if 0 <= idx < 32:
                                self._servo_latest.pwm[idx] = getattr(msg, fld)
                    self._servo_latest.t_pc = time.time()
            elif t == 'BATTERY_STATUS':
                # MAVLink BATTERY_STATUS — 多 cell 电池详细数据
                # voltages[0] = mV (UINT16_MAX=未连接), current_battery = cA (10mA), battery_remaining = %
                try:
                    voltages = list(msg.voltages) if hasattr(msg, 'voltages') else []
                    v_mv = voltages[0] if voltages and voltages[0] != 65535 else 0
                    cur_ca = msg.current_battery if hasattr(msg, 'current_battery') else -1
                    pct = msg.battery_remaining if hasattr(msg, 'battery_remaining') else -1
                    consumed = msg.current_consumed if hasattr(msg, 'current_consumed') else 0
                    with self._lock:
                        self._battery_latest = BatteryState(
                            t_pc=time.time(),
                            voltage_v=v_mv / 1000.0 if v_mv > 0 else 0.0,
                            current_a=cur_ca / 100.0 if cur_ca > 0 else 0.0,
                            remaining_pct=int(pct),
                            consumed_mah=float(consumed),
                        )
                except Exception:
                    pass
            elif t == 'SYS_STATUS':
                # SYS_STATUS — 备用源, voltage_battery (mV), current_battery (cA), battery_remaining (%)
                # 若 BATTERY_STATUS 还没收到, SYS_STATUS fallback
                try:
                    v_mv = msg.voltage_battery if hasattr(msg, 'voltage_battery') else 0
                    cur_ca = msg.current_battery if hasattr(msg, 'current_battery') else -1
                    pct = msg.battery_remaining if hasattr(msg, 'battery_remaining') else -1
                    with self._lock:
                        # 若现有数据 stale (>2s) 才用 SYS_STATUS
                        if time.time() - self._battery_latest.t_pc > 2.0:
                            self._battery_latest = BatteryState(
                                t_pc=time.time(),
                                voltage_v=v_mv / 1000.0 if v_mv > 0 else 0.0,
                                current_a=cur_ca / 100.0 if cur_ca > 0 else 0.0,
                                remaining_pct=int(pct),
                                consumed_mah=0.0,
                            )
                except Exception:
                    pass
            elif t == 'PARAM_VALUE':
                with self._lock:
                    self._param_cache[msg.param_id] = msg.param_value

    def set_param(self, name: str, value: float, retries: int = 3,
                  ack_timeout: float = 2.0) -> bool:
        """PARAM_SET + verify via PARAM_VALUE response. Returns True on success."""
        for attempt in range(retries):
            self.master.mav.param_set_send(
                self._sys, self._comp,
                name.encode('ascii').ljust(16, b'\x00')[:16],
                float(value),
                mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
            # Wait for PARAM_VALUE echo
            deadline = time.time() + ack_timeout
            while time.time() < deadline:
                with self._lock:
                    if name in self._param_cache and abs(self._param_cache[name] - value) < 1e-4:
                        return True
                time.sleep(0.05)
        return False

    def get_param(self, name: str, timeout: float = 1.0) -> Optional[float]:
        """Cached if already received via PARAM_VALUE stream, else request + wait."""
        with self._lock:
            if name in self._param_cache:
                return self._param_cache[name]
        self.master.mav.param_request_read_send(
            self._sys, self._comp,
            name.encode('ascii').ljust(16, b'\x00')[:16], -1)
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if name in self._param_cache:
                    return self._param_cache[name]
            time.sleep(0.05)
        return None

    def latest_servo(self) -> Optional[ServoState]:
        with self._lock:
            return self._servo_latest

    def latest_battery(self) -> BatteryState:
        with self._lock:
            return self._battery_latest

    def drain_statustext(self) -> list[tuple[float, int, str]]:
        """Get all STATUSTEXT received since last drain. Returns (t, sev, text) list."""
        with self._lock:
            out = list(self._statustext_buf)
            self._statustext_buf.clear()
        return out

    def wait_status_contains(self, substring: str, timeout: float = 5.0) -> Optional[str]:
        """Block until a STATUSTEXT contains `substring`. Returns text or None."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            for _, _, txt in self.drain_statustext():
                if substring in txt:
                    return txt
            time.sleep(0.1)
        return None


if __name__ == '__main__':
    import sys
    port = sys.argv[1] if len(sys.argv) > 1 else '/dev/ttyACM0'
    fc = FCMavlink(port)
    fc.connect()
    print(f'connected sys={fc._sys}')
    time.sleep(2)
    s = fc.latest_servo()
    if s:
        print(f'servo PWM: {s.pwm[:12]}')
    msg = fc.drain_statustext()
    for t, sev, tx in msg[-5:]:
        print(f'[{sev}] {tx}')
    fc.close()
