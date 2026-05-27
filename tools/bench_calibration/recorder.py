"""CSV recorder for bench test points.

Each test point gets its own CSV file. Columns include sensor 3-channel,
servo PWM (16 channels), commanded mode/motor/tilt/thr, status.
"""

from __future__ import annotations

import csv
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class RecordRow:
    t_pc: float
    sensor: dict[int, float] = field(default_factory=dict)   # channel addr → value
    servo_pwm: list[int] = field(default_factory=list)       # 16-ch PWM
    cmd: dict = field(default_factory=dict)                  # mode/motor/tilt_sgrp/tilt_df/thr_tgt
    fc_status: str = ''


class Recorder:
    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        os.makedirs(output_dir, exist_ok=True)
        self._writer: Optional[csv.DictWriter] = None
        self._fh = None
        self._path: Optional[str] = None
        self._row_count = 0

    def start_task(self, motors_str: str, tilts_str: str, angles_str: str,
                   thr_range_str: str, config: Optional[dict] = None):
        """启动一个任务录制. 文件名含 task 配置摘要; CSV 顶部嵌 # 注释块."""
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        fname = f'bench_{ts}_M{motors_str}_T{tilts_str}_A{angles_str}_thr{thr_range_str}.csv'
        fname = fname.replace(' ', '').replace('/', '-')[:200]
        if not fname.endswith('.csv'): fname += '.csv'
        self._path = os.path.join(self.output_dir, fname)
        self._fh = open(self._path, 'w', newline='')
        # ── 头部 # 注释块: 任务配置 + 时间 + 备注 ────────
        ts_full = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        self._fh.write(f'# MantaShark 台架标定记录\n')
        self._fh.write(f'# 时间: {ts_full}\n')
        self._fh.write(f'# ─── 任务配置 ───\n')
        self._fh.write(f'# 电机选: {motors_str}\n')
        self._fh.write(f'# 倾转选: {tilts_str}\n')
        self._fh.write(f'# 扫描角度: {angles_str} 度\n')
        self._fh.write(f'# 油门范围: {thr_range_str} %\n')
        if config:
            for k, v in config.items():
                self._fh.write(f'# {k}: {v}\n')
        self._fh.write(f'# ──────────────\n')
        # ── 数据列头 ──
        fields = ['t_pc', 's1', 's2', 's3']
        for i in range(1, 22):
            fields.append(f'pwm{i}')
        fields += ['phase', 'ang_idx', 'ang_deg', 'thr_pct', 'fc_status']
        self._writer = csv.DictWriter(self._fh, fieldnames=fields)
        self._writer.writeheader()
        self._row_count = 0
        return self._path

    # 旧 API 保留 (单点录制)
    def start_point(self, mode: int, motor: int, tilt_sgrp: float, tilt_df: float, thr: float):
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        fname = f'bench_{ts}_mode{mode}_m{motor}_sgrp{int(tilt_sgrp)}_df{int(tilt_df)}_thr{int(thr*100)}.csv'
        self._path = os.path.join(self.output_dir, fname)
        self._fh = open(self._path, 'w', newline='')
        fields = ['t_pc', 's1', 's2', 's3']
        for i in range(1, 17):
            fields.append(f'pwm{i}')
        fields += ['cmd_mode', 'cmd_motor', 'cmd_sgrp', 'cmd_df', 'cmd_thr', 'fc_status']
        self._writer = csv.DictWriter(self._fh, fieldnames=fields)
        self._writer.writeheader()
        self._row_count = 0

    def write(self, row: RecordRow):
        """旧单点 row 兼容 (CH 1-16)"""
        if self._writer is None:
            return
        d = {'t_pc': f'{row.t_pc:.4f}',
             's1': row.sensor.get(1, ''),
             's2': row.sensor.get(2, ''),
             's3': row.sensor.get(3, '')}
        for i in range(1, 17):
            d[f'pwm{i}'] = row.servo_pwm[i - 1] if i <= len(row.servo_pwm) else ''
        d['cmd_mode'] = row.cmd.get('mode', '')
        d['cmd_motor'] = row.cmd.get('motor', '')
        d['cmd_sgrp'] = row.cmd.get('tilt_sgrp', '')
        d['cmd_df'] = row.cmd.get('tilt_df', '')
        d['cmd_thr'] = row.cmd.get('thr_tgt', '')
        d['fc_status'] = row.fc_status
        self._writer.writerow(d)
        self._row_count += 1

    def write_task(self, t_pc, sensor, pwm_1_16, pwm_17_21, phase, ang_idx, ang_deg, thr_pct, fc_status=''):
        """v8 任务录: CH 1-21 全 PWM + phase 信息."""
        if self._writer is None:
            return
        d = {'t_pc': f'{t_pc:.4f}',
             's1': sensor.get(1, ''), 's2': sensor.get(2, ''), 's3': sensor.get(3, '')}
        for i in range(1, 17):
            d[f'pwm{i}'] = pwm_1_16[i - 1] if i <= len(pwm_1_16) else ''
        for i in range(17, 22):
            idx = i - 17
            d[f'pwm{i}'] = pwm_17_21[idx] if idx < len(pwm_17_21) else ''
        d['phase']   = phase
        d['ang_idx'] = ang_idx
        d['ang_deg'] = ang_deg
        d['thr_pct'] = thr_pct
        d['fc_status'] = fc_status
        self._writer.writerow(d)
        self._row_count += 1

    def end_point(self) -> tuple[str, int]:
        if self._fh:
            self._fh.close()
            self._fh = None
            self._writer = None
        return self._path, self._row_count
