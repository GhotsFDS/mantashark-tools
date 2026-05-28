#!/usr/bin/env python3
"""MantaShark 台架标定上位机 v6 — 滚动 + 复选框 + 卡片式 Tilt.

布局:
  - 顶部 连接栏 (固定)
  - 主区 Notebook (3 tab, 所有 tab 都带垂直滚动条):
      Tab1 倾转校准: 9 路卡片网格 (PWM 滑杆 + 实时预览, 仿 Tuner TiltPanel)
      Tab2 任务配置: 电机/倾转复选框 + 组快捷 + 角度列表 + 油门
      Tab3 实时预览: 传感器 + PWM + STATUSTEXT
  - 底部 状态栏
"""

from __future__ import annotations

import argparse
import os
import signal
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox, font as tkfont

from serial.tools import list_ports

from transducer_modbus import TransducerModbus as TransducerAscii
from fc_mavlink import FCMavlink
from recorder import Recorder, RecordRow


# ─────────── 配置 ──────────────────────────────────────────

# 9 路 tilt: (id, channel, 中文说明)
TILT_LIST = [
    ('DFL',  13, 'DFL 前下吹 左'),
    ('DFR',  14, 'DFR 前下吹 右'),
    ('TL1',  15, 'TL1 后推 左外'),
    ('TR1',  16, 'TR1 后推 右外'),
    ('RDL',  17, 'RDL 尾下吹 左'),
    ('RDR',  18, 'RDR 尾下吹 右'),
    ('SGRP', 19, 'SGRP S 组桁架 (4 路 KS)'),
    ('TL2',  20, 'TL2 后推 左内'),
    ('TR2',  21, 'TR2 后推 右内'),
]

# 12 motor: (idx 1-12, 中文标签, 组归属)
MOTOR_LIST = [
    (1,  'M1 SL1', 'KS'),
    (2,  'M2 SL2', 'KS'),
    (3,  'M3 SR1', 'KS'),
    (4,  'M4 SR2', 'KS'),
    (5,  'M5 DFL', 'KDF'),
    (6,  'M6 DFR', 'KDF'),
    (7,  'M7 TL1', 'KT-outer'),
    (8,  'M8 TL2', 'KT-inner'),
    (9,  'M9 TR1', 'KT-outer'),
    (10, 'M10 TR2', 'KT-inner'),
    (11, 'M11 RDL', 'KRD'),
    (12, 'M12 RDR', 'KRD'),
]

# 电机组快捷 (组名 → motor idx 列表)
MOTOR_GROUPS = [
    ('KS 组 (1-4)',       [1, 2, 3, 4]),
    ('KDF 组 (5,6)',      [5, 6]),
    ('KT 外侧 (7,9)',     [7, 9]),
    ('KT 内侧 (8,10)',    [8, 10]),
    ('KT 全部 (7-10)',    [7, 8, 9, 10]),
    ('KRD 组 (11,12)',    [11, 12]),
    ('全部 (1-12)',       list(range(1, 13))),
]

# 倾转组快捷
TILT_GROUPS = [
    ('S+DF 组 (SGRP/DFL/DFR)', ['SGRP', 'DFL', 'DFR']),
    ('KT 外侧 (TL1/TR1)',       ['TL1', 'TR1']),
    ('KT 内侧 (TL2/TR2)',       ['TL2', 'TR2']),
    ('KRD (RDL/RDR)',           ['RDL', 'RDR']),
    ('全部 (9 路)',             [nm for nm, _, _ in TILT_LIST]),
]

PWM_PER_DEG = 11.11   # 跟 lua 一致


# ─────────── 样式 ──────────────────────────────────────────

def apply_modern_style(root):
    style = ttk.Style(root)
    style.theme_use('clam')

    BG       = '#f5f7fa'
    CARD     = '#ffffff'
    PRIMARY  = '#2563eb'
    PRIM_HV  = '#1d4ed8'
    ACCENT   = '#0ea5e9'
    DANGER   = '#dc2626'
    DANG_HV  = '#b91c1c'
    SUCCESS  = '#16a34a'
    WARN     = '#d97706'
    TEXT     = '#1f2937'
    SUBTLE   = '#6b7280'
    BORDER   = '#d1d5db'
    HOVER    = '#e5e7eb'

    root.configure(bg=BG)

    fams = tkfont.families()
    if 'Noto Sans CJK SC' in fams:
        base_font = ('Noto Sans CJK SC', 10)
        title     = ('Noto Sans CJK SC', 14, 'bold')
        h2        = ('Noto Sans CJK SC', 11, 'bold')
    elif 'Microsoft YaHei' in fams:
        base_font = ('Microsoft YaHei', 10)
        title     = ('Microsoft YaHei', 14, 'bold')
        h2        = ('Microsoft YaHei', 11, 'bold')
    else:
        base_font = ('TkDefaultFont', 10)
        title     = ('TkDefaultFont', 14, 'bold')
        h2        = ('TkDefaultFont', 11, 'bold')

    mono = ('Noto Sans Mono CJK SC', 10) if 'Noto Sans Mono CJK SC' in fams else ('DejaVu Sans Mono', 10)

    style.configure('.', font=base_font, foreground=TEXT, background=BG)
    style.configure('TFrame', background=BG)
    style.configure('Card.TFrame', background=CARD)
    style.configure('TLabel', background=BG, foreground=TEXT)
    style.configure('Card.TLabel', background=CARD, foreground=TEXT)
    style.configure('H1.TLabel', background=BG, foreground=TEXT, font=title)
    style.configure('H2.TLabel', background=CARD, foreground=TEXT, font=h2)
    style.configure('Subtle.TLabel', background=BG, foreground=SUBTLE)
    style.configure('CardSubtle.TLabel', background=CARD, foreground=SUBTLE)
    style.configure('Success.TLabel', background=BG, foreground=SUCCESS, font=h2)
    style.configure('Danger.TLabel', background=BG, foreground=DANGER, font=h2)
    style.configure('Warn.TLabel', background=CARD, foreground=WARN)
    style.configure('Mono.TLabel', background=CARD, foreground=TEXT, font=mono)
    style.configure('PWM.TLabel', background=CARD, foreground=PRIMARY, font=(mono[0], 14, 'bold'))

    style.configure('TLabelframe', background=CARD, borderwidth=1, relief='solid',
                    bordercolor=BORDER)
    style.configure('TLabelframe.Label', background=CARD, foreground=TEXT, font=h2)

    style.configure('TButton', font=base_font, padding=(10, 5),
                    background=CARD, foreground=TEXT,
                    bordercolor=BORDER, relief='flat')
    style.map('TButton',
              background=[('active', HOVER), ('pressed', '#d1d5db')])
    style.configure('Primary.TButton', font=h2, padding=(16, 8),
                    background=PRIMARY, foreground='white',
                    bordercolor=PRIMARY, relief='flat')
    style.map('Primary.TButton',
              background=[('active', PRIM_HV), ('pressed', PRIM_HV)])
    style.configure('Danger.TButton', font=h2, padding=(16, 8),
                    background=DANGER, foreground='white',
                    bordercolor=DANGER, relief='flat')
    style.map('Danger.TButton',
              background=[('active', DANG_HV)])
    style.configure('Accent.TButton', font=base_font, padding=(8, 4),
                    background=ACCENT, foreground='white',
                    bordercolor=ACCENT, relief='flat')
    style.map('Accent.TButton',
              background=[('active', '#0284c7')])
    style.configure('Pill.TButton', font=base_font, padding=(8, 3),
                    background=HOVER, foreground=TEXT,
                    bordercolor=BORDER, relief='flat')

    style.configure('TCombobox', padding=4, font=base_font,
                    fieldbackground=CARD,
                    selectbackground=PRIMARY, selectforeground='white')
    style.configure('TSpinbox', padding=4, font=base_font,
                    fieldbackground=CARD)
    style.configure('TCheckbutton', background=BG, foreground=TEXT, font=base_font)
    style.configure('Card.TCheckbutton', background=CARD, foreground=TEXT, font=base_font)
    style.map('Card.TCheckbutton', background=[('active', CARD)])

    # Scale (slider)
    style.configure('TScale', background=CARD, troughcolor=HOVER)

    # Notebook
    style.configure('TNotebook', background=BG, borderwidth=0)
    style.configure('TNotebook.Tab', font=h2, padding=(20, 10),
                    background='#e5e7eb', foreground=TEXT)
    style.map('TNotebook.Tab',
              background=[('selected', CARD)],
              foreground=[('selected', PRIMARY)])

    return {
        'bg': BG, 'card': CARD, 'primary': PRIMARY, 'danger': DANGER,
        'success': SUCCESS, 'subtle': SUBTLE, 'border': BORDER,
        'text': TEXT, 'hover': HOVER, 'accent': ACCENT, 'warn': WARN,
        'mono': mono, 'base': base_font, 'h2': h2,
    }


