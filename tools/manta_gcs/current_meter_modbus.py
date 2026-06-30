"""HB-CT16B-JC 16-channel current meter driver — Modbus RTU.

手册 (docs/HB-CT16B-JC V1.2.pdf):
- 接口: RS-485 → USB
- 默认: 站号 30, 波特 9600 (自适应主机, 最高 115200), 8N1
- 协议: Modbus RTU, 功能码 0x03 (读保持寄存器)
- 寄存器: 0x0050 起 16 个 (H50..H5F), 每通道 1 个 uint16, 单位 0.1A
- 量程 0-50A, 精度 0.1A, 采样 50ms, 交流真有效值 (夹电机相线)

示例帧 (读 16 通道): 发 1E 03 00 50 00 10 47 B1
通道→涵道: CH1..CH12 = Motor1..Motor12 (飞控涵道序:
  SL1 SL2 SR1 SR2 DFL DFR TL1 TL2 TR1 TR2 RDL RDR). CH13-16 未接.

接口跟 transducer_modbus.TransducerModbus 一致 (open/handshake/
start_continuous/get_latest), GUI/runner 可统一处理两个串口设备.

用法:
    cm = CurrentMeterModbus('/dev/ttyUSB1', baud=9600, slave=30)
    cm.open(); cm.handshake()
    cm.start_continuous(interval_ms=100)
    cm.get_latest()   # {1: 12.3, 2: 11.8, ... 12: 0.0}  单位 A
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
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc.to_bytes(2, 'little')


# 通道 → 涵道名 (CH1..CH12 = Motor1..12, 飞控涵道序)
DUCT_NAMES = ['SL1', 'SL2', 'SR1', 'SR2', 'DFL', 'DFR',
              'TL1', 'TL2', 'TR1', 'TR2', 'RDL', 'RDR']


@dataclass
class Sample:
    t_pc: float
    channels: dict = field(default_factory=dict)   # channel id (1-N) → Amps


class CurrentMeterModbus:
    """HB-CT16B-JC 16 通道电流计 Modbus RTU driver (单位 A)."""

    LSB_TO_A = 0.1   # 寄存器单位 0.1A

    def __init__(self, port: str, baud: int = 9600,
                 slave: int = 30,
                 reg_start: int = 0x0050,
                 reg_count: int = 16,
                 n_channels: int = 12,        # 实际接 12 路涵道
                 channels=None):
        self.port = port
        self.baud = baud
        self.slave = slave
        self.reg_start = reg_start
        self.reg_count = reg_count
        self.n_channels = n_channels
        self.channels = channels if channels else list(range(1, n_channels + 1))
        self._ser: Optional[serial.Serial] = None
        self._stop_flag = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._latest: dict = {}
        self._samples: deque = deque(maxlen=200)
        req = bytes([self.slave, 0x03,
                     (self.reg_start >> 8) & 0xFF, self.reg_start & 0xFF,
                     (self.reg_count >> 8) & 0xFF, self.reg_count & 0xFF])
        self._req_frame = req + _crc16(req)
        # 响应: slave + fn + bytecount(1) + 2*reg_count + CRC(2)
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
            except Exception: pass
            self._ser = None

    def _one_query(self, timeout: float = 0.5) -> Optional[list[float]]:
        """发一帧请求, 收响应, 返回 16 通道电流值 (A) list."""
        if self._ser is None:
            return None
        try:
            self._ser.reset_input_buffer()
            self._ser.write(self._req_frame)
            t0 = time.time()
            buf = b''
            # P1-8 修: 按需精确读 (read(64) 永收不满会阻塞满 0.3s 串口超时, 让 timeout 形参失效)
            while len(buf) < self._expected_len and time.time() - t0 < timeout:
                buf += self._ser.read(self._expected_len - len(buf))
            if len(buf) < self._expected_len:
                return None
            header = bytes([self.slave, 0x03, 2 * self.reg_count])
            idx = buf.find(header)
            if idx < 0:
                return None
            frame_len = 3 + 2 * self.reg_count
            data = buf[idx + 3: idx + frame_len]
            if len(data) < 2 * self.reg_count:
                return None
            # P1-7 修: 校验响应 CRC (强 EMI 台架下防噪声帧静默注入错值)
            crc_recv = buf[idx + frame_len: idx + frame_len + 2]
            if len(crc_recv) == 2 and _crc16(buf[idx: idx + frame_len]) != crc_recv:
                return None
            # 每通道 1 个 uint16 big-endian → ×0.1A
            vals = []
            for i in range(self.reg_count):
                raw = struct.unpack('>H', data[i*2:(i+1)*2])[0]
                vals.append(raw * self.LSB_TO_A)
            return vals
        except Exception:
            return None

    def handshake(self) -> dict:
        """一次请求验证响应. 返回 {channel: bool}."""
        result = {ch: False for ch in self.channels}
        vals = self._one_query()
        if vals:
            for ch in self.channels:
                if 1 <= ch <= len(vals):
                    result[ch] = True
        return result

    def start_continuous(self, interval_ms: int = 100, **kwargs):
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
                            self._latest[ch] = vals[ch - 1]
                            sample.channels[ch] = vals[ch - 1]
                    self._samples.append(sample)
            dt = time.time() - t0
            if dt < interval_s:
                time.sleep(interval_s - dt)

    def get_latest(self) -> dict:
        with self._lock:
            return {ch: self._latest.get(ch) for ch in self.channels}

    def total_current(self) -> float:
        """12 路电流和 (A)."""
        with self._lock:
            return sum(v for v in self._latest.values() if v is not None)


if __name__ == '__main__':
    import sys
    port = sys.argv[1] if len(sys.argv) > 1 else '/dev/ttyUSB1'
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else 9600
    print(f'开 {port} @ {baud} Modbus RTU slave 30 (HB-CT16B-JC)...')
    cm = CurrentMeterModbus(port, baud=baud)
    cm.open()
    hs = cm.handshake()
    ok = sum(1 for v in hs.values() if v)
    print(f'握手: {ok}/{len(hs)} 通道响应')
    if not ok:
        print('握手失败 — 查站号(拨码)/波特/接线'); cm.close(); sys.exit(1)
    cm.start_continuous(interval_ms=100)
    print('10Hz 轮询 5s (CH1-12 = SL1..RDR, 单位 A)...')
    for _ in range(5):
        time.sleep(1)
        latest = cm.get_latest()
        row = '  '.join(f'{DUCT_NAMES[ch-1]}={latest[ch]:.1f}'
                        for ch in range(1, 13) if latest.get(ch) is not None)
        print(f'  Σ={cm.total_current():.1f}A | {row}')
    cm.close()
    print('done.')
