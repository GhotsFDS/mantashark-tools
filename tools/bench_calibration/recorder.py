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

    def end_point(self) -> tuple[str, int]:
        if self._fh:
            self._fh.close()
            self._fh = None
            self._writer = None
        return self._path, self._row_count
