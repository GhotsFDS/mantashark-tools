#!/usr/bin/env python3
"""
MantaShark 专用地面站 — 自动扫描串口 + MAVProxy 分发 + Web 仪表盘。

启动:
  python msk_gcs.py              (交互式: 扫描串口 → 选择 → 自动 MAVProxy)
  python msk_gcs.py --master=udpin:0.0.0.0:14551   (直连: 跳过 MAVProxy)

浏览器打开 http://localhost:9088
Windows / Linux / macOS 通用。
"""

import argparse
import json
import math
import re
import socket
import subprocess
import signal
import threading
import time
import sys
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from pymavlink import mavutil

if sys.platform == 'win32':
    os.system('')  # 启用 ANSI escape (Win10+)
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

# ─── 全局状态 ───
state = {
    # 飞控基础
    "armed": False,
    "connected": False,
    "heartbeat_age": 99,
    # 姿态
    "pitch": 0.0, "roll": 0.0, "yaw": 0.0,
    # GPS
    "gps_fix": 0, "gps_nsat": 0, "gps_hdop": 99.9,
    "groundspeed": 0.0,
    # 电池
    "batt1_v": 0.0, "batt1_a": 0.0, "batt1_pct": -1,
    "batt2_v": 0.0, "batt2_a": 0.0, "batt2_pct": -1,
    # SERVO 输出 (14 路 + 2 倾转舵)
    "servo": [0]*16,
    # RC 输入 (9 通道)
    "rc": [0]*10,
    # ─── MantaShark 专有 ───
    "msk_mode": "?",       # NOGPS / GPS
    "msk_gear": 0,         # 1/2/3
    "msk_auto": False,
    "msk_tilt": 0.0,       # 倾转角 °
    "msk_ks": 0, "msk_kdf": 0, "msk_kdm": 0, "msk_kt": 0, "msk_krd": 0,
    "msk_speed": 0.0,      # 混控用的速度 (限速后)
    "msk_speed_raw": 0.0,  # 原始 GPS 速度
    "msk_pitch": 0.0,      # 混控看到的俯仰角
    "msk_chk_stage": "",   # 预检阶段
    # GCS 消息流
    "messages": [],        # 最近 200 条
    # ─── 飞控参数缓存 ───
    "params": {},          # {name: value} 全量参数 (启动时 fetch_all)
    "params_ready": False, # 参数是否已全部拉取
}
state_lock = threading.Lock()
MAX_MESSAGES = 200
param_write_queue = []     # [(name, value), ...] 待写入队列 (线程安全靠 state_lock)
param_refetch_flag = [False]  # HTTP 请求"刷新 MSK_ 参数" 的信号
param_read_queue = []      # [name, ...] 定向读参数队列 (由 refetch_flag 填)

# 62 个 MSK 参数名 (从 scripts/mantashark_mixer_v7_gps.lua add_param 生成)
# 定向读代替 param_fetch_all, 57600 数传从 30-60s 降到 3-5s
MSK_PARAMS = [
    "MSK_ATT_KP","MSK_AUTO_CH","MSK_AUTO_CUT","MSK_AUTO_TGT",
    "MSK_CHK_CH","MSK_CHK_GRP_MS","MSK_CHK_PWM","MSK_CHK_STOP",
    "MSK_GEAR_CH","MSK_GPS_TAU",
    "MSK_KDF1","MSK_KDF2","MSK_KDF3",
    "MSK_KDM1","MSK_KDM2","MSK_KDM3",
    "MSK_KRD1","MSK_KRD2","MSK_KRD3",
    "MSK_KS1","MSK_KS2","MSK_KS3",
    "MSK_KT1","MSK_KT2","MSK_KT3",
    "MSK_M1_KDF","MSK_M1_KDM","MSK_M1_KRD","MSK_M1_KS","MSK_M1_KT",
    "MSK_M2_KDF","MSK_M2_KDM","MSK_M2_KRD","MSK_M2_KS","MSK_M2_KT",
    "MSK_M3_KDF","MSK_M3_KDM","MSK_M3_KRD","MSK_M3_KS","MSK_M3_KT",
    "MSK_MODE_CH","MSK_PIT_LIM","MSK_RAMP","MSK_RC_LIM","MSK_ROL_LIM",
    "MSK_TILT_CAL","MSK_TILT_DEG",
    "MSK_TILT_L_DIR","MSK_TILT_L_ZERO","MSK_TILT_R_DIR","MSK_TILT_R_ZERO",
    "MSK_TILT_SVL","MSK_TILT_SVR","MSK_TILT_TAU","MSK_TILT_USPD",
    "MSK_TILT_V1","MSK_TILT_V2","MSK_TILT_V3",
    "MSK_V1","MSK_V2","MSK_V3","MSK_WING_OFS",
]

# ─── MSK 日志解析 ───
# GPS 模式: "MSK_G G2A V6.0 P8 T15 64/73/63/56/75" (A=auto, ! = GPS 丢失)
RE_GPS = re.compile(
    r"MSK_G G(\d)(A?)(!?)\s+V([\d.]+)\s+"
    r"P([-\d.]+)\s+T([-\d.]+)\s+"
    r"(\d+)/(\d+)/(\d+)/(\d+)/(\d+)"
)
# 无 GPS 模式: "MSK_N G1 T0 70/80/70/40/65"
RE_NOGPS = re.compile(
    r"MSK_N G(\d)(A?)\s+T([-\d.]+)\s+"
    r"(\d+)/(\d+)/(\d+)/(\d+)/(\d+)"
)


def parse_msk_status(text, st):
    """从 STATUSTEXT 解析 MSK 专有状态。"""
    m = RE_GPS.match(text)
    if m:
        st["msk_mode"] = "GPS"
        st["msk_gear"] = int(m.group(1))
        st["msk_auto"] = m.group(2) == "A"
        st["msk_speed_raw"] = float(m.group(4))
        st["msk_speed"] = float(m.group(4))
        st["msk_pitch"] = float(m.group(5))
        st["msk_tilt"] = float(m.group(6))
        st["msk_ks"] = int(m.group(7))
        st["msk_kdf"] = int(m.group(8))
        st["msk_kdm"] = int(m.group(9))
        st["msk_kt"] = int(m.group(10))
        st["msk_krd"] = int(m.group(11))
        return True
    m = RE_NOGPS.match(text)
    if m:
        st["msk_mode"] = "NOGPS"
        st["msk_gear"] = int(m.group(1))
        st["msk_auto"] = m.group(2) == "A"
        st["msk_tilt"] = float(m.group(3))
        st["msk_ks"] = int(m.group(4))
        st["msk_kdf"] = int(m.group(5))
        st["msk_kdm"] = int(m.group(6))
        st["msk_kt"] = int(m.group(7))
        st["msk_krd"] = int(m.group(8))
        return True
    # 切换事件
    if "MSK: NOGPS" in text and "GEAR" not in text:
        st["msk_mode"] = "NOGPS"
    elif "MSK: GPS_FULL" in text and "GEAR" not in text:
        st["msk_mode"] = "GPS_FULL"
    elif "MSK: GPS_WEAK" in text and "GEAR" not in text:
        st["msk_mode"] = "GPS_WEAK"
    elif "MSK: GPS" in text and "GEAR" not in text:
        st["msk_mode"] = "GPS"
    if re.search(r"GEAR (\d)", text):
        g = re.search(r"GEAR (\d)", text)
        if g: st["msk_gear"] = int(g.group(1))
    if "MSK: AUTO ON" in text:
        st["msk_auto"] = True
    elif "MSK: AUTO OFF" in text:
        st["msk_auto"] = False
    # 预检
    if "MSK CHK" in text:
        if "OFF" in text:
            st["msk_chk_stage"] = ""
        else:
            st["msk_chk_stage"] = text.replace("MSK CHK: ", "").replace("MSK CHK ", "")
    return False


# ─── MAVLink 接收线程 ───
last_heartbeat = 0


def mavlink_thread(master_str, baudrate):
    global last_heartbeat
    while True:
        try:
            _mavlink_loop(master_str, baudrate)
        except Exception as e:
            print(f"[MAV] ERROR: {e}")
            with state_lock:
                state["connected"] = False
            print("[MAV] Reconnecting in 3s...")
            time.sleep(3)


def _mavlink_loop(master_str, baudrate):
    global last_heartbeat
    print(f"[MAV] Connecting to {master_str} ...")
    mav = mavutil.mavlink_connection(master_str, baud=baudrate, source_system=255)
    mav.wait_heartbeat(timeout=30)
    print(f"[MAV] Connected (sysid={mav.target_system})")

    # 主动请求各类数据流 (数传 57600 默认不推 SERVO/RC/ATTITUDE)
    # 低 baud 下用合理速率, 每类 2-4 Hz 就够 GUI 显示
    for stream_id, rate_hz in [
        (mavutil.mavlink.MAV_DATA_STREAM_EXTENDED_STATUS, 2),  # SYS_STATUS + GPS
        (mavutil.mavlink.MAV_DATA_STREAM_POSITION, 2),          # GLOBAL_POSITION_INT
        (mavutil.mavlink.MAV_DATA_STREAM_EXTRA1, 4),            # ATTITUDE
        (mavutil.mavlink.MAV_DATA_STREAM_EXTRA2, 2),            # VFR_HUD
        (mavutil.mavlink.MAV_DATA_STREAM_EXTRA3, 2),            # AHRS + VIBRATION + ...
        (mavutil.mavlink.MAV_DATA_STREAM_RC_CHANNELS, 4),       # SERVO_OUTPUT_RAW + RC_CHANNELS
        (mavutil.mavlink.MAV_DATA_STREAM_RAW_SENSORS, 1),
    ]:
        mav.mav.request_data_stream_send(
            mav.target_system, mav.target_component,
            stream_id, rate_hz, 1  # 1 = start stream
        )
    print("[MAV] 数据流请求已发送")

    # 启动后拉全量参数 (后台, 不阻塞)
    print("[MAV] Fetching all parameters...")
    mav.param_fetch_all()

    while True:
        # 处理参数写入队列 (来自 HTTP API)
        with state_lock:
            to_write = list(param_write_queue)
            param_write_queue.clear()
            do_refetch = param_refetch_flag[0]
            param_refetch_flag[0] = False
            to_read = list(param_read_queue)
            param_read_queue.clear()
        for name, value in to_write:
            mav.param_set_send(name, value)
            time.sleep(0.05)
        if do_refetch:
            # 定向读 MSK 参数 (不拉整表), 排队由 HTTP 处理器填充
            print(f'[MAV] refetch MSK 参数 ({len(to_read)} 个)')
        for name in to_read:
            mav.mav.param_request_read_send(
                mav.target_system, mav.target_component,
                name.encode()[:16], -1)
            time.sleep(0.05)

        msg = mav.recv_match(blocking=True, timeout=0.2)
        if msg is None:
            continue
        t = msg.get_type()
        with state_lock:
            if t == "HEARTBEAT":
                last_heartbeat = time.time()
                state["connected"] = True
                state["armed"] = (msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED) != 0

            elif t == "ATTITUDE":
                state["pitch"] = math.degrees(msg.pitch)
                state["roll"] = math.degrees(msg.roll)
                state["yaw"] = math.degrees(msg.yaw)

            elif t == "GPS_RAW_INT":
                state["gps_fix"] = msg.fix_type
                state["gps_nsat"] = msg.satellites_visible
                state["gps_hdop"] = msg.eph / 100.0 if msg.eph < 9999 else 99.9

            elif t == "VFR_HUD":
                state["groundspeed"] = msg.groundspeed

            elif t == "SYS_STATUS":
                state["batt1_v"] = msg.voltage_battery / 1000.0
                state["batt1_a"] = msg.current_battery / 100.0
                state["batt1_pct"] = msg.battery_remaining

            elif t == "BATTERY_STATUS":
                if msg.id == 1:
                    v = sum(c for c in msg.voltages[:6] if c < 65535) / 1000.0
                    if v > 0:
                        state["batt2_v"] = v
                    if msg.current_battery >= 0:
                        state["batt2_a"] = msg.current_battery / 100.0
                    state["batt2_pct"] = msg.battery_remaining

            elif t == "SERVO_OUTPUT_RAW":
                for i in range(16):
                    state["servo"][i] = getattr(msg, f"servo{i+1}_raw", 0)

            elif t == "RC_CHANNELS":
                for i in range(min(9, 18)):
                    state["rc"][i] = getattr(msg, f"chan{i+1}_raw", 0)

            elif t == "PARAM_VALUE":
                name = msg.param_id.rstrip('\x00')
                state["params"][name] = msg.param_value
                if msg.param_index + 1 >= msg.param_count:
                    if not state["params_ready"]:
                        state["params_ready"] = True
                        msk_count = sum(1 for k in state["params"] if k.startswith("MSK_"))
                        print(f"[MAV] Parameters ready: {len(state['params'])} total, {msk_count} MSK_")

            elif t == "STATUSTEXT":
                text = msg.text.rstrip('\x00').strip()
                if text:
                    ts = time.strftime("%H:%M:%S")
                    severity = msg.severity
                    entry = {"t": ts, "s": severity, "m": text}
                    state["messages"].append(entry)
                    if len(state["messages"]) > MAX_MESSAGES:
                        state["messages"] = state["messages"][-MAX_MESSAGES:]
                    parse_msk_status(text, state)

            state["heartbeat_age"] = time.time() - last_heartbeat


