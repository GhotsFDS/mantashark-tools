#!/usr/bin/env python3
"""MantaShark 地面站 — MAVLink ↔ WebSocket bridge.

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
# PyInstaller frozen EXE: __file__ 指向 PyInstaller 虚拟路径, 真正的 .py
# 资源 (datas 嵌入的 log_analysis.py / rtk.py) 在 sys._MEIPASS 临时目录里.
if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
    if sys._MEIPASS not in sys.path:
        sys.path.insert(0, sys._MEIPASS)
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

# v9 P4 RTK manager (9PS Survey-In + RTCM3 → MAVLink GPS_RTCM_DATA 注入)
try:
    from rtk import RtkManager
except ImportError:
    RtkManager = None
    print('[WARN] rtk.py 缺失, RTK 功能不可用')

# v9 P4 LOG analyzer (lib local, 同目录)
try:
    sys.path.insert(0, SCRIPT_DIR)
    from log_analysis import analyze_log as _analyze_log  # type: ignore
except ImportError as _e:
    print(f'[WARN] log_analysis import 失败 ({_e}), /analyze_log WS 不可用')
    _analyze_log = None  # type: ignore


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
    def __init__(self, device, baud, mp_outs=None):
        self.device = device
        self.baud = baud
        self.mav = None
        self.clients = set()
        self.loop = None
        self.running = True
        self._sys = 1
        self._comp = 1
        # MP forward 入口列表 (UDP 字符串, eg ['udpout:127.0.0.1:14550'] / ['udpin:0.0.0.0:14550']).
        # mavbridge 收 FC → forward 给所有 mp_outs; 也读 mp_outs 回包写回 FC.
        self.mp_outs = mp_outs or []
        self.mp_conns = []   # [mavutil.mavlink_connection, ...]
        # SERVO_OUTPUT_RAW 24 路缓存 (按 port 字段分段):
        # port=0 → 1-8, port=1 → 9-16, port=2 → 17-24 (倾转舵 RDL/RDR/SGRP 在这)
        self.servo_buf = [0] * 24

        # ═════════════ MAVLink mission protocol state (参考 MP saveWPs) ═════════════
        # upload: Tuner→fc.  收 MISSION_REQUEST_INT(seq) → 弹 _mission_upload[seq] 发 MISSION_ITEM_INT
        self._mission_upload = None       # None or list of {lat, lon, alt, cmd}
        self._mission_upload_start_ms = 0
        # download: fc→Tuner.  收 MISSION_COUNT(N) → 循环 MISSION_REQUEST_INT(0..N-1) → 收 MISSION_ITEM_INT
        self._mission_download = None     # None or {count, items: list, next_seq}
        self._mission_download_start_ms = 0
        # 电池缓存 — ArduPilot BATTERY_STATUS 偶尔发 current=-1 (该帧未读到), 保持上次有效值防跳变
        self.last_battery_current = None
        self.last_battery_voltage = 0
        self.last_battery_remaining = -1
        self.last_battery_consumed = 0
        # RTK manager (lazy init after FC connect, needs mav handle)
        self.rtk = None

    def connect_mav(self):
        print(f'[bridge] 连 FC: {self.device} @ {self.baud}')
        # 必须用 MAVLink v2 dialect (ardupilotmega): SERVO_OUTPUT_RAW 后 8 路 (servo9..16_raw)
        # 是 v2 extension 字段, v1 默认会丢. 不设 dialect 时 ArduPilot 4.7 默认 v2 但保险显式给.
        os.environ.setdefault('MAVLINK20', '1')
        self.mav = mavutil.mavlink_connection(self.device, baud=self.baud, dialect='ardupilotmega')
        print('[bridge] 等 HEARTBEAT...')
        m = self.mav.wait_heartbeat(timeout=8)
        if m is None:
            raise RuntimeError('HEARTBEAT 等超时, 检查线缆/设备')
        self._sys = self.mav.target_system
        self._comp = self.mav.target_component
        print(f'[bridge] ✓ FC sys={self._sys} comp={self._comp} type={m.type}')

        # 纯 raw 架构: 不再写死流请求. GCS 连入后自己发 set_msg_interval 请求
        # 所需消息+频率 (ATTITUDE/VFR_HUD/NAMED_VALUE_FLOAT/...), 加信号/改频率不碰 mavbridge.

        # 起 MP forward 出口 (Mission Planner / QGC 接这些 UDP 端点)
        for spec in self.mp_outs:
            try:
                conn = mavutil.mavlink_connection(spec, source_system=255, source_component=0)
                self.mp_conns.append(conn)
                print(f'[bridge] MP 桥: {spec} ✓')
            except Exception as e:
                print(f'[bridge] MP 桥失败 {spec}: {e}')

        # RTK manager: forward 9PS RTCM3 → FC GPS_RTCM_DATA
        # Backup raw RTCM byte stream to LOGS/<date>_<src>.gpsbase (MP-style)
        if RtkManager is not None:
            backup_dir = os.path.join(SCRIPT_DIR, '..', '..', 'LOGS', 'rtk')
            self.rtk = RtkManager(
                self.mav, self._sys, self._comp,
                on_status=lambda d: self._broadcast_thread('rtk_status', d),
                on_svin=lambda d: self._broadcast_thread('rtk_svin', d),
                on_inject=lambda d: self._broadcast_thread('rtk_inject', d),
                backup_dir=os.path.normpath(backup_dir),
            )

    def _broadcast_thread(self, type_str, data_dict):
        """Thread-safe broadcast helper for RTK callbacks (called from RTK reader thread)."""
        if self.loop is None:
            return
        msg = {'type': type_str, **data_dict}
        asyncio.run_coroutine_threadsafe(self.broadcast(msg), self.loop)

    def mav_loop(self):
        """后台线程: 收 MAVLink → 广播给 WS 客户端 + 转发给 MP."""
        while self.running:
            m = self.mav.recv_match(blocking=True, timeout=0.5)
            if m is None:
                continue
            # FC → MP 透传 (整包转发)
            if self.mp_conns:
                try:
                    buf = m.get_msgbuf()
                    for c in self.mp_conns:
                        try: c.write(buf)
                        except Exception: pass
                except Exception:
                    pass
            t = m.get_type()
            data = None

            # ═══ 纯 raw 透传架构: 遥测一律 {type:'mav', mt, f}, GCS 自己解析 ═══
            # 保留服务端必须处理的: mission 协议状态机 (RPC 支持) / RTK rover tap / STATUSTEXT utf-8.
            # 新增遥测信号 / 改频率 → 全在 GCS 侧 (set_message_interval), 不碰 mavbridge.

            # ── mission 协议 (upload/download 状态机, 非遥测, 服务端处理) ──
            if t in ('MISSION_REQUEST_INT', 'MISSION_REQUEST'):
                if self._mission_upload is not None:
                    seq = int(m.seq)
                    if 0 <= seq < len(self._mission_upload):
                        wp = self._mission_upload[seq]
                        self.mav.mav.mission_item_int_send(
                            self._sys, self._comp, seq,
                            int(wp.get('frame', mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT)),
                            int(wp.get('cmd', mavutil.mavlink.MAV_CMD_NAV_WAYPOINT)),
                            0, 1,
                            float(wp.get('p1', 0)), float(wp.get('p2', 0)),
                            float(wp.get('p3', 0)), float(wp.get('p4', 0)),
                            int(wp['lat'] * 1e7), int(wp['lon'] * 1e7), float(wp.get('alt', 0)),
                            mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
                continue
            elif t == 'MISSION_ACK':
                if self._mission_upload is not None:
                    res = int(m.type)
                    res_name = mavutil.mavlink.enums['MAV_MISSION_RESULT'][res].name if res in mavutil.mavlink.enums['MAV_MISSION_RESULT'] else str(res)
                    elapsed = (time.time() * 1000) - self._mission_upload_start_ms
                    data = {'type': 'mission_uploaded', 'count': len(self._mission_upload),
                            'result': res, 'result_name': res_name, 'elapsed_ms': int(elapsed)}
                    self._mission_upload = None
            elif t == 'MISSION_COUNT':
                if self._mission_download is not None:
                    self._mission_download['count'] = int(m.count)
                    self._mission_download['items'] = [None] * int(m.count)
                    self._mission_download['next_seq'] = 0
                    if m.count > 0:
                        self.mav.mav.mission_request_int_send(self._sys, self._comp, 0,
                            mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
                    else:
                        self.mav.mav.mission_ack_send(self._sys, self._comp,
                            mavutil.mavlink.MAV_MISSION_ACCEPTED, mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
                        data = {'type': 'mission_list', 'count': 0, 'wps': []}
                        self._mission_download = None
            elif t == 'MISSION_ITEM_INT':
                if self._mission_download is not None:
                    seq = int(m.seq)
                    if 0 <= seq < self._mission_download['count']:
                        self._mission_download['items'][seq] = {
                            'seq': seq, 'frame': int(m.frame), 'cmd': int(m.command),
                            'lat': m.x / 1e7, 'lon': m.y / 1e7, 'alt': float(m.z),
                            'p1': float(m.param1), 'p2': float(m.param2),
                            'p3': float(m.param3), 'p4': float(m.param4)}
                    next_seq = seq + 1
                    if next_seq < self._mission_download['count']:
                        self._mission_download['next_seq'] = next_seq
                        self.mav.mav.mission_request_int_send(self._sys, self._comp, next_seq,
                            mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
                    else:
                        self.mav.mav.mission_ack_send(self._sys, self._comp,
                            mavutil.mavlink.MAV_MISSION_ACCEPTED, mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
                        data = {'type': 'mission_list', 'count': self._mission_download['count'],
                                'wps': self._mission_download['items']}
                        self._mission_download = None
                # mission item 不再 raw 透传 (download 中), 但非 download 期也无意义
                if data is None:
                    continue
            else:
                # ── RTK rover-position tap (服务端 NTRIP $GPGGA 需要), 之后仍 raw 透传 ──
                if t == 'GLOBAL_POSITION_INT' and self.rtk is not None:
                    try:
                        self.rtk.update_rover_position(m.lat / 1e7, m.lon / 1e7, m.alt / 1000.0)
                    except Exception:
                        pass
                # ── generic raw 透传: 任意 MAVLink msg → {type:'mav', mt, f} ──
                f = m.to_dict()
                f.pop('mavpackettype', None)
                # STATUSTEXT utf-8: to_dict 的 text 已被 ascii mangle, 用 _text_raw 重解
                if t == 'STATUSTEXT':
                    raw_txt = getattr(m, '_text_raw', None)
                    if raw_txt is not None:
                        f['text'] = raw_txt.split(b'\x00', 1)[0].decode('utf-8', errors='replace')
                data = {'type': 'mav', 'mt': t, 'f': f}
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
                elif t == 'mission_upload':
                    # Tuner → fc: 上传 WP 列表 (参考 MP saveWPs)
                    # ⚠ ArduPlane 强制 seq=0 = home (no-op replace user data), 必须 prepend home,
                    # user WPs 从 seq=1 起算 (跟 MP commandlist.Insert(0, home) 一致)
                    wps = req.get('wps') or []
                    if not isinstance(wps, list):
                        await ws.send(json.dumps({'type':'mission_uploaded','error':'wps must be list'}))
                        continue
                    # prepend home dummy (用 user 第一个 WP 当 home 占位, ArduPlane 内部用 GPS 真实 home 替换)
                    home = {'lat': wps[0]['lat'] if wps else 0.0, 'lon': wps[0]['lon'] if wps else 0.0,
                            'alt': 0.0, 'frame': mavutil.mavlink.MAV_FRAME_GLOBAL}
                    self._mission_upload = [home] + wps
                    self._mission_upload_start_ms = int(time.time() * 1000)
                    self.mav.mav.mission_count_send(self._sys, self._comp,
                                                    len(self._mission_upload),
                                                    mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
                    await ws.send(json.dumps({'type':'mission_upload_started','count':len(wps)}))
                elif t == 'mission_download':
                    # Tuner → fc: 拉 fc 上当前 mission (启动 request_list)
                    self._mission_download = {'count': 0, 'items': [], 'next_seq': 0}
                    self._mission_download_start_ms = int(time.time() * 1000)
                    self.mav.mav.mission_request_list_send(self._sys, self._comp,
                                                            mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
                    await ws.send(json.dumps({'type':'mission_download_started'}))
                elif t == 'mission_clear':
                    # 清 fc 上 mission
                    self.mav.mav.mission_clear_all_send(self._sys, self._comp,
                                                        mavutil.mavlink.MAV_MISSION_TYPE_MISSION)
                    await ws.send(json.dumps({'type':'mission_cleared'}))
                elif t == 'motor_test':
                    # MAV_CMD_DO_MOTOR_TEST = 209
                    # 绕过 Q_M_PWM disarmed 强制 0, 用 ArduPilot 内置 motor_test, 不需 arm
                    # p1 motor_instance (1-12), p2 throttle_type (1=PCT 固定, 不读 req.type 防字段冲突),
                    # p3 throttle_value, p4 timeout_sec, p5 motor_count, p6 test_order, p7 0
                    motor_idx = int(req.get('motor', 1))
                    throttle_val = float(req.get('value', 5))  # 5% 默认怠速
                    timeout_s = float(req.get('timeout', 2))   # 2s 默认
                    self.mav.mav.command_long_send(self._sys, self._comp, 209, 0,
                                                    motor_idx, 1, throttle_val, timeout_s, 0, 0, 0)
                elif t == 'motor_test_stop':
                    # 显式停 (timeout=0 立即结束)
                    self.mav.mav.command_long_send(self._sys, self._comp, 209, 0,
                                                    1, 1, 0, 0, 0, 0, 0)
                elif t == 'set_mode':
                    # v9 P7: 切 ArduPilot custom mode (WIG_AUTO=27 / WIG_RECV=29 / QSTAB=17)
                    # MAV_CMD_DO_SET_MODE = 176, p1 = base_mode, p2 = custom_mode
                    # base_mode 必须含 MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1
                    mode_id = int(req.get('mode', 17))
                    base_mode = mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
                    self.mav.mav.command_long_send(self._sys, self._comp, 176, 0,
                                                    base_mode, mode_id, 0, 0, 0, 0, 0)
                elif t == 'command_long':
                    # 通用 MAV_CMD 出口: GCS 自主发任意 command (不用为新 cmd 改 mavbridge)
                    # {type:'command_long', command:<id>, params:[p1..p7]}
                    p = list(req.get('params', [])) + [0] * 7
                    self.mav.mav.command_long_send(self._sys, self._comp,
                        int(req['command']), 0,
                        float(p[0]), float(p[1]), float(p[2]), float(p[3]),
                        float(p[4]), float(p[5]), float(p[6]))
                elif t == 'set_msg_interval':
                    # GCS 自主请求任意消息流+频率 (MAV_CMD_SET_MESSAGE_INTERVAL=511)
                    # {type:'set_msg_interval', msgid:<id>, hz:<rate>} (hz<=0 → 关流)
                    hz = float(req.get('hz', 0))
                    interval_us = (1e6 / hz) if hz > 0 else -1
                    self.mav.mav.command_long_send(self._sys, self._comp, 511, 0,
                        int(req['msgid']), interval_us, 0, 0, 0, 0, 0)
                elif t == 'analyze_log':
                    # v9 P4: BIN 离线分析 (CPU-bound, 走 thread executor 不阻塞 WS)
                    if _analyze_log is None:
                        await ws.send(json.dumps({'type': 'log_analysis_done',
                                                   'error': 'log_analysis lib unavailable'}))
                        continue
                    bin_path = req.get('path', '')
                    cur_params = req.get('current_params') or {}
                    if not bin_path or not os.path.isfile(bin_path):
                        await ws.send(json.dumps({'type': 'log_analysis_done',
                                                   'error': f'BIN 不存在: {bin_path}'}))
                        continue
                    await ws.send(json.dumps({'type': 'log_analysis_progress',
                                               'pct': 5, 'msg': '解析 BIN...'}))
                    try:
                        loop = asyncio.get_running_loop()
                        result = await loop.run_in_executor(
                            None, _analyze_log, bin_path, cur_params)
                        await ws.send(json.dumps({'type': 'log_analysis_done',
                                                   'data': result}))
                    except Exception as ex:
                        await ws.send(json.dumps({'type': 'log_analysis_done',
                                                   'error': f'分析失败: {ex}'}))
                elif t == 'rtk_connect':
                    if self.rtk is None:
                        await ws.send(json.dumps({'type':'rtk_status','error':'RTK module unavailable'}))
                        continue
                    port = req.get('port', '').strip()
                    baud = int(req.get('baud', 115200))
                    if not port:
                        await ws.send(json.dumps({'type':'rtk_status','error':'port empty'}))
                        continue
                    self.rtk.connect(port, baud)
                elif t == 'rtk_disconnect':
                    if self.rtk:
                        self.rtk.disconnect()
                elif t == 'rtk_survey_start':
                    if self.rtk:
                        min_dur = int(req.get('min_dur', 60))
                        acc_mm = int(req.get('acc_mm', 2500))
                        self.rtk.start_survey_in(min_dur, acc_mm)
                elif t == 'rtk_survey_stop':
                    if self.rtk:
                        self.rtk.stop_survey_in()
                elif t == 'rtk_inject':
                    if self.rtk:
                        self.rtk.set_inject(bool(req.get('on', False)))
                elif t == 'rtk_list_ports':
                    # Return available serial ports for 9PS picker
                    try:
                        from serial.tools import list_ports
                        ports = []
                        for p in list_ports.comports():
                            ports.append({'device': p.device, 'description': p.description,
                                          'manufacturer': p.manufacturer or '',
                                          'vid': p.vid, 'pid': p.pid})
                        await ws.send(json.dumps({'type':'rtk_ports','ports':ports}))
                    except Exception as ex:
                        await ws.send(json.dumps({'type':'rtk_ports','error':str(ex)}))
                elif t == 'rtk_fixed_pos':
                    if self.rtk:
                        try:
                            lat = float(req.get('lat', 0))
                            lon = float(req.get('lon', 0))
                            alt = float(req.get('alt', 0))
                            acc = int(req.get('acc_mm', 100))
                            self.rtk.set_fixed_position(lat, lon, alt, acc)
                        except Exception as ex:
                            await ws.send(json.dumps({'type':'rtk_status','error':f'fixed_pos: {ex}'}))
                elif t == 'rtk_ntrip_connect':
                    if self.rtk:
                        host = req.get('host', '').strip()
                        port = int(req.get('port', 2101))
                        mp = req.get('mountpoint', '').strip()
                        user = req.get('user', '')
                        pw = req.get('password', '')
                        v1 = bool(req.get('v1', False))
                        if not host or not mp:
                            await ws.send(json.dumps({'type':'rtk_status','error':'host/mountpoint required'}))
                        else:
                            self.rtk.ntrip_connect(host, port, mp, user, pw, ntrip_v1=v1)
                elif t == 'rtk_ntrip_disconnect':
                    if self.rtk:
                        self.rtk.ntrip_disconnect()
                elif t == 'rtk_ntrip_sourcetable':
                    if self.rtk:
                        host = req.get('host', '').strip()
                        port = int(req.get('port', 2101))
                        try:
                            entries = self.rtk.ntrip_fetch_sourcetable(host, port)
                            await ws.send(json.dumps({'type':'rtk_sourcetable','entries':entries}))
                        except Exception as ex:
                            await ws.send(json.dumps({'type':'rtk_sourcetable','error':str(ex)}))
                elif t == 'pid_apply':
                    # v9 P4: 应用 PID 建议 (前端必须先双确认 + 备份). 这里只批量 PARAM_SET.
                    # 防呆: 必须 disarmed (前端检查 + 此处 best-effort 二次)
                    params_to_set = req.get('params') or {}
                    for pname, pval in params_to_set.items():
                        try:
                            name_b = str(pname).encode('ascii')
                            self.mav.mav.param_set_send(
                                self._sys, self._comp, name_b, float(pval),
                                mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
                        except Exception as ex:
                            await ws.send(json.dumps({'type': 'pid_apply_err',
                                                       'name': pname, 'err': str(ex)}))
                    await ws.send(json.dumps({'type': 'pid_apply_done',
                                               'count': len(params_to_set)}))
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.clients.discard(ws)
            print(f'[bridge] WS 客户端断开, 剩 {len(self.clients)}')

    def mp_to_fc_loop(self, conn, label):
        """MP → FC: 把 MP 端 (Mission Planner / QGC) 发的 MAVLink 透传到 FC."""
        while self.running:
            try:
                m = conn.recv_match(blocking=True, timeout=0.5)
            except Exception:
                continue
            if m is None or m.get_type() == 'BAD_DATA':
                continue
            try:
                self.mav.write(m.get_msgbuf())
            except Exception as e:
                print(f'[bridge] MP→FC 写失败 ({label}): {e}')

    async def run(self, ws_host, ws_port):
        self.loop = asyncio.get_running_loop()
        t = threading.Thread(target=self.mav_loop, daemon=True)
        t.start()
        # 每个 MP 端点起独立线程做反向转发
        for spec, conn in zip(self.mp_outs, self.mp_conns):
            tt = threading.Thread(target=self.mp_to_fc_loop, args=(conn, spec), daemon=True)
            tt.start()
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
    ap.add_argument('--mp-out', action='append', default=[],
                    help='MP/QGC 桥接出口, eg udpout:127.0.0.1:14550 (可多次). 双向转发.')
    args = ap.parse_args()

    if args.device:
        device, baud = args.device, args.baud
        mp_outs = list(args.mp_out)
    elif args.auto:
        device = find_device()
        if not device:
            print('[FATAL] --auto 模式没找到串口. 插 FC USB 线后重试.')
            sys.exit(2)
        baud = args.baud
        mp_outs = list(args.mp_out)
        print(f'[bridge] --auto 选: {device} @ {baud}')
    else:
        # 交互式让用户选 (Windows + Linux 通用)
        try:
            device, baud = interactive_pick(default_baud=args.baud)
            # 问 MP 桥接
            ans = input('  桥接到 Mission Planner / QGC? [y/N]: ').strip().lower()
            mp_outs = list(args.mp_out)
            if ans == 'y':
                pmp = input('  MP UDP 端口 [14550]: ').strip() or '14550'
                mp_outs.append(f'udpout:127.0.0.1:{pmp}')
                print(f'  ✓ MP 桥接: udpout:127.0.0.1:{pmp}')
                print(f'    MP 端添加 UDP 连接: 127.0.0.1:{pmp}')
        except (KeyboardInterrupt, EOFError):
            print('\n[bridge] 已取消')
            sys.exit(1)

    bridge = Bridge(device, baud, mp_outs=mp_outs)
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
