#!/usr/bin/env python3
"""MantaShark Mixer Tuner — MAVLink ↔ WebSocket bridge.

浏览器 SPA 通过 ws://127.0.0.1:8765 连本脚本, 本脚本通过 pymavlink 连飞控.

用途: 实时 PARAM_SET/READ, HEARTBEAT, ATTITUDE, VFR_HUD 透传给 Tuner.

依赖:
  pip install pymavlink websockets
  (已在 sim/.venv 里)

用法:
  python3 mavbridge.py                # 自动找 /dev/ttyACM*
  python3 mavbridge.py --device /dev/ttyACM1 --baud 115200
  python3 mavbridge.py --ws-port 8765

WS 协议 (JSON):
  浏览器 → 桥:
    { "type":"param_read",  "name":"MSK_V1" }
    { "type":"param_read_all" }
    { "type":"param_set",   "name":"MSK_V1", "value":4.5 }
    { "type":"ping" }
  桥 → 浏览器:
    { "type":"status",    "connected":true, "sys":1, "comp":1 }
    { "type":"heartbeat", "mode":"QSTABILIZE", "armed":false }
    { "type":"attitude",  "roll":1.2, "pitch":8.3, "yaw":45 }
    { "type":"vfr_hud",   "airspeed":0, "groundspeed":3.2, "alt":0, "climb":0, "throttle":0 }
    { "type":"param",     "name":"MSK_V1", "value":4.0, "index":42, "count":120 }
    { "type":"statustext","severity":5, "text":"MSK K: ..." }
    { "type":"error",     "msg":"..." }
"""
import os
import sys
import asyncio
import argparse
import json
import glob
import math
import time
import threading
from contextlib import suppress

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VENV_SITE = os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..', 'sim', '.venv', 'lib', 'python3.12', 'site-packages'))
if os.path.isdir(VENV_SITE) and VENV_SITE not in sys.path:
    sys.path.insert(0, VENV_SITE)

# Windows 默认 cp1252 控制台撞中文 → 强制 UTF-8.
# 含 PyInstaller onefile (Win runner CI smoke test) 也走这里.
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass
    try:
        os.system('')  # ANSI escape (Win10+)
    except Exception:
        pass

try:
    from pymavlink import mavutil
    import websockets
    _ws_major = int(websockets.__version__.split('.')[0])
    if _ws_major >= 13:
        print(f'[WARN] websockets=={websockets.__version__} 可能有握手 bug. 建议 pip install "websockets<13"')
except ImportError as e:
    print(f'[FATAL] 缺依赖: {e}')
    print(f'  激活 venv: source {os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "sim", ".venv", "bin", "activate"))}')
    print(f'  或 pip install pymavlink "websockets<13"')
    sys.exit(1)


def find_device():
    """无 GUI 时的回退: 自动选第一个可用串口."""
    for p in ['/dev/ttyACM0', '/dev/ttyACM1', '/dev/ttyACM2', '/dev/ttyUSB0']:
        if os.path.exists(p):
            return p
    cands = glob.glob('/dev/serial/by-id/*')
    if cands:
        return cands[0]
    return None


