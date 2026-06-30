"""单 RS-485 总线轮询器 — 力变送器 + 16通道电流计共一条 485→USB.

RS-485 多点总线: 一条线挂多 Modbus slave, 站号唯一即可.
  力变送器:   slave 1,  reg 0x01C2, int32×8 (CH1-6 有效, ADC count)
  电流计:     slave 30, reg 0x0050, uint16×16 (CH1-12=M1-12, 0.1A)
波特率: 都设 115200 (电流计自适应主机). 8N1.

单线程串行轮询 (不能两线程抢同串口): 发 slave1 → 收力 → 发 slave30 → 收电流 → 循环.
对外接口跟独立 driver 一致: get_force()/get_current(), 让 runner 透明切换.

用法:
    bus = Bus485('/dev/ttyUSB0', baud=115200)
    bus.open(); bus.handshake()
    bus.start()
    bus.get_force()    # {1: count, ... 6: count}
    bus.get_current()  # {1: A, ... 12: A}
"""
from __future__ import annotations
import sys, time, threading
from pathlib import Path

import serial

# 复用已验证的帧构造/解析
sys.path.insert(0, str(Path(__file__).parent.parent))
from transducer_modbus import TransducerModbus
from current_meter_modbus import CurrentMeterModbus, DUCT_NAMES


class Bus485:
    def __init__(self, port: str, baud: int = 115200,
                 force_slave: int = 1, curr_slave: int = 30):
        self.port = port
        self.baud = baud
        self._ser = None
        # 子 driver 只借用帧构造/解析, 串口共享, 不自起线程
        self.force = TransducerModbus(port, baud=baud, slave=force_slave,
                                      channels=[1, 2, 3, 4, 5, 6])
        self.curr = CurrentMeterModbus(port, baud=baud, slave=curr_slave)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._lf = {}   # 力 latest {ch: count}
        self._lc = {}   # 电流 latest {ch: A}

    def open(self):
        self._ser = serial.Serial(self.port, self.baud, timeout=0.3)
        self.force.attach_serial(self._ser)
        self.curr.attach_serial(self._ser)

    def close(self):
        self.stop()
        if self._ser:
            try: self._ser.close()
            except Exception: pass
            self._ser = None

    def handshake(self):
        """各查一次, 返回 (force_ok 计数, curr_ok 计数). 电流计可能要几帧适应波特率."""
        fok = cok = 0
        for _ in range(3):   # 电流计自适应主机波特率, 多试几帧
            fv = self.force._one_query()
            cv = self.curr._one_query()
            fok = sum(1 for i in range(6) if fv and i < len(fv))
            cok = sum(1 for i in range(12) if cv and i < len(cv))
            if fok and cok:
                break
            time.sleep(0.2)
        return fok, cok

    def start(self, interval_ms: int = 100):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, args=(interval_ms,), daemon=True)
        self._thread.start()

    def stop(self):
        if self._thread:
            self._stop.set()
            self._thread.join(timeout=1.0)
            self._thread = None

    def _loop(self, interval_ms: int):
        interval_s = max(0.05, interval_ms / 1000.0)
        while not self._stop.is_set():
            t0 = time.time()
            # 串行轮询: 先力 (slave1), 再电流 (slave30)
            fv = self.force._one_query(timeout=interval_s * 0.4)
            if fv:
                with self._lock:
                    for ch in range(1, 7):
                        if ch - 1 < len(fv):
                            self._lf[ch] = float(fv[ch - 1])
            cv = self.curr._one_query(timeout=interval_s * 0.4)
            if cv:
                with self._lock:
                    for ch in range(1, 13):
                        if ch - 1 < len(cv):
                            self._lc[ch] = float(cv[ch - 1])
            dt = time.time() - t0
            if dt < interval_s:
                time.sleep(interval_s - dt)

    def get_force(self) -> dict:
        with self._lock:
            return {ch: self._lf.get(ch) for ch in range(1, 7)}

    def get_current(self) -> dict:
        with self._lock:
            return {ch: self._lc.get(ch) for ch in range(1, 13)}

    def total_current(self) -> float:
        with self._lock:
            return sum(v for v in self._lc.values() if v is not None)


if __name__ == '__main__':
    port = sys.argv[1] if len(sys.argv) > 1 else '/dev/ttyUSB0'
    print(f'开共享总线 {port} @115200 (力 slave1 + 电流 slave30)...')
    bus = Bus485(port)
    bus.open()
    fok, cok = bus.handshake()
    print(f'握手: 力 {fok}/6, 电流 {cok}/12')
    if not fok and not cok:
        print('两个都没响应 — 查接线/站号/波特(电流计拨码站号30, 首次可能要等自适应)')
        bus.close(); sys.exit(1)
    bus.start(interval_ms=100)
    print('轮询 5s...')
    for _ in range(5):
        time.sleep(1)
        f = bus.get_force()
        c = bus.get_current()
        frow = ' '.join(f'{k}={f[k]:.0f}' if f[k] is not None else f'{k}=-' for k in range(1, 7))
        crow = ' '.join(f'{DUCT_NAMES[k-1]}={c[k]:.1f}' for k in range(1, 13) if c[k] is not None)
        print(f'  力[count]: {frow}')
        print(f'  电流[A]: Σ={bus.total_current():.1f} | {crow}')
    bus.close()
    print('done.')