# ─────────── 可滚动 Frame helper ───────────────────────────

class ScrollableFrame(ttk.Frame):
    """带垂直滚动条的可滚动容器. 把内容 pack/grid 进 .inner."""
    def __init__(self, parent, bg='#f5f7fa', **kw):
        super().__init__(parent, **kw)
        self.canvas = tk.Canvas(self, bg=bg, highlightthickness=0)
        self.vsb = ttk.Scrollbar(self, orient='vertical', command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self.vsb.set)
        self.vsb.pack(side='right', fill='y')
        self.canvas.pack(side='left', fill='both', expand=True)
        self.inner = ttk.Frame(self.canvas, style='TFrame')
        self.inner_id = self.canvas.create_window((0, 0), window=self.inner, anchor='nw')
        self.inner.bind('<Configure>',
            lambda e: self.canvas.configure(scrollregion=self.canvas.bbox('all')))
        self.canvas.bind('<Configure>',
            lambda e: self.canvas.itemconfigure(self.inner_id, width=e.width))
        # 鼠标滚轮
        self.canvas.bind_all('<MouseWheel>', self._on_wheel, add='+')
        self.canvas.bind_all('<Button-4>', lambda e: self.canvas.yview_scroll(-1, 'units'))
        self.canvas.bind_all('<Button-5>', lambda e: self.canvas.yview_scroll(1, 'units'))

    def _on_wheel(self, ev):
        try:
            self.canvas.yview_scroll(int(-1 * (ev.delta / 120)), 'units')
        except Exception:
            pass


# ─────────── 主程序 ────────────────────────────────────────

