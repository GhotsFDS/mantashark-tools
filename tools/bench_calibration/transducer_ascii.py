"""6-channel transducer ASCII protocol driver.

per docs/三种协议: ASCII协议, Modbus协议和自由协议.docx
- 默认 8N1 9600 bps, 帧 `:` + addr(3B) + cmd + content + CR LF
- 关键指令: CONNECT (握手), RDMS (读测量值), CONTI=... (连续发送)
- 6 通道变送器: 默认假设各通道有独立子地址 (001-006)
  实际硬件协议如果用 SELCH/RDMS+ch 索引, 通过 channel_strategy 参数切

Usage:
    drv = TransducerAscii('/dev/ttyUSB0', channels=[1, 2, 3])
    drv.open()
    drv.handshake()
    drv.start_continuous(interval_ms=50, fmt=1)
    while True:
        sample = drv.read_sample(timeout=0.2)
        if sample: print(sample)   # {'ch1': 12.34, 'ch2': 23.45, 'ch3': 34.56, 't_pc': 1234.56}
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from queue import Queue, Empty
from typing import Optional

import serial

# Frame parser regex: `:` + 3-digit addr + content + \r\n
# Content format examples:
#   :001MS=12.34
#   :001OK
#   :002MS=-5.6
FRAME_RE = re.compile(rb':(\d{3})([A-Z]+)(?:=([^\r\n]*))?\r?\n?')


@dataclass
class Sample:
    t_pc: float                   # PC clock at frame parse time (epoch sec)
    channels: dict[int, float] = field(default_factory=dict)   # addr → value


class TransducerAscii:
    def __init__(self, port: str, baud: int = 9600,
                 channels: list[int] = None,
                 channel_strategy: str = 'sub_address',
                 timeout: float = 0.2):
        """
        port: serial device (e.g. /dev/ttyUSB0)
        baud: 9600 (default), 19200, 38400, 57600, 115200, 230400
        channels: list of channel addresses to use, default [1, 2, 3]
        channel_strategy: 'sub_address' (each ch has own addr 001..006)
                          or 'single_addr' (single addr, RDMS returns multi-value — TBD)
        """
        self.port = port
        self.baud = baud
        self.channels = channels or [1, 2, 3]
        self.channel_strategy = channel_strategy
        self.timeout = timeout
        self.ser: Optional[serial.Serial] = None
        self._reader_thread: Optional[threading.Thread] = None
        self._stop_flag = threading.Event()
        self._sample_queue: Queue[Sample] = Queue(maxsize=500)
        self._latest = {ch: None for ch in self.channels}
        self._lock = threading.Lock()

    def open(self):
        self.ser = serial.Serial(self.port, self.baud, bytesize=8,
                                  parity='N', stopbits=1, timeout=self.timeout)
        # Flush any boot junk
        self.ser.reset_input_buffer()
        self.ser.reset_output_buffer()

    def close(self):
        if self._reader_thread:
            self._stop_flag.set()
            self._reader_thread.join(timeout=1.0)
        if self.ser and self.ser.is_open:
            self.ser.close()

    def _send_cmd(self, addr: int, cmd: str, content: str = '') -> None:
        """Send :NNNCMD<content>\\r\\n"""
        payload = f':{addr:03d}{cmd}{content}\r\n'.encode('ascii')
        self.ser.write(payload)
        self.ser.flush()

    def _read_response_blocking(self, expected_addr: int, timeout: float = 1.0) -> Optional[bytes]:
        """Read one response frame ending with \\r\\n. Blocking with timeout."""
        deadline = time.time() + timeout
        buf = b''
        while time.time() < deadline:
            byte = self.ser.read(1)
            if not byte:
                continue
            buf += byte
            if buf.endswith(b'\n'):
                if buf.startswith(b':') and f'{expected_addr:03d}'.encode() in buf:
                    return buf
                buf = b''   # not for us, reset
        return None

    def handshake(self) -> dict[int, bool]:
        """Try CONNECT on each configured channel. Returns {addr: ok}."""
        results = {}
        for ch in self.channels:
            self._send_cmd(ch, 'CONNECT')
            resp = self._read_response_blocking(ch, timeout=0.5)
            results[ch] = bool(resp and b'OK' in resp)
        return results

    def start_continuous(self, data_type: int = 0, send_type: int = 0,
                         interval_ms: int = 50, fmt: int = 1) -> None:
        """Enable continuous transmit on all configured channels.

        data_type:   0=测量值 / 1=AD内码 / 2=毛重 / 3=净重
        send_type:   0=always send / 1=only on change
        interval_ms: gap between frames
        fmt:         0=full ASCII (with addr/cmd/content) / 1=simplified (value only?)
        """
        # Per docx: CONTI=Enable,DataType,SendType,Intervals,Format
        # We use full format (fmt=0) to keep addr disambiguation
        content = f'={"01" if True else "0"},{data_type},{send_type},{interval_ms},0'
        for ch in self.channels:
            self._send_cmd(ch, 'CONTI', content)
            time.sleep(0.05)   # spacing for RS485
        # Wait for first frames; start reader thread
        self._stop_flag.clear()
        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader_thread.start()

    def stop_continuous(self) -> None:
        for ch in self.channels:
            self._send_cmd(ch, 'CONTI', '=0,0,0,100,0')
            time.sleep(0.05)
        self._stop_flag.set()

    def _reader_loop(self):
        """Background thread: read bytes, parse :NNNMS=VALUE frames, dispatch."""
        buf = b''
        while not self._stop_flag.is_set():
            try:
                data = self.ser.read(256)
            except (serial.SerialException, OSError):
                break
            if not data:
                continue
            buf += data
            # Process all complete frames
            while True:
                m = FRAME_RE.search(buf)
                if not m:
                    break
                addr = int(m.group(1))
                cmd = m.group(2).decode('ascii', errors='ignore')
                content = m.group(3)
                # Trim consumed
                buf = buf[m.end():]
                if cmd == 'MS' and content is not None:
                    try:
                        val = float(content.decode('ascii', errors='ignore'))
                    except ValueError:
                        continue
                    now = time.time()
                    with self._lock:
                        self._latest[addr] = val
                        # If all configured channels have recent values, emit a Sample
                        if all(self._latest.get(c) is not None for c in self.channels):
                            sample = Sample(t_pc=now,
                                            channels={c: self._latest[c] for c in self.channels})
                            try:
                                self._sample_queue.put_nowait(sample)
                            except Exception:
                                pass   # queue full, drop oldest sample

    def read_sample(self, timeout: float = 0.5) -> Optional[Sample]:
        """Get one Sample (all channels collated). Returns None on timeout."""
        try:
            return self._sample_queue.get(timeout=timeout)
        except Empty:
            return None

    def get_latest(self) -> dict[int, Optional[float]]:
        with self._lock:
            return dict(self._latest)


if __name__ == '__main__':
    import sys
    port = sys.argv[1] if len(sys.argv) > 1 else '/dev/ttyUSB0'
    drv = TransducerAscii(port, channels=[1, 2, 3])
    drv.open()
    print('handshake:', drv.handshake())
    drv.start_continuous(interval_ms=100)
    try:
        for _ in range(30):
            s = drv.read_sample(timeout=1.0)
            print(s)
    finally:
        drv.stop_continuous()
        drv.close()
