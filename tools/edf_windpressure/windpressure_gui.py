#!/usr/bin/env python3
"""涵道风压/流速台架 GUI 上位机 (配 edf_windpressure.lua).

功能:
  - 连接 FC (串口下拉自动枚举)
  - 选电机 / 目标油门 / hold 秒 / 上升&下降 ramp / 喷口面积 / 空气密度
  - 差压传感器静置归零 (实时显示 offset)
  - 单点测试 或 多油门自动扫描 (一次跑出油门-压差/流速/盘载曲线)
  - 实时大字读数: 压差 / 流速 / 盘载 / 油门 / 状态 / 电池
  - 嵌入实时曲线 (压差 + 油门 vs 时间)
  - 扫描结果表 (每个油门点的 HOLD 稳态: 压差/流速/盘载/流量/功率)
  - 自动导出 CSV
  - 安全: 启动确认 + Abort 急停 + 关窗自动停电机

数据: 原始 SCALED_PRESSURE.press_diff (不信飞控 airspeed), V=sqrt(2q/rho), 盘载=rho*V^2.

依赖: pymavlink, pyserial, matplotlib(TkAgg), python3-pil.imagetk
"""
from __future__ import annotations
import collections
import csv
import math
import os
import queue
import threading
import time
from datetime import datetime

import matplotlib
matplotlib.use('TkAgg')
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure

import tkinter as tk
from tkinter import ttk, messagebox

from pymavlink import mavutil
from serial.tools import list_ports

# 复用 CLI 的纯函数
from windpressure_pc import parse_throttle, nv_name

# motor 号 → 名 (CLAUDE.md: SERVO1-12)
MOTOR_NAMES = {1: 'SL1', 2: 'SL2', 3: 'SR1', 4: 'SR2', 5: 'DFL', 6: 'DFR',
               7: 'TL1', 8: 'TL2', 9: 'TR1', 10: 'TR2', 11: 'RDL', 12: 'RDR'}
STATE_NAME = {0: 'IDLE', 1: 'RAMP_UP', 2: 'HOLD', 3: 'RAMP_DN', 4: 'DONE'}


