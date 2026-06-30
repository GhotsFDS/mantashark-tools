"""6-channel transducer driver — Modbus RTU 协议.

实测变送器配置 (2026-05-27):
- 接口: RS232/485 → USB-CH340
- 波特: 115200, 8N1
- 协议: Modbus RTU
- slave id: 1
- 寄存器: 0x01C2 起 16 个 holding registers (8 channel × 2 reg each)
- 数据: 8 × int32 big-endian (CH1-CH6 有效, CH7/CH8 = 0 未用)
- 单位: 原始 ADC count (lsb 转 N 系数由用户标定)

提供跟 TransducerAscii 一样的接口让 GUI/CLI 直接换 driver.

用法:
    sensor = TransducerModbus('/dev/ttyACM0', baud=115200, slave=1)
    sensor.open()
    sensor.handshake()                      # 验证一次响应
    sensor.start_continuous(interval_ms=100) # 后台 10Hz 轮询
    while True:
        latest = sensor.get_latest()
        # latest = {1: 670.0, 2: -367.0, 3: -3697.0}
"""

from __future__ import annotations

import threading
import time
import struct
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import serial


def _crc16(data: bytes) -> bytes:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc.to_bytes(2, 'little')


@dataclass
class Sample:
    t_pc: float
    channels: dict = field(default_factory=dict)   # channel id (1-N) → value


class TransducerModbus:
    """6 通道变送器 Modbus RTU driver, GUI-compatible 接口."""

    def __init__(self, port: str, baud: int = 115200,
                 channels=None,
                 slave: int = 1,
                 reg_start: int = 0x01C2,
                 reg_count: int = 16,    # 16 regs = 8 ch × 2 reg
                 n_channels: int = 6):   # 实际有效 channel 数
        self.port = port
        self.baud = baud
        self.slave = slave
        self.reg_start = reg_start
        self.reg_count = reg_count
        self.n_channels = n_channels
        # GUI 端传 channels=[1,2,3] 表示只关心 3 通道
        self.channels = channels if channels else list(range(1, n_channels + 1))
        self._ser: Optional[serial.Serial] = None
        self._stop_flag = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._latest: dict = {}                     # channel → last value
        self._samples: deque = deque(maxlen=200)    # 历史 200 sample
        # 预计算 Modbus 请求帧 (slave / fn3 / start / count + CRC)
        req = bytes([self.slave, 0x03,
                     (self.reg_start >> 8) & 0xFF, self.reg_start & 0xFF,
                     (self.reg_count >> 8) & 0xFF, self.reg_count & 0xFF])
        self._req_frame = req + _crc16(req)
        # 期望响应长度: 3 (slave+fn+bytecount) + 2*reg_count + 2 (CRC) = 5 + 2*reg_count
        self._expected_len = 5 + 2 * self.reg_count

    def open(self):
        self._ser = serial.Serial(self.port, self.baud, timeout=0.3)

    def attach_serial(self, ser):
        """注入共享 serial (共 485 总线模式). 标记不 own → close 不关串口."""
        self._ser = ser
        self._shared = True

    def close(self):
        self.stop_continuous()
        if self._ser and not getattr(self, '_shared', False):
            try: self._ser.close()
            except: pass
            self._ser = None

    def _one_query(self, timeout: float = 0.5) -> Optional[list[int]]:
        """发一帧 Modbus 请求, 收响应, 解 channel values list (int)."""
        if self._ser is None: return None
        try:
            self._ser.reset_input_buffer()
            self._ser.write(self._req_frame)
            # 等够字节或超时. P1-8 修: 按需精确读 (read(64) 永收不满阻塞满串口超时)
            t0 = time.time()
            buf = b''
            while len(buf) < self._expected_len and time.time() - t0 < timeout:
                buf += self._ser.read(self._expected_len - len(buf))
            if len(buf) < self._expected_len:
                return None
            # 解析: 寻找 slave+fn+bytecount header
            header = bytes([self.slave, 0x03, 2 * self.reg_count])
            idx = buf.find(header)
            if idx < 0:
                return None
            frame_len = 3 + 2 * self.reg_count
            data = buf[idx + 3 : idx + frame_len]
            if len(data) < 2 * self.reg_count:
                return None
            # P1-7 修: 校验响应 CRC (防强 EMI 噪声帧静默注入)
            crc_recv = buf[idx + frame_len: idx + frame_len + 2]
            if len(crc_recv) == 2 and _crc16(buf[idx: idx + frame_len]) != crc_recv:
                return None
            # 每通道 4 字节 int32 big-endian
            n_channels_in_data = self.reg_count // 2   # 2 reg = 4 byte = 1 int32
            vals = []
            for i in range(n_channels_in_data):
                raw = data[i*4 : (i+1)*4]
                v = struct.unpack('>i', raw)[0]
                vals.append(v)
            return vals
        except Exception:
            return None

    def handshake(self) -> dict[int, bool]:
        """一次请求 + 验证所有通道有响应. 返回 {channel: True/False}."""
        result = {ch: False for ch in self.channels}
        vals = self._one_query()
        if vals:
            for ch in self.channels:
                if 1 <= ch <= len(vals):
                    result[ch] = True
        return result

    def start_continuous(self, interval_ms: int = 100, **kwargs):
        """启后台 thread 周期轮询 (默 10Hz)."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_flag.clear()
        self._thread = threading.Thread(
            target=self._poll_loop, args=(interval_ms,), daemon=True)
        self._thread.start()

    def stop_continuous(self):
        if self._thread:
            self._stop_flag.set()
            self._thread.join(timeout=1.0)
            self._thread = None

    def _poll_loop(self, interval_ms: int):
        interval_s = max(0.02, interval_ms / 1000.0)
        while not self._stop_flag.is_set():
            t0 = time.time()
            vals = self._one_query(timeout=interval_s * 0.8)
            if vals:
                with self._lock:
                    sample = Sample(t_pc=time.time())
                    for ch in self.channels:
                        if 1 <= ch <= len(vals):
                            v = float(vals[ch - 1])
                            self._latest[ch] = v
                            sample.channels[ch] = v
                    self._samples.append(sample)
            # 等到下个 interval
            dt = time.time() - t0
            if dt < interval_s:
                time.sleep(interval_s - dt)

    def get_latest(self) -> dict[int, Optional[float]]:
        with self._lock:
            return {ch: self._latest.get(ch) for ch in self.channels}

    def read_sample(self, timeout: float = 0.5) -> Optional[Sample]:
        """阻塞: 拉一个最新 sample (轮询 _samples)."""
        t0 = time.time()
        while time.time() - t0 < timeout:
            with self._lock:
                if self._samples:
                    return self._samples[-1]
            time.sleep(0.01)
        return None


if __name__ == '__main__':
    import sys
    port = sys.argv[1] if len(sys.argv) > 1 else '/dev/ttyACM0'
    print(f'开 {port} @ 115200 Modbus RTU slave 1...')
    s = TransducerModbus(port, baud=115200, channels=[1, 2, 3])
    s.open()
    hs = s.handshake()
    print(f'握手: {hs}')
    if not any(hs.values()):
        print('握手失败')
        s.close()
        sys.exit(1)
    s.start_continuous(interval_ms=100)
    print('10Hz 轮询 5s...')
    for _ in range(5):
        time.sleep(1)
        latest = s.get_latest()
        print(f'  {latest}')
    s.close()
    print('done.')