def scan_serial_ports():
    """扫描所有可用串口 → [(device, description), ...]."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    ports = []
    for p in sorted(list_ports.comports(), key=lambda x: x.device):
        # 过滤 Linux 虚拟 ttyS (没有真实硬件)
        if p.device.startswith('/dev/ttyS') and not p.manufacturer and (p.description or 'n/a') == 'n/a':
            continue
        desc = (p.description or '').strip()
        if p.manufacturer and p.manufacturer not in desc:
            desc = (desc + f' ({p.manufacturer})').strip()
        ports.append((p.device, desc))
    return ports


COMMON_BAUDS = [115200, 57600, 921600, 230400, 460800, 38400]


def interactive_pick(default_baud=115200):
    """交互式让用户选串口 + 波特率. 返回 (device, baud)."""
    print()
    print('  ╔════════════════════════════════════════╗')
    print('  ║  MantaShark Tuner — 选择 FC 连接       ║')
    print('  ╚════════════════════════════════════════╝')
    print()

    ports = scan_serial_ports()
    if ports:
        print('  扫描到以下串口:')
        for i, (dev, desc) in enumerate(ports):
            print(f'    [{i+1}] {dev:<22}  {desc}')
    else:
        print('  ⚠ 未扫描到串口 (pyserial 未装 或 没插 FC).')
    print(f'    [0] 手动输入 (如 COM3 / /dev/ttyUSB0 / udp:14551)')
    print()

    default_idx = '1' if ports else '0'
    choice = input(f'  请选 [{default_idx}]: ').strip() or default_idx

    if choice == '0':
        device = input('  输入连接串: ').strip()
        if not device:
            print('  ✗ 未输入, 退出')
            sys.exit(1)
    else:
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(ports):
                device = ports[idx][0]
            else:
                print(f'  ✗ 无效选择 {choice}')
                sys.exit(1)
        except ValueError:
            # 直接输入了串口名 (如 COM5) 也接受
            device = choice

    print()
    print('  常用波特率:')
    for i, b in enumerate(COMMON_BAUDS):
        marker = ' ← 默认' if b == default_baud else ''
        print(f'    [{i+1}] {b}{marker}')
    print(f'    [0] 自定义')
    print()

    default_baud_idx = str(COMMON_BAUDS.index(default_baud) + 1) if default_baud in COMMON_BAUDS else '1'
    bchoice = input(f'  请选 [{default_baud_idx}]: ').strip() or default_baud_idx

    if bchoice == '0':
        bs = input('  输入波特率: ').strip()
        try:
            baud = int(bs)
        except ValueError:
            print(f'  ✗ 无效波特率 {bs}, 用默认 {default_baud}')
            baud = default_baud
    else:
        try:
            idx = int(bchoice) - 1
            if 0 <= idx < len(COMMON_BAUDS):
                baud = COMMON_BAUDS[idx]
            else:
                baud = default_baud
        except ValueError:
            try:
                baud = int(bchoice)
            except ValueError:
                baud = default_baud

    print()
    print(f'  ✓ 串口: {device} @ {baud}')
    print()
    return device, baud


class Bridge:
    def __init__(self, device, baud):
        self.device = device
        self.baud = baud
        self.mav = None
        self.clients = set()
        self.loop = None
        self.running = True
        self._sys = 1
        self._comp = 1

    def connect_mav(self):
        print(f'[bridge] 连 FC: {self.device} @ {self.baud}')
        self.mav = mavutil.mavlink_connection(self.device, baud=self.baud)
        print('[bridge] 等 HEARTBEAT...')
        m = self.mav.wait_heartbeat(timeout=8)
        if m is None:
            raise RuntimeError('HEARTBEAT 等超时, 检查线缆/设备')
        self._sys = self.mav.target_system
        self._comp = self.mav.target_component
        print(f'[bridge] ✓ FC sys={self._sys} comp={self._comp} type={m.type}')

    def mav_loop(self):
        """后台线程: 收 MAVLink → 广播给 WS 客户端."""
        while self.running:
            m = self.mav.recv_match(blocking=True, timeout=0.5)
            if m is None:
                continue
            t = m.get_type()
            data = None
            if t == 'HEARTBEAT':
                flight_mode = mavutil.mode_string_v10(m) if hasattr(mavutil, 'mode_string_v10') else str(m.custom_mode)
                armed = (m.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED) != 0
                data = {'type': 'heartbeat', 'mode': flight_mode, 'armed': armed}
            elif t == 'ATTITUDE':
                data = {'type': 'attitude',
                        'roll':  math.degrees(m.roll),
                        'pitch': math.degrees(m.pitch),
                        'yaw':   math.degrees(m.yaw)}
            elif t == 'VFR_HUD':
                data = {'type': 'vfr_hud',
                        'airspeed': m.airspeed, 'groundspeed': m.groundspeed,
                        'alt': m.alt, 'climb': m.climb, 'throttle': m.throttle}
            elif t == 'GPS_RAW_INT':
                data = {'type': 'gps',
                        'fix_type': m.fix_type,
                        'sats': m.satellites_visible,
                        'hdop': m.eph / 100.0 if m.eph != 0xFFFF else None}
            elif t == 'PARAM_VALUE':
                name = m.param_id
                if hasattr(name, 'decode'):
                    name = name.decode('ascii', errors='replace')
                name = str(name).rstrip('\x00')
                data = {'type': 'param', 'name': name,
                        'value': float(m.param_value),
                        'index': m.param_index,
                        'count': m.param_count}
            elif t == 'STATUSTEXT':
                txt = m.text
                if hasattr(txt, 'decode'):
                    txt = txt.decode('ascii', errors='replace')
                txt = str(txt).rstrip('\x00')
                data = {'type': 'statustext', 'severity': m.severity, 'text': txt}
            elif t == 'RC_CHANNELS':
                chans = [getattr(m, f'chan{i}_raw', 0) for i in range(1, 9)]
                data = {'type': 'rc', 'channels': chans}
            else:
                continue
            if data is not None and self.loop is not None:
                asyncio.run_coroutine_threadsafe(self.broadcast(data), self.loop)

    async def broadcast(self, obj):
        if not self.clients:
            return
        msg = json.dumps(obj)
        dead = []
        for ws in self.clients:
            try:
                await ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def handle_client(self, ws):
        print(f'[bridge] WS 客户端连入, 共 {len(self.clients) + 1}')
        self.clients.add(ws)
        try:
            await ws.send(json.dumps({'type': 'status', 'connected': True,
                                       'sys': self._sys, 'comp': self._comp,
                                       'device': self.device}))
            async for raw in ws:
                try:
                    req = json.loads(raw)
                except Exception:
                    continue
                t = req.get('type')
                if t == 'ping':
                    await ws.send(json.dumps({'type': 'pong', 'ts': time.time()}))
                elif t == 'param_read':
                    name = req.get('name', '').encode('ascii')
                    self.mav.mav.param_request_read_send(self._sys, self._comp, name, -1)
                elif t == 'param_read_all':
                    self.mav.mav.param_request_list_send(self._sys, self._comp)
                elif t == 'param_set':
                    name = req.get('name', '').encode('ascii')
                    val = float(req.get('value', 0))
                    self.mav.mav.param_set_send(self._sys, self._comp, name, val,
                                                 mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
                elif t == 'arm':
                    self.mav.mav.command_long_send(self._sys, self._comp, 400, 0,
                                                    1, 0, 0, 0, 0, 0, 0)
                elif t == 'disarm':
                    self.mav.mav.command_long_send(self._sys, self._comp, 400, 0,
                                                    0, 0, 0, 0, 0, 0, 0)
                elif t == 'reboot':
                    self.mav.mav.command_long_send(self._sys, self._comp, 246, 0,
                                                    1, 0, 0, 0, 0, 0, 0)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)
            print(f'[bridge] WS 客户端断开, 剩 {len(self.clients)}')

    async def run(self, ws_host, ws_port):
        self.loop = asyncio.get_running_loop()
        t = threading.Thread(target=self.mav_loop, daemon=True)
        t.start()
        print(f'[bridge] WS 服务器监听 ws://{ws_host}:{ws_port}')
        async with websockets.serve(self.handle_client, ws_host, ws_port):
            await asyncio.Future()  # run forever


def main():
    ap = argparse.ArgumentParser(
        description='MantaShark Tuner MAVLink<->WebSocket bridge',
        epilog='No --device: interactive serial+baud picker. --auto: pick first found.')
    ap.add_argument('--device', default=None, help='串口/UDP 连接串 (e.g. COM3, /dev/ttyACM0, udp:14551)')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--ws-host', default='127.0.0.1')
    ap.add_argument('--ws-port', type=int, default=8765)
    ap.add_argument('--auto', action='store_true', help='不交互, 自动选第一个串口')
    args = ap.parse_args()

    if args.device:
        device, baud = args.device, args.baud
    elif args.auto:
        device = find_device()
        if not device:
            print('[FATAL] --auto 模式没找到串口. 插 FC USB 线后重试.')
            sys.exit(2)
        baud = args.baud
        print(f'[bridge] --auto 选: {device} @ {baud}')
    else:
        # 交互式让用户选 (Windows + Linux 通用)
        try:
            device, baud = interactive_pick(default_baud=args.baud)
        except (KeyboardInterrupt, EOFError):
            print('\n[bridge] 已取消')
            sys.exit(1)

    bridge = Bridge(device, baud)
    try:
        bridge.connect_mav()
    except Exception as e:
        print(f'[FATAL] FC 连接失败: {e}')
        sys.exit(3)

    try:
        asyncio.run(bridge.run(args.ws_host, args.ws_port))
    except KeyboardInterrupt:
        print('\n[bridge] 收到 Ctrl-C, 退出')
        bridge.running = False


if __name__ == '__main__':
    main()