class BenchApp:
    def __init__(self, default_fc, default_sensor, output_dir):
        self.output_dir = output_dir
        os.makedirs(output_dir, exist_ok=True)
        self.fc = None
        self.sensor = None
        self._default_fc = default_fc
        self._default_sensor = default_sensor

        self._root = tk.Tk()
        self._root.title('MantaShark · 台架标定上位机 v6')
        self._root.geometry('1280x860')
        self._root.minsize(960, 600)

        self.theme = apply_modern_style(self._root)

        # 串口 var
        self.var_fc_port     = tk.StringVar()
        self.var_sensor_port = tk.StringVar()
        self.var_fc_baud     = tk.IntVar(value=115200)
        self.var_sensor_baud = tk.IntVar(value=115200)
        self._port_map = {}

        # 校准 var
        self.cal_vars = {nm: {
            'p45': tk.IntVar(value=2000),
            'dir': tk.IntVar(value=1),
            'preview_ang': tk.IntVar(value=45),  # GUI 端预览角度
        } for nm, _, _ in TILT_LIST}
        self._cal_widgets = {}    # 缓存 widget 用于更新 PWM 显示

        # S→DF 解耦 全局参数 (跟主线 tilt_driver 一致)
        self.cpl_en = tk.IntVar(value=1)
        self.cpl_k  = tk.DoubleVar(value=1.0)

        # 任务 var (新时序: 0 →ramp→ START → step up → MAX → 切角度回 START → ...)
        self.motor_chk  = {m: tk.IntVar(value=0) for m, _, _ in MOTOR_LIST}
        self.tilt_chk   = {nm: tk.IntVar(value=0) for nm, _, _ in TILT_LIST}
        self.task = {
            'n_ang':    tk.IntVar(value=1),
            'angles':   [tk.DoubleVar(value=0.0) for _ in range(8)],
            'thr_start':tk.DoubleVar(value=0.50),   # 起步 baseline
            'thr_max':  tk.DoubleVar(value=1.00),   # 终点
            'thr_step': tk.DoubleVar(value=0.10),
            'hold_ms':  tk.IntVar(value=2000),
            'ramp_ms':  tk.IntVar(value=500),       # 0 → START 快速 ramp
            'ramp_dn':  tk.IntVar(value=1000),      # 结束缓降 MAX → 0 时长
        }

        # 实时预览模式 (cal tab live PWM 推飞控)
        self.live_preview = tk.IntVar(value=0)
        self._last_push_ms = {}   # 滑杆节流 per-tilt

        # 任务录制 (push_task 后启, BENCH DONE 后停)
        self._recording = False
        self._record_thread = None
        self._stop_record = threading.Event()
        self._cur_phase = 'IDLE'
        self._cur_ang_idx = 0
        self._cur_ang_deg = 0.0
        self._cur_thr = 0.0

        self._build_ui()
        self._refresh_ports()
        signal.signal(signal.SIGINT, lambda *a: self.emergency_stop())

    # ─────────────────── UI 构建 ────────────────────────────

    def _build_ui(self):
        # 顶部标题 + 连接栏 (固定不滚)
        header = ttk.Frame(self._root)
        header.pack(fill='x', padx=20, pady=(15, 5))
        ttk.Label(header, text='MantaShark · 台架推力 / 力矩 标定',
                  style='H1.TLabel').pack(side='left')
        ttk.Label(header, text='v6', style='Subtle.TLabel').pack(side='left', padx=(8, 0), pady=(8, 0))

        self._build_conn_bar()

        # Notebook
        nb = ttk.Notebook(self._root)
        nb.pack(fill='both', expand=True, padx=20, pady=10)

        tab_cal  = ScrollableFrame(nb, bg=self.theme['bg'])
        tab_task = ScrollableFrame(nb, bg=self.theme['bg'])
        tab_live = ScrollableFrame(nb, bg=self.theme['bg'])
        nb.add(tab_cal,  text='  倾转校准  ')
        nb.add(tab_task, text='  任务配置  ')
        nb.add(tab_live, text='  实时预览  ')
        self._build_cal_tab(tab_cal.inner)
        self._build_task_tab(tab_task.inner)
        self._build_live_tab(tab_live.inner)

        # 底部常驻 传感器实时栏 (任何 tab 都可见)
        bottom_sensor = ttk.LabelFrame(self._root, text='  传感器实时 (3 通道 Z 向力)  ',
                                       padding=(15, 6))
        bottom_sensor.pack(fill='x', side='bottom', padx=20, pady=(0, 5))
        self.lbl_bot_sensor = ttk.Label(bottom_sensor, text='— 未连接 —',
            style='Mono.TLabel',
            font=(self.theme['mono'][0], 14, 'bold'))
        self.lbl_bot_sensor.pack(anchor='w')

        # 底部常驻 电池监控栏 (飞控电池电压/电流/累计)
        bottom_batt = ttk.LabelFrame(self._root, text='  电池监控 (飞控读)  ',
                                      padding=(15, 4))
        bottom_batt.pack(fill='x', side='bottom', padx=20, pady=(0, 2))
        self.lbl_bot_batt = ttk.Label(bottom_batt, text='— 未连接飞控 —',
            style='Mono.TLabel',
            font=(self.theme['mono'][0], 12, 'bold'))
        self.lbl_bot_batt.pack(anchor='w')

        # 底部状态栏
        statusbar = ttk.Frame(self._root)
        statusbar.pack(fill='x', side='bottom', padx=20, pady=(0, 8))
        self.lbl_status = ttk.Label(statusbar, text='就绪', style='Subtle.TLabel')
        self.lbl_status.pack(side='left')

        self._root.after(200, self._update_display)

    def _build_conn_bar(self):
        bar = ttk.LabelFrame(self._root, text='  设备连接 (飞控 / 传感器 独立连接)  ',
                             padding=(15, 10))
        bar.pack(fill='x', padx=20, pady=5)

        FC_BAUDS     = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]
        SENSOR_BAUDS = [4800, 9600, 19200, 38400, 57600, 115200]

        # ── 飞控行 ──
        ttk.Label(bar, text='飞控串口:', style='Card.TLabel').grid(
            row=0, column=0, sticky='w', padx=(0, 8), pady=4)
        self.cb_fc = ttk.Combobox(bar, textvariable=self.var_fc_port,
                                  width=38, state='readonly')
        self.cb_fc.grid(row=0, column=1, sticky='ew', pady=4)
        ttk.Label(bar, text='波特:', style='Card.TLabel').grid(
            row=0, column=2, sticky='e', padx=(8, 4))
        self.cb_fc_baud = ttk.Combobox(bar, textvariable=self.var_fc_baud,
                                       width=8, state='readonly',
                                       values=[str(b) for b in FC_BAUDS])
        self.cb_fc_baud.grid(row=0, column=3, pady=4)
        self.lbl_fc_dot = ttk.Label(bar, text='●', style='Card.TLabel',
                                    foreground=self.theme['danger'])
        self.lbl_fc_dot.grid(row=0, column=4, padx=(10, 4))
        self.btn_fc_connect = ttk.Button(bar, text='连接飞控',
                                         command=self.on_connect_fc,
                                         style='Primary.TButton')
        self.btn_fc_connect.grid(row=0, column=5, padx=4, pady=4)
        self.btn_fc_disconnect = ttk.Button(bar, text='断开',
                                           command=self.on_disconnect_fc,
                                           state='disabled')
        self.btn_fc_disconnect.grid(row=0, column=6, padx=4, pady=4)

        # ── 传感器行 ──
        ttk.Label(bar, text='传感器串口:', style='Card.TLabel').grid(
            row=1, column=0, sticky='w', padx=(0, 8), pady=4)
        self.cb_sensor = ttk.Combobox(bar, textvariable=self.var_sensor_port,
                                      width=38, state='readonly')
        self.cb_sensor.grid(row=1, column=1, sticky='ew', pady=4)
        ttk.Label(bar, text='波特:', style='Card.TLabel').grid(
            row=1, column=2, sticky='e', padx=(8, 4))
        self.cb_sensor_baud = ttk.Combobox(bar, textvariable=self.var_sensor_baud,
                                           width=8, state='readonly',
                                           values=[str(b) for b in SENSOR_BAUDS])
        self.cb_sensor_baud.grid(row=1, column=3, pady=4)
        self.lbl_sensor_dot = ttk.Label(bar, text='●', style='Card.TLabel',
                                        foreground=self.theme['danger'])
        self.lbl_sensor_dot.grid(row=1, column=4, padx=(10, 4))
        self.btn_sensor_connect = ttk.Button(bar, text='连接传感器',
                                            command=self.on_connect_sensor,
                                            style='Primary.TButton')
        self.btn_sensor_connect.grid(row=1, column=5, padx=4, pady=4)
        self.btn_sensor_disconnect = ttk.Button(bar, text='断开',
                                                command=self.on_disconnect_sensor,
                                                state='disabled')
        self.btn_sensor_disconnect.grid(row=1, column=6, padx=4, pady=4)

        # ── 全局按钮 ──
        glob = ttk.Frame(bar, style='Card.TFrame')
        glob.grid(row=0, column=7, rowspan=2, padx=(20, 0), sticky='ns')
        self.btn_refresh = ttk.Button(glob, text='↻ 刷新串口',
                                      command=self._refresh_ports)
        self.btn_refresh.pack(side='top', padx=2, pady=2, fill='x')
        self.btn_estop = ttk.Button(glob, text='⛔ 紧急停止',
                                    command=self.emergency_stop,
                                    style='Danger.TButton', state='disabled')
        self.btn_estop.pack(side='top', padx=2, pady=2, fill='x')

        bar.columnconfigure(1, weight=1)

    # ─────────────────── 倾转校准 Tab (卡片网格) ──────────────

    def _build_cal_tab(self, parent):
        # 顶部说明 + 全局控件
        head = ttk.LabelFrame(parent, text='  校准说明  ', padding=12)
        head.pack(fill='x', padx=10, pady=10)
        ttk.Label(head, justify='left', style='CardSubtle.TLabel', text=(
            '校准原理: PWM = 45°PWM + 11.11 × 方向 × (角度 - 45°)\n'
            '步骤:\n'
            '  ① 飞控未解锁 + 开 "实时预览" 开关\n'
            '  ② 拖卡片内 "预览角度" 滑杆 → servo 实时跟着转\n'
            '  ③ 拖到 45°, 调 "45° PWM" 数字让 servo 物理对准 45° 位置\n'
            '  ④ 拖到 0° 或 90° 看是否到位, 不到位 → 切方向 ±1\n'
            '  ⑤ 点 "保存" 写飞控. 全部校完点底部 "全部保存".'
        )).pack(anchor='w')

        ctl = ttk.Frame(head, style='Card.TFrame')
        ctl.pack(fill='x', pady=(8, 0))
        ttk.Checkbutton(ctl, text='实时预览 (拖滑杆即推 servo)',
                        variable=self.live_preview,
                        style='Card.TCheckbutton',
                        command=self._on_live_toggle).pack(side='left')
        ttk.Button(ctl, text='⬇ 从飞控读取', command=self.cal_load_all,
                   style='Pill.TButton').pack(side='left', padx=8)
        ttk.Button(ctl, text='⬆ 全部保存', command=self.cal_save_all,
                   style='Primary.TButton').pack(side='left', padx=4)
        ttk.Button(ctl, text='■ 停止预览', command=self._stop_cal,
                   style='Pill.TButton').pack(side='left', padx=4)

        # S→DF 解耦 (跟主线 tilt_driver 一致)
        cpl = ttk.Frame(head, style='Card.TFrame')
        cpl.pack(fill='x', pady=(8, 0))
        ttk.Label(cpl, text='S→DF 机械解耦:', style='Card.TLabel'
                  ).pack(side='left', padx=(0, 8))
        ttk.Checkbutton(cpl, text='启用 (校 DFL/DFR 时 SGRP 自动锁 45°)',
                        variable=self.cpl_en,
                        style='Card.TCheckbutton',
                        command=self._on_cpl_change).pack(side='left')
        ttk.Label(cpl, text='K (耦合系数):', style='Card.TLabel'
                  ).pack(side='left', padx=(16, 4))
        sb_k = ttk.Spinbox(cpl, from_=0.0, to=2.0, increment=0.05,
                           format='%.2f', textvariable=self.cpl_k, width=8,
                           command=self._on_cpl_change)
        sb_k.pack(side='left')
        sb_k.bind('<FocusOut>', lambda e: self._on_cpl_change())
        sb_k.bind('<Return>',   lambda e: self._on_cpl_change())
        ttk.Label(cpl,
            text='公式: shaft = body − K × (SGRP_shaft − 45)',
            style='CardSubtle.TLabel').pack(side='left', padx=(16, 0))

        # 9 卡片 3x3 网格 (随宽度自适应)
        grid = ttk.Frame(parent)
        grid.pack(fill='both', expand=True, padx=10, pady=5)
        cols = 3
        for c in range(cols):
            grid.columnconfigure(c, weight=1, uniform='cal')

        for i, (nm, ch, desc) in enumerate(TILT_LIST):
            r, c = divmod(i, cols)
            self._build_tilt_card(grid, nm, ch, desc).grid(
                row=r, column=c, padx=8, pady=8, sticky='nsew')

    def _build_tilt_card(self, parent, nm, ch, desc):
        v = self.cal_vars[nm]
        card = ttk.LabelFrame(parent, text=f'  {nm} · CH{ch}  ', padding=12)
        widgets = {}

        ttk.Label(card, text=desc, style='CardSubtle.TLabel'
                  ).pack(anchor='w', pady=(0, 8))

        # 45° PWM 行
        f1 = ttk.Frame(card, style='Card.TFrame')
        f1.pack(fill='x', pady=4)
        ttk.Label(f1, text='45° PWM:', style='Card.TLabel'
                  ).pack(side='left', padx=(0, 8))
        sb_p45 = ttk.Spinbox(f1, from_=500, to=2500, increment=5,
                             textvariable=v['p45'], width=10,
                             command=lambda n=nm: self._on_cal_change(n))
        sb_p45.pack(side='left')
        sb_p45.bind('<Return>',     lambda e, n=nm: self._on_cal_change(n))
        sb_p45.bind('<FocusOut>',   lambda e, n=nm: self._on_cal_change(n))
        widgets['p45_spin'] = sb_p45

        # 方向 三态
        f2 = ttk.Frame(card, style='Card.TFrame')
        f2.pack(fill='x', pady=4)
        ttk.Label(f2, text='方向:', style='Card.TLabel'
                  ).pack(side='left', padx=(0, 8))
        for val, label in [(1, '+1'), (0, '0 锁'), (-1, '−1')]:
            ttk.Radiobutton(f2, text=label, variable=v['dir'], value=val,
                            style='Card.TCheckbutton',
                            command=lambda n=nm: self._on_cal_change(n)
                            ).pack(side='left', padx=2)

        # 预览角度滑杆
        f3 = ttk.Frame(card, style='Card.TFrame')
        f3.pack(fill='x', pady=(8, 4))
        head = ttk.Frame(f3, style='Card.TFrame')
        head.pack(fill='x')
        ttk.Label(head, text='预览角度', style='Card.TLabel').pack(side='left')
        lbl_ang = ttk.Label(head, text='45°', style='Mono.TLabel')
        lbl_ang.pack(side='right')
        widgets['lbl_ang'] = lbl_ang

        sc = ttk.Scale(f3, from_=0, to=90, orient='horizontal',
                       variable=v['preview_ang'],
                       command=lambda x, n=nm: self._on_preview_change(n, float(x)))
        sc.pack(fill='x', pady=2)

        scale_marks = ttk.Frame(f3, style='Card.TFrame')
        scale_marks.pack(fill='x')
        ttk.Label(scale_marks, text='0°', style='CardSubtle.TLabel').pack(side='left')
        ttk.Label(scale_marks, text='45°', style='CardSubtle.TLabel').pack(side='left', padx=(85, 85))
        ttk.Label(scale_marks, text='90°', style='CardSubtle.TLabel').pack(side='left')

        # 快捷按钮 + 输出 PWM
        f4 = ttk.Frame(card, style='Card.TFrame')
        f4.pack(fill='x', pady=(8, 0))
        for ang in (0, 45, 90):
            ttk.Button(f4, text=f'{ang}°', width=4,
                       command=lambda n=nm, a=ang: self._quick_preview(n, a),
                       style='Pill.TButton').pack(side='left', padx=2)
        ttk.Button(f4, text='保存', command=lambda n=nm: self.cal_save_row(n),
                   style='Accent.TButton').pack(side='right')

        # 输出 PWM 显示 (左: GUI 算的, 右: FC 实测 SERVO_OUTPUT_RAW)
        f5 = ttk.Frame(card, style='Card.TFrame')
        f5.pack(fill='x', pady=(8, 0))
        ttk.Label(f5, text='GUI 算:', style='Card.TLabel').pack(side='left')
        lbl_pwm = ttk.Label(f5, text='—', style='PWM.TLabel')
        lbl_pwm.pack(side='left', padx=(4, 12))
        ttk.Label(f5, text='│ FC 实测:', style='Card.TLabel').pack(side='left')
        lbl_pwm_actual = ttk.Label(f5, text='—', style='PWM.TLabel',
                                    foreground=self.theme['accent'])
        lbl_pwm_actual.pack(side='left', padx=4)
        widgets['lbl_pwm'] = lbl_pwm
        widgets['lbl_pwm_actual'] = lbl_pwm_actual

        self._cal_widgets[nm] = widgets
        # 初次更新 PWM
        self._root.after(50, lambda n=nm: self._on_cal_change(n, push=False))
        return card

    # ─────────────────── 任务配置 Tab ──────────────────────

    def _build_task_tab(self, parent):
        info = ttk.LabelFrame(parent, text='  任务流程  ', padding=12)
        info.pack(fill='x', padx=10, pady=10)
        ttk.Label(info, justify='left', style='CardSubtle.TLabel', text=(
            '① 复选框勾选 要测试的电机 + 要扫描的倾转\n'
            '② 设角度列表 + 油门范围 → 下发\n'
            '③ RC 解锁 或 软触发 → lua 自动按每角度扫油门 MAX→MIN, 每档 HOLD ms\n'
            '④ 跑完后 STATUSTEXT 显示 BENCH DONE, 可拨 disarm 再触发\n'
            '⑤ 中途 disarm / 紧急停止 → 立即停所有电机'
        )).pack(anchor='w')

        # 电机选择
        cm = ttk.LabelFrame(parent, text='  ① 选择电机 (可多选, 同时驱动)  ', padding=12)
        cm.pack(fill='x', padx=10, pady=5)
        # 组快捷
        gm_row = ttk.Frame(cm, style='Card.TFrame')
        gm_row.pack(fill='x', pady=(0, 8))
        ttk.Label(gm_row, text='快捷:', style='Card.TLabel'
                  ).pack(side='left', padx=(0, 8))
        for label, ids in MOTOR_GROUPS:
            ttk.Button(gm_row, text=label,
                       command=lambda x=ids: self._toggle_motor_group(x),
                       style='Pill.TButton').pack(side='left', padx=2)
        ttk.Button(gm_row, text='清空',
                   command=lambda: self._toggle_motor_group([], clear=True),
                   style='Pill.TButton').pack(side='left', padx=(16, 2))

        # 12 motor 复选框 6 列 × 2 行
        grid = ttk.Frame(cm, style='Card.TFrame')
        grid.pack(fill='x')
        for i, (m, label, grp) in enumerate(MOTOR_LIST):
            r, c = divmod(i, 6)
            ttk.Checkbutton(grid, text=label, variable=self.motor_chk[m],
                            style='Card.TCheckbutton'
                            ).grid(row=r, column=c, padx=10, pady=4, sticky='w')

        # 倾转选择
        ct = ttk.LabelFrame(parent, text='  ② 选择倾转 (可多选, 同步同角度)  ', padding=12)
        ct.pack(fill='x', padx=10, pady=5)
        gt_row = ttk.Frame(ct, style='Card.TFrame')
        gt_row.pack(fill='x', pady=(0, 8))
        ttk.Label(gt_row, text='快捷:', style='Card.TLabel'
                  ).pack(side='left', padx=(0, 8))
        for label, ids in TILT_GROUPS:
            ttk.Button(gt_row, text=label,
                       command=lambda x=ids: self._toggle_tilt_group(x),
                       style='Pill.TButton').pack(side='left', padx=2)
        ttk.Button(gt_row, text='清空',
                   command=lambda: self._toggle_tilt_group([], clear=True),
                   style='Pill.TButton').pack(side='left', padx=(16, 2))

        grid_t = ttk.Frame(ct, style='Card.TFrame')
        grid_t.pack(fill='x')
        for i, (nm, ch, desc) in enumerate(TILT_LIST):
            r, c = divmod(i, 3)
            ttk.Checkbutton(grid_t, text=f'{nm} (CH{ch}) · {desc.split(" ", 1)[-1]}',
                            variable=self.tilt_chk[nm],
                            style='Card.TCheckbutton'
                            ).grid(row=r, column=c, padx=10, pady=4, sticky='w')

        ttk.Label(ct, justify='left', style='CardSubtle.TLabel',
                  text='未选中的 tilt 自动保持物理默认 (S/DF=45° KT/KRD=90°), 无需配置.'
                  ).pack(anchor='w', pady=(8, 0))

        # 角度列表
        ca = ttk.LabelFrame(parent, text='  ③ 扫描角度列表 (1-8 个角度)  ', padding=12)
        ca.pack(fill='x', padx=10, pady=5)
        row1 = ttk.Frame(ca, style='Card.TFrame')
        row1.pack(fill='x')
        ttk.Label(row1, text='角度数:', style='Card.TLabel'
                  ).pack(side='left')
        ttk.Spinbox(row1, from_=1, to=8, increment=1,
                    textvariable=self.task['n_ang'], width=5
                    ).pack(side='left', padx=(4, 16))
        for i in range(8):
            ttk.Label(row1, text=f'A{i+1}', style='Card.TLabel'
                      ).pack(side='left', padx=(8, 2))
            ttk.Spinbox(row1, from_=-30, to=120, increment=5,
                        textvariable=self.task['angles'][i], width=6
                        ).pack(side='left')

        # 油门 (新时序: 0 →ramp→ START → step up → MAX → 切角度回 START → ...)
        cp = ttk.LabelFrame(parent, text='  ④ 油门扫描参数 (0→START 快速 ramp, 再 step up 到 MAX)  ', padding=12)
        cp.pack(fill='x', padx=10, pady=5)
        rt = ttk.Frame(cp, style='Card.TFrame')
        rt.pack(fill='x')
        for label, var, kw in [
            ('起始 START:',   self.task['thr_start'],{'from_':0.0, 'to':1.0, 'increment':0.05, 'format':'%.2f'}),
            ('终点 MAX:',     self.task['thr_max'],  {'from_':0.0, 'to':1.0, 'increment':0.05, 'format':'%.2f'}),
            ('步进 STEP:',    self.task['thr_step'], {'from_':0.05,'to':0.5, 'increment':0.05, 'format':'%.2f'}),
            ('每档 HOLD (ms):',self.task['hold_ms'], {'from_':500, 'to':10000, 'increment':500}),
            ('启动 RAMP (ms):',self.task['ramp_ms'], {'from_':0,   'to':5000,  'increment':100}),
            ('结束缓降 (ms):', self.task['ramp_dn'], {'from_':0,   'to':10000, 'increment':100}),
        ]:
            ttk.Label(rt, text=label, style='Card.TLabel'
                      ).pack(side='left', padx=(0, 4))
            ttk.Spinbox(rt, textvariable=var, width=8, **kw
                        ).pack(side='left', padx=(0, 12))
        ttk.Label(cp, justify='left', style='CardSubtle.TLabel', text=(
            '时序: 0 →RAMP→ START (起步) → HOLD → STEP_UP HOLD → ... → MAX HOLD\n'
            '切下个角度: thr 跳变回 START + tilt → ang[i+1], HOLD 等 servo 到位, 再 STEP_UP'
        )).pack(anchor='w', padx=(0, 0), pady=(6, 0))

        # 操作按钮
        ops = ttk.Frame(parent)
        ops.pack(fill='x', padx=10, pady=20)
        ttk.Button(ops, text='⬆ 下发并启用 (EN=1)', command=self.push_task,
                   style='Primary.TButton').pack(side='left', padx=4)
        ttk.Button(ops, text='■ 关闭 (EN=0)',
                   command=lambda: self._set_param_safe('MSAK_EN', 0)
                   ).pack(side='left', padx=4)
        ttk.Button(ops, text='▶ 软触发 (跳过 RC)',
                   command=self.task_sw_trigger,
                   style='Accent.TButton').pack(side='left', padx=20)
        ttk.Button(ops, text='■ 软停止', command=self.task_sw_stop
                   ).pack(side='left', padx=4)

    # ─────────────────── 实时预览 Tab ──────────────────────

    def _build_live_tab(self, parent):
        c1 = ttk.LabelFrame(parent, text='  传感器 · 3 通道 Z 向力  ', padding=20)
        c1.pack(fill='x', padx=10, pady=10)
        self.lbl_sensor_vals = ttk.Label(c1, text='— 未连接 —',
            style='Mono.TLabel',
            font=(self.theme['mono'][0], 18))
        self.lbl_sensor_vals.pack(anchor='w')

        c2 = ttk.LabelFrame(parent, text='  PWM 输出 (CH 1-21)  ', padding=15)
        c2.pack(fill='x', padx=10, pady=5)
        self.lbl_pwm_motors = ttk.Label(c2, text='电机: —', style='Mono.TLabel')
        self.lbl_pwm_motors.pack(anchor='w', pady=(0, 4))
        self.lbl_pwm_tilts = ttk.Label(c2, text='倾转: —', style='Mono.TLabel')
        self.lbl_pwm_tilts.pack(anchor='w')

        c3 = ttk.LabelFrame(parent, text='  飞控消息流 (STATUSTEXT)  ', padding=10)
        c3.pack(fill='both', expand=True, padx=10, pady=(5, 15))
        frm = ttk.Frame(c3, style='Card.TFrame')
        frm.pack(fill='both', expand=True)
        sb = ttk.Scrollbar(frm)
        sb.pack(side='right', fill='y')
        self.txt_st = tk.Text(frm, height=18, font=self.theme['mono'],
            bg=self.theme['card'], fg=self.theme['text'],
            relief='flat', wrap='word', yscrollcommand=sb.set)
        self.txt_st.pack(fill='both', expand=True, padx=4, pady=4)
        sb.config(command=self.txt_st.yview)

    # ─────────────────── 串口扫描 ──────────────────────────

    def _refresh_ports(self):
        self._port_map.clear()
        items = []
        for p in list_ports.comports():
            dev = p.device
            if dev.startswith('/dev/ttyS'):
                continue
            desc = p.description or ''
            man  = p.manufacturer or ''
            extra = []
            if desc and desc != 'n/a': extra.append(desc)
            if man  and man  != 'n/a' and man not in desc: extra.append(man)
            tag = f'{dev}  ·  {" · ".join(extra)}' if extra else dev
            self._port_map[tag] = dev
            items.append(tag)
        items.sort()
        self.cb_fc['values']     = items
        self.cb_sensor['values'] = items

        if not self.var_fc_port.get() or self.var_fc_port.get() not in items:
            picked = next((it for it in items if 'ArduPilot' in it or 'CUAV' in it), None)
            if picked: self.var_fc_port.set(picked)
            elif items: self.var_fc_port.set(items[0])

        if not self.var_sensor_port.get() or self.var_sensor_port.get() not in items:
            picked = next((it for it in items
                           if any(k in it for k in ('CH340', 'CP210', 'FT232', 'USB Serial'))), None)
            if picked: self.var_sensor_port.set(picked)
            elif items and len(items) > 1:
                fc = self.var_fc_port.get()
                for it in items:
                    if it != fc: self.var_sensor_port.set(it); break

        self.log_st(f'[串口] 扫到 {len(items)} 个可用串口')

    def _selected_port(self, label):
        return self._port_map.get(label, label.split('  ·')[0] if '  ·' in label else label)

    # ─────────────────── 连接 (飞控 / 传感器 独立) ────────────

    @property
    def _connected(self):
        return self.fc is not None or self.sensor is not None

    def on_connect_fc(self):
        fc_label = self.var_fc_port.get()
        if not fc_label:
            messagebox.showwarning('未选飞控串口', '请先选择飞控串口')
            return
        fc_dev = self._selected_port(fc_label)
        sn_dev = self._selected_port(self.var_sensor_port.get()) if self.var_sensor_port.get() else None
        if sn_dev and fc_dev == sn_dev and self.sensor:
            messagebox.showerror('串口冲突', '飞控和传感器选了同一串口, 且传感器已占用')
            return

        baud = int(self.var_fc_baud.get())
        self.set_status(f'正在连接飞控 {fc_dev} @ {baud}...', 'subtle')
        self.fc = FCMavlink(fc_dev, baud=baud)
        try:
            self.fc.connect(timeout=15)
        except Exception as e:
            self.fc = None
            messagebox.showerror('飞控连接失败', f'端口 {fc_dev} @ {baud}\n\n{e}')
            self.set_status('飞控连接失败', 'danger')
            self.lbl_fc_dot.config(foreground=self.theme['danger'])
            return

        self.lbl_fc_dot.config(foreground=self.theme['success'])
        self.btn_fc_connect.config(state='disabled')
        self.btn_fc_disconnect.config(state='normal')
        self.btn_estop.config(state='normal')
        self.cb_fc.config(state='disabled')
        self.set_status(self._status_combined(), 'success')
        self.log_st(f'[连接] 飞控 {fc_dev} ✓')

    def on_disconnect_fc(self):
        try:
            if self.fc: self.fc.close()
        except Exception: pass
        self.fc = None
        self.lbl_fc_dot.config(foreground=self.theme['danger'])
        self.btn_fc_connect.config(state='normal')
        self.btn_fc_disconnect.config(state='disabled')
        self.cb_fc.config(state='readonly')
        if self.sensor is None:
            self.btn_estop.config(state='disabled')
        self.set_status(self._status_combined(), 'subtle')
        self.log_st('[连接] 飞控已断开')

    def on_connect_sensor(self):
        sn_label = self.var_sensor_port.get()
        if not sn_label:
            messagebox.showwarning('未选传感器串口', '请先选择传感器串口')
            return
        sn_dev = self._selected_port(sn_label)
        fc_dev = self._selected_port(self.var_fc_port.get()) if self.var_fc_port.get() else None
        if fc_dev and sn_dev == fc_dev and self.fc:
            messagebox.showerror('串口冲突', '传感器和飞控选了同一串口, 且飞控已占用')
            return

        baud = int(self.var_sensor_baud.get())
        self.set_status(f'正在连接传感器 {sn_dev} @ {baud}...', 'subtle')
        self.sensor = TransducerAscii(sn_dev, baud=baud, channels=[1, 2, 3])
        try:
            self.sensor.open()
            hs = self.sensor.handshake()
            ok = sum(1 for v in hs.values() if v)
            self.sensor.start_continuous(interval_ms=100, fmt=1)
        except Exception as e:
            try: self.sensor.close()
            except Exception: pass
            self.sensor = None
            messagebox.showerror('传感器连接失败', f'端口 {sn_dev}\n\n{e}')
            self.set_status('传感器连接失败', 'danger')
            self.lbl_sensor_dot.config(foreground=self.theme['danger'])
            return

        self.lbl_sensor_dot.config(
            foreground=self.theme['success'] if ok >= 3 else self.theme['warn'])
        self.btn_sensor_connect.config(state='disabled')
        self.btn_sensor_disconnect.config(state='normal')
        self.cb_sensor.config(state='disabled')
        self.set_status(self._status_combined(), 'success')
        self.log_st(f'[连接] 传感器 {sn_dev} ✓ (握手 {ok}/3)')

    def on_disconnect_sensor(self):
        try:
            if self.sensor: self.sensor.close()
        except Exception: pass
        self.sensor = None
        self.lbl_sensor_dot.config(foreground=self.theme['danger'])
        self.btn_sensor_connect.config(state='normal')
        self.btn_sensor_disconnect.config(state='disabled')
        self.cb_sensor.config(state='readonly')
        self.set_status(self._status_combined(), 'subtle')
        self.log_st('[连接] 传感器已断开')

    def _status_combined(self):
        parts = []
        if self.fc:     parts.append('飞控')
        if self.sensor: parts.append('传感器')
        if not parts:   return '已断开'
        return '已连接 · ' + '+'.join(parts)

    # ─────────────────── Cal 卡片回调 ──────────────────────

    def _need_fc(self, warn=True):
        if not self._connected or self.fc is None:
            if warn: messagebox.showwarning('未连接', '请先连接飞控')
            return False
        return True

    def _set_param_safe(self, name, val):
        return bool(self.fc and self.fc.set_param(name, float(val)))

    def _calc_pwm(self, nm, ang):
        v = self.cal_vars[nm]
        p45 = v['p45'].get()
        dir_ = v['dir'].get()
        if dir_ >= 0: dir_ = 1
        else: dir_ = -1
        pwm = p45 + PWM_PER_DEG * dir_ * (ang - 45)
        return int(max(500, min(2500, round(pwm))))

    def _on_cal_change(self, nm, push=True):
        """卡片内 P45/DIR/preview_ang 改时, 更新 PWM 显示 + (live 模式)推飞控."""
        widgets = self._cal_widgets.get(nm)
        if not widgets: return
        v = self.cal_vars[nm]
        ang = v['preview_ang'].get()
        pwm = self._calc_pwm(nm, ang)
        widgets['lbl_pwm'].config(text=f'{pwm}  μs')
        widgets['lbl_ang'].config(text=f'{ang}°')

        if push and self.live_preview.get() and self._connected:
            ch = next((c for n, c, _ in TILT_LIST if n == nm), None)
            if ch is None: return
            now_ms = int(time.time() * 1000)
            last = self._last_push_ms.get(nm, 0)
            if now_ms - last < 50:    # 50ms 节流
                return
            self._last_push_ms[nm] = now_ms
            # 设 CAL_PWM 直接写 PWM (绕公式, 调 P45 时显示=飞控)
            self._set_param_safe('MSAK_CAL_PWM', pwm)
            self._set_param_safe('MSAK_CAL_CH',  ch)

    def _on_preview_change(self, nm, val):
        self.cal_vars[nm]['preview_ang'].set(int(val))
        self._on_cal_change(nm)

    def _quick_preview(self, nm, ang):
        self.cal_vars[nm]['preview_ang'].set(ang)
        self._on_cal_change(nm)

    def _on_live_toggle(self):
        if self.live_preview.get():
            if not self._need_fc(): self.live_preview.set(0); return
            self.log_st('[校准] 实时预览开 — 拖滑杆即推 servo')
        else:
            self._stop_cal()

    def _stop_cal(self):
        if not self._connected: return
        self._set_param_safe('MSAK_CAL_CH', 0)
        self._set_param_safe('MSAK_CAL_PWM', 0)
        self.log_st('[校准] 已停止 (CAL_CH=0)')

    def cal_save_row(self, nm):
        if not self._need_fc(): return
        v = self.cal_vars[nm]
        ok = all([
            self._set_param_safe(f'TLT_{nm}_P45', v['p45'].get()),
            self._set_param_safe(f'TLT_{nm}_DIR', v['dir'].get()),
        ])
        self.log_st(f'[校准] 保存 {nm}: 45°PWM={v["p45"].get()} 方向={v["dir"].get()} '
                    f'{"OK" if ok else "失败"}')

    def cal_save_all(self):
        if not self._need_fc(): return
        for nm, _, _ in TILT_LIST:
            self.cal_save_row(nm)
        # 同时保存耦合参数
        self._set_param_safe('TLT_CPL_EN', self.cpl_en.get())
        self._set_param_safe('TLT_CPL_SDF_K', self.cpl_k.get())
        self.log_st(f'[校准] 耦合 EN={self.cpl_en.get()} K={self.cpl_k.get():.2f} 已保存')

    def cal_load_all(self):
        if not self._need_fc(): return
        for nm, _, _ in TILT_LIST:
            for key, vk in [('P45', 'p45'), ('DIR', 'dir')]:
                val = self.fc.get_param(f'TLT_{nm}_{key}', timeout=1.0)
                if val is not None:
                    self.cal_vars[nm][vk].set(int(val))
            self._on_cal_change(nm, push=False)
        # 读耦合参数
        en = self.fc.get_param('TLT_CPL_EN', timeout=1.0)
        k  = self.fc.get_param('TLT_CPL_SDF_K', timeout=1.0)
        if en is not None: self.cpl_en.set(int(en))
        if k  is not None: self.cpl_k.set(round(k, 2))
        self.log_st(f'[校准] 已从飞控读取 (耦合 EN={self.cpl_en.get()} K={self.cpl_k.get():.2f})')

    def _on_cpl_change(self):
        """耦合参数改 → 实时推飞控 (不等保存按钮)."""
        if not self._connected: return
        self._set_param_safe('TLT_CPL_EN', self.cpl_en.get())
        self._set_param_safe('TLT_CPL_SDF_K', self.cpl_k.get())
        self.log_st(f'[耦合] EN={self.cpl_en.get()} K={self.cpl_k.get():.2f}')

    # ─────────────────── 任务 ──────────────────────────────

    def _toggle_motor_group(self, ids, clear=False):
        if clear:
            for m in self.motor_chk: self.motor_chk[m].set(0)
            return
        # 如全已选 → 反选, 否则全选
        all_on = all(self.motor_chk[m].get() for m in ids)
        for m in ids: self.motor_chk[m].set(0 if all_on else 1)

    def _toggle_tilt_group(self, ids, clear=False):
        if clear:
            for nm in self.tilt_chk: self.tilt_chk[nm].set(0)
            return
        all_on = all(self.tilt_chk[nm].get() for nm in ids)
        for nm in ids: self.tilt_chk[nm].set(0 if all_on else 1)

    def _motor_mask(self):
        mask = 0
        for m in self.motor_chk:
            if self.motor_chk[m].get():
                mask |= (1 << (m - 1))
        return mask

    def _tilt_mask(self):
        mask = 0
        for i, (nm, _, _) in enumerate(TILT_LIST):
            if self.tilt_chk[nm].get():
                mask |= (1 << i)
        return mask

    def push_task(self):
        if not self._need_fc(): return
        m_mask = self._motor_mask()
        t_mask = self._tilt_mask()
        if m_mask == 0:
            messagebox.showwarning('未选电机', '至少要勾一个电机')
            return
        t = self.task
        n_ang = int(t['n_ang'].get())
        params = [
            ('MSAK_EN', 0), ('MSAK_SW_ARM', 0),
            ('MSAK_CAL_CH', 0), ('MSAK_CAL_PWM', 0),
            ('MSAK_MOTOR_MSK', m_mask),
            ('MSAK_TILT_MSK',  t_mask),
            ('MSAK_ANG_N',     n_ang),
            ('MSAK_THR_START', t['thr_start'].get()),
            ('MSAK_THR_MAX',   t['thr_max'].get()),
            ('MSAK_THR_STEP',  t['thr_step'].get()),
            ('MSAK_HOLD_MS',   t['hold_ms'].get()),
            ('MSAK_RAMP_MS',   t['ramp_ms'].get()),
            ('MSAK_RAMP_DN',   t['ramp_dn'].get()),
            # (撤) MSAK_TILT_FIX: 未选中 tilt 自动维持 boot 默认
        ]
        for i in range(8):
            params.append((f'MSAK_ANG_{i+1}', t['angles'][i].get()))
        params.append(('MSAK_EN', 1))
        ok = all(self._set_param_safe(n, v) for n, v in params)
        ms = [str(m) for m in range(1, 13) if m_mask & (1 << (m-1))]
        ts = [nm for i, (nm, _, _) in enumerate(TILT_LIST) if t_mask & (1 << i)]
        ang_str = ','.join(f'{t["angles"][i].get():.0f}' for i in range(n_ang))
        self.log_st(f'[任务] 电机=[{",".join(ms)}] 倾转=[{",".join(ts) or "无"}] '
                    f'角度=[{ang_str}] 油门={t["thr_start"].get():.2f}→{t["thr_max"].get():.2f}'
                    f'/step{t["thr_step"].get():.2f} hold={t["hold_ms"].get()}ms · '
                    f'{"成功" if ok else "部分失败"}')
        self.set_status('任务已下发 · 等 RC 解锁 或 软触发', 'success')

        # 启录制 — 不管 sensor 在不在线都录 (fc 端 PWM + STATE 是核心)
        if ok and self.fc:
            extra_config = {
                '起始油门 (THR_START)': f'{t["thr_start"].get():.2f}',
                '终点油门 (THR_MAX)':   f'{t["thr_max"].get():.2f}',
                '步进 (THR_STEP)':      f'{t["thr_step"].get():.2f}',
                '每档保持 (HOLD)':      f'{t["hold_ms"].get()} ms',
                '启动 ramp (RAMP_MS)':  f'{t["ramp_ms"].get()} ms',
                '结束缓降 (RAMP_DN)':   f'{t["ramp_dn"].get()} ms',
                '电机 mask (bit)':      f'{m_mask}',
                '倾转 mask (bit)':      f'{t_mask}',
                '电机详单':              ','.join(f'M{m}' for m in range(1,13) if m_mask & (1 << (m-1))),
                '倾转详单':              ','.join(nm for i,(nm,_,_) in enumerate(TILT_LIST) if t_mask & (1<<i)) or 'none',
                '角度数 (ANG_N)':       f'{n_ang}',
                '角度列表':              ang_str,
                'S→DF 解耦 EN':         f'{self.cpl_en.get()}',
                'S→DF 解耦 K':          f'{self.cpl_k.get():.2f}',
            }
            self._start_recording(motors_str='-'.join(ms),
                                  tilts_str='-'.join(ts) or 'none',
                                  angles_str=ang_str.replace(',', '-'),
                                  thr_range=f'{int(t["thr_start"].get()*100)}-{int(t["thr_max"].get()*100)}',
                                  config=extra_config)

    def _start_recording(self, motors_str, tilts_str, angles_str, thr_range, config=None):
        if self._recording:
            return
        try:
            path = self.recorder.start_task(motors_str, tilts_str, angles_str, thr_range,
                                            config=config)
        except Exception as e:
            self.log_st(f'[录制] 启动失败: {e}')
            return
        self._recording = True
        self._stop_record.clear()
        self._record_thread = threading.Thread(target=self._record_loop, daemon=True)
        self._record_thread.start()
        self.log_st(f'[录制] 开始 → {os.path.basename(path)}')

    def _record_loop(self):
        """10Hz 抓 sensor + servo PWM, 写 CSV. 直到 _stop_record."""
        t0 = time.time()
        pwm_1_16 = [0] * 16
        pwm_17_21 = [0] * 5
        while not self._stop_record.is_set():
            try:
                sensor_vals = self.sensor.get_latest() if self.sensor else {}
                if self.fc:
                    servo = self.fc.latest_servo()
                    if servo and servo.pwm:
                        pwm_1_16 = list(servo.pwm[:16])
                        pwm_17_21 = list(servo.pwm[16:21])
                battery = self.fc.latest_battery() if self.fc else None
                self.recorder.write_task(
                    t_pc=time.time() - t0,
                    sensor=sensor_vals,
                    pwm_1_16=pwm_1_16, pwm_17_21=pwm_17_21,
                    phase=self._cur_phase,
                    ang_idx=self._cur_ang_idx,
                    ang_deg=self._cur_ang_deg,
                    thr_pct=self._cur_thr,
                    battery=battery,
                    fc_status='',
                )
            except Exception as e:
                pass
            time.sleep(0.1)

    def _stop_recording(self):
        if not self._recording:
            return
        self._stop_record.set()
        if self._record_thread:
            self._record_thread.join(timeout=2.0)
        try:
            path, n = self.recorder.end_point()
            self.log_st(f'[录制] 结束 · {n} 行 → {os.path.basename(path)}')
        except Exception as e:
            self.log_st(f'[录制] 收尾错: {e}')
        self._recording = False
        self._cur_phase = 'IDLE'

    def _parse_bench_status(self, txt):
        """从 'BENCH ang[1/2]=30.0 thr=15%' 提 ang_idx / ang / thr."""
        import re
        m = re.search(r'ang\[(\d+)/\d+\]=(-?[\d.]+)\s+thr=(\d+)%', txt)
        if m:
            self._cur_ang_idx = int(m.group(1))
            self._cur_ang_deg = float(m.group(2))
            self._cur_thr = float(m.group(3))
        if 'RAMP_UP' in txt: self._cur_phase = 'RAMP_UP'
        elif 'HOLD' in txt:  self._cur_phase = 'HOLD'
        elif 'RAMP_DOWN' in txt: self._cur_phase = 'RAMP_DOWN'
        elif 'DONE' in txt:
            self._cur_phase = 'DONE'
            self._stop_recording()
        elif 'ABORT' in txt:
            self._cur_phase = 'ABORT'
            self._stop_recording()
        elif 'START' in txt:
            self._cur_phase = 'START'

    def task_sw_trigger(self):
        if not self._need_fc(): return
        if not messagebox.askyesno('确认软触发',
                '即将软件 arm 触发任务 (不需 RC 解锁).\n\n'
                '⚠ 确认机身已机械固定到台架! 继续?'):
            return
        # 强制 0 → 1 边沿: 即使上次 SW_ARM 还是 1 (task 没回 IDLE),
        # 也保证 lua 看到 false→true 跃迁触发新任务
        self._set_param_safe('MSAK_SW_ARM', 0)
        time.sleep(0.3)
        self._set_param_safe('MSAK_SW_ARM', 1)
        self.log_st('[任务] 软触发 (0→1 边沿)')

    def task_sw_stop(self):
        if not self._need_fc(): return
        self._set_param_safe('MSAK_SW_ARM', 0)
        self.log_st('[任务] 软停止 SW_ARM=0')

    # ─────────────────── 紧急 + 显示 ──────────────────────

    def emergency_stop(self):
        try:
            if self.fc:
                self._set_param_safe('MSAK_SW_ARM', 0)
                self._set_param_safe('MSAK_EN', 0)
                self._set_param_safe('MSAK_CAL_CH', 0)
                self._set_param_safe('MSAK_CAL_PWM', 0)
        except Exception: pass
        self.set_status('⛔ 紧急停止 · EN=0 · 请同时 RC 锁定', 'danger')
        self.log_st('!! 紧急停止已下发 !!')

    def log_st(self, msg):
        self.txt_st.insert('end', f'{time.strftime("%H:%M:%S")}  {msg}\n')
        self.txt_st.see('end')

    def set_status(self, msg, style='subtle'):
        m = {'subtle':'Subtle.TLabel', 'success':'Success.TLabel', 'danger':'Danger.TLabel'}
        self.lbl_status.config(text=msg, style=m.get(style, 'Subtle.TLabel'))

    def _update_display(self):
        # 传感器实时 (sensor 连了就更新, 跟 fc 状态无关; 显在底部条 + Live tab 大字)
        if self.sensor is not None:
            try:
                latest = self.sensor.get_latest()
                txt = (f'CH1 = {latest.get(1, "—"):>10}    '
                       f'CH2 = {latest.get(2, "—"):>10}    '
                       f'CH3 = {latest.get(3, "—"):>10}')
                self.lbl_bot_sensor.config(text=txt)
                if hasattr(self, 'lbl_sensor_vals'):
                    self.lbl_sensor_vals.config(text=txt)
            except Exception: pass
        else:
            self.lbl_bot_sensor.config(text='— 传感器未连接 —')

        if self._connected and self.fc:
            try:
                # 电池实时
                batt = self.fc.latest_battery()
                if batt and batt.voltage_v > 0:
                    pct_str = f'{batt.remaining_pct}%' if batt.remaining_pct >= 0 else '—'
                    self.lbl_bot_batt.config(text=(
                        f'电压 = {batt.voltage_v:>5.2f} V    '
                        f'电流 = {batt.current_a:>6.2f} A    '
                        f'功率 = {batt.voltage_v * batt.current_a:>6.1f} W    '
                        f'剩余 = {pct_str:>4s}    '
                        f'消耗 = {batt.consumed_mah:>5.0f} mAh'
                    ))
                else:
                    self.lbl_bot_batt.config(text='— 飞控未返回电池数据 (检查 BATT_MONITOR) —')
                servo = self.fc.latest_servo()
                if servo:
                    # pwm[0..15]=ch1-16, pwm[16..31]=ch17-32
                    m_line = '  '.join(f'M{i+1:02d}={servo.pwm[i]:>4}' for i in range(12))
                    t_line = '  '.join(f'T{ch:02d}={servo.pwm[ch-1]:>4}' for _, ch, _ in TILT_LIST)
                    self.lbl_pwm_motors.config(text=f'电机 (CH1-12): {m_line}')
                    self.lbl_pwm_tilts.config(text=f'倾转 (CH13-21): {t_line}')
                    # 同步刷 cal 卡片的 "FC 实测 PWM"
                    for nm, ch, _ in TILT_LIST:
                        w = self._cal_widgets.get(nm)
                        if w and 'lbl_pwm_actual' in w:
                            w['lbl_pwm_actual'].config(text=f'{servo.pwm[ch-1]} μs')
                for _, sev, txt in self.fc.drain_statustext():
                    # 全部 STATUSTEXT 显示 (除 PreArm 噪音重复 / STT 心跳)
                    if 'STT:' in txt: continue
                    if 'PreArm' in txt and 'Waiting' in txt:
                        # 把 Waiting for RC 这种重复消息只显 1 次 / 5s
                        now = time.time()
                        if now - getattr(self, '_last_prearm_log', 0) < 5:
                            continue
                        self._last_prearm_log = now
                    sev_tag = {0:'急', 1:'警', 2:'关', 3:'错', 4:'告', 5:'注', 6:'信', 7:'调'}.get(sev, str(sev))
                    self.log_st(f'飞控[{sev_tag}]: {txt}')
                    if 'BENCH' in txt:
                        self._parse_bench_status(txt)
            except Exception: pass
        self._root.after(200, self._update_display)

    def run(self):
        self._root.protocol('WM_DELETE_WINDOW', self.on_close)
        self._root.mainloop()

    def on_close(self):
        if self._connected:
            self.emergency_stop()
            try:
                if self.fc: self.fc.close()
                if self.sensor: self.sensor.close()
            except Exception: pass
        self._root.destroy()


def main():
    ap = argparse.ArgumentParser(description='MantaShark 台架标定上位机 v6')
    ap.add_argument('--fc',     default='/dev/ttyACM0')
    ap.add_argument('--sensor', default='/dev/ttyUSB0')
    ap.add_argument('--out',    default='./bench_logs')
    args = ap.parse_args()
    BenchApp(args.fc, args.sensor, args.out).run()


if __name__ == '__main__':
    main()