# ─── HTTP 服务 ───
HTML = r"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MantaShark GCS</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{height:100%;}
body{background:linear-gradient(135deg,#05071a 0%,#0a0e28 100%);color:#e0e6f0;
  font-family:'SF Mono','JetBrains Mono','Consolas',monospace;font-size:14px;overflow:hidden;}

.top{display:flex;align-items:center;padding:10px 20px;
  background:linear-gradient(180deg,#141838 0%,#0e1128 100%);
  border-bottom:1px solid #2a3060;gap:10px;flex-wrap:wrap;
  box-shadow:0 2px 10px rgba(0,0,0,0.5);}
.top .title{font-size:20px;font-weight:700;letter-spacing:1px;
  background:linear-gradient(90deg,#0ff,#4af);-webkit-background-clip:text;
  background-clip:text;color:transparent;margin-right:8px;}
.top .tuner-btn{color:#0ff;text-decoration:none;font-size:13px;font-weight:600;
  border:1px solid #0ff;padding:5px 14px;border-radius:18px;transition:all .2s;}
.top .tuner-btn:hover{background:#0ff;color:#000;box-shadow:0 0 12px rgba(0,255,255,0.6);}

.badge{padding:5px 12px;border-radius:14px;font-size:12px;font-weight:700;
  letter-spacing:.5px;transition:all .3s;}
.b-ok{background:linear-gradient(135deg,#0a6,#0d8);color:#fff;box-shadow:0 0 8px rgba(0,221,136,0.4);}
.b-warn{background:linear-gradient(135deg,#c70,#e93);color:#fff;box-shadow:0 0 8px rgba(238,147,51,0.4);}
.b-err{background:linear-gradient(135deg,#c00,#e33);color:#fff;box-shadow:0 0 10px rgba(238,51,51,0.5);}
.b-info{background:linear-gradient(135deg,#06a,#29c);color:#fff;}
.b-off{background:#242848;color:#667;}

.main{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 280px;
  height:calc(100vh - 60px);gap:2px;background:#1a1d38;padding:2px;}
.panel{background:linear-gradient(180deg,#0d1128 0%,#0a0d22 100%);
  padding:18px 20px;overflow:auto;border-radius:6px;
  box-shadow:inset 0 0 0 1px #1a1d3e;}
.panel::-webkit-scrollbar{width:8px;}
.panel::-webkit-scrollbar-track{background:#0a0d22;}
.panel::-webkit-scrollbar-thumb{background:#2a2d5e;border-radius:4px;}

h3{color:#5ff;font-size:13px;font-weight:700;margin:14px 0 8px;
  border-bottom:1px solid #1e2350;padding-bottom:6px;
  text-transform:uppercase;letter-spacing:1.5px;}
h3:first-child{margin-top:0;}

/* 涵道布局图 */
.layout{position:relative;width:440px;height:460px;margin:0 auto 10px;}
.fan{position:absolute;width:46px;height:46px;border-radius:50%;border:2px solid #3a3f68;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;transition:all .25s;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,0.05),0 2px 4px rgba(0,0,0,0.4);}
.fan.active{border-color:#0f8;box-shadow:0 0 16px rgba(0,255,136,0.6),inset 0 0 8px rgba(0,255,136,0.2);}
.fan .pwm{font-size:10px;color:#99a;font-weight:500;margin-top:1px;}
.grp-S{background:radial-gradient(circle,#ff9f4333,#ff9f4311);color:#ffb366;}
.grp-F{background:radial-gradient(circle,#1dd1a133,#1dd1a111);color:#4fe0b5;}
.grp-D{background:radial-gradient(circle,#54a0ff33,#54a0ff11);color:#7db8ff;}
.grp-T{background:radial-gradient(circle,#00d2d333,#00d2d311);color:#3de2e2;}
.grp-R{background:radial-gradient(circle,#ee5a2433,#ee5a2411);color:#ff7d4a;}
.tilt-ind{position:absolute;width:70px;text-align:center;font-size:12px;
  color:#4fe0b5;font-weight:600;text-shadow:0 0 4px rgba(29,209,161,0.5);}

/* 系数条形图 */
.bar-group{display:flex;align-items:center;gap:10px;margin:6px 0;}
.bar-label{width:38px;text-align:right;font-size:12px;font-weight:600;color:#99a3b8;}
.bar-track{flex:1;height:20px;background:#151838;border-radius:10px;
  position:relative;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,0.5);}
.bar-fill{height:100%;border-radius:10px;transition:width .35s;position:relative;
  box-shadow:0 0 8px currentColor;}
.bar-val{position:absolute;right:8px;top:0;line-height:20px;
  font-size:11px;font-weight:700;color:#fff;text-shadow:0 0 2px rgba(0,0,0,0.8);}

/* 消息流 */
.msg-list{font-size:12px;line-height:1.7;}
.msg-list .m{padding:3px 8px;border-bottom:1px solid #13163a;border-radius:3px;}
.msg-list .m:hover{background:#13163a;}
.msg-list .m.s0,.msg-list .m.s1,.msg-list .m.s2{color:#ff5577;font-weight:700;background:#3a111a;}
.msg-list .m.s3{color:#ffaa33;}
.msg-list .m.s4{color:#55bbff;}
.msg-list .m.s5{color:#aab;}
.msg-list .m.s6{color:#556;}
.msg-list .ts{color:#446;margin-right:10px;font-weight:500;}

/* 数据格 */
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;}
.kv .k{color:#778;text-align:right;font-weight:500;}
.kv .v{color:#fff;font-weight:600;font-variant-numeric:tabular-nums;}
.kv .v.warn{color:#fa3;} .kv .v.err{color:#f55;}

/* 右面板双列 */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;}

/* SERVO 网格 */
.servo-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 10px;font-size:12px;}
.servo-grid.two{grid-template-columns:repeat(2,1fr);}
.servo-grid .sv{background:#13163a;padding:6px 8px;border-radius:4px;
  display:flex;justify-content:space-between;border-left:3px solid #2a2d5e;}
.servo-grid .sv.on{border-left-color:#0f8;}
.servo-grid .sv .n{color:#99a;font-weight:600;}
.servo-grid .sv .v{color:#fff;font-variant-numeric:tabular-nums;}

/* RC 通道 */
.rc-row{display:flex;gap:8px;margin:5px 0;align-items:center;}
.rc-label{width:80px;font-size:11px;color:#99a;text-align:right;font-weight:600;}
.rc-bar{flex:1;max-width:180px;height:12px;background:#151838;border-radius:6px;
  position:relative;overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,0.5);}
.rc-pos{height:100%;background:linear-gradient(90deg,#29c,#5af);border-radius:6px;transition:width .2s;
  box-shadow:0 0 6px rgba(68,170,255,0.5);}
.rc-val{font-size:11px;color:#bbc;width:44px;font-variant-numeric:tabular-nums;font-weight:600;}
</style>
</head>
<body>
<!-- 顶部状态栏 -->
<div class="top">
  <span class="title">MantaShark GCS</span>
  <a href="/tuner" target="_blank" class="tuner-btn">调参工具</a>
  <span id="b_conn" class="badge b-off">DISCONNECTED</span>
  <span id="b_arm" class="badge b-off">DISARMED</span>
  <span id="b_mode" class="badge b-info">?</span>
  <span id="b_gear" class="badge b-info">G?</span>
  <span id="b_auto" class="badge b-off">MANUAL</span>
  <span id="b_gps" class="badge b-off">GPS ?</span>
  <span id="b_batt1" class="badge b-info">B1: ?V</span>
  <span id="b_batt2" class="badge b-info">B2: ?V</span>
  <span id="b_chk" class="badge b-off" style="display:none">CHK</span>
</div>

<div class="main">
  <!-- 左面板: 涵道布局 -->
  <div class="panel">
    <h3>涵道布局 (俯视)</h3>
    <div class="layout" id="layout"></div>
  </div>

  <!-- 右上面板: 状态 + 系数 + RC -->
  <div class="panel">
    <div class="two-col">
      <div>
        <h3>飞行状态</h3>
        <div class="kv" id="kv_flight"></div>
        <h3>混控系数 (归一化前 ×100)</h3>
        <div id="bars"></div>
      </div>
      <div>
        <h3>SERVO 输出 (PWM)</h3>
        <div class="servo-grid two" id="kv_servo"></div>
        <h3>RC 通道</h3>
        <div id="rc_panel"></div>
      </div>
    </div>
  </div>

  <!-- 左下: 空或合并 -->
  <!-- 底部: 消息流 (横跨两列) -->
  <div class="panel" style="grid-column:1/3;">
    <h3>GCS 消息流</h3>
    <div class="msg-list" id="msg_list"></div>
  </div>
</div>

<script>
// ─── 涵道布局坐标 (俯视, 归一化到 layout 宽高) ───
// i = SERVO 通道索引 (0-based). 当前 FC 布局:
//   SERVO1-8=Motor1-8, SERVO9-10=Motor9-10, SERVO11-12=Motor11-12,
//   SERVO13-14=倾转舵, SERVO15-16=Motor13-14 虚拟槽 (RDL/RDR)
const FANS = [
  {id:'DFL',i:4, x:0.18,y:0.06,g:'F'},{id:'DFR',i:5, x:0.82,y:0.06,g:'F'},
  {id:'SL1',i:0, x:0.33,y:0.14,g:'S'},{id:'SL2',i:1, x:0.43,y:0.14,g:'S'},
  {id:'SR1',i:2, x:0.57,y:0.14,g:'S'},{id:'SR2',i:3, x:0.67,y:0.14,g:'S'},
  {id:'DML',i:6, x:0.10,y:0.36,g:'D'},{id:'DMR',i:7, x:0.90,y:0.36,g:'D'},
  {id:'TL1',i:8, x:0.16,y:0.62,g:'T'},{id:'TL2',i:9, x:0.30,y:0.70,g:'T'},
  {id:'TR1',i:10,x:0.84,y:0.62,g:'T'},{id:'TR2',i:11,x:0.70,y:0.70,g:'T'},
  {id:'RDL',i:14,x:0.42,y:0.86,g:'R'},{id:'RDR',i:15,x:0.58,y:0.86,g:'R'},
];

const BARS = [
  {key:'msk_ks', label:'KS', color:'#ff9f43'},
  {key:'msk_kdf',label:'DF', color:'#1dd1a1'},
  {key:'msk_kdm',label:'DM', color:'#54a0ff'},
  {key:'msk_kt', label:'KT', color:'#00d2d3'},
  {key:'msk_krd',label:'RD', color:'#ee5a24'},
];

const RC_LABELS = ['Roll','Pitch','Thr','Yaw','','MODE','GEAR','CHK','AUTO'];

// ─── 初始化布局 ───
const layoutEl = document.getElementById('layout');
FANS.forEach(f => {
  const d = document.createElement('div');
  d.className = `fan grp-${f.g}`;
  d.id = `fan_${f.i}`;
  d.style.left = `${f.x*100}%`; d.style.top = `${f.y*100}%`;
  d.style.transform = 'translate(-50%,-50%)';
  d.innerHTML = `${f.id}<span class="pwm" id="fpwm_${f.i}">0</span>`;
  layoutEl.appendChild(d);
});
// 倾转角指示
['DFL','DFR'].forEach((name,i) => {
  const d = document.createElement('div');
  d.className = 'tilt-ind';
  d.id = `tilt_${i}`;
  d.style.left = i===0?'10%':'78%'; d.style.top = '18%';
  d.textContent = `${name} 0°`;
  layoutEl.appendChild(d);
});
// 机身轮廓
const outline = document.createElement('div');
outline.style.cssText = 'position:absolute;left:6%;top:2%;width:88%;height:92%;border:1.5px solid #2a2f5a;border-radius:45% 45% 35% 35%;pointer-events:none;background:radial-gradient(ellipse at center top,rgba(20,24,56,0.4),transparent 70%);';
layoutEl.appendChild(outline);

// 系数条形图
const barsEl = document.getElementById('bars');
BARS.forEach(b => {
  barsEl.innerHTML += `<div class="bar-group">
    <span class="bar-label">${b.label}</span>
    <div class="bar-track"><div class="bar-fill" id="bf_${b.key}" style="background:${b.color};width:0%">
      <span class="bar-val" id="bv_${b.key}">0</span>
    </div></div>
  </div>`;
});

// RC 通道
const rcEl = document.getElementById('rc_panel');
for(let i=0;i<9;i++){
  if(!RC_LABELS[i]) continue;
  rcEl.innerHTML += `<div class="rc-row">
    <span class="rc-label">CH${i+1} ${RC_LABELS[i]}</span>
    <div class="rc-bar"><div class="rc-pos" id="rc_${i}"></div></div>
    <span class="rc-val" id="rcv_${i}">0</span>
  </div>`;
}

// ─── 更新循环 ───
let lastMsgCount = 0;
let prevState = null;

function render(s){
    // 连接
    const conn = s.connected && s.heartbeat_age < 3;
    setB('b_conn', conn?'CONNECTED':'DISCONNECTED', conn?'b-ok':'b-err');
    setB('b_arm', s.armed?'ARMED':'DISARMED', s.armed?'b-err':'b-ok');

    // MSK 模式/档位/Auto
    const modeMap = {NOGPS:'b-info', GPS_WEAK:'b-warn', GPS_FULL:'b-err', GPS:'b-warn', '?':'b-off'};
    setB('b_mode', s.msk_mode, modeMap[s.msk_mode]||'b-off');
    setB('b_gear', `G${s.msk_gear}`, s.msk_gear===3?'b-warn':s.msk_gear===2?'b-info':'b-off');
    setB('b_auto', s.msk_auto?'AUTO':'MANUAL', s.msk_auto?'b-warn':'b-off');

    // GPS
    const gpsOk = s.gps_fix >= 3 && s.gps_nsat >= 6;
    setB('b_gps', `GPS ${s.gps_nsat}★ ${s.gps_hdop.toFixed(1)}`, gpsOk?'b-ok':'b-warn');

    // 电池
    const b1cls = s.batt1_v < 21?'b-err': s.batt1_v < 22?'b-warn':'b-ok';
    const b2cls = s.batt2_v < 21?'b-err': s.batt2_v < 22?'b-warn':'b-ok';
    setB('b_batt1', `B1:${s.batt1_v.toFixed(1)}V ${s.batt1_a.toFixed(0)}A`, b1cls);
    setB('b_batt2', `B2:${s.batt2_v.toFixed(1)}V ${s.batt2_a.toFixed(0)}A`, b2cls);

    // 预检
    const chkEl = document.getElementById('b_chk');
    if(s.msk_chk_stage){
      chkEl.style.display='inline';
      chkEl.textContent = 'CHK: '+s.msk_chk_stage;
      chkEl.className = 'badge b-warn';
    } else {
      chkEl.style.display='none';
    }

    // 涵道 PWM
    FANS.forEach(f => {
      const pwm = s.servo[f.i]||0;
      const el = document.getElementById(`fan_${f.i}`);
      const active = pwm > 1050;
      el.classList.toggle('active', active);
      const pct = Math.max(0, Math.min(100, (pwm-1000)/10));
      el.style.opacity = active ? 0.5 + pct/200 : 0.4;
      document.getElementById(`fpwm_${f.i}`).textContent = pwm;
    });

    // 倾转角
    const tl = s.msk_tilt||0;
    document.getElementById('tilt_0').textContent = `DFL ${tl.toFixed(0)}°`;
    document.getElementById('tilt_1').textContent = `DFR ${tl.toFixed(0)}°`;

    // 系数条
    BARS.forEach(b => {
      const v = s[b.key]||0;
      document.getElementById(`bf_${b.key}`).style.width = v+'%';
      document.getElementById(`bv_${b.key}`).textContent = v;
    });

    // RC 通道
    for(let i=0;i<9;i++){
      if(!RC_LABELS[i]) continue;
      const v = s.rc[i]||1500;
      const pct = Math.max(0,Math.min(100,(v-1000)/10));
      const posEl = document.getElementById(`rc_${i}`);
      if(posEl) posEl.style.width = pct+'%';
      const valEl = document.getElementById(`rcv_${i}`);
      if(valEl) valEl.textContent = v;
    }

    // 飞行状态
    const kvf = document.getElementById('kv_flight');
    kvf.innerHTML = kv('模式', s.msk_mode) + kv('档位', `G${s.msk_gear}`) +
      kv('Auto', s.msk_auto?'ON':'OFF') + kv('倾转角', `${(s.msk_tilt||0).toFixed(1)}°`) +
      kv('GPS 速度', `${s.groundspeed.toFixed(1)} m/s`) +
      kv('混控速度', `${s.msk_speed.toFixed(1)} m/s`) +
      kv('俯仰', `${s.pitch.toFixed(1)}°`, Math.abs(s.pitch)>18?'warn':'') +
      kv('横滚', `${s.roll.toFixed(1)}°`, Math.abs(s.roll)>15?'warn':'') +
      kv('偏航', `${s.yaw.toFixed(0)}°`);

    // SERVO
    const kvs = document.getElementById('kv_servo');
    // SERVO 通道标签 (最新布局):
    // 1-8=Motor1-8, 9-10=Motor9-10, 11-12=Motor11-12, 13-14=倾转舵, 15-16=Motor13-14
    const names = ['SL1','SL2','SR1','SR2','DFL','DFR','DML','DMR',
                   'TL1','TL2','TR1','TR2','TiltL','TiltR','RDL','RDR'];
    let sh = '';
    for(let i=0;i<16;i++){
      const v = s.servo[i]||0;
      const on = v > 1050;
      sh += `<div class="sv ${on?'on':''}"><span class="n">${names[i]}</span><span class="v">${v}</span></div>`;
    }
    kvs.innerHTML = sh;

    // 消息流
    if(s.messages.length !== lastMsgCount){
      lastMsgCount = s.messages.length;
      const ml = document.getElementById('msg_list');
      ml.innerHTML = s.messages.slice(-80).map(m =>
        `<div class="m s${m.s}"><span class="ts">${m.t}</span>${esc(m.m)}</div>`
      ).join('');
      ml.parentElement.scrollTop = ml.parentElement.scrollHeight;
    }

    prevState = s;
}
function update(){ fetch('/api/state').then(r=>r.json()).then(render).catch(()=>{}); }

function setB(id, text, cls){
  const el=document.getElementById(id);
  el.textContent=text;
  el.className='badge '+cls;
}
function kv(k,v,cls){
  return `<span class="k">${k}</span><span class="v ${cls||''}">${v}</span>`;
}
function esc(s){return s.replace(/</g,'&lt;').replace(/>/g,'&gt;');}

/*__INIT__*/
if(window.__INIT__) render(window.__INIT__);
setInterval(update, 200);
update();
</script>
</body>
</html>"""


# 调参页 HTML (mixer_tuner.html 已嵌入, 单文件部署)
TUNER_HTML = r"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>MantaShark Mixer Tuner v7</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#1a1a2e;color:#e0e0e0;font-family:'Consolas',monospace;user-select:none;}
.hdr{padding:6px 14px;background:#16213e;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;}
.hdr h1{font-size:14px;color:#0ff;}
.hdr button{margin-left:6px;padding:3px 10px;background:#0a3d62;color:#ddd;border:1px solid #0ff3;cursor:pointer;font-size:11px;border-radius:2px;}
.hdr button:hover{background:#0ff3;}
.wrap{display:flex;height:calc(100vh - 32px);}
.mid{flex:1;display:flex;flex-direction:column;min-width:0;}
.pMotor{flex:3;min-height:0;}
.pSlider{height:44px;flex-shrink:0;background:#0d1b2a;border-top:1px solid #333;border-bottom:1px solid #333;overflow:hidden;}
.pCurve{flex:5;min-height:0;}
canvas{display:block;width:100%;height:100%;}
.sb{width:240px;flex-shrink:0;background:#16213e;padding:8px;overflow-y:auto;border-left:1px solid #333;font-size:11px;}
.sb h3{color:#0ff;margin:8px 0 3px;font-size:11px;border-bottom:1px solid #333;padding-bottom:2px;}
.pr{display:flex;justify-content:space-between;align-items:center;margin:2px 0;}
.pr label{color:#aaa;font-size:10px;flex:1;}
.pr input{width:50px;background:#0d1b2a;border:1px solid #444;color:#fff;text-align:center;font-size:10px;padding:1px;border-radius:2px;}
.pr select{width:50px;background:#0d1b2a;border:1px solid #444;color:#fff;font-size:10px;padding:1px;border-radius:2px;}
.cal-row{flex-wrap:wrap;}
.cal-btns{display:flex;gap:3px;width:100%;margin-top:3px;}
.cal-btns button{flex:1;padding:4px 6px;background:#2a6f3d;border:1px solid #3c8;color:#fff;font-size:11px;cursor:pointer;border-radius:3px;font-weight:bold;}
.cal-btns button:hover{background:#3c8;}
.cal-btns button.cal-off{background:#7a2a2a;border-color:#c44;}
.cal-btns button.cal-off:hover{background:#c44;}
.tabs{display:flex;gap:2px;margin:4px 0;}
.tabs button{flex:1;padding:3px;background:#0a3d62;border:1px solid #333;color:#aaa;cursor:pointer;font-size:10px;border-radius:2px;}
.tabs button.act{background:#0ff3;color:#fff;border-color:#0ff6;}
.lg{display:flex;gap:8px;flex-wrap:wrap;margin:3px 0;}
.lg span{font-size:9px;display:flex;align-items:center;gap:3px;}
.lg .c{width:12px;height:3px;border-radius:1px;}
.minfo{background:#0d1b2a;padding:5px;margin:3px 0;border-radius:3px;font-size:10px;line-height:1.6;}
#popup{position:fixed;display:none;z-index:10;}
#popup input{width:60px;background:#0a3d62;border:1px solid #0ff;color:#fff;text-align:center;font-size:12px;padding:3px;border-radius:3px;outline:none;}
#toast{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:#0a3d62;color:#0ff;padding:5px 14px;border-radius:3px;display:none;z-index:20;font-size:11px;}
.mode-row{display:flex;gap:4px;margin:2px 0;}
.mode-row label{color:#aaa;font-size:10px;width:32px;text-align:right;}
.mode-row input{width:42px;background:#0d1b2a;border:1px solid #444;color:#fff;text-align:center;font-size:10px;padding:1px;border-radius:2px;}
</style>
</head>
<body>
<div class="hdr">
  <h1>MantaShark Mixer Tuner v7</h1>
  <div>
    <button onclick="doImport()">Import</button>
    <button onclick="doExport()">Export</button>
    <button onclick="doSave()">Save</button>
    <button onclick="doReset()">Reset</button>
    <span id="fc_buttons" style="display:none; margin-left:8px;">
      <span style="color:#0f0;font-size:10px;margin-right:4px;">● 飞控在线</span>
      <button onclick="readFromFC()" style="background:#0a5;color:#fff;">读取飞控</button>
      <button onclick="writeToFC()" style="background:#c60;color:#fff;">写入飞控</button>
    </span>
  </div>
</div>
<div class="wrap">
  <div class="mid">
    <div class="pMotor"><canvas id="cM"></canvas></div>
    <div class="pSlider"><canvas id="cS"></canvas></div>
    <div class="pCurve"><canvas id="cC"></canvas></div>
  </div>
  <div class="sb" id="sb">
    <h3>模式1 水面机动 (固定系数)</h3>
    <div class="mode-row"><label>KS</label><input id="m1_ks" type="number" step="0.05" value="0.55">
      <label>KDF</label><input id="m1_kdf" type="number" step="0.05" value="0.65">
      <label>KDM</label><input id="m1_kdm" type="number" step="0.05" value="0.55"></div>
    <div class="mode-row"><label>KT</label><input id="m1_kt" type="number" step="0.05" value="0.15">
      <label>KRD</label><input id="m1_krd" type="number" step="0.05" value="0.55"></div>

    <h3>模式2 飞行曲线</h3>
    <div class="pr"><label>显示速度上限 (m/s)</label><input id="i_vmax" type="number" step="5" value="20" min="10" max="60"></div>
    <div class="pr"><label>档位预览 GEAR</label>
      <select id="i_gear" onchange="onGearChange()"></select></div>
    <div class="pr"><label>GEAR_CH 档位通道</label><input id="i_gch" type="number" step="1" value="7"></div>
    <div class="pr"><label>V1 滑跑 (m/s)</label><input id="i_v1" type="number" step="1" value="4"></div>
    <div class="pr"><label>V2 驼峰 (m/s)</label><input id="i_v2" type="number" step="1" value="8"></div>
    <div class="pr"><label>V3 巡航 (m/s)</label><input id="i_v3" type="number" step="1" value="14"></div>
    <div class="pr"><label>RAMP 过渡速率 (/s)</label><input id="i_rmp" type="number" step="0.1" value="0.4"></div>
    <div class="pr"><label>MODE_CH 模式通道</label><input id="i_mch" type="number" step="1" value="6"></div>

    <h3>安全 / 通道</h3>
    <div class="pr"><label>CHK_CH 预检通道</label><input id="i_cch" type="number" step="1" value="8"></div>
    <div class="pr"><label>CHK_PWM 怠速 PWM</label><input id="i_ckp" type="number" step="10" value="1100"></div>
    <div class="pr"><label>CHK_STOP 停转 PWM</label><input id="i_cks" type="number" step="10" value="1000"></div>
    <div class="pr"><label>CHK_GRP_MS 子步(ms)</label><input id="i_ckg" type="number" step="100" value="2000"></div>
    <div class="pr"><label>GPS_TAU 失效衰减(s)</label><input id="i_gtau" type="number" step="0.5" value="3.0"></div>
    <div class="pr"><label>AUTO_CH 自动模式通道</label><input id="i_autoch" type="number" step="1" value="9"></div>
    <div class="pr"><label>AUTO_TGT 目标油门</label><input id="i_autotgt" type="number" step="0.05" value="0.80"></div>
    <div class="pr"><label>AUTO_CUT 紧急关停</label><input id="i_autocut" type="number" step="0.05" value="0.10"></div>

    <h3>姿态保护 (飞行模式)</h3>
    <div class="pr"><label>WING_OFS 巡航俯仰(°)</label><input id="i_wofs" type="number" step="0.5" value="8.0"></div>
    <div class="pr"><label>PIT_LIM 俯仰限位(°)</label><input id="i_plim" type="number" step="1" value="10.0"></div>
    <div class="pr"><label>ROL_LIM 横滚限位(°)</label><input id="i_rlim" type="number" step="1" value="15.0"></div>
    <div class="pr"><label>ATT_KP 修正增益</label><input id="i_atkp" type="number" step="0.05" value="0.3"></div>
    <div class="pr"><label>RC_LIM 摇杆范围(°)</label><input id="i_rclim" type="number" step="1" value="5.0"></div>

    <h3>倾转舵 (DFL/DFR)</h3>
    <div class="pr"><label>TILT_SVL 左舵通道</label><input id="i_tsvl" type="number" step="1" value="13"></div>
    <div class="pr"><label>TILT_SVR 右舵通道</label><input id="i_tsvr" type="number" step="1" value="14"></div>
    <div class="pr"><label>TILT_L_ZERO 左0° PWM</label><input id="i_tlz" type="number" step="1" value="1500"></div>
    <div class="pr"><label>TILT_L_DIR 左方向(±1)</label><input id="i_tld" type="number" step="1" value="1"></div>
    <div class="pr"><label>TILT_R_ZERO 右0° PWM</label><input id="i_trz" type="number" step="1" value="1500"></div>
    <div class="pr"><label>TILT_R_DIR 右方向(±1)</label><input id="i_trd" type="number" step="1" value="-1"></div>
    <div class="pr"><label>TILT_USPD μs 每度</label><input id="i_tuspd" type="number" step="0.1" value="8.0"></div>
    <div class="pr"><label>TILT_DEG 最大倾(°)</label><input id="i_tm" type="number" step="5" value="30"></div>
    <div class="pr"><label>TILT_TAU LPF 时间常数(s)</label><input id="i_ttau" type="number" step="0.1" value="0.5"></div>
    <div class="pr"><label>TILT_V1 V1 倾角(°)</label><input id="i_tv1" type="number" step="1" value="0"></div>
    <div class="pr"><label>TILT_V2 V2 倾角(°)</label><input id="i_tv2" type="number" step="1" value="15"></div>
    <div class="pr"><label>TILT_V3 V3 倾角(°)</label><input id="i_tv3" type="number" step="1" value="30"></div>
    <div class="pr cal-row"><label>TILT_CAL 校准角度(°)</label><input id="i_tcal" type="number" step="1" value="-1">
      <div class="cal-btns">
        <button onclick="calBtn(0)">0°中立</button>
        <button onclick="calBtn(15)">15°</button>
        <button onclick="calBtn(30)">30°满偏</button>
        <button onclick="calBtn(-1)" class="cal-off">退出</button>
      </div>
    </div>

    <h3>曲线 Curves</h3>
    <div class="tabs" id="tabBtns">
      <button class="act" onclick="setTab('throttle')">油门分配</button>
      <button onclick="setTab('tilt')">倾转</button>
      <button onclick="setTab('geom')">姿态几何</button>
    </div>
    <div class="lg" id="lgThrottle">
      <span><span class="c" style="background:#ff9f43"></span>KS 斜吹</span>
      <span><span class="c" style="background:#1dd1a1"></span>KDF 前下吹</span>
      <span><span class="c" style="background:#54a0ff"></span>KDM 中下吹</span>
      <span><span class="c" style="background:#00d2d3"></span>KT 后推</span>
      <span><span class="c" style="background:#ee5a24"></span>KRD 后斜下</span>
    </div>
    <div class="lg" id="lgTilt" style="display:none">
      <span style="color:#aaa">DFL/DFR 倾转: 0°=纯下吹, max=前倾。左右独立 PWM 校准支持镜像安装</span>
    </div>
    <div class="lg" id="lgGeom" style="display:none">
      <span><span class="c" style="background:#ff6b6b"></span>俯仰 Pitch</span>
      <span><span class="c" style="background:#48dbfb"></span>横滚 Roll</span>
      <span><span class="c" style="background:#feca57"></span>偏航 Yaw</span>
    </div>
    <div style="color:#666;font-size:9px;margin:4px 0;">
      拖拽节点=调X+Y | 双击=加点 | 右击=删点 | 单击=精确输入 | 拖段=调expo
    </div>
    <div id="mdet" class="minfo" style="display:none"></div>
  </div>
</div>
<div id="popup"><input id="popIn" type="number" step="0.01"></div>
<div id="toast"></div>
<input type="file" id="fIn" style="display:none" accept=".txt,.parm,.param" onchange="onFile(event)">

<script>
// ========== CONFIG ==========
const CC={KS:'#ff9f43',KDF:'#1dd1a1',KDM:'#54a0ff',KT:'#00d2d3',KRD:'#ee5a24'};
const GC={pitch:'#ff6b6b',roll:'#48dbfb',yaw:'#feca57'};
const GK={S:'KS',F:'KDF',D:'KDM',T:'KT',R:'KRD'};
const CURVE_KEYS=['KS','KDF','KDM','KT','KRD'];
const CURVE_LABELS={KS:'斜吹',KDF:'前下吹',KDM:'中下吹',KT:'后推',KRD:'后斜下'};
let MAX_SPEED=20; // m/s display range, adjustable

const ML=[
  {id:'DFL',i:4,x:-.29,y:.80,g:'F',tilt:1},
  {id:'SL1',i:0,x:-.20,y:.79,g:'S'},
  {id:'SL2',i:1,x:-.11,y:.79,g:'S'},
  {id:'SR1',i:2,x:.11,y:.79,g:'S'},
  {id:'SR2',i:3,x:.20,y:.79,g:'S'},
  {id:'DFR',i:5,x:.29,y:.80,g:'F',tilt:1},
  {id:'DML',i:6,x:-.48,y:.50,g:'D'},
  {id:'DMR',i:7,x:.48,y:.50,g:'D'},
  {id:'TL1',i:8,x:-.42,y:.17,g:'T'},
  {id:'TL2',i:9,x:-.30,y:.05,g:'T'},
  {id:'TR1',i:10,x:.42,y:.17,g:'T'},
  {id:'TR2',i:11,x:.30,y:.05,g:'T'},
  {id:'RDL',i:12,x:-.08,y:-.02,g:'R'},
  {id:'RDR',i:13,x:.08,y:-.02,g:'R'},
];

// GEOM — 只有 DML/DMR 参与 roll（其他斜角组有耦合，KDF/KRD 力臂不占优）
// yaw: 只有 TL/TR, 按 X 力臂归一化 (TL1/TR1 ±0.53m = ±0.5 基准)
let GEOM={
  0:{r:0,p:.5,y:0},   1:{r:0,p:.5,y:0},   // SL1/SL2 (roll 禁用避免 KS 耦合)
  2:{r:0,p:.5,y:0},   3:{r:0,p:.5,y:0},   // SR1/SR2
  4:{r:0,p:.5,y:0},   5:{r:0,p:.5,y:0},   // DFL/DFR (roll 禁用)
  6:{r:.5,p:-.5,y:0}, 7:{r:-.5,p:-.5,y:0}, // ★DML/DMR 唯一 roll 控制
  8:{r:0,p:0,y:.50},  9:{r:0,p:0,y:.36},  // TL1 x=-0.530, TL2 x=-0.380
  10:{r:0,p:0,y:-.50},11:{r:0,p:0,y:-.36}, // TR1/TR2
  12:{r:0,p:-.5,y:0}, 13:{r:0,p:-.5,y:0}  // RDL/RDR (x 过小, roll 禁用)
};

// 左右镜像配对（按物理 X 位置）
// SL1(外左 x=-0.244) ↔ SR2(外右 x=0.244)
// SL2(内左 x=-0.135) ↔ SR1(内右 x=0.135)
// TL1(外左 x=-0.530) ↔ TR1(外右 x=0.530)
// TL2(内左 x=-0.380) ↔ TR2(内右 x=0.380)
// 注: 编辑左侧自动同步右侧 (roll/yaw 反符号, pitch 同号)
const MIRROR_PAIRS={0:3,1:2,2:1,3:0,  4:5,5:4,  6:7,7:6,  8:10,9:11,10:8,11:9,  12:13,13:12};

// ─── 物理常量（用于力平衡分析）───
const MASS_KG=10.0;
const G=9.81;
const WEIGHT_N=MASS_KG*G;
const FAN_MAX_THRUST=23.25;  // 6S 满电单涵道满推 (N)
const WING_OFS_DEG=8.0;       // 翼面安装角偏置

// 实测推力表（涵道数据2300KV.png, 24V 6S 满电, QF2822 64mm）
// [throttle 0~1, thrust N per fan]
const THROTTLE_THRUST_TABLE=[
  [0.00,  0.00],
  [0.50,  7.36],   // 750g  / 240W  / 10A
  [0.60, 10.30],   // 1050g / 408W  / 17A
  [0.70, 13.54],   // 1380g / 600W  / 25A
  [0.80, 16.87],   // 1720g / 840W  / 35A
  [0.90, 20.40],   // 2080g / 1128W / 47A
  [1.00, 23.25],   // 2370g / 1368W / 57A
];

// 通过表格线性插值得到推力（更精确，匹配实测数据）
function thrustFromThrottle(throttle){
  if(throttle<=0) return 0;
  if(throttle>=1) return THROTTLE_THRUST_TABLE[THROTTLE_THRUST_TABLE.length-1][1];
  for(let i=0;i<THROTTLE_THRUST_TABLE.length-1;i++){
    let[x0,y0]=THROTTLE_THRUST_TABLE[i];
    let[x1,y1]=THROTTLE_THRUST_TABLE[i+1];
    if(throttle<=x1){
      let t=(throttle-x0)/(x1-x0);
      return y0+(y1-y0)*t;
    }
  }
  return THROTTLE_THRUST_TABLE[THROTTLE_THRUST_TABLE.length-1][1];
}

// 同理估算电流（通过表格插值）
const THROTTLE_CURRENT_TABLE=[
  [0.00, 0],
  [0.50, 10.0],
  [0.60, 17.0],
  [0.70, 25.0],
  [0.80, 35.0],
  [0.90, 47.0],
  [1.00, 57.0],
];
function currentFromThrottle(throttle){
  if(throttle<=0) return 0;
  if(throttle>=1) return 57;
  for(let i=0;i<THROTTLE_CURRENT_TABLE.length-1;i++){
    let[x0,y0]=THROTTLE_CURRENT_TABLE[i];
    let[x1,y1]=THROTTLE_CURRENT_TABLE[i+1];
    if(throttle<=x1){
      let t=(throttle-x0)/(x1-x0);
      return y0+(y1-y0)*t;
    }
  }
  return 57;
}
// 各组在机体系下的"thrust 方向角度"（相对机体 Y 轴向上抬的角度）
// KS: 45° 相对翼面 = 37° 机体系（45 - 8）
// KDF/KDM: 90° (纯垂直)
// KT: 0° (沿机体 Y 前推)
// KRD: 38° 相对翼面 = 30° 机体系
const GROUP_BODY_ANGLE={KS:37,KDF:90,KDM:90,KT:0,KRD:30};
const GROUP_COUNT={KS:4,KDF:2,KDM:2,KT:4,KRD:2};

// 估算给定速度+机体俯仰下的总力分量（用实测推力表，不算气动）
// 摇杆 stick (0~1) → 每电机 throttle = stick × normalized_factor
// thrust per fan = thrustFromThrottle(motor_throttle) [来自2300KV实测]
function calcForce(stick,bodyPitch){
  let es=showMode===1?speed:gearSpeed(speed);
  let raw={};
  for(let k of CURVE_KEYS) raw[k]=showMode===1?M1[k]:evalCV(k,es);
  let kmax=Math.max(...Object.values(raw));
  if(kmax<=0)return{V:0,H:0,perGroup:{}};
  let totalV=0,totalH=0,perGroup={};
  for(let k of CURVE_KEYS){
    let normFactor=raw[k]/kmax;
    let motorThrottle=stick*normFactor;
    let thrustPerFan=thrustFromThrottle(motorThrottle);
    let groupThrust=thrustPerFan*GROUP_COUNT[k];
    let worldAngleDeg=GROUP_BODY_ANGLE[k]+bodyPitch;
    let v=groupThrust*Math.sin(worldAngleDeg*Math.PI/180);
    let h=groupThrust*Math.cos(worldAngleDeg*Math.PI/180);
    perGroup[k]={V:v,H:h,thrust:groupThrust,throttle:motorThrottle};
    totalV+=v; totalH+=h;
  }
  return {V:totalV,H:totalH,perGroup};
}

// 估算阻力：D = 0.5 ρ V² Cd S （机体+诱导阻力，地效中诱导降低）
function estimateDrag(spd){
  if(spd<0.5) return 1;
  let rho=1.225, S_frontal=0.06, Cd=0.4;
  let formDrag=0.5*rho*spd*spd*S_frontal*Cd;
  // 驼峰前水阻力主导（非常大），驼峰后下降
  let waterDrag=0;
  if(spd<8) waterDrag=Math.max(0,30*(1-Math.abs(spd-7)/7)); // 驼峰处~30N
  return formDrag+waterDrag;
}

// ─── 气动升力 + 地效（粗略模型）───
const WING_AREA=1.5;       // 翼面积 m²
const RHO=1.225;
const CL_BASE=0.7;          // 巡航 CL（翼面 0° AoA, 蝠鲼形低 AR）
const GE_MAX=1.4;           // 地效最大升力倍率
const GE_START_V=4;         // 开始有地效（开始滑水）
const GE_FULL_V=10;         // 完全地效

// 地效因子：从 V<GE_START 时 1.0 平滑增长到 GE_FULL 时 GE_MAX
function geFactor(spd){
  if(spd<=GE_START_V) return 1.0;
  if(spd>=GE_FULL_V) return GE_MAX;
  let t=(spd-GE_START_V)/(GE_FULL_V-GE_START_V);
  return 1.0+(GE_MAX-1.0)*t;
}

// 翼面 CL 随机体俯仰变化（俯仰大→翼面 AoA 大→CL 大）
function effectiveCL(bodyPitchDeg){
  let aoaDeg=bodyPitchDeg-WING_OFS_DEG;
  // 简化线性：CL = CL_base + 0.07/° × AoA, clamped
  return Math.max(0.1,Math.min(1.4,CL_BASE+0.07*aoaDeg));
}

// 气动升力（含地效）
function aeroLift(spd,bodyPitchDeg){
  if(spd<1) return 0;
  let cl=effectiveCL(bodyPitchDeg);
  let ge=geFactor(spd);
  return 0.5*RHO*spd*spd*WING_AREA*cl*ge;
}

// 水浮力支撑：起飞前水承担大部分重量，离水后归零
function waterSupport(spd){
  if(spd<2) return WEIGHT_N*0.95;        // 静止：浮力承担 95%
  if(spd<6) return WEIGHT_N*(0.95-(spd-2)*0.15); // 滑水建立：递减
  if(spd<10) return WEIGHT_N*(0.35-(spd-6)*0.08); // 驼峰过渡：进一步降
  return 0;                                 // 离水：水支撑归零
}
function setGeomMirrored(idx,axis,val){
  GEOM[idx][axis]=val;
  let pair=MIRROR_PAIRS[idx];
  if(pair!==undefined){
    if(axis==='r' || axis==='y') GEOM[pair][axis]=-val;  // roll/yaw 反向
    else GEOM[pair][axis]=val;                             // pitch 同向
  }
}

// ========== CURVE MODEL (free-form pts + bends, like original tuner) ==========
// X = speed (m/s), Y = coefficient (0~1)
// Each curve has independent pts[{x,y}] and bends[] per segment
// V1-V4 in sidebar define Lua export breakpoints; visual curves are free-form

// N_PTS 固定 3：V1=滑跑, V2=驼峰, V3=巡航(曲线最大)
const N_PTS=3;
let nPts=N_PTS;
let V=[4.0, 8.0, 14.0]; // V3=14 巡航估算

function mkCurve(pts){
  return {pts:pts.map(p=>({...p})), bends:new Array(pts.length-1).fill(0)};
}
// 默认曲线基于 LOG36 实测驼峰 7-8 m/s, 10kg, 23N/涵道
let CV={
  KS:  mkCurve([{x:0,y:0.70},{x:4,y:0.70},{x:8,y:0.55},{x:14,y:0.10},{x:MAX_SPEED,y:0.10}]),
  KDF: mkCurve([{x:0,y:0.80},{x:4,y:0.80},{x:8,y:0.65},{x:14,y:0.08},{x:MAX_SPEED,y:0.08}]),
  KDM: mkCurve([{x:0,y:0.70},{x:4,y:0.70},{x:8,y:0.55},{x:14,y:0.08},{x:MAX_SPEED,y:0.08}]),
  KT:  mkCurve([{x:0,y:0.30},{x:4,y:0.40},{x:8,y:0.85},{x:14,y:0.65},{x:MAX_SPEED,y:0.65}]),
  KRD: mkCurve([{x:0,y:0.55},{x:4,y:0.65},{x:8,y:0.85},{x:14,y:0.25},{x:MAX_SPEED,y:0.25}]),
};

// Mode 1 fixed coefficients
let M1={KS:0.55, KDF:0.65, KDM:0.55, KT:0.15, KRD:0.55};

let speed=0, selMot=null, selCurve=null, curveTab='throttle', tiltMax=30;
let showMode=2; // 1=surface, 2=fly (for motor view)
let gear=3; // 1=档1(上限V1), 2=档2(上限V2), 3=全开

// ========== MATH ==========
function cl(v,a,b){return Math.max(a,Math.min(b,v));}
function lp(a,b,t){return a+(b-a)*cl(t,0,1);}

// Evaluate curve with quadratic bezier per segment + bend (same as original tuner)
function evalCV(key,spd){
  let c=CV[key], pts=c.pts, bends=c.bends;
  if(spd<=pts[0].x) return pts[0].y;
  if(spd>=pts[pts.length-1].x) return pts[pts.length-1].y;
  for(let i=0;i<pts.length-1;i++){
    if(spd<=pts[i+1].x){
      let dx=pts[i+1].x-pts[i].x;
      if(dx<1e-9) return pts[i].y;
      let t=(spd-pts[i].x)/dx;
      let midY=lp(pts[i].y,pts[i+1].y,0.5)+bends[i];
      return (1-t)*(1-t)*pts[i].y + 2*(1-t)*t*midY + t*t*pts[i+1].y;
    }
  }
  return pts[pts.length-1].y;
}

// Sample visual curve at V breakpoints → generate Lua-compatible y values + expo approximation
function sampleForExport(key){
  let ys=[], expos=[];
  for(let i=0;i<nPts;i++) ys.push(cl(evalCV(key,V[i]),0,1));
  for(let i=0;i<nPts-1;i++){
    // Fit expo: at midpoint speed, what expo makes piecewise match the visual curve?
    let midSpd=(V[i]+V[i+1])/2;
    let midVal=evalCV(key,midSpd);
    let dy=ys[i+1]-ys[i];
    if(Math.abs(dy)<0.001){expos.push(1.0);continue;}
    let frac=cl((midVal-ys[i])/dy,0.01,0.99);
    expos.push(cl(Math.log(frac)/Math.log(0.5),0.1,5.0));
  }
  return {y:ys, expo:expos};
}

// Apply gear clamp: limit effective speed to current gear's breakpoint
function gearSpeed(spd){
  if(gear<nPts) return Math.min(spd,V[gear-1]);
  return spd;
}

// Get motor throttle factor at current speed/mode
function motorThr(m,spd){
  let key=GK[m.g];
  if(showMode===1) return cl(M1[key]||0,0,1);
  return cl(evalCV(key,gearSpeed(spd)),0,1);
}

// Normalized factor (divide by kmax, same as Lua)
function motorThrNorm(m,spd){
  let es=showMode===1?spd:gearSpeed(spd);
  let vals=CURVE_KEYS.map(k=>showMode===1?M1[k]:evalCV(k,es));
  let kmax=Math.max(...vals);
  if(kmax<=0) return 0;
  let key=GK[m.g];
  let raw=showMode===1?M1[key]:evalCV(key,es);
  return cl(raw/kmax,0,1);
}

// ========== CANVAS ==========
function setupCv(id){
  let cv=document.getElementById(id),p=cv.parentElement,r=p.getBoundingClientRect();
  let d=devicePixelRatio||1;
  cv.width=r.width*d;cv.height=r.height*d;
  cv.style.width=r.width+'px';cv.style.height=r.height+'px';
  let ctx=cv.getContext('2d');ctx.scale(d,d);
  return{cv,ctx,w:r.width,h:r.height};
}

// ========== MOTOR VIEW ==========
function drawMotors(){
  let{ctx,w,h}=setupCv('cM');
  ctx.clearRect(0,0,w,h);
  let cx=w/2,cy=h*0.48,sc=Math.min(w*0.85,h*0.85);
  ctx.save();ctx.translate(cx,cy);

  let frontY=-0.80*sc+sc*0.42, midY=-0.50*sc+sc*0.42;
  let rearY=-0.10*sc+sc*0.42, tailY=-0.08*sc+sc*0.42;
  let frontHW=0.33*sc, midHW=0.52*sc, rearHW=0.46*sc, tailHW=0.10*sc;
  ctx.beginPath();
  ctx.moveTo(-frontHW,frontY);ctx.lineTo(frontHW,frontY);
  ctx.quadraticCurveTo(midHW+sc*0.06,(frontY+midY)/2,midHW,midY);
  ctx.quadraticCurveTo(midHW-sc*0.02,(midY+rearY)/2,rearHW,rearY);
  ctx.quadraticCurveTo(rearHW*0.5,(rearY+tailY)/2,tailHW,tailY);
  ctx.lineTo(-tailHW,tailY);
  ctx.quadraticCurveTo(-rearHW*0.5,(rearY+tailY)/2,-rearHW,rearY);
  ctx.quadraticCurveTo(-midHW+sc*0.02,(midY+rearY)/2,-midHW,midY);
  ctx.quadraticCurveTo(-midHW-sc*0.06,(frontY+midY)/2,-frontHW,frontY);
  ctx.closePath();
  ctx.fillStyle='#1e3050';ctx.fill();
  ctx.strokeStyle='#2a4a6a';ctx.lineWidth=1;ctx.stroke();

  ctx.fillStyle='#0ff5';ctx.font='9px monospace';ctx.textAlign='center';
  ctx.beginPath();ctx.moveTo(0,frontY-12);ctx.lineTo(-5,frontY-6);ctx.lineTo(5,frontY-6);ctx.closePath();ctx.fill();
  ctx.fillText('FRONT',0,frontY-16);

  for(let m of ML){
    let mx=m.x*sc, my=-m.y*sc+sc*0.42;
    let thr=motorThrNorm(m,speed);
    let rad=6+thr*12, col=CC[GK[m.g]];

    let groupKey=GK[m.g];
    let highlighted=selMot===m.i||(selCurve&&selCurve===groupKey);

    ctx.beginPath();ctx.arc(mx,my,rad,0,Math.PI*2);
    let a=Math.floor(cl(0.3+thr*0.7,0,1)*255).toString(16).padStart(2,'0');
    ctx.fillStyle=col+a;ctx.fill();
    ctx.strokeStyle=highlighted?'#fff':col;
    ctx.lineWidth=highlighted?2.5:1;
    ctx.stroke();
    if(selCurve&&selCurve===groupKey&&selMot!==m.i){
      ctx.beginPath();ctx.arc(mx,my,rad+3,0,Math.PI*2);
      ctx.strokeStyle=col+'60';ctx.lineWidth=2;ctx.stroke();
    }

    ctx.fillStyle='#eee';ctx.font='8px monospace';ctx.textAlign='center';
    ctx.fillText(m.id,mx,my+3);
    ctx.fillStyle='#888';ctx.font='7px monospace';
    ctx.fillText((thr*100).toFixed(0)+'%',mx,my+rad+9);
  }

  let modeStr=showMode===1?'NOGPS':'GPS';
  let gearStr=showMode===2?(gear<nPts?`G${gear}(\u2264${V[gear-1]}m/s)`:`G${gear}(FULL)`):'';
  ctx.fillStyle='#0ff';ctx.font='11px monospace';ctx.textAlign='left';
  ctx.fillText(`Mode:${modeStr}  Speed:${speed.toFixed(1)}m/s  ${gearStr}`,-sc*0.44,sc*0.47);
  ctx.restore();

  // ─── 力平衡显示（右上角）───
  // 估算机体俯仰：根据速度阶段
  let estimatedPitch;
  if(speed<2) estimatedPitch=0;
  else if(speed<6) estimatedPitch=5+speed;  // 0~11°
  else if(speed<10) estimatedPitch=11+(speed-6)*1.25;  // 11~16°
  else if(speed<14) estimatedPitch=16-(speed-10)*2;    // 16~8°
  else estimatedPitch=8;
  let f80=calcForce(0.8,estimatedPitch);
  let f100=calcForce(1.0,estimatedPitch);
  let drag=estimateDrag(speed);
  // 气动+地效+水浮力
  let aero=aeroLift(speed,estimatedPitch);
  let water=waterSupport(speed);
  let ge=geFactor(speed);
  // 涵道升力需求 = max(0, 重量 - 气动 - 水浮)
  let fanReq=Math.max(0, WEIGHT_N - aero - water);

  ctx.font='9px monospace';ctx.textAlign='left';
  let bx=w-260, by=14;
  ctx.fillStyle='#16213e';ctx.fillRect(bx-4,by-2,250,135);
  ctx.strokeStyle='#0f3460';ctx.strokeRect(bx-4,by-2,250,135);
  ctx.fillStyle='#0ff';
  ctx.fillText(`力平衡 @ V=${speed.toFixed(1)}m/s pitch≈${estimatedPitch.toFixed(0)}°`,bx,by+8);
  ctx.fillStyle='#888';
  ctx.fillText(`重量 ${WEIGHT_N.toFixed(0)}N  GE×${ge.toFixed(2)}  阻力 ${drag.toFixed(0)}N`,bx,by+20);
  ctx.fillStyle='#aaf';
  ctx.fillText(`气动升力 ${aero.toFixed(0)}N  水浮力 ${water.toFixed(0)}N`,bx,by+32);
  let reqColor=fanReq>0?'#fa0':'#0f0';
  ctx.fillStyle=reqColor;
  ctx.fillText(`涵道V需求 ${fanReq.toFixed(0)}N (${(fanReq/WEIGHT_N*100).toFixed(0)}%)`,bx,by+44);
  // 80% stick
  let v80Color=f80.V>=fanReq?'#0f0':(f80.V>=fanReq*0.8?'#ff0':'#f00');
  ctx.fillStyle=v80Color;
  ctx.fillText(`80%: V=${f80.V.toFixed(0)}N H=${f80.H.toFixed(0)}N  ${f80.V>=fanReq?'✓':'✗'}`,bx,by+58);
  // 100% stick
  let v100Color=f100.V>=fanReq?'#0f0':'#f00';
  ctx.fillStyle=v100Color;
  ctx.fillText(`100%: V=${f100.V.toFixed(0)}N H=${f100.H.toFixed(0)}N  ${f100.V>=fanReq?'✓':'✗'}`,bx,by+70);
  // Net forward
  let netH80=f80.H-drag, accel80=netH80/MASS_KG;
  ctx.fillStyle=accel80>0?'#0f0':'#f00';
  ctx.fillText(`80% 净推 ${netH80.toFixed(0)}N → ${accel80.toFixed(1)}m/s²`,bx,by+84);
  let netH100=f100.H-drag, accel100=netH100/MASS_KG;
  ctx.fillStyle=accel100>0?'#0f0':'#f00';
  ctx.fillText(`100% 净推 ${netH100.toFixed(0)}N → ${accel100.toFixed(1)}m/s²`,bx,by+96);
  // Battery current（用实测电流表）
  let totalA=0;
  for(let k of CURVE_KEYS){
    let g=f100.perGroup[k];
    if(g) totalA+=GROUP_COUNT[k]*currentFromThrottle(g.throttle);
  }
  ctx.fillStyle=totalA<800?'#0f0':'#f00';
  ctx.fillText(`100% 总电流 ${totalA.toFixed(0)}A (限800A)`,bx,by+110);
  // 总升力小结
  let totalLift=aero+water+f100.V;
  ctx.fillStyle=totalLift>=WEIGHT_N*1.1?'#0f0':(totalLift>=WEIGHT_N?'#ff0':'#f00');
  ctx.fillText(`总升力 ${totalLift.toFixed(0)}N (${(totalLift/WEIGHT_N*100).toFixed(0)}%重量)`,bx,by+124);
}

// ========== SLIDER ==========
function drawSlider(){
  let{ctx,w,h}=setupCv('cS');
  ctx.clearRect(0,0,w,h);
  let pad=24,by=h*0.4,bh=8,bL=pad,bR=w-pad,bW=bR-bL;

  // Background bar
  ctx.fillStyle='#182a40';ctx.fillRect(bL,by-bh/2,bW,bh);

  // V breakpoint markers
  for(let i=0;i<nPts;i++){
    let vx=bL+(V[i]/MAX_SPEED)*bW;
    ctx.beginPath();ctx.setLineDash([2,2]);ctx.moveTo(vx,by-bh-2);ctx.lineTo(vx,by+bh+2);
    ctx.strokeStyle='#fff6';ctx.lineWidth=1.5;ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#aaa';ctx.font='8px monospace';ctx.textAlign='center';
    ctx.fillText('V'+(i+1)+' '+V[i].toFixed(0),vx,by+bh+10);
  }

  // Speed indicator
  let sx=bL+(speed/MAX_SPEED)*bW;
  ctx.beginPath();ctx.moveTo(sx,by-bh-1);ctx.lineTo(sx,by+bh+1);
  ctx.strokeStyle='#0ff';ctx.lineWidth=2;ctx.stroke();

  // Mode indicator
  ctx.fillStyle='#555';ctx.font='8px monospace';
  ctx.textAlign='left';ctx.fillText('0',bL,by+bh+10);
  ctx.textAlign='right';ctx.fillText(MAX_SPEED+' m/s',bR,by+bh+10);

  // Mode toggle hint
  ctx.fillStyle=showMode===1?'#0f0':'#ff0';ctx.font='9px monospace';ctx.textAlign='center';
  ctx.fillText(showMode===1?'[N] NOGPS':'[G] GPS  (按N/G切换)',bL+bW/2,by-bh-6);
}

// ========== CURVE VIEW ==========
let CT=null;
function drawCurves(){
  let{cv,ctx,w,h}=setupCv('cC');
  ctx.clearRect(0,0,w,h);
  let p={l:42,r:14,t:14,b:24};
  let pw=w-p.l-p.r,ph=h-p.t-p.b;
  let yLo=curveTab==='geom'?-0.6:0, yHi=curveTab==='geom'?0.6:1.0;
  let tx=spd=>p.l+(spd/MAX_SPEED)*pw;
  let ty=v=>p.t+(1-(v-yLo)/(yHi-yLo))*ph;
  let fxSpd=px=>(px-p.l)/pw*MAX_SPEED;
  let fyVal=py=>yHi-(py-p.t)/ph*(yHi-yLo);
  CT={tx,ty,fxSpd,fyVal,p,pw,ph,cv};

  // Grid
  ctx.strokeStyle='#ffffff08';ctx.lineWidth=1;
  for(let v=yLo;v<=yHi+0.001;v+=0.1){
    ctx.beginPath();ctx.moveTo(p.l,ty(v));ctx.lineTo(w-p.r,ty(v));ctx.stroke();
    if(Math.round(v*100)%20===0){
      ctx.fillStyle='#555';ctx.font='9px monospace';ctx.textAlign='right';
      ctx.fillText(v.toFixed(1),p.l-3,ty(v)+3);
    }
  }
  // Speed grid
  for(let s=0;s<=MAX_SPEED;s+=5){
    ctx.beginPath();ctx.moveTo(tx(s),p.t);ctx.lineTo(tx(s),h-p.b);
    ctx.strokeStyle='#ffffff06';ctx.stroke();
    if(s%10===0){
      ctx.fillStyle='#555';ctx.font='9px monospace';ctx.textAlign='center';
      ctx.fillText(s+'',tx(s),h-p.b+12);
    }
  }

  // V breakpoint lines
  for(let i=0;i<nPts;i++){
    ctx.beginPath();ctx.setLineDash([4,3]);ctx.moveTo(tx(V[i]),p.t);ctx.lineTo(tx(V[i]),h-p.b);
    ctx.strokeStyle='#fff3';ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);
  }

  // Gear limit line
  if(gear<nPts){
    let gSpd=V[gear-1];
    ctx.fillStyle='#f005';ctx.fillRect(tx(gSpd),p.t,w-p.r-tx(gSpd),ph);
    ctx.beginPath();ctx.moveTo(tx(gSpd),p.t);ctx.lineTo(tx(gSpd),h-p.b);
    ctx.strokeStyle='#f00a';ctx.lineWidth=2;ctx.setLineDash([6,3]);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#f88';ctx.font='9px monospace';ctx.textAlign='left';
    ctx.fillText('G'+gear+' LIMIT',tx(gSpd)+4,p.t+12);
  }

  // Current speed line
  ctx.beginPath();ctx.moveTo(tx(speed),p.t);ctx.lineTo(tx(speed),h-p.b);
  ctx.strokeStyle='#0ff4';ctx.lineWidth=1.5;ctx.stroke();

  if(curveTab==='geom'){
    // Zero line
    ctx.beginPath();ctx.moveTo(p.l,ty(0));ctx.lineTo(w-p.r,ty(0));
    ctx.strokeStyle='#fff2';ctx.lineWidth=1;ctx.stroke();
    drawGeomCurves(ctx);
  } else if(curveTab==='throttle'){
    drawThrottleCurves(ctx);
  } else {
    ctx.fillStyle='#666';ctx.font='12px monospace';ctx.textAlign='center';
    ctx.fillText('倾转舵控制逻辑待加入 Lua 脚本',p.l+pw/2,p.t+ph/2);
  }
}

function drawThrottleCurves(ctx){
  let{tx,ty}=CT;
  for(let key of CURVE_KEYS){
    let c=CV[key], pts=c.pts, bends=c.bends;

    // Draw curve line
    ctx.beginPath();
    for(let s=0;s<=400;s++){
      let spd=s/400*MAX_SPEED, v=evalCV(key,spd);
      s===0?ctx.moveTo(tx(spd),ty(v)):ctx.lineTo(tx(spd),ty(v));
    }
    ctx.strokeStyle=CC[key];
    ctx.lineWidth=selCurve===key?3:1.5;
    ctx.globalAlpha=selCurve&&selCurve!==key?0.25:1;
    ctx.stroke();ctx.globalAlpha=1;

    // Bend handles
    for(let i=0;i<pts.length-1;i++){
      let bmx=(pts[i].x+pts[i+1].x)/2;
      let bmy=lp(pts[i].y,pts[i+1].y,0.5)+bends[i];
      if(Math.abs(bends[i])>0.005){
        ctx.beginPath();ctx.arc(tx(bmx),ty(bmy),3.5,0,Math.PI*2);
        ctx.fillStyle=CC[key]+'80';ctx.fill();
        ctx.strokeStyle=CC[key];ctx.lineWidth=0.5;ctx.stroke();
      }
    }

    // Control points
    for(let j=0;j<pts.length;j++){
      let pt=pts[j];
      ctx.beginPath();ctx.arc(tx(pt.x),ty(pt.y),5,0,Math.PI*2);
      ctx.fillStyle=CC[key];ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.stroke();
      ctx.fillStyle=CC[key];ctx.font='8px monospace';
      ctx.textAlign=j===0?'right':'left';
      ctx.fillText(pt.y.toFixed(2),tx(pt.x)+(j===0?-8:8),ty(pt.y)-6);
    }
  }
}

function drawGeomCurves(ctx){
  let{tx,ty}=CT;
  if(selMot===null){
    ctx.fillStyle='#666';ctx.font='12px monospace';ctx.textAlign='center';
    ctx.fillText('点击电机查看姿态几何',CT.p.l+CT.pw/2,CT.p.t+CT.ph/2);
    return;
  }
  let g=GEOM[selMot];
  let axes=[{k:'p',label:'Pitch',color:GC.pitch},{k:'r',label:'Roll',color:GC.roll},{k:'y',label:'Yaw',color:GC.yaw}];
  for(let ax of axes){
    let val=g[ax.k];
    ctx.beginPath();ctx.moveTo(tx(0),ty(val));ctx.lineTo(tx(MAX_SPEED),ty(val));
    ctx.strokeStyle=ax.color;ctx.lineWidth=2;ctx.stroke();
    ctx.beginPath();ctx.arc(tx(MAX_SPEED/2),ty(val),5,0,Math.PI*2);
    ctx.fillStyle=ax.color;ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.stroke();
    ctx.fillStyle=ax.color;ctx.font='9px monospace';ctx.textAlign='left';
    ctx.fillText(`${ax.label}: ${val.toFixed(2)}`,tx(MAX_SPEED/2)+10,ty(val)+3);
  }
}

function redraw(){drawMotors();drawSlider();drawCurves();updateDetail();}

// ========== TABS ==========
function setTab(t){
  curveTab=t;
  document.querySelectorAll('#tabBtns button').forEach((b,i)=>{
    b.classList.toggle('act',i===(['throttle','tilt','geom'].indexOf(t)));
  });
  document.getElementById('lgThrottle').style.display=t==='throttle'?'flex':'none';
  document.getElementById('lgTilt').style.display=t==='tilt'?'flex':'none';
  document.getElementById('lgGeom').style.display=t==='geom'?'flex':'none';
  selCurve=null;redraw();
}

// ========== POPUP ==========
let popupTarget=null;
function showPopup(x,y,val,cb){
  let el=document.getElementById('popup'),inp=document.getElementById('popIn');
  el.style.display='block';el.style.left=x+'px';el.style.top=y+'px';
  inp.value=val.toFixed(3);inp.focus();inp.select();popupTarget=cb;
}
function hidePopup(){document.getElementById('popup').style.display='none';popupTarget=null;}
document.getElementById('popIn').addEventListener('keydown',e=>{
  if(e.key==='Enter'){let v=parseFloat(document.getElementById('popIn').value);if(!isNaN(v)&&popupTarget)popupTarget(v);hidePopup();redraw();}
  else if(e.key==='Escape')hidePopup();
});
document.getElementById('popIn').addEventListener('blur',()=>{
  let v=parseFloat(document.getElementById('popIn').value);if(!isNaN(v)&&popupTarget)popupTarget(v);hidePopup();redraw();
});

// ========== N_PTS / V SYNC ==========
function onGearChange(){
  gear=parseInt(document.getElementById('i_gear').value);
  redraw();
}
function syncGearDropdown(){
  // 固定 3 档：1档(≤V1) 2档(≤V2) 3档(全开到V3)
  let sel=document.getElementById('i_gear');
  let prev=gear;
  sel.innerHTML='';
  let labels=['1档 (≤V1 滑跑)','2档 (≤V2 驼峰)','3档 (全开)'];
  for(let i=1;i<=3;i++){
    let opt=document.createElement('option');
    opt.value=i;
    opt.textContent=labels[i-1];
    sel.appendChild(opt);
  }
  gear=Math.min(prev,3);
  sel.value=gear;
}
function readV(){
  V[0]=parseFloat(document.getElementById('i_v1').value)||4;
  V[1]=parseFloat(document.getElementById('i_v2').value)||8;
  V[2]=parseFloat(document.getElementById('i_v3').value)||18;
}

// ========== SLIDER INTERACTION ==========
(function(){
  let cv=document.getElementById('cS'),dragging=false;
  cv.onmousedown=e=>{dragging=true;mv(e);};
  cv.onmousemove=e=>{if(dragging)mv(e);};
  cv.onmouseup=cv.onmouseleave=()=>{dragging=false;};
  function mv(e){
    let rect=cv.getBoundingClientRect(),pad=24;
    let bW=rect.width-pad*2;
    speed=cl((e.clientX-rect.left-pad)/bW*MAX_SPEED,0,MAX_SPEED);
    redraw();
  }
})();

// ========== MOTOR CLICK ==========
document.getElementById('cM').addEventListener('click',e=>{
  let cv=e.target,rect=cv.getBoundingClientRect();
  let mx=e.clientX-rect.left-rect.width/2,my=e.clientY-rect.top-rect.height*0.48;
  let sc=Math.min(rect.width*0.85,rect.height*0.85);
  let best=null,bestD=20;
  for(let m of ML){
    let px=m.x*sc,py=-m.y*sc+sc*0.42;
    let d=Math.hypot(mx-px,my-py);
    if(d<bestD){bestD=d;best=m;}
  }
  selMot=best?best.i:null;redraw();
});

// ========== CURVE INTERACTION (original free-form: drag X+Y, dblclick add, right-click delete, bend handles) ==========
(function(){
  let cv=document.getElementById('cC'),drag=null,geomDrag=null;

  cv.onmousemove=e=>{
    if(drag){mvCurve(e);return;}
    if(curveTab==='geom'&&geomDrag){geomMove(e);return;}
    if(CT&&curveTab==='throttle'){
      let rect=cv.getBoundingClientRect();
      let mx=e.clientX-rect.left,my=e.clientY-rect.top;
      let spd=CT.fxSpd(mx),bestKey=null,bestD=15;
      for(let key of CURVE_KEYS){
        let v=evalCV(key,spd);
        let d=Math.abs(my-CT.ty(v));
        if(d<bestD){bestD=d;bestKey=key;}
      }
      if(selCurve!==bestKey){selCurve=bestKey;redraw();}
    }
  };
  cv.onmouseup=()=>{drag=null;geomDrag=null;};
  cv.onmouseleave=()=>{drag=null;geomDrag=null;selCurve=null;redraw();};

  // Click on point → popup
  cv.onclick=e=>{
    if(!CT)return;
    let rect=cv.getBoundingClientRect();
    let mx=e.clientX-rect.left,my=e.clientY-rect.top;
    if(curveTab==='throttle'){
      for(let key of CURVE_KEYS){
        let c=CV[key];
        for(let j=0;j<c.pts.length;j++){
          if(Math.hypot(mx-CT.tx(c.pts[j].x),my-CT.ty(c.pts[j].y))<8){
            selCurve=key;redraw();
            showPopup(e.clientX+5,e.clientY-30,c.pts[j].y,v=>{c.pts[j].y=cl(v,0,1);});
            return;
          }
        }
      }
    } else if(curveTab==='geom'&&selMot!==null){
      let g=GEOM[selMot];
      for(let ax of['p','r','y']){
        if(Math.abs(my-CT.ty(g[ax]))<8){
          let savedAx=ax;
          showPopup(e.clientX+5,e.clientY-30,g[ax],v=>{setGeomMirrored(selMot,savedAx,cl(v,-1,1));});return;
        }
      }
    }
  };

  // Double click → add node to nearest curve
  cv.ondblclick=e=>{
    if(!CT||curveTab!=='throttle')return;
    let rect=cv.getBoundingClientRect();
    let mx=e.clientX-rect.left,my=e.clientY-rect.top;
    let spd=CT.fxSpd(mx);
    for(let key of CURVE_KEYS){
      let v=evalCV(key,spd);
      if(Math.abs(my-CT.ty(v))<12){
        let c=CV[key];
        for(let i=0;i<c.pts.length-1;i++){
          if(spd>c.pts[i].x+0.5&&spd<c.pts[i+1].x-0.5){
            c.pts.splice(i+1,0,{x:spd,y:v});
            let oldBend=c.bends[i];
            c.bends.splice(i,1,oldBend*0.5,oldBend*0.5);
            redraw();toast('Added node to '+key);
            return;
          }
        }
      }
    }
  };

  // Right click → remove node (not first or last)
  cv.oncontextmenu=e=>{
    e.preventDefault();
    if(!CT||curveTab!=='throttle')return;
    let rect=cv.getBoundingClientRect();
    let mx=e.clientX-rect.left,my=e.clientY-rect.top;
    for(let key of CURVE_KEYS){
      let c=CV[key];
      for(let j=1;j<c.pts.length-1;j++){
        if(Math.hypot(mx-CT.tx(c.pts[j].x),my-CT.ty(c.pts[j].y))<10){
          c.pts.splice(j,1);
          let merged=(c.bends[j-1]+c.bends[j])*0.5;
          c.bends.splice(j-1,2,merged);
          redraw();toast('Removed node from '+key);
          return;
        }
      }
    }
  };

  cv.onmousedown=e=>{
    if(curveTab==='geom'){geomDown(e);return;}
    if(!CT||curveTab!=='throttle')return;
    let rect=cv.getBoundingClientRect();
    let mx=e.clientX-rect.left,my=e.clientY-rect.top;
    let best=null,bestD=12;
    // Check control points
    for(let key of CURVE_KEYS){
      let c=CV[key];
      for(let j=0;j<c.pts.length;j++){
        let d=Math.hypot(mx-CT.tx(c.pts[j].x),my-CT.ty(c.pts[j].y));
        if(d<bestD){bestD=d;best={type:'pt',key,j};}
      }
      // Check bend handles
      for(let i=0;i<c.pts.length-1;i++){
        let bmx=(c.pts[i].x+c.pts[i+1].x)/2;
        let bmy=lp(c.pts[i].y,c.pts[i+1].y,0.5)+c.bends[i];
        let d=Math.hypot(mx-CT.tx(bmx),my-CT.ty(bmy));
        if(d<bestD){bestD=d;best={type:'bend',key,seg:i};}
      }
    }
    // Fallback: grab closest curve for bend
    if(!best||bestD>10){
      let spd=CT.fxSpd(mx);
      for(let key of CURVE_KEYS){
        let v=evalCV(key,spd);
        if(Math.abs(my-CT.ty(v))<10){
          let c=CV[key];
          for(let i=0;i<c.pts.length-1;i++){
            if(spd>=c.pts[i].x&&spd<=c.pts[i+1].x){best={type:'bend',key,seg:i};break;}
          }
          if(best)break;
        }
      }
    }
    drag=best;
    if(drag&&drag.key)selCurve=drag.key;
    if(drag&&drag.type==='bend')mvCurve(e);
  };

  function mvCurve(e){
    let rect=cv.getBoundingClientRect();
    let mx=e.clientX-rect.left,my=e.clientY-rect.top;
    if(drag.type==='pt'){
      let c=CV[drag.key],pt=c.pts[drag.j];
      pt.y=cl(CT.fyVal(my),0,1);
      // Interior points: X also draggable
      if(drag.j>0&&drag.j<c.pts.length-1){
        let newX=CT.fxSpd(mx);
        pt.x=cl(newX,c.pts[drag.j-1].x+0.3,c.pts[drag.j+1].x-0.3);
      }
    } else if(drag.type==='bend'){
      let c=CV[drag.key],i=drag.seg;
      let linMid=lp(c.pts[i].y,c.pts[i+1].y,0.5);
      c.bends[i]=cl(CT.fyVal(my)-linMid,-0.5,0.5);
    }
    redraw();
  }

  function geomDown(e){
    if(!CT||selMot===null)return;
    let rect=cv.getBoundingClientRect(),my=e.clientY-rect.top;
    let g=GEOM[selMot];
    for(let ax of['p','r','y']){
      if(Math.abs(my-CT.ty(g[ax]))<10){geomDrag={ax};return;}
    }
  }
  function geomMove(e){
    if(!geomDrag||selMot===null)return;
    let rect=cv.getBoundingClientRect(),my=e.clientY-rect.top;
    setGeomMirrored(selMot,geomDrag.ax,cl(CT.fyVal(my),-1,1));
    redraw();
  }
})();

// ========== KEYBOARD ==========
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
  if(e.key==='n'||e.key==='N'){showMode=1;redraw();}
  if(e.key==='g'||e.key==='G'){showMode=2;redraw();}
});

// ========== DETAIL ==========
function updateDetail(){
  let el=document.getElementById('mdet');
  if(selMot===null){el.style.display='none';return;}
  el.style.display='block';
  let m=ML.find(m=>m.i===selMot),g=GEOM[selMot];
  let thr=motorThrNorm(m,speed);
  let key=GK[m.g];
  let es=showMode===1?speed:gearSpeed(speed);
  let raw=showMode===1?M1[key]:evalCV(key,es);
  let pair=MIRROR_PAIRS[selMot];
  let pairId=pair!==undefined?ML.find(mm=>mm.i===pair).id:'';
  el.innerHTML=`<b style="color:#0ff">${m.id}</b> (${key} ${CURVE_LABELS[key]}) ${pairId?'↔ <span style="color:#888">'+pairId+'</span>':''}<br>`+
    `Raw: ${raw.toFixed(2)} | Norm: ${(thr*100).toFixed(1)}% | P:${g.p.toFixed(2)} R:${g.r.toFixed(2)} Y:${g.y.toFixed(2)}`+
    `<br><span style="color:#888;font-size:9px">编辑GEOM自动镜像到 ${pairId}</span>`;
}

// ========== SIDEBAR SYNC ==========
document.querySelectorAll('.sb input, .sb select').forEach(inp=>{
  inp.addEventListener('change',()=>{
    M1.KS=parseFloat(document.getElementById('m1_ks').value)||0;
    M1.KDF=parseFloat(document.getElementById('m1_kdf').value)||0;
    M1.KDM=parseFloat(document.getElementById('m1_kdm').value)||0;
    M1.KT=parseFloat(document.getElementById('m1_kt').value)||0;
    M1.KRD=parseFloat(document.getElementById('m1_krd').value)||0;
    readV();syncGearDropdown();
    tiltMax=parseFloat(document.getElementById('i_tm').value)||30;
    let newMax=parseFloat(document.getElementById('i_vmax').value)||20;
    if(newMax!==MAX_SPEED){
      // Rescale curve points beyond new max
      MAX_SPEED=newMax;
      for(let key of CURVE_KEYS){
        let c=CV[key];
        // Update the last point's X to match new MAX_SPEED
        let lastIdx=c.pts.length-1;
        c.pts[lastIdx].x=MAX_SPEED;
        // Clip any interior points beyond MAX_SPEED
        c.pts=c.pts.filter((p,i)=>i===lastIdx||p.x<MAX_SPEED);
        // Recompute bends array
        if(c.bends.length!==c.pts.length-1){
          c.bends=new Array(c.pts.length-1).fill(0);
        }
      }
    }
    redraw();
  });
});

// ========== IMPORT ==========
function doImport(){document.getElementById('fIn').click();}
function onFile(e){
  let f=e.target.files[0];if(!f)return;
  let rd=new FileReader();
  rd.onload=ev=>{
    let ps={};
    ev.target.result.split('\n').forEach(l=>{
      l=l.replace(/#.*/,'').trim();if(!l)return;
      let[k,v]=l.split(',');if(k&&v)ps[k.trim()]=parseFloat(v.trim());
    });
    // Mode 1
    if(ps.MSK_M1_KS!==undefined) M1.KS=ps.MSK_M1_KS;
    if(ps.MSK_M1_KDF!==undefined) M1.KDF=ps.MSK_M1_KDF;
    if(ps.MSK_M1_KDM!==undefined) M1.KDM=ps.MSK_M1_KDM;
    if(ps.MSK_M1_KT!==undefined) M1.KT=ps.MSK_M1_KT;
    if(ps.MSK_M1_KRD!==undefined) M1.KRD=ps.MSK_M1_KRD;
    // Breakpoints (固定 N_PTS=3)
    nPts=N_PTS;
    if(ps.MSK_V1!==undefined) V[0]=ps.MSK_V1;
    if(ps.MSK_V2!==undefined) V[1]=ps.MSK_V2;
    if(ps.MSK_V3!==undefined) V[2]=ps.MSK_V3;
    // Rebuild visual curves from imported V/Y values
    const YM={KS:'KS',KDF:'KDF',KDM:'KDM',KT:'KT',KRD:'KRD'};
    for(let[ck,pk] of Object.entries(YM)){
      let ys=[];
      for(let i=0;i<3;i++){
        let pn=`MSK_${pk}${i+1}`;
        ys.push(ps[pn]!==undefined?ps[pn]:(CV[ck].pts[0]?CV[ck].pts[0].y:0.5));
      }
      // Build pts: endpoint at 0 + V breakpoints + endpoint at MAX_SPEED
      let pts=[{x:0,y:ys[0]}];
      for(let i=0;i<3;i++) pts.push({x:V[i],y:ys[i]});
      pts.push({x:MAX_SPEED,y:ys[2]});
      CV[ck]=mkCurve(pts);
    }
    if(ps.MSK_RAMP!==undefined) document.getElementById('i_rmp').value=ps.MSK_RAMP;
    if(ps.MSK_MODE_CH!==undefined) document.getElementById('i_mch').value=ps.MSK_MODE_CH;
    if(ps.MSK_GEAR_CH!==undefined) document.getElementById('i_gch').value=ps.MSK_GEAR_CH;
    if(ps.MSK_CHK_CH!==undefined) document.getElementById('i_cch').value=ps.MSK_CHK_CH;
    if(ps.MSK_CHK_PWM!==undefined) document.getElementById('i_ckp').value=ps.MSK_CHK_PWM;
    if(ps.MSK_CHK_STOP!==undefined) document.getElementById('i_cks').value=ps.MSK_CHK_STOP;
    if(ps.MSK_CHK_GRP_MS!==undefined) document.getElementById('i_ckg').value=ps.MSK_CHK_GRP_MS;
    if(ps.MSK_GPS_TAU!==undefined) document.getElementById('i_gtau').value=ps.MSK_GPS_TAU;
    if(ps.MSK_AUTO_CH!==undefined) document.getElementById('i_autoch').value=ps.MSK_AUTO_CH;
    if(ps.MSK_AUTO_TGT!==undefined) document.getElementById('i_autotgt').value=ps.MSK_AUTO_TGT;
    if(ps.MSK_AUTO_CUT!==undefined) document.getElementById('i_autocut').value=ps.MSK_AUTO_CUT;
    if(ps.MSK_WING_OFS!==undefined) document.getElementById('i_wofs').value=ps.MSK_WING_OFS;
    if(ps.MSK_PIT_LIM!==undefined) document.getElementById('i_plim').value=ps.MSK_PIT_LIM;
    if(ps.MSK_ROL_LIM!==undefined) document.getElementById('i_rlim').value=ps.MSK_ROL_LIM;
    if(ps.MSK_ATT_KP!==undefined) document.getElementById('i_atkp').value=ps.MSK_ATT_KP;
    if(ps.MSK_RC_LIM!==undefined) document.getElementById('i_rclim').value=ps.MSK_RC_LIM;
    // 倾转舵
    if(ps.MSK_TILT_SVL!==undefined) document.getElementById('i_tsvl').value=ps.MSK_TILT_SVL;
    if(ps.MSK_TILT_SVR!==undefined) document.getElementById('i_tsvr').value=ps.MSK_TILT_SVR;
    if(ps.MSK_TILT_L_ZERO!==undefined) document.getElementById('i_tlz').value=ps.MSK_TILT_L_ZERO;
    if(ps.MSK_TILT_L_DIR!==undefined) document.getElementById('i_tld').value=ps.MSK_TILT_L_DIR;
    if(ps.MSK_TILT_R_ZERO!==undefined) document.getElementById('i_trz').value=ps.MSK_TILT_R_ZERO;
    if(ps.MSK_TILT_R_DIR!==undefined) document.getElementById('i_trd').value=ps.MSK_TILT_R_DIR;
    if(ps.MSK_TILT_USPD!==undefined) document.getElementById('i_tuspd').value=ps.MSK_TILT_USPD;
    if(ps.MSK_TILT_DEG!==undefined) document.getElementById('i_tm').value=ps.MSK_TILT_DEG;
    if(ps.MSK_TILT_TAU!==undefined) document.getElementById('i_ttau').value=ps.MSK_TILT_TAU;
    if(ps.MSK_TILT_CAL!==undefined) document.getElementById('i_tcal').value=ps.MSK_TILT_CAL;
    if(ps.MSK_TILT_V1!==undefined) document.getElementById('i_tv1').value=ps.MSK_TILT_V1;
    if(ps.MSK_TILT_V2!==undefined) document.getElementById('i_tv2').value=ps.MSK_TILT_V2;
    if(ps.MSK_TILT_V3!==undefined) document.getElementById('i_tv3').value=ps.MSK_TILT_V3;
    // Sync UI
    document.getElementById('m1_ks').value=M1.KS;document.getElementById('m1_kdf').value=M1.KDF;
    document.getElementById('m1_kdm').value=M1.KDM;document.getElementById('m1_kt').value=M1.KT;
    document.getElementById('m1_krd').value=M1.KRD;
    document.getElementById('i_v1').value=V[0];document.getElementById('i_v2').value=V[1];
    document.getElementById('i_v3').value=V[2];
    syncGearDropdown();redraw();toast('Imported');
  };
  rd.readAsText(f);e.target.value='';
}

// ========== EXPORT ==========
function doExport(){
  let L=['# MantaShark v7 Mixer Parameters','# 可直接导入 Mission Planner',''];
  // Mode 1
  L.push(`MSK_M1_KS,${M1.KS.toFixed(2)}`);
  L.push(`MSK_M1_KDF,${M1.KDF.toFixed(2)}`);
  L.push(`MSK_M1_KDM,${M1.KDM.toFixed(2)}`);
  L.push(`MSK_M1_KT,${M1.KT.toFixed(2)}`);
  L.push(`MSK_M1_KRD,${M1.KRD.toFixed(2)}`);
  L.push('');
  // Breakpoints (固定 N_PTS=3)
  L.push(`MSK_N_PTS,3`);
  L.push(`MSK_V1,${V[0].toFixed(1)}`);
  L.push(`MSK_V2,${V[1].toFixed(1)}`);
  L.push(`MSK_V3,${V[2].toFixed(1)}`);
  L.push('');
  // Curve Y values + Expo (sampled from visual curves at V breakpoints)
  const YM={KS:'KS',KDF:'KDF',KDM:'KDM',KT:'KT',KRD:'KRD'};
  const EM={KS:'CS',KDF:'CDF',KDM:'CDM',KT:'CT',KRD:'CRD'};
  for(let[ck,pk] of Object.entries(YM)){
    let s=sampleForExport(ck);
    for(let i=0;i<3;i++) L.push(`MSK_${pk}${i+1},${s.y[i].toFixed(2)}`);
  }
  L.push('');
  for(let[ck,pk] of Object.entries(EM)){
    let s=sampleForExport(ck);
    for(let i=0;i<2;i++) L.push(`MSK_${pk}${i+1},${s.expo[i].toFixed(2)}`);
  }
  L.push('');
  // Control
  L.push(`MSK_RAMP,${document.getElementById('i_rmp').value}`);
  L.push(`MSK_MODE_CH,${document.getElementById('i_mch').value}`);
  L.push(`MSK_GEAR_CH,${document.getElementById('i_gch').value}`);
  L.push(`MSK_CHK_CH,${document.getElementById('i_cch').value}`);
  L.push(`MSK_CHK_PWM,${document.getElementById('i_ckp').value}`);
  L.push(`MSK_CHK_STOP,${document.getElementById('i_cks').value}`);
  L.push(`MSK_CHK_GRP_MS,${document.getElementById('i_ckg').value}`);
  L.push(`MSK_GPS_TAU,${document.getElementById('i_gtau').value}`);
  L.push(`MSK_AUTO_CH,${document.getElementById('i_autoch').value}`);
  L.push(`MSK_AUTO_TGT,${document.getElementById('i_autotgt').value}`);
  L.push(`MSK_AUTO_CUT,${document.getElementById('i_autocut').value}`);
  L.push('');
  // 姿态保护
  L.push(`MSK_WING_OFS,${document.getElementById('i_wofs').value}`);
  L.push(`MSK_PIT_LIM,${document.getElementById('i_plim').value}`);
  L.push(`MSK_ROL_LIM,${document.getElementById('i_rlim').value}`);
  L.push(`MSK_ATT_KP,${document.getElementById('i_atkp').value}`);
  L.push(`MSK_RC_LIM,${document.getElementById('i_rclim').value}`);
  L.push('');
  // 倾转舵 (DFL/DFR)
  L.push(`MSK_TILT_SVL,${document.getElementById('i_tsvl').value}`);
  L.push(`MSK_TILT_SVR,${document.getElementById('i_tsvr').value}`);
  L.push(`MSK_TILT_L_ZERO,${document.getElementById('i_tlz').value}`);
  L.push(`MSK_TILT_L_DIR,${document.getElementById('i_tld').value}`);
  L.push(`MSK_TILT_R_ZERO,${document.getElementById('i_trz').value}`);
  L.push(`MSK_TILT_R_DIR,${document.getElementById('i_trd').value}`);
  L.push(`MSK_TILT_USPD,${document.getElementById('i_tuspd').value}`);
  L.push(`MSK_TILT_DEG,${document.getElementById('i_tm').value}`);
  L.push(`MSK_TILT_TAU,${document.getElementById('i_ttau').value}`);
  L.push(`MSK_TILT_CAL,${document.getElementById('i_tcal').value}`);
  L.push(`MSK_TILT_V1,${document.getElementById('i_tv1').value}`);
  L.push(`MSK_TILT_V2,${document.getElementById('i_tv2').value}`);
  L.push(`MSK_TILT_V3,${document.getElementById('i_tv3').value}`);
  L.push('');
  // GEOM as comments
  L.push('# GEOM (roll/pitch/yaw per motor, for reference)');
  for(let m of ML){
    let g=GEOM[m.i];
    L.push(`# ${m.id}[${m.i}]: r=${g.r.toFixed(2)} p=${g.p.toFixed(2)} y=${g.y.toFixed(2)}`);
  }
  let b=new Blob([L.join('\n')],{type:'text/plain'});
  let a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='msk_v7_params.txt';a.click();
  toast('Exported msk_v7_params.txt');
}

// ========== RESET ==========
function doReset(){
  nPts=N_PTS;V=[4,8,14];MAX_SPEED=20;
  CV={
    KS:mkCurve([{x:0,y:0.70},{x:4,y:0.70},{x:8,y:0.55},{x:14,y:0.10},{x:MAX_SPEED,y:0.10}]),
    KDF:mkCurve([{x:0,y:0.80},{x:4,y:0.80},{x:8,y:0.65},{x:14,y:0.08},{x:MAX_SPEED,y:0.08}]),
    KDM:mkCurve([{x:0,y:0.70},{x:4,y:0.70},{x:8,y:0.55},{x:14,y:0.08},{x:MAX_SPEED,y:0.08}]),
    KT:mkCurve([{x:0,y:0.30},{x:4,y:0.40},{x:8,y:0.85},{x:14,y:0.65},{x:MAX_SPEED,y:0.65}]),
    KRD:mkCurve([{x:0,y:0.55},{x:4,y:0.65},{x:8,y:0.85},{x:14,y:0.25},{x:MAX_SPEED,y:0.25}]),
  };
  M1={KS:0.55,KDF:0.65,KDM:0.55,KT:0.15,KRD:0.55};
  GEOM={
    0:{r:0,p:.5,y:0},   1:{r:0,p:.5,y:0},
    2:{r:0,p:.5,y:0},   3:{r:0,p:.5,y:0},
    4:{r:0,p:.5,y:0},   5:{r:0,p:.5,y:0},
    6:{r:.5,p:-.5,y:0}, 7:{r:-.5,p:-.5,y:0},
    8:{r:0,p:0,y:.50},  9:{r:0,p:0,y:.36},
    10:{r:0,p:0,y:-.50},11:{r:0,p:0,y:-.36},
    12:{r:0,p:-.5,y:0}, 13:{r:0,p:-.5,y:0}};
  speed=0;selMot=null;showMode=2;tiltMax=30;
  document.getElementById('m1_ks').value='0.55';document.getElementById('m1_kdf').value='0.65';
  document.getElementById('m1_kdm').value='0.55';document.getElementById('m1_kt').value='0.15';
  document.getElementById('m1_krd').value='0.55';
  document.getElementById('i_vmax').value='20';
  document.getElementById('i_v1').value='4';document.getElementById('i_v2').value='8';
  document.getElementById('i_v3').value='14';
  document.getElementById('i_rmp').value='0.4';document.getElementById('i_mch').value='6';
  document.getElementById('i_gch').value='7';document.getElementById('i_cch').value='8';
  document.getElementById('i_ckp').value='1100';document.getElementById('i_cks').value='1000';
  document.getElementById('i_ckg').value='2000';
  document.getElementById('i_gtau').value='3.0';document.getElementById('i_tm').value='30';
  document.getElementById('i_autoch').value='9';
  document.getElementById('i_autotgt').value='0.80';
  document.getElementById('i_autocut').value='0.10';
  document.getElementById('i_wofs').value='8.0';
  document.getElementById('i_plim').value='10.0';
  document.getElementById('i_rlim').value='15.0';
  document.getElementById('i_atkp').value='0.3';
  document.getElementById('i_rclim').value='5.0';
  document.getElementById('i_tsvl').value='15';document.getElementById('i_tsvr').value='16';
  document.getElementById('i_tlz').value='1500';document.getElementById('i_tld').value='1';
  document.getElementById('i_trz').value='1500';document.getElementById('i_trd').value='-1';
  document.getElementById('i_tuspd').value='8.0';document.getElementById('i_ttau').value='0.5';
  document.getElementById('i_tcal').value='-1';
  document.getElementById('i_tv1').value='0';document.getElementById('i_tv2').value='15';
  document.getElementById('i_tv3').value='30';
  syncGearDropdown();redraw();toast('Reset to defaults');
}
function toast(m){let t=document.getElementById('toast');t.textContent=m;t.style.display='block';setTimeout(()=>t.style.display='none',1500);}

// ========== SAVE / LOAD (localStorage) ==========
const SAVE_KEY='msk_tuner_v7';
function getState(){
  return {
    nPts, V:[...V], CV:JSON.parse(JSON.stringify(CV)), M1:{...M1}, GEOM:JSON.parse(JSON.stringify(GEOM)),
    gear, tiltMax, MAX_SPEED,
    rmp: document.getElementById('i_rmp').value,
    mch: document.getElementById('i_mch').value,
    gch: document.getElementById('i_gch').value,
    cch: document.getElementById('i_cch').value,
    ckp: document.getElementById('i_ckp').value,
    cks: document.getElementById('i_cks').value,
    ckg: document.getElementById('i_ckg').value,
    gtau: document.getElementById('i_gtau').value,
    tm: document.getElementById('i_tm').value,
    autoch: document.getElementById('i_autoch').value,
    autotgt: document.getElementById('i_autotgt').value,
    autocut: document.getElementById('i_autocut').value,
    wofs: document.getElementById('i_wofs').value,
    plim: document.getElementById('i_plim').value,
    rlim: document.getElementById('i_rlim').value,
    atkp: document.getElementById('i_atkp').value,
    rclim: document.getElementById('i_rclim').value,
    tsvl: document.getElementById('i_tsvl').value,
    tsvr: document.getElementById('i_tsvr').value,
    tlz: document.getElementById('i_tlz').value,
    tld: document.getElementById('i_tld').value,
    trz: document.getElementById('i_trz').value,
    trd: document.getElementById('i_trd').value,
    tuspd: document.getElementById('i_tuspd').value,
    ttau: document.getElementById('i_ttau').value,
    tcal: document.getElementById('i_tcal').value,
    tv1: document.getElementById('i_tv1').value,
    tv2: document.getElementById('i_tv2').value,
    tv3: document.getElementById('i_tv3').value,
  };
}
function applyState(s){
  nPts=s.nPts; V=s.V; CV=s.CV; M1=s.M1; GEOM=s.GEOM;
  gear=s.gear||3; tiltMax=s.tiltMax||30;
  if(s.MAX_SPEED) MAX_SPEED=s.MAX_SPEED;
  document.getElementById('m1_ks').value=M1.KS;document.getElementById('m1_kdf').value=M1.KDF;
  document.getElementById('m1_kdm').value=M1.KDM;document.getElementById('m1_kt').value=M1.KT;
  document.getElementById('m1_krd').value=M1.KRD;
  document.getElementById('i_vmax').value=MAX_SPEED;
  document.getElementById('i_v1').value=V[0];document.getElementById('i_v2').value=V[1];
  document.getElementById('i_v3').value=V[2];
  document.getElementById('i_rmp').value=s.rmp||'0.4';
  document.getElementById('i_mch').value=s.mch||'6';
  document.getElementById('i_gch').value=s.gch||'7';
  document.getElementById('i_cch').value=s.cch||'8';
  document.getElementById('i_ckp').value=s.ckp||'1100';
  document.getElementById('i_cks').value=s.cks||'1000';
  document.getElementById('i_ckg').value=s.ckg||'2000';
  document.getElementById('i_gtau').value=s.gtau||'3.0';
  document.getElementById('i_tm').value=s.tm||'30';
  document.getElementById('i_autoch').value=s.autoch||'9';
  document.getElementById('i_autotgt').value=s.autotgt||'0.80';
  document.getElementById('i_autocut').value=s.autocut||'0.10';
  document.getElementById('i_wofs').value=s.wofs||'8.0';
  document.getElementById('i_plim').value=s.plim||'10.0';
  document.getElementById('i_rlim').value=s.rlim||'15.0';
  document.getElementById('i_atkp').value=s.atkp||'0.3';
  document.getElementById('i_rclim').value=s.rclim||'5.0';
  document.getElementById('i_tsvl').value=s.tsvl||'15';
  document.getElementById('i_tsvr').value=s.tsvr||'16';
  document.getElementById('i_tlz').value=s.tlz||'1500';
  document.getElementById('i_tld').value=s.tld||'1';
  document.getElementById('i_trz').value=s.trz||'1500';
  document.getElementById('i_trd').value=s.trd||'-1';
  document.getElementById('i_tuspd').value=s.tuspd||'8.0';
  document.getElementById('i_ttau').value=s.ttau||'0.5';
  document.getElementById('i_tcal').value=s.tcal||'-1';
  document.getElementById('i_tv1').value=s.tv1||'0';
  document.getElementById('i_tv2').value=s.tv2||'15';
  document.getElementById('i_tv3').value=s.tv3||'30';
  syncGearDropdown();redraw();
}
function doSave(){
  try{localStorage.setItem(SAVE_KEY,JSON.stringify(getState()));toast('Saved');}
  catch(e){toast('Save failed: '+e.message);}
}
function doLoad(){
  try{
    let raw=localStorage.getItem(SAVE_KEY);
    if(!raw){toast('No saved state');return false;}
    applyState(JSON.parse(raw));toast('Loaded saved state');return true;
  }catch(e){toast('Load failed: '+e.message);return false;}
}

// ========== 在线模式 (从 GCS serve 时自动启用) ==========
// 检测 /api/params/msk 是否可用 → 显示读写飞控按钮
// 不再自动轮询! 只在用户点"读取飞控参数"时拉取, 避免覆盖编辑中的值.
function checkOnlineMode(){
  fetch('/api/params/msk').then(r=>r.json()).then(d=>{
    document.getElementById('fc_buttons').style.display='inline';
    console.log('Online mode: FC connected,', Object.keys(d.params||{}).length, 'MSK_ params');
  }).catch(()=>{
    // 离线模式 (直接打开 HTML), 隐藏按钮
    document.getElementById('fc_buttons').style.display='none';
  });
}

function applyParamsFromDict(ps){
  // 与 onFile 中解析后的逻辑相同: ps = {MSK_V2: 8.0, ...}
  if(ps.MSK_M1_KS!==undefined) M1.KS=ps.MSK_M1_KS;
  if(ps.MSK_M1_KDF!==undefined) M1.KDF=ps.MSK_M1_KDF;
  if(ps.MSK_M1_KDM!==undefined) M1.KDM=ps.MSK_M1_KDM;
  if(ps.MSK_M1_KT!==undefined) M1.KT=ps.MSK_M1_KT;
  if(ps.MSK_M1_KRD!==undefined) M1.KRD=ps.MSK_M1_KRD;
  nPts=N_PTS;
  if(ps.MSK_V1!==undefined) V[0]=ps.MSK_V1;
  if(ps.MSK_V2!==undefined) V[1]=ps.MSK_V2;
  if(ps.MSK_V3!==undefined) V[2]=ps.MSK_V3;
  const YM={KS:'KS',KDF:'KDF',KDM:'KDM',KT:'KT',KRD:'KRD'};
  for(let[ck,pk] of Object.entries(YM)){
    let ys=[];
    for(let i=0;i<3;i++){
      let pn=`MSK_${pk}${i+1}`;
      ys.push(ps[pn]!==undefined?ps[pn]:(CV[ck].pts[0]?CV[ck].pts[0].y:0.5));
    }
    let pts=[{x:0,y:ys[0]}];
    for(let i=0;i<3;i++) pts.push({x:V[i],y:ys[i]});
    pts.push({x:MAX_SPEED,y:ys[2]});
    CV[ck]=mkCurve(pts);
  }
  // 控制参数
  if(ps.MSK_RAMP!==undefined) document.getElementById('i_rmp').value=ps.MSK_RAMP;
  if(ps.MSK_MODE_CH!==undefined) document.getElementById('i_mch').value=ps.MSK_MODE_CH;
  if(ps.MSK_GEAR_CH!==undefined) document.getElementById('i_gch').value=ps.MSK_GEAR_CH;
  if(ps.MSK_CHK_CH!==undefined) document.getElementById('i_cch').value=ps.MSK_CHK_CH;
  if(ps.MSK_CHK_PWM!==undefined) document.getElementById('i_ckp').value=ps.MSK_CHK_PWM;
  if(ps.MSK_CHK_STOP!==undefined) document.getElementById('i_cks').value=ps.MSK_CHK_STOP;
  if(ps.MSK_CHK_GRP_MS!==undefined) document.getElementById('i_ckg').value=ps.MSK_CHK_GRP_MS;
  if(ps.MSK_GPS_TAU!==undefined) document.getElementById('i_gtau').value=ps.MSK_GPS_TAU;
  if(ps.MSK_AUTO_CH!==undefined) document.getElementById('i_autoch').value=ps.MSK_AUTO_CH;
  if(ps.MSK_AUTO_TGT!==undefined) document.getElementById('i_autotgt').value=ps.MSK_AUTO_TGT;
  if(ps.MSK_AUTO_CUT!==undefined) document.getElementById('i_autocut').value=ps.MSK_AUTO_CUT;
  if(ps.MSK_WING_OFS!==undefined) document.getElementById('i_wofs').value=ps.MSK_WING_OFS;
  if(ps.MSK_PIT_LIM!==undefined) document.getElementById('i_plim').value=ps.MSK_PIT_LIM;
  if(ps.MSK_ROL_LIM!==undefined) document.getElementById('i_rlim').value=ps.MSK_ROL_LIM;
  if(ps.MSK_ATT_KP!==undefined) document.getElementById('i_atkp').value=ps.MSK_ATT_KP;
  if(ps.MSK_RC_LIM!==undefined) document.getElementById('i_rclim').value=ps.MSK_RC_LIM;
  // 倾转 (zero/dir model, 字段对齐 HTML 实际 ID)
  if(ps.MSK_TILT_SVL!==undefined) document.getElementById('i_tsvl').value=ps.MSK_TILT_SVL;
  if(ps.MSK_TILT_SVR!==undefined) document.getElementById('i_tsvr').value=ps.MSK_TILT_SVR;
  if(ps.MSK_TILT_L_ZERO!==undefined) document.getElementById('i_tlz').value=ps.MSK_TILT_L_ZERO;
  if(ps.MSK_TILT_L_DIR!==undefined) document.getElementById('i_tld').value=ps.MSK_TILT_L_DIR;
  if(ps.MSK_TILT_R_ZERO!==undefined) document.getElementById('i_trz').value=ps.MSK_TILT_R_ZERO;
  if(ps.MSK_TILT_R_DIR!==undefined) document.getElementById('i_trd').value=ps.MSK_TILT_R_DIR;
  if(ps.MSK_TILT_USPD!==undefined) document.getElementById('i_tuspd').value=ps.MSK_TILT_USPD;
  if(ps.MSK_TILT_TAU!==undefined) document.getElementById('i_ttau').value=ps.MSK_TILT_TAU;
  if(ps.MSK_TILT_CAL!==undefined) document.getElementById('i_tcal').value=ps.MSK_TILT_CAL;
  if(ps.MSK_TILT_DEG!==undefined) document.getElementById('i_tm').value=ps.MSK_TILT_DEG;
  if(ps.MSK_TILT_V1!==undefined) document.getElementById('i_tv1').value=ps.MSK_TILT_V1;
  if(ps.MSK_TILT_V2!==undefined) document.getElementById('i_tv2').value=ps.MSK_TILT_V2;
  if(ps.MSK_TILT_V3!==undefined) document.getElementById('i_tv3').value=ps.MSK_TILT_V3;
  // UI sync
  document.getElementById('m1_ks').value=M1.KS;document.getElementById('m1_kdf').value=M1.KDF;
  document.getElementById('m1_kdm').value=M1.KDM;document.getElementById('m1_kt').value=M1.KT;
  document.getElementById('m1_krd').value=M1.KRD;
  document.getElementById('i_v1').value=V[0];document.getElementById('i_v2').value=V[1];
  document.getElementById('i_v3').value=V[2];
  syncGearDropdown();redraw();
}

function readFromFC(){
  toast('定向读 62 个 MSK 参数 (USB ~2s, 数传 ~10s)...');
  fetch('/api/params/refetch').then(r=>r.json()).then(d=>{
    if(!d.ok){toast('refetch 失败: '+JSON.stringify(d));return;}
    const n = d.got || 0;
    const exp = d.expected || 62;
    if(n === 0){
      toast(`收到 0 个参数 (用时 ${d.elapsed}s)。检查: 飞控连接? SCR_ENABLE=1? Lua 加载成功?`);
      return;
    }
    applyParamsFromDict(d.params);
    if(n < exp){
      const miss = (d.missing||[]).slice(0,4).join(', ');
      toast(`⚠ 读 ${n}/${exp} 个 (用时 ${d.elapsed}s), 缺: ${miss}${d.missing.length>4?'...':''}`);
    } else {
      toast(`✓ 读 ${n}/${exp} 个 MSK 参数 (用时 ${d.elapsed}s)`);
    }
  }).catch(e=>toast('读取失败: '+e.message));
}

function getExportParams(){
  // 收集所有参数为 {name: value} dict, 复用 doExport 的逻辑
  let ps={};
  ps.MSK_M1_KS=parseFloat(document.getElementById('m1_ks').value);
  ps.MSK_M1_KDF=parseFloat(document.getElementById('m1_kdf').value);
  ps.MSK_M1_KDM=parseFloat(document.getElementById('m1_kdm').value);
  ps.MSK_M1_KT=parseFloat(document.getElementById('m1_kt').value);
  ps.MSK_M1_KRD=parseFloat(document.getElementById('m1_krd').value);
  ps.MSK_N_PTS=3;
  ps.MSK_V1=V[0]; ps.MSK_V2=V[1]; ps.MSK_V3=V[2];
  const YM={KS:'KS',KDF:'KDF',KDM:'KDM',KT:'KT',KRD:'KRD'};
  const EM={KS:'CS',KDF:'CDF',KDM:'CDM',KT:'CT',KRD:'CRD'};
  for(let[ck,pk] of Object.entries(YM)){
    let s=sampleForExport(ck);
    for(let i=0;i<3;i++) ps[`MSK_${pk}${i+1}`]=parseFloat(s.y[i].toFixed(4));
  }
  for(let[ck,pk] of Object.entries(EM)){
    let s=sampleForExport(ck);
    for(let i=0;i<2;i++) ps[`MSK_${pk}${i+1}`]=parseFloat(s.expo[i].toFixed(4));
  }
  ps.MSK_RAMP=parseFloat(document.getElementById('i_rmp').value);
  ps.MSK_MODE_CH=parseFloat(document.getElementById('i_mch').value);
  ps.MSK_GEAR_CH=parseFloat(document.getElementById('i_gch').value);
  ps.MSK_CHK_CH=parseFloat(document.getElementById('i_cch').value);
  ps.MSK_CHK_PWM=parseFloat(document.getElementById('i_ckp').value);
  ps.MSK_CHK_STOP=parseFloat(document.getElementById('i_cks').value);
  ps.MSK_CHK_GRP_MS=parseFloat(document.getElementById('i_ckg').value);
  ps.MSK_GPS_TAU=parseFloat(document.getElementById('i_gtau').value);
  ps.MSK_AUTO_CH=parseFloat(document.getElementById('i_autoch').value);
  ps.MSK_AUTO_TGT=parseFloat(document.getElementById('i_autotgt').value);
  ps.MSK_AUTO_CUT=parseFloat(document.getElementById('i_autocut').value);
  ps.MSK_WING_OFS=parseFloat(document.getElementById('i_wofs').value);
  ps.MSK_PIT_LIM=parseFloat(document.getElementById('i_plim').value);
  ps.MSK_ROL_LIM=parseFloat(document.getElementById('i_rlim').value);
  ps.MSK_ATT_KP=parseFloat(document.getElementById('i_atkp').value);
  ps.MSK_RC_LIM=parseFloat(document.getElementById('i_rclim').value);
  ps.MSK_TILT_SVL=parseFloat(document.getElementById('i_tsvl').value);
  ps.MSK_TILT_SVR=parseFloat(document.getElementById('i_tsvr').value);
  ps.MSK_TILT_L_ZERO=parseFloat(document.getElementById('i_tlz').value);
  ps.MSK_TILT_L_DIR=parseFloat(document.getElementById('i_tld').value);
  ps.MSK_TILT_R_ZERO=parseFloat(document.getElementById('i_trz').value);
  ps.MSK_TILT_R_DIR=parseFloat(document.getElementById('i_trd').value);
  ps.MSK_TILT_USPD=parseFloat(document.getElementById('i_tuspd').value);
  ps.MSK_TILT_DEG=parseFloat(document.getElementById('i_tm').value);
  ps.MSK_TILT_TAU=parseFloat(document.getElementById('i_ttau').value);
  ps.MSK_TILT_CAL=parseFloat(document.getElementById('i_tcal').value);
  ps.MSK_TILT_V1=parseFloat(document.getElementById('i_tv1').value);
  ps.MSK_TILT_V2=parseFloat(document.getElementById('i_tv2').value);
  ps.MSK_TILT_V3=parseFloat(document.getElementById('i_tv3').value);
  return ps;
}

// 舵机校准快捷按钮: 单独写 MSK_TILT_CAL 到飞控, 不依赖 writeToFC 的全量写
function calBtn(deg){
  document.getElementById('i_tcal').value=deg;
  fetch('/api/params/write',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({MSK_TILT_CAL: deg})
  }).then(r=>r.json()).then(d=>{
    if(d.ok){
      if(deg < 0) toast('已退出校准, 恢复正常运行');
      else toast(`校准: 舵机锁定在 ${deg}°, 看物理位置调 ZERO/DIR/USPD`);
    }
  }).catch(e=>toast('校准写入失败: '+e.message));
}

function writeToFC(){
  if(!confirm('确认将当前参数写入飞控? (立刻生效)')) return;
  let ps=getExportParams();
  toast(`写入 ${Object.keys(ps).length} 个参数...`);
  fetch('/api/params/write',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(ps)
  }).then(r=>r.json()).then(d=>{
    if(d.ok) toast(`已写入 ${d.queued} 个参数到飞控`);
    else toast('写入失败: '+JSON.stringify(d));
  }).catch(e=>toast('写入失败: '+e.message));
}

// ========== INIT ==========
syncGearDropdown();
if(!doLoad()){redraw();}
window.addEventListener('resize',redraw);
// 检测在线模式 (延迟 500ms 等 GCS 加载)
setTimeout(checkOnlineMode, 500);
</script>
</body>
</html>
"""


class GCSHTTPServer(HTTPServer):
    # Windows 下 SO_REUSEADDR 允许多进程绑同一端口, 导致请求路由到僵尸进程
    if sys.platform == 'win32':
        allow_reuse_address = False


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/state':
            with state_lock:
                data = json.dumps(state, ensure_ascii=False)
            self._json(data)

        elif self.path == '/api/params/msk':
            # 返回所有 MSK_ 参数 (从缓存)
            with state_lock:
                msk = {k: v for k, v in state["params"].items() if k.startswith("MSK_")}
                data = json.dumps({"ready": state["params_ready"], "params": msk})
            self._json(data)

        elif self.path == '/api/params/refetch':
            # 定向读 62 个 MSK 参数 (不拉整表), 轮询直到收齐或超时
            expected = set(MSK_PARAMS)
            with state_lock:
                # 清掉旧的 MSK_ 缓存, 强制重新采样 (区分本次是否收到)
                for name in MSK_PARAMS:
                    state["params"].pop(name, None)
                param_refetch_flag[0] = True
                param_read_queue.extend(MSK_PARAMS)
            # 轮询: 每 0.3s 看一次, 收齐或超时
            timeout_s = 30   # 定向读快得多, 30s 够
            poll_interval = 0.3
            last_count = 0
            stable_ticks = 0
            t0 = time.time()
            while time.time() - t0 < timeout_s:
                time.sleep(poll_interval)
                with state_lock:
                    got = sum(1 for n in MSK_PARAMS if n in state["params"])
                if got >= len(expected):
                    break
                # 稳定 2 秒不变也退出 (部分丢包)
                if got == last_count:
                    stable_ticks += 1
                    if stable_ticks >= 7 and got > 0:  # 7 * 0.3s ≈ 2.1s
                        # 自动 retry 一次丢包的
                        with state_lock:
                            missing = [n for n in MSK_PARAMS if n not in state["params"]]
                            if missing and stable_ticks < 15:
                                param_read_queue.extend(missing)
                                stable_ticks = 0
                                continue
                        break
                else:
                    stable_ticks = 0
                last_count = got
            elapsed = time.time() - t0
            with state_lock:
                msk = {k: v for k, v in state["params"].items() if k.startswith("MSK_")}
                missing = [n for n in MSK_PARAMS if n not in state["params"]]
                data = json.dumps({"ok": True, "elapsed": round(elapsed, 1),
                                   "expected": len(expected), "got": len(msk),
                                   "missing": missing,
                                   "params": msk})
            self._json(data)

        elif self.path == '/api/params/all':
            # 返回全部参数 (调试用)
            with state_lock:
                data = json.dumps({"ready": state["params_ready"],
                                   "count": len(state["params"]),
                                   "params": state["params"]})
            self._json(data)

        elif self.path == '/tuner':
            # 内嵌调参工具
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(TUNER_HTML.encode('utf-8'))

        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            with state_lock:
                init = json.dumps(state, ensure_ascii=False)
            html = HTML.replace('/*__INIT__*/', f'window.__INIT__={init};')
            self.wfile.write(html.encode('utf-8'))

    def do_POST(self):
        if self.path == '/api/params/write':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length).decode('utf-8')
            try:
                params = json.loads(body)  # {"MSK_V2": 8.0, "MSK_KT2": 0.85, ...}
            except json.JSONDecodeError:
                self._json('{"ok":false,"error":"invalid JSON"}', 400)
                return
            with state_lock:
                for name, value in params.items():
                    param_write_queue.append((name, float(value)))
            count = len(params)
            self._json(json.dumps({"ok": True, "queued": count}))
        else:
            self.send_response(404)
            self.end_headers()

    def _json(self, data, code=200):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(data.encode('utf-8') if isinstance(data, str) else data)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        pass


# ═══════════════════════════════════════════════════════════
# 串口扫描 + MAVProxy 管理
# ═══════════════════════════════════════════════════════════

def scan_serial_ports():
    """扫描可用串口, 返回 [(port, description), ...]. 过滤虚拟/无设备口."""
    try:
        from serial.tools import list_ports
        ports = []
        for p in sorted(list_ports.comports(), key=lambda x: x.device):
            # 过滤 Linux 虚拟 ttyS (没有真实硬件)
            if p.device.startswith('/dev/ttyS') and not p.manufacturer and p.description == 'n/a':
                continue
            desc = p.description or ""
            if p.manufacturer:
                desc += f" ({p.manufacturer})"
            ports.append((p.device, desc.strip()))
        return ports
    except ImportError:
        return []


def find_free_port(start=14551, tries=20):
    """从 start 开始找一个空闲的 UDP 端口"""
    for p in range(start, start + tries):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.bind(('0.0.0.0', p))
            s.close()
            return p
        except OSError:
            continue
    return start  # fallback


def find_mavproxy():
    """查找 MAVProxy 可执行路径 (Windows/Linux 通用)
    优先级:
      1. msk_gcs.exe 同目录的 mavproxy.exe (PyInstaller 打包场景)
      2. venv (开发环境)
      3. Python 解释器 Scripts 目录
      4. PATH
    """
    import shutil
    try:
        here = os.path.dirname(os.path.abspath(__file__))
    except NameError:
        here = os.getcwd()

    candidates = []

    # 1. sys.executable 同目录 (PyInstaller 场景: msk_gcs.exe 和 mavproxy.exe 放一起)
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    if sys.platform == 'win32':
        candidates += [os.path.join(exe_dir, 'mavproxy.exe')]
    else:
        candidates += [os.path.join(exe_dir, 'mavproxy')]

    # 2. MSK_GCS 源码场景: venv
    project = os.path.dirname(os.path.dirname(here))
    if sys.platform == 'win32':
        candidates += [
            os.path.join(project, 'sim', '.venv', 'Scripts', 'mavproxy.exe'),
            os.path.join(project, 'sim', '.venv', 'Scripts', 'mavproxy.py'),
            os.path.join(exe_dir, 'Scripts', 'mavproxy.exe'),
        ]
    else:
        candidates += [
            os.path.join(project, 'sim', '.venv', 'bin', 'mavproxy.py'),
            os.path.join(project, 'sim', '.venv', 'bin', 'mavproxy'),
        ]

    print(f"[MP FIND] sys.executable: {sys.executable}")
    print(f"[MP FIND] exe_dir: {exe_dir}")
    print(f"[MP FIND] 检查候选 ({len(candidates)}):")
    for c in candidates:
        exists = os.path.isfile(c)
        print(f"[MP FIND]   {'[OK]' if exists else '[NO]'} {c}")
        if exists:
            return c

    # 3. PATH
    for name in ['mavproxy.py', 'mavproxy.exe', 'mavproxy']:
        found = shutil.which(name)
        if found:
            print(f"[MP FIND] PATH 找到: {found}")
            return found
    print(f"[MP FIND] PATH 查找 ['mavproxy.py','mavproxy.exe','mavproxy'] 都失败")
    return None


mavproxy_proc = None


def mavproxy_healthcheck(exe):
    """跑 mavproxy --help 确认没有 ImportError / 缺依赖. PyInstaller 打包首次解压 + 导入很慢 → 60s 超时.
    完整打印 stdout/stderr/returncode 方便排查."""
    print(f"[MP HEALTHCHECK] 路径: {exe}")
    print(f"[MP HEALTHCHECK] 文件存在: {os.path.isfile(exe)}, 大小: {os.path.getsize(exe) if os.path.isfile(exe) else 'N/A'}")
    try:
        if exe.endswith('.py'):
            cmd = [sys.executable, exe, '--help']
        else:
            cmd = [exe, '--help']
        print(f"[MP HEALTHCHECK] 执行: {' '.join(cmd)}")
        t0 = time.time()
        r = subprocess.run(cmd, capture_output=True, timeout=60, text=True, errors='ignore')
        dt = time.time() - t0
        print(f"[MP HEALTHCHECK] 用时 {dt:.1f}s  returncode={r.returncode}")
        stdout = (r.stdout or '').strip()
        stderr = (r.stderr or '').strip()
        if stdout:
            print(f"[MP HEALTHCHECK] --- stdout (前 500 字符) ---")
            print(stdout[:500])
        if stderr:
            print(f"[MP HEALTHCHECK] --- stderr (前 800 字符) ---")
            print(stderr[:800])
        combined = stdout + '\n' + stderr
        if 'ModuleNotFoundError' in combined or 'No module named' in combined:
            # 挑出第一行 ModuleNotFound
            for line in combined.split('\n'):
                if 'ModuleNotFoundError' in line or 'No module named' in line:
                    return False, line.strip()
            return False, 'ModuleNotFoundError (详见上方输出)'
        if r.returncode != 0 and not stdout.lower().startswith('usage'):
            return False, f'returncode={r.returncode}'
        return True, None
    except subprocess.TimeoutExpired as e:
        print(f"[MP HEALTHCHECK] TIMEOUT 60s")
        # 打印超时前已拿到的输出
        if e.stdout:
            out = e.stdout.decode('utf-8', errors='ignore') if isinstance(e.stdout, bytes) else e.stdout
            print(f"[MP HEALTHCHECK] 超时前 stdout: {out[:500]}")
        if e.stderr:
            err = e.stderr.decode('utf-8', errors='ignore') if isinstance(e.stderr, bytes) else e.stderr
            print(f"[MP HEALTHCHECK] 超时前 stderr: {err[:500]}")
        return False, 'healthcheck timeout (60s). 可能是 PyInstaller 首次解压慢, 或 mavproxy 在等 stdin. 详见上方输出.'
    except Exception as e:
        print(f"[MP HEALTHCHECK] EXCEPTION: {type(e).__name__}: {e}")
        return False, f'{type(e).__name__}: {e}'


def start_mavproxy(serial_port, baudrate, mp_port, gcs_port):
    """启动 MAVProxy 子进程做端口分发"""
    global mavproxy_proc
    exe = find_mavproxy()
    if not exe:
        print("[!] MAVProxy 未找到。请安装: pip install MAVProxy")
        print(f"[!] 或手动启动 MAVProxy 后用 --master=udpin:0.0.0.0:{gcs_port} 重新运行本工具")
        return None

    # 预飞检查: 跑 --help 看依赖齐不齐
    ok, err = mavproxy_healthcheck(exe)
    if not ok:
        print(f"[!] MAVProxy 不可用: {err}")
        print("[!] 原因一般是打包时缺 prompt_toolkit 等依赖")
        return None

    cmd = [
        sys.executable if exe.endswith('.py') else exe,
    ]
    if exe.endswith('.py'):
        cmd = [sys.executable, exe]
    else:
        cmd = [exe]

    cmd += [
        f'--master={serial_port}',
        f'--baudrate={baudrate}',
        f'--out=udp:127.0.0.1:{mp_port}',
        f'--out=udp:127.0.0.1:{gcs_port}',
        '--daemon',
    ]

    print(f"[MAVProxy] 启动: {' '.join(cmd)}")
    try:
        kwargs = {}
        if sys.platform == 'win32':
            # CREATE_NEW_CONSOLE: MAVProxy 的 prompt_toolkit 需要真实控制台
            # 不能重定向 stdout/stderr, 否则 NoConsoleScreenBufferError
            kwargs['creationflags'] = subprocess.CREATE_NEW_CONSOLE
            env = os.environ.copy()
            env.pop('TERM', None)  # 移除 TERM 避免 prompt_toolkit 问题
            kwargs['env'] = env
            mavproxy_proc = subprocess.Popen(cmd, **kwargs)
        else:
            kwargs['preexec_fn'] = os.setsid
            mavproxy_proc = subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
        time.sleep(2)  # 等 MAVProxy 启动
        if mavproxy_proc.poll() is not None:
            print("[!] MAVProxy 启动失败")
            return None
        print(f"[MAVProxy] PID={mavproxy_proc.pid}")
        return mavproxy_proc
    except Exception as e:
        print(f"[!] MAVProxy 启动异常: {e}")
        return None


def stop_mavproxy():
    global mavproxy_proc
    if mavproxy_proc and mavproxy_proc.poll() is None:
        print("[MAVProxy] 关闭...")
        try:
            mavproxy_proc.terminate()
            mavproxy_proc.wait(timeout=5)
        except Exception:
            pass
        try:
            if mavproxy_proc.poll() is None:
                mavproxy_proc.kill()
                mavproxy_proc.wait(timeout=3)
        except Exception:
            pass
        mavproxy_proc = None


def interactive_setup():
    """交互式扫描串口、选择、配置端口, 返回 (master_str, baudrate, mp_port_or_None)"""
    print()
    print("  ╔══════════════════════════════════════╗")
    print("  ║     MantaShark 专用地面站  v1.0      ║")
    print("  ╚══════════════════════════════════════╝")
    print()

    # 扫描串口
    ports = scan_serial_ports()
    if ports:
        print("  扫描到以下串口:")
        for i, (dev, desc) in enumerate(ports):
            print(f"    [{i+1}] {dev}  {desc}")
    else:
        print("  未扫描到串口 (pyserial 未安装 或 无设备)")
    print(f"    [0] 手动输入连接串 (如 udp:14551, tcp:192.168.1.10:5760)")
    print()

    choice = input(f"  请选择 [{'1' if ports else '0'}]: ").strip()
    if not choice:
        choice = '1' if ports else '0'

    baudrate = 115200
    mp_port = None  # None = 不需要 MAVProxy (直连)

    if choice == '0':
        master = input("  输入连接串: ").strip()
        if not master:
            master = 'udpin:0.0.0.0:14551'
        return master, baudrate, None

    try:
        idx = int(choice) - 1
        if 0 <= idx < len(ports):
            serial_port = ports[idx][0]
        else:
            print(f"  [!] 无效选择, 使用第一个串口")
            serial_port = ports[0][0]
    except ValueError:
        # 可能直接输入了串口名或连接串
        serial_port = choice

    # 波特率
    br = input(f"  波特率 [{baudrate}]: ").strip()
    if br:
        baudrate = int(br)

    # 问要不要同时跑 MAVProxy (默认不跑 - MP 能独立连串口)
    use_mp = input("  启动 MAVProxy 让 Mission Planner 并行? [y/N]: ").strip().lower()
    if use_mp != 'y':
        print()
        print(f"  直连串口: {serial_port} @ {baudrate}")
        print()
        return serial_port, baudrate, None

    # MP 端口
    mp_default = 14550
    mp = input(f"  Mission Planner UDP 端口 [{mp_default}]: ").strip()
    mp_port = int(mp) if mp else mp_default
    gcs_port = find_free_port(mp_port + 1)

    print()
    print(f"  串口:     {serial_port} @ {baudrate}")
    print(f"  MP 端口:  udp:127.0.0.1:{mp_port}")
    print(f"  GCS 端口: udp:127.0.0.1:{gcs_port} (自动分配)")
    print()

    # 启动 MAVProxy
    proc = start_mavproxy(serial_port, baudrate, mp_port, gcs_port)
    if not proc:
        print("  [!] MAVProxy 启动失败, 降级直连串口 (MP 无法同时使用)")
        return serial_port, baudrate, None

    master = f'udpin:0.0.0.0:{gcs_port}'
    return master, baudrate, mp_port


def main():
    parser = argparse.ArgumentParser(
        description='MantaShark 专用地面站',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python msk_gcs.py                    交互式 (自动扫描串口 + MAVProxy)
  python msk_gcs.py --master=COM3      直连串口 (不启动 MAVProxy)
  python msk_gcs.py --master=udpin:0.0.0.0:14551  连已有的 MAVProxy
""")
    parser.add_argument('--master', default=None,
                        help='MAVLink 连接串 (不指定则交互式扫描)')
    parser.add_argument('--baudrate', type=int, default=115200)
    parser.add_argument('--port', type=int, default=9088,
                        help='Web 端口 (default: 9088, 被占自动找下一个)')
    args = parser.parse_args()

    mp_port = None
    if args.master:
        # 直连模式: 跳过 MAVProxy
        master = args.master
        baudrate = args.baudrate
    else:
        # 交互模式: 扫描 → 选择 → MAVProxy
        master, baudrate, mp_port = interactive_setup()

    # 退出时清理 MAVProxy
    import atexit
    atexit.register(stop_mavproxy)

    # MAVLink 线程
    t = threading.Thread(target=mavlink_thread, args=(master, baudrate), daemon=True)
    t.start()

    # HTTP 服务 (端口被占则自动向后找)
    server = None
    for p in range(args.port, args.port + 20):
        try:
            server = GCSHTTPServer(('127.0.0.1', p), Handler)
            args.port = p
            break
        except OSError:
            continue
    if server is None:
        print(f"[!] 端口 {args.port}-{args.port+19} 全部被占, 退出")
        sys.exit(1)
    print()
    print(f"  ┌────────────────────────────────────────┐")
    print(f"  │  MantaShark GCS → http://localhost:{args.port} │")
    print(f"  │  MAVLink: {master:<29}│")
    if mp_port:
        print(f"  │  MP 请连: udp:127.0.0.1:{mp_port:<14}│")
    print(f"  │  Ctrl+C 退出 (自动关闭 MAVProxy)      │")
    print(f"  └────────────────────────────────────────┘")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[STOP] 正在关闭...")
        server.server_close()
        stop_mavproxy()
        print("[DONE]")


if __name__ == '__main__':
    main()