# ───────────────────────── 后台 MAVLink 线程 ─────────────────────────
class FCWorker(threading.Thread):
    """所有 MAVLink I/O 在本线程; GUI 通过命令队列 + 共享状态(加锁)交互。"""

    def __init__(self):
        super().__init__(daemon=True)
        self.master = None
        self._sys = self._comp = 0
        self._stop = threading.Event()
        self._cmd = queue.Queue()
        self.lock = threading.Lock()

        # ---- 共享状态 (加锁读写) ----
        self.connected = False
        self.conn_state = 'disconnected'    # disconnected / connected / lost
        self.busy = 'idle'                  # idle / zeroing / testing
        self.offset = 0.0
        self.rho = 1.20
        self.area_m2 = 0.0
        self.live = dict(press=0.0, vel=0.0, dl=0.0, thr=0.0, state=0, bv=0.0, ba=0.0, temp=0.0)
        self.plot = collections.deque(maxlen=3000)   # (t, press_pa, thr_pct)
        self.status = collections.deque(maxlen=300)
        self.summary = None                 # 测试完成后的逐点统计 list
        self.summary_new = False
        self.csv_path = None

        # ---- 内部 ----
        self._last_rx = 0.0                  # 最后收到消息时刻 (失联检测)
        self.recording = False
        self.rec = []
        self.rec_t0 = 0.0
        self._cur_sp = 0                     # 当前 setpoint (%)
        self._mode = 'idle'
        self._zero_until = 0.0
        self._zero_samples = []
        self._cfg = None
        self._ts = []
        self._ts_i = 0
        self._ts_phase = 'gap'
        self._ts_phase_t0 = 0.0
        self._ts_deadline = 0.0
        self._ts_armed_seen = False

    # ---------- 供 GUI 调用 (线程安全, 仅入队) ----------
    def cmd_connect(self, port, baud): self._cmd.put(('connect', port, baud))
    def cmd_disconnect(self):          self._cmd.put(('disconnect',))
    def cmd_zero(self, secs):          self._cmd.put(('zero', secs))
    def cmd_start(self, cfg):          self._cmd.put(('start', cfg))
    def cmd_abort(self):               self._cmd.put(('abort',))
    def shutdown(self):                self._stop.set()

    def snap(self):
        with self.lock:
            return dict(connected=self.connected, conn_state=self.conn_state,
                        busy=self.busy, offset=self.offset,
                        live=dict(self.live), plot=list(self.plot),
                        status=list(self.status),
                        summary=self.summary, summary_new=self.summary_new,
                        csv_path=self.csv_path)

    def clear_summary_flag(self):
        with self.lock:
            self.summary_new = False

    # ---------- 线程主循环 ----------
    def run(self):
        last_hb = 0.0
        while not self._stop.is_set():
            try:
                cmd = self._cmd.get_nowait()
            except queue.Empty:
                cmd = None
            if cmd:
                self._handle_cmd(cmd)

            if self.master is None:
                time.sleep(0.05)
                continue

            now = time.time()
            if now - last_hb > 2.0:
                try:
                    self.master.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_GCS,
                                                    mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)
                except Exception as e:
                    self._link_lost(f'心跳发送失败: {e}'); continue
                last_hb = now

            if self._mode == 'zero':
                self._tick_zero(now)
            elif self._mode == 'test':
                self._tick_test(now)

            try:
                msg = self.master.recv_match(blocking=True, timeout=0.02)
                if msg:
                    self._last_rx = now
                    self._on_msg(msg, now)
                    while True:                   # drain backlog (别单 pop)
                        m2 = self.master.recv_match(blocking=False)
                        if not m2:
                            break
                        self._on_msg(m2, now)
            except Exception as e:
                self._link_lost(f'接收异常: {e}'); continue

            # 失联检测: >5s 收不到任何消息 (拔线/重启/挂死)
            if self._last_rx and now - self._last_rx > 5.0:
                self._link_lost('5s 无数据 (FC 断开/重启?)'); continue

        # 退出: 停电机
        if self.master is not None:
            self._send('WPT_SW_ARM', 0)
            self._send('WPT_EN', 0)
            try:
                self.master.close()
            except Exception:
                pass

    # ---------- 命令处理 ----------
    def _handle_cmd(self, cmd):
        name = cmd[0]
        if name == 'connect':
            self._do_connect(cmd[1], cmd[2])
        elif name == 'zero':
            if self.connected and self._mode == 'idle':
                self._zero_samples = []
                self._zero_until = time.time() + cmd[1]
                self._mode = 'zero'
                with self.lock:
                    self.busy = 'zeroing'
                self._push('归零中 (别给气流)...')
        elif name == 'start':
            if self.connected and self._mode == 'idle':
                self._begin_test(cmd[1])
        elif name == 'disconnect':
            self._do_disconnect()
        elif name == 'abort':
            self._abort()

    def _do_connect(self, port, baud):
        try:
            self.master = mavutil.mavlink_connection(port, baud=baud, dialect='ardupilotmega')
            if not self.master.wait_heartbeat(timeout=8):
                self.master = None
                with self.lock:
                    self.conn_state = 'disconnected'
                self._push('❌ 无 heartbeat')
                return
            self._sys = self.master.target_system
            self._comp = self.master.target_component
            self.master.mav.request_data_stream_send(self._sys, self._comp,
                                                      mavutil.mavlink.MAV_DATA_STREAM_ALL, 20, 1)
            try:
                self.master.mav.command_long_send(self._sys, self._comp,
                    mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0, 29, 20000, 0, 0, 0, 0, 0)
            except Exception:
                pass
            self._last_rx = time.time()
            with self.lock:
                self.connected = True
                self.conn_state = 'connected'
            self._push(f'✓ 连接 sys={self._sys}')
        except Exception as e:
            self.master = None
            with self.lock:
                self.conn_state = 'disconnected'
            self._push(f'❌ 连接失败: {e}')

    def _send(self, name, val):
        if self.master is None:
            return
        pid = name.encode('ascii').ljust(16, b'\x00')[:16]
        try:
            for _ in range(2):
                self.master.mav.param_set_send(self._sys, self._comp, pid,
                                               float(val), mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
        except Exception as e:
            self._push(f'发送失败 ({name}): {e}')

    def _do_disconnect(self):
        """主动断开: 先停电机, 再关串口。"""
        self.recording = False
        self._mode = 'idle'
        self._send('WPT_SW_ARM', 0)
        self._send('WPT_EN', 0)
        try:
            if self.master:
                self.master.close()
        except Exception:
            pass
        self.master = None
        self._last_rx = 0.0
        with self.lock:
            self.connected = False
            self.conn_state = 'disconnected'
            self.busy = 'idle'
        self._push('已断开连接')

    def _link_lost(self, why):
        """被动断线 (异常/失联): 不再尝试发送, 标记 lost。"""
        was = self.connected
        self.recording = False
        self._mode = 'idle'
        try:
            if self.master:
                self.master.close()
        except Exception:
            pass
        self.master = None
        self._last_rx = 0.0
        with self.lock:
            self.connected = False
            self.conn_state = 'lost'
            self.busy = 'idle'
        if was:
            self._push(f'⚠ 连接丢失: {why}')

    def _push(self, text):
        with self.lock:
            self.status.append((time.time(), text))

    # ---------- 消息 ----------
    def _on_msg(self, msg, now):
        t = msg.get_type()
        if t == 'SCALED_PRESSURE':
            q = msg.press_diff * 100.0 - self.offset
            qc = max(q, 0.0)
            vel = math.sqrt(2 * qc / self.rho)
            dl = self.rho * vel * vel
            temp = msg.temperature / 100.0
            with self.lock:
                self.live['press'] = q
                self.live['vel'] = vel
                self.live['dl'] = dl
                self.live['temp'] = temp
                thr = self.live['thr']
                self.plot.append((now, q, thr * 100.0))
                if self.recording:
                    self.rec.append(dict(
                        t_s=round(now - self.rec_t0, 4), setpoint_pct=self._cur_sp,
                        thr_cmd=round(thr, 4), state=self.live['state'],
                        press_diff_pa=round(q, 2), vel_ms=round(vel, 3),
                        disk_load_Nm2=round(dl, 1),
                        flow_m3s=round(vel * self.area_m2, 4) if self.area_m2 > 0 else 0.0,
                        batt_v=round(self.live['bv'], 2), batt_a=round(self.live['ba'], 2),
                        sensor_temp_c=round(temp, 1)))
            if self._mode == 'zero':
                self._zero_samples.append(msg.press_diff * 100.0)
        elif t == 'NAMED_VALUE_FLOAT':
            nm = nv_name(msg)
            with self.lock:
                if nm == 'WTHR':
                    self.live['thr'] = msg.value
                elif nm == 'WST':
                    self.live['state'] = int(round(msg.value))
        elif t == 'BATTERY_STATUS':
            v = list(getattr(msg, 'voltages', [0]))[0]
            c = getattr(msg, 'current_battery', 0)
            with self.lock:
                if v and v != 65535:
                    self.live['bv'] = v / 1000.0
                if c and c > 0:
                    self.live['ba'] = c / 100.0
        elif t == 'SYS_STATUS':
            v = getattr(msg, 'voltage_battery', 0)
            c = getattr(msg, 'current_battery', 0)
            with self.lock:
                if v and self.live['bv'] == 0:
                    self.live['bv'] = v / 1000.0
                if c and c > 0 and self.live['ba'] == 0:
                    self.live['ba'] = c / 100.0
        elif t == 'STATUSTEXT':
            txt = getattr(msg, 'text', '')
            if txt:
                self._push(txt)

    # ---------- 归零 ----------
    def _tick_zero(self, now):
        if now >= self._zero_until:
            s = self._zero_samples
            off = sum(s) / len(s) if s else 0.0
            with self.lock:
                self.offset = off
                self.busy = 'idle'
            self._mode = 'idle'
            self._push(f'零点 offset = {off:+.2f} Pa (n={len(s)})')

    # ---------- 测试 ----------
    def _begin_test(self, cfg):
        self._cfg = cfg
        with self.lock:
            self.area_m2 = cfg['area_m2']
            self.rho = cfg['rho']
            self.summary = None
        self._send('WPT_SW_ARM', 0)
        self._send('WPT_MOTOR_MSK', cfg['mask'])
        self._send('WPT_HOLD_S', cfg['hold_s'])
        self._send('WPT_RAMP_UP', cfg['ramp_up'])
        self._send('WPT_RAMP_DN', cfg['ramp_dn'])
        self._send('WPT_EN', 1)
        self.rec = []
        self.rec_t0 = time.time()
        self.recording = True
        self._ts = cfg['setpoints']
        self._ts_i = 0
        self._ts_phase = 'gap'
        self._ts_phase_t0 = time.time()
        self._ts_results = []
        self._mode = 'test'
        with self.lock:
            self.busy = 'testing'
        n = len(self._ts)
        self._push(f'测试开始: {n} 个油门点 {[round(x*100) for x in self._ts]}%')

    def _tick_test(self, now):
        cfg = self._cfg
        gap = 1.2
        if self._ts_phase == 'gap':
            if now - self._ts_phase_t0 >= gap:
                if self._ts_i >= len(self._ts):
                    self._finish_test(now)
                    return
                sp = self._ts[self._ts_i]
                self._cur_sp = round(sp * 100)
                self._send('WPT_THR_TGT', sp)
                self._send('WPT_SW_ARM', 1)
                self._ts_phase = 'wait'
                self._ts_phase_t0 = now
                self._ts_armed_seen = False
                self._ts_deadline = now + cfg['ramp_up'] / 1000.0 + cfg['hold_s'] + cfg['ramp_dn'] / 1000.0 + 3.0
                self._push(f'  → 油门 {self._cur_sp}%')
        elif self._ts_phase == 'wait':
            st = self.live['state']
            if st in (1, 2, 3):
                self._ts_armed_seen = True
            if not self._ts_armed_seen and now - self._ts_phase_t0 > 1.5:
                self._send('WPT_SW_ARM', 1)        # 触发重试
            if (self._ts_armed_seen and st in (0, 4)) or now > self._ts_deadline:
                self._send('WPT_SW_ARM', 0)
                self._collect_seg(self._cur_sp)
                self._ts_i += 1
                self._ts_phase = 'gap'
                self._ts_phase_t0 = now

    def _collect_seg(self, sp_pct):
        rows = [r for r in self.rec if r['setpoint_pct'] == sp_pct and r['state'] == 2]
        if not rows:
            self._ts_results.append(dict(sp=sp_pct, n=0))
            return
        pds = [r['press_diff_pa'] for r in rows]
        vs = [r['vel_ms'] for r in rows]
        bv = [r['batt_v'] for r in rows if r['batt_v'] > 0]
        ba = [r['batt_a'] for r in rows if r['batt_a'] > 0]
        mp = sum(pds) / len(pds)
        mv = sum(vs) / len(vs)
        res = dict(sp=sp_pct, n=len(rows),
                   press=mp, press_max=max(pds), vel=mv,
                   dl=self.rho * mv * mv,
                   Q=(mv * self.area_m2) if self.area_m2 > 0 else 0.0,
                   bv=(sum(bv) / len(bv)) if bv else 0.0,
                   ba=(sum(ba) / len(ba)) if ba else 0.0)
        res['power'] = res['bv'] * res['ba']
        self._ts_results.append(res)
        self._push(f'    {sp_pct}%: 压差{mp:.0f}Pa 流速{mv:.1f}m/s 盘载{res["dl"]:.0f}N/m²')

    def _finish_test(self, now):
        self.recording = False
        self._send('WPT_SW_ARM', 0)
        self._send('WPT_EN', 0)
        self._mode = 'idle'
        path = self._write_csv()
        with self.lock:
            self.busy = 'idle'
            self.summary = list(self._ts_results)
            self.summary_new = True
            self.csv_path = path
        self._push(f'✓ 测试完成, CSV: {os.path.basename(path) if path else "?"}')

    def _write_csv(self):
        if not self.rec:
            return None
        logs = os.path.join(os.path.dirname(__file__), 'logs')
        os.makedirs(logs, exist_ok=True)
        stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        sps = '-'.join(str(round(x * 100)) for x in self._ts)
        path = os.path.join(logs, f'wp_{stamp}_thr{sps}.csv')
        with open(path, 'w', newline='') as f:
            f.write(f'# edf_windpressure GUI {datetime.now().isoformat()}\n')
            f.write(f'# mask={self._cfg["mask"]} hold_s={self._cfg["hold_s"]} '
                    f'ramp_up_ms={self._cfg["ramp_up"]} ramp_dn_ms={self._cfg["ramp_dn"]}\n')
            f.write(f'# rho={self.rho} zero_offset_pa={self.offset:.3f} area_cm2={self.area_m2*1e4:.2f}\n')
            f.write('# vel=sqrt(2*q/rho) disk_load=rho*vel^2 flow=vel*area\n')
            w = csv.DictWriter(f, fieldnames=list(self.rec[0].keys()))
            w.writeheader()
            w.writerows(self.rec)
        return path

    def _abort(self):
        self.recording = False
        self._mode = 'idle'
        self._send('WPT_SW_ARM', 0)
        self._send('WPT_EN', 0)
        with self.lock:
            self.busy = 'idle'
        self._push('⚠ ABORT - 电机已停')


# ───────────────────────── GUI ─────────────────────────
class App:
    def __init__(self, root):
        self.root = root
        self.fc = FCWorker()
        self.fc.start()
        self.motor_vars = {}
        root.title('涵道风压 / 流速 台架 — windpressure GUI')
        root.protocol('WM_DELETE_WINDOW', self._on_close)
        self._build()
        self._refresh()

    def _build(self):
        # ---- 顶部连接栏 ----
        top = ttk.Frame(self.root, padding=6)
        top.pack(side='top', fill='x')
        ttk.Label(top, text='串口:').pack(side='left')
        self.port_cb = ttk.Combobox(top, width=18, values=self._ports())
        acm = [p for p in self._ports() if 'ACM' in p]
        self.port_cb.set(acm[0] if acm else (self._ports()[0] if self._ports() else ''))
        self.port_cb.pack(side='left', padx=3)
        ttk.Button(top, text='⟳', width=3, command=lambda: self.port_cb.config(values=self._ports())).pack(side='left')
        ttk.Label(top, text='波特:').pack(side='left', padx=(8, 0))
        self.baud_e = ttk.Entry(top, width=8); self.baud_e.insert(0, '115200'); self.baud_e.pack(side='left', padx=3)
        self.conn_btn = ttk.Button(top, text='连接', command=self._toggle_conn); self.conn_btn.pack(side='left', padx=6)
        self.conn_lbl = ttk.Label(top, text='● 未连接', foreground='gray'); self.conn_lbl.pack(side='left', padx=6)

        body = ttk.Frame(self.root, padding=6); body.pack(side='top', fill='both', expand=True)

        # ---- 左: 配置 ----
        left = ttk.LabelFrame(body, text='测试配置', padding=8); left.pack(side='left', fill='y')

        mf = ttk.LabelFrame(left, text='电机 (勾选要跑的)', padding=4); mf.pack(fill='x', pady=3)
        for i in range(1, 13):
            v = tk.BooleanVar(value=(i == 5))
            self.motor_vars[i] = v
            r, c = divmod(i - 1, 3)
            ttk.Checkbutton(mf, text=f'{i} {MOTOR_NAMES[i]}', variable=v).grid(row=r, column=c, sticky='w', padx=2)

        gf = ttk.Frame(left); gf.pack(fill='x', pady=4)
        self._row(gf, 0, 'Hold 秒:', 'hold_e', '5')
        self._row(gf, 1, '上升 ramp ms:', 'rampup_e', '2500')
        self._row(gf, 2, '下降 ramp ms:', 'rampdn_e', '1500')
        self._row(gf, 3, '喷口面积 cm²:', 'area_e', '0')
        self._row(gf, 4, '空气密度 ρ:', 'rho_e', '1.20')

        # 油门
        tf = ttk.LabelFrame(left, text='油门', padding=4); tf.pack(fill='x', pady=4)
        self.sweep_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(tf, text='扫描模式 (多点)', variable=self.sweep_var, command=self._toggle_sweep).pack(anchor='w')
        sgl = ttk.Frame(tf); sgl.pack(fill='x')
        self.thr_scale = tk.Scale(sgl, from_=0, to=100, orient='horizontal', length=180,
                                  label='单点油门 %', command=lambda e: None)
        self.thr_scale.set(50); self.thr_scale.pack(side='left')
        self.sweep_lbl = ttk.Label(tf, text='扫描列表 %:')
        self.sweep_e = ttk.Entry(tf, width=24); self.sweep_e.insert(0, '30,40,50,60,70,80')

        # 归零 + 启停
        zf = ttk.Frame(left); zf.pack(fill='x', pady=6)
        ttk.Button(zf, text='归零 (3s)', command=self._zero).pack(side='left')
        self.off_lbl = ttk.Label(zf, text='offset: -- Pa'); self.off_lbl.pack(side='left', padx=6)

        bf = ttk.Frame(left); bf.pack(fill='x', pady=4)
        self.start_btn = ttk.Button(bf, text='▶ 开始测试', command=self._start); self.start_btn.pack(side='left')
        self.abort_btn = ttk.Button(bf, text='■ 急停 Abort', command=self.fc.cmd_abort); self.abort_btn.pack(side='left', padx=6)

        # ---- 右: 实时 ----
        right = ttk.Frame(body, padding=4); right.pack(side='left', fill='both', expand=True)

        rd = ttk.LabelFrame(right, text='实时', padding=6); rd.pack(fill='x')
        self.big = {}
        cells = [('press', '压差 Pa'), ('vel', '流速 m/s'), ('dl', '盘载 N/m²'),
                 ('thr', '油门 %'), ('state', '状态'), ('batt', '电池')]
        for idx, (k, lab) in enumerate(cells):
            f = ttk.Frame(rd); f.grid(row=0, column=idx, padx=8)
            ttk.Label(f, text=lab, foreground='gray').pack()
            l = ttk.Label(f, text='--', font=('TkDefaultFont', 16, 'bold')); l.pack()
            self.big[k] = l

        # 曲线
        self.fig = Figure(figsize=(6, 2.6), dpi=90)
        self.ax1 = self.fig.add_subplot(111)
        self.ax2 = self.ax1.twinx()
        self.ax1.set_xlabel('t (s)'); self.ax1.set_ylabel('Press (Pa)', color='tab:blue')
        self.ax2.set_ylabel('Throttle (%)', color='tab:orange'); self.ax2.set_ylim(0, 100)
        self.fig.tight_layout()
        self.canvas = FigureCanvasTkAgg(self.fig, master=right)
        self.canvas.get_tk_widget().pack(fill='both', expand=True, pady=4)

        # 结果表
        resf = ttk.LabelFrame(right, text='扫描结果 (HOLD 稳态)', padding=4); resf.pack(fill='x')
        cols = ('sp', 'press', 'vel', 'dl', 'Q', 'power')
        heads = ('油门%', '压差Pa', '流速m/s', '盘载N/m²', '流量m³/s', '功率W')
        self.tree = ttk.Treeview(resf, columns=cols, show='headings', height=6)
        for c, h in zip(cols, heads):
            self.tree.heading(c, text=h); self.tree.column(c, width=90, anchor='center')
        self.tree.pack(fill='x')

        # STATUSTEXT 日志
        logf = ttk.LabelFrame(right, text='日志', padding=2); logf.pack(fill='both', expand=True)
        self.log = tk.Text(logf, height=6, font=('TkFixedFont', 9)); self.log.pack(fill='both', expand=True)

        self._toggle_sweep()

    def _row(self, parent, r, label, attr, default):
        ttk.Label(parent, text=label).grid(row=r, column=0, sticky='w', pady=1)
        e = ttk.Entry(parent, width=10); e.insert(0, default)
        e.grid(row=r, column=1, sticky='w', padx=4)
        setattr(self, attr, e)

    def _toggle_sweep(self):
        if self.sweep_var.get():
            self.thr_scale.config(state='disabled')
            self.sweep_lbl.pack(anchor='w'); self.sweep_e.pack(anchor='w')
        else:
            self.thr_scale.config(state='normal')
            self.sweep_lbl.pack_forget(); self.sweep_e.pack_forget()

    def _ports(self):
        return [p.device for p in list_ports.comports()]

    def _toggle_conn(self):
        if self.fc.snap()['connected']:
            self.fc.cmd_disconnect()
        else:
            self._connect()

    def _connect(self):
        try:
            baud = int(self.baud_e.get())
        except ValueError:
            messagebox.showerror('错误', '波特率无效'); return
        self.fc.cmd_connect(self.port_cb.get(), baud)

    def _zero(self):
        self.fc.cmd_zero(3.0)

    def _mask(self):
        m = 0
        for i, v in self.motor_vars.items():
            if v.get():
                m |= (1 << (i - 1))
        return m

    def _start(self):
        mask = self._mask()
        if mask == 0:
            messagebox.showerror('错误', '至少勾选一个电机'); return
        try:
            hold = float(self.hold_e.get()); ru = int(self.rampup_e.get()); rd = int(self.rampdn_e.get())
            area = float(self.area_e.get()); rho = float(self.rho_e.get())
        except ValueError:
            messagebox.showerror('错误', '参数格式无效'); return
        if self.sweep_var.get():
            try:
                sps = [parse_throttle(float(x)) for x in self.sweep_e.get().split(',') if x.strip()]
            except ValueError:
                messagebox.showerror('错误', '扫描列表格式无效'); return
            if not sps:
                messagebox.showerror('错误', '扫描列表为空'); return
        else:
            sps = [self.thr_scale.get() / 100.0]
        names = [MOTOR_NAMES[i] for i in self.motor_vars if self.motor_vars[i].get()]
        if not messagebox.askyesno('确认启动',
                f'电机: {", ".join(names)}\n油门: {[round(x*100) for x in sps]}%\n'
                f'hold {hold}s / 上升 {ru}ms / 下降 {rd}ms\n\n⚠️ 电机会转! 确认台架固定、周围安全、皮托管到位。'):
            return
        cfg = dict(mask=mask, setpoints=sps, hold_s=hold, ramp_up=ru, ramp_dn=rd,
                   area_m2=area * 1e-4, rho=rho)
        for c in self.tree.get_children():
            self.tree.delete(c)
        self.fc.cmd_start(cfg)

    def _refresh(self):
        s = self.fc.snap()
        # 连接状态 + 按钮切换 + 控件启用
        cs = s.get('conn_state', 'disconnected')
        if cs == 'connected':
            self.conn_lbl.config(text=f'● 已连接 ({s["busy"]})', foreground='green')
            self.conn_btn.config(text='断开')
        elif cs == 'lost':
            self.conn_lbl.config(text='● 连接丢失!', foreground='red')
            self.conn_btn.config(text='连接')
        else:
            self.conn_lbl.config(text='● 未连接', foreground='gray')
            self.conn_btn.config(text='连接')
        ctl_state = 'normal' if cs == 'connected' else 'disabled'
        self.start_btn.config(state=ctl_state)
        # 大字
        lv = s['live']
        self.big['press'].config(text=f'{lv["press"]:+.1f}')
        self.big['vel'].config(text=f'{lv["vel"]:.1f}')
        self.big['dl'].config(text=f'{lv["dl"]:.0f}')
        self.big['thr'].config(text=f'{lv["thr"]*100:.0f}')
        st = STATE_NAME.get(lv['state'], '?')
        self.big['state'].config(text=st)
        self.big['batt'].config(text=f'{lv["bv"]:.1f}V/{lv["ba"]:.0f}A')
        self.off_lbl.config(text=f'offset: {s["offset"]:+.2f} Pa')
        # 曲线 (最近 30s)
        plot = s['plot']
        if plot:
            t_now = plot[-1][0]
            data = [(t - t_now, p, th) for (t, p, th) in plot if t_now - t <= 30]
            xs = [d[0] for d in data]; ps = [d[1] for d in data]; ths = [d[2] for d in data]
            self.ax1.clear(); self.ax2.clear()
            self.ax1.plot(xs, ps, color='tab:blue', lw=1.2)
            self.ax2.plot(xs, ths, color='tab:orange', lw=1.0, alpha=0.7)
            self.ax1.set_xlabel('t (s, rel)'); self.ax1.set_ylabel('Press (Pa)', color='tab:blue')
            self.ax2.set_ylabel('Throttle (%)', color='tab:orange'); self.ax2.set_ylim(0, 100)
            self.ax1.grid(True, alpha=0.3)
            self.canvas.draw_idle()
        # 日志
        cur = len(self.log.get('1.0', 'end-1c').splitlines())
        msgs = s['status']
        if len(msgs) != getattr(self, '_last_log_n', -1):
            self._last_log_n = len(msgs)
            self.log.delete('1.0', 'end')
            for (t, txt) in list(msgs)[-40:]:
                self.log.insert('end', f'{datetime.fromtimestamp(t).strftime("%H:%M:%S")} {txt}\n')
            self.log.see('end')
        # 结果表
        if s['summary_new']:
            self.fc.clear_summary_flag()
            for r in (s['summary'] or []):
                if r.get('n', 0) == 0:
                    self.tree.insert('', 'end', values=(r['sp'], '无数据', '-', '-', '-', '-'))
                else:
                    self.tree.insert('', 'end', values=(
                        r['sp'], f'{r["press"]:.0f}', f'{r["vel"]:.1f}',
                        f'{r["dl"]:.0f}', f'{r["Q"]:.3f}' if r['Q'] else '-',
                        f'{r["power"]:.0f}' if r['power'] else '-'))
            if s['csv_path']:
                messagebox.showinfo('完成', f'测试完成\nCSV: {s["csv_path"]}')
        self.root.after(150, self._refresh)

    def _on_close(self):
        self.fc.cmd_abort()
        self.fc.shutdown()
        time.sleep(0.3)
        self.root.destroy()


def main():
    root = tk.Tk()
    try:
        ttk.Style().theme_use('clam')
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == '__main__':
    main()
