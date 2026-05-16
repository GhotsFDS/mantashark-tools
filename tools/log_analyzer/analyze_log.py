#!/usr/bin/env python3
"""
MantaShark 飞行日志自动分析 v2

测试阶段专用：每一刻看清楚曲线状态、开关位置、各组涵道行为、姿态。
不只是检错，更要帮你理解曲线和实际飞行的差异。

读取 ArduPilot dataflash log (.BIN)，输出：
  - SERVO 配置检查
  - 各组涵道 PWM 输出范围 + 死通道检测
  - 飞行阶段自动识别（静止/滑跑/驼峰/离水/巡航）
  - 每个阶段的统计（持续时间、姿态、油门、速度变化）
  - 开关位置时间线（mode/gear/auto）
  - 油门 vs 速度对比（驼峰检测）
  - KRD 抬尾权限验证
  - 关键事件列表
  - 可选图表

用法：
  python3 analyze_log.py LOGS/00000036.BIN
  python3 analyze_log.py LOGS/00000036.BIN --plot
  python3 analyze_log.py LOGS/00000036.BIN --csv  # 导出 CSV
"""

import sys
import os
import re
import argparse
import math
from collections import defaultdict

# Windows: 强制 stdout/stderr 用 UTF-8 (避免 cp1252 编码错误)
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except (AttributeError, OSError):
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from pymavlink import DFReader
except ImportError:
    print("ERROR: pymavlink not installed. Run: pip install pymavlink")
    sys.exit(1)

# ─── 涵道分组（与 Lua 一致）───
# v9 P4: 12 EDF 4 组 (KDM 已删, motor 7-8 重映射为 TL1/TL2 = KT 组)
MOTOR_GROUPS = {
    'KS':  {'name':'斜吹',     'channels':[1,2,3,4],         'angle_body':37},
    'KDF': {'name':'前下吹',   'channels':[5,6],             'angle_body':90},
    'KT':  {'name':'后推',     'channels':[7,8,9,10],        'angle_body':0},
    'KRD': {'name':'后斜下',   'channels':[11,12],           'angle_body':30},
}

# 实测推力表 (24V 6S 满电, QF2822 64mm) — 共享自 sim/edf_thrust.py
# 单一权威源, 离线分析 + Gazebo + Lua sim 都用这一份
_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
sys.path.insert(0, os.path.join(_REPO_ROOT, 'sim'))
try:
    from edf_thrust import THRUST_TABLE as THROTTLE_THRUST, thrust_per_fan_pwm as thrust_per_fan, _interp as interp  # type: ignore
except ImportError:
    # Fallback: 旧实测表 (PyInstaller onefile 兜底)
    THROTTLE_THRUST = [
        (0.00, 0.00), (0.50, 7.36), (0.60, 10.30), (0.70, 13.54),
        (0.80, 16.87), (0.90, 20.40), (1.00, 23.25),
    ]
    def interp(table, x):
        if x <= 0: return 0
        if x >= 1: return table[-1][1]
        for i in range(len(table)-1):
            x0,y0 = table[i]; x1,y1 = table[i+1]
            if x <= x1:
                t = (x - x0)/(x1 - x0)
                return y0 + (y1 - y0)*t
        return table[-1][1]
    def thrust_per_fan(pwm):
        if pwm < 1050: return 0
        throttle = max(0, min(1, (pwm - 1000) / 1000))
        return interp(THROTTLE_THRUST, throttle)

# 颜色（终端 ANSI）
class C:
    RED='\033[91m'; GRN='\033[92m'; YEL='\033[93m'; BLU='\033[94m'
    CYN='\033[96m'; MAG='\033[95m'; BOLD='\033[1m'; END='\033[0m'

def colored(text, color):
    return f"{color}{text}{C.END}" if sys.stdout.isatty() else text


class LogAnalyzer:
    def __init__(self, path):
        self.path = path
        self.first_t = None
        self.modes = []
        self.events = []
        self.errors = []
        self.params = {}
        # ═══ pitch 坐标系警告 (memory: feedback_ahrs_pitch_is_body.md) ═══
        # ATT.Pitch 在 VTOL 模式是 VIEW 帧 (= body - Q_TRIM_PITCH), Plane.Log_Write_Attitude:14-23
        # 调 ahrs_view->Write_AttitudeView(...). 跟 MAVLink ATTITUDE.pitch 同源.
        # 要 body 绝对角度, 用 MSK4.pa (我们 lua 写的, ahrs:get_pitch_rad() = body), 或 ATT.Pitch + Q_TRIM_PITCH.
        self.att = []      # (t, roll, pitch_view, yaw, des_pitch)  pitch_view (VTOL): = body - Q_TRIM_PITCH
        self.msk4 = []     # (t, pa_body_deg, pb_target_deg, po, ra_body_deg, ro, yo, to) — body 帧, 都 deg (P7.8n+ 单位统一)
        self.msk5 = []     # (t, v_tgt, v_act, v_err, kt_corr, layer) — V_PI 速度环状态 (1Hz)
        self.msk6 = []     # (t, ks_d, kdf_d, kt_d, krd_d) — K_drift 4 路 (50Hz)
        self.msk8 = []     # (t, mode, v_tgt, base_pitch, layer) — dispatcher mode + phase 状态
        self.msk_phase_changes = []   # (t, phase_int)  MSKP — wig_auto phase 切换 marker
        self.msk_run_starts = []      # (t, cruise, strat, profile, v_tgt)  MSKR — armed 边沿 run 配置 latch
        self.gps = []      # (t, spd, alt)
        self.rcin = []     # (t, ch1..ch19)
        self.rcou = []     # (t, ch1..ch19)  19 = MantaShark v9 7 倾转占 SERVO13-19
        self.bat = []      # (t, voltage, current)
        self.armed_periods = []
        self.warnings = []
        # v9 P4: MSK7 = tilt 实际角度 abs° (commanded/actual × 7 路 + S→DF 补偿)
        self.msk7 = []     # (t, cDl,cDr,cTl,cTr,cRl,cRr,cS, aDl,aDr,aTl,aTr,aRl,aRr,aS, CMP)
        # v3+ 固件: MSK Lua 事件 (来自 MSG 文本)
        self.msk_mode_changes = []    # (t, mode_name)  NOGPS/GPS_WEAK/GPS_FULL
        self.msk_gear_changes = []    # (t, gear)
        self.msk_auto_changes = []    # (t, 'ON'|'OFF')
        self.msk_chk_events = []      # (t, stage_label)  'CHK: STAGE 1 ...', 'CHK 1.3/5 ...'
        self.msk_emergency = []       # (t, 'STOP'|'released')
        self.msk_errors = []          # (t, err_text)  MSK ERR: ...
        self.msk_att_guard = []       # (t, pitch, target, roll, corr)  ATT GUARD 事件
        # v8 新增 (1Hz K 心跳 + RTL)
        self.msk_k_history = []       # (t, S, DF, T, RD, spd_eff, spd_real)
        self.msk_rtl_changes = []     # (t, 'ACTIVE'|'released')

    def parse(self):
        log = DFReader.DFReader_binary(self.path)
        while True:
            m = log.recv_msg()
            if m is None: break
            t = m.get_type()
            if hasattr(m, 'TimeUS'):
                if self.first_t is None: self.first_t = m.TimeUS
                ts = (m.TimeUS - self.first_t) / 1e6
            else:
                continue
            if t == 'PARM':
                self.params[m.Name] = m.Value
            elif t == 'MODE':
                # P7.8p: ArduPilot 自定义 mode 17/27/29 在 BIN 显示 "Mode(N)" 字符串, 这里解码
                num = getattr(m, 'ModeNum', None)
                name = m.Mode
                if isinstance(name, str) and name.startswith('Mode('):
                    # 自定义 mode 标准名 fallback
                    name = {17:'MANUAL(QSTAB)', 27:'AUTO(WIG_AUTO)', 29:'RECV(WIG_RECV)'}.get(num, name)
                self.modes.append((ts, name, num))
            elif t == 'EV':
                self.events.append((ts, m.Id))
            elif t == 'ERR':
                self.errors.append((ts, m.Subsys, m.ECode))
            elif t == 'ATT':
                # m.Pitch 是 VIEW 帧 (VTOL 模式, = body - Q_TRIM_PITCH). 实际 body 用 MSK4.pa 或 + Q_TRIM_PITCH
                self.att.append((ts, m.Roll, m.Pitch, m.Yaw, getattr(m,'DesPitch',0)))
            elif t == 'MSK4':
                # lua 自定义 BIN (P7.8n+): pa=body pitch deg, pb=target deg, po/ra/ro/yo/to. body err = pb - pa.
                # 旧 P6/P7.5- BIN pa 是 rad 单位混杂 bug, 分析旧 log 看到 pa<2 大概率是 rad → 自动转 deg
                try:
                    pa = m.pa
                    ra = m.ra
                    if abs(pa) < 2 and abs(ra) < 2:  # 旧 log rad 兼容 (deg 通常 > 2)
                        pa = pa * 57.2958
                        ra = ra * 57.2958
                    self.msk4.append((ts, pa, m.pb, m.po, ra, m.ro, m.yo, m.to))
                except AttributeError:
                    pass
            elif t == 'MSK5':
                # V_PI 速度环 1Hz 状态: v_tgt / v_actual / err / kt_correction / accel_layer
                try:
                    self.msk5.append((ts, m.vt, m.va, m.ve, m.ko, m.la))
                except AttributeError:
                    pass
            elif t == 'MSK6':
                # K_drift 50Hz: 4 路偏移值
                try:
                    self.msk6.append((ts, m.ksd, m.kdd, m.ktd, m.krd))
                except AttributeError:
                    pass
            elif t == 'MSK8':
                # dispatcher mode + V_TGT + base_pitch + layer (50Hz)
                try:
                    self.msk8.append((ts, m.mode, m.vtd, m.bpc, m.lay))
                except AttributeError:
                    pass
            elif t == 'MSKP':
                # WIG_AUTO phase 切换 marker (state machine 状态分析)
                try:
                    self.msk_phase_changes.append((ts, m.phase))
                except AttributeError:
                    pass
            elif t == 'MSKR':
                # WIG_AUTO armed 边沿 run config latch: cruise_mode / strat / profile / v_tgt
                try:
                    self.msk_run_starts.append((ts, m.mode, m.strat, m.prof, m.vtgt))
                except AttributeError:
                    pass
            elif t == 'GPS':
                self.gps.append((ts, m.Spd, m.Alt))
            elif t == 'RCIN':
                # ArduPlane 4.7 32-channel: RCIN.C1-14, RCIN2.C15-32. 这里只 C1-14 就够 (用户用 ch1-7).
                self.rcin.append((ts, *[getattr(m,f'C{i}',0) for i in range(1,17)]))
            elif t == 'RCOU':
                # ArduPlane 4.7+: RCOU 含 C1-C14 (SERVO 1-14), RCO2/RCO3 拆出后续
                # 这里建一帧 (t, ch1..ch19), C15-C19 先填 0, 等 RCO2/RCO3 来 patch
                vals = [getattr(m, f'C{i}', 0) for i in range(1, 15)]  # C1-C14 真实
                vals.extend([0, 0, 0, 0, 0])  # C15-C19 占位
                self.rcou.append((ts,) + tuple(vals))
            elif t == 'RCO2':
                # ArduPlane 4.7+ RCO2.C15-C18 = SERVO 15-18
                if self.rcou:
                    last = list(self.rcou[-1])
                    # last = [t, ch1, ch2, ..., ch19] (1 + 19 = 20 长度)
                    # ch_i 在 last[i] (1-indexed offset), C15 → last[15]
                    for ch in (15, 16, 17, 18):
                        v = getattr(m, f'C{ch}', 0)
                        if v: last[ch] = v
                    self.rcou[-1] = tuple(last)
            elif t == 'RCO3':
                # ArduPlane 4.7+ RCO3.C19+ = SERVO 19+
                if self.rcou:
                    last = list(self.rcou[-1])
                    v = getattr(m, 'C19', 0)
                    if v: last[19] = v
                    self.rcou[-1] = tuple(last)
            elif t == 'BAT':
                self.bat.append((ts, m.Volt, getattr(m,'Curr',0)))
            elif t == 'MSK7':
                # v9 P4: tilt 实际角度 abs° (相对机身), commanded/actual × 7 路
                try:
                    self.msk7.append((ts,
                        m.cDl, m.cDr, m.cTl, m.cTr, m.cRl, m.cRr, m.cS,
                        m.aDl, m.aDr, m.aTl, m.aTr, m.aRl, m.aRr, m.aS,
                        getattr(m, 'CMP', 0)))
                except AttributeError:
                    pass
            elif t == 'MSG':
                self._parse_msg(ts, getattr(m, 'Message', ''))
        self.duration = ts if self.first_t else 0

    # ─── v7-v8 兼容 (老 BIN 还能解析, P5+ 不再产生) ───
    _RE_MSK_MODE_OLD = re.compile(r'^MSK(?::\s*|\s+mode\s*->\s*)(NOGPS|GPS_WEAK|GPS_FULL|GPS)(?:\s*\(curve\))?\s*(?:GEAR\s*(\d+)|gear=(\d+))?')
    _RE_MSK_GEAR_OLD = re.compile(r'^MSK\s+gear\s*->\s*(\d+)')
    _RE_MSK_AUTO_OLD = re.compile(r'^MSK(?::\s*AUTO\s+(ON|OFF)|\s+auto\s*->\s*(AUTO|MANUAL))')
    _RE_MSK_CHK_OLD  = re.compile(r'^MSK\s*CHK[:\s].*')
    _RE_MSK_STOP_OLD = re.compile(r'^MSK:\s*EMERGENCY STOP')
    _RE_MSK_REL_OLD  = re.compile(r'^MSK:\s*emergency released')
    _RE_MSK_K_HB_OLD = re.compile(r'^MSK\s+K:\s*S=(\d+)\s+DF=(\d+)\s+T=(\d+)\s+RD=(\d+).*?spd=([\d.]+)/([\d.]+)')
    _RE_MSK_RTL_OLD  = re.compile(r'^MSK\s+RTL\s+(ACTIVE|released)')
    _RE_ATT_GUARD    = re.compile(r'^ATT GUARD:\s*P=([-0-9.]+)\(t=([-0-9.]+)\)\s*R=([-0-9.]+)\s*corr=([-0-9.]+)')
    _RE_LUA_ERR      = re.compile(r'^Lua:\s*.*?:(\d+):\s*(.*)')
    _RE_MSK_ERR      = re.compile(r'^MSK ERR:\s*(.*)')

    # ─── v9 P6+ 新 STATUSTEXT (WIG dispatcher / phase / emergency) ───
    _RE_WIG_DISPATCH = re.compile(r'^WIG dispatcher:\s*([-\d]+)\s*->\s*(\d+)')      # 17/27/29 mode 切换
    _RE_WIG_PHASE    = re.compile(r'^WIG_AUTO phase\s*[→\->]+\s*(\w+)')             # FLOAT_TAXI/TRANS_A 等
    _RE_WIG_RUN      = re.compile(r'^WIG_AUTO start:\s*profile=(\w+)\s+cruise=(\w+)\s+strat=(\w+)\s+V_TGT=([\d.]+)')
    _RE_WIG_EMRG     = re.compile(r'^(?:WIG_AUTO L3 EMERG|MANUAL EMERG):\s*(.*)')
    _RE_WIG_RECV     = re.compile(r'^WIG RECOVER:\s*throttle ramp')
    _RE_WIG_ABORT    = re.compile(r'^WIG_AUTO\s+\S+\s*timeout\s*→\s*ABORT')

    def _parse_msg(self, ts, text):
        if not text: return

        # ═══ v9 P6+ 新 pattern (优先匹配, 现役格式) ═══
        m = self._RE_WIG_DISPATCH.match(text)
        if m:
            # mode_changes 记 ArduPilot mode 切换 (17 MANUAL / 27 AUTO / 29 RECV)
            new_mode = int(m.group(2))
            mode_name = {17:'MANUAL', 27:'AUTO', 29:'RECV'}.get(new_mode, f'mode{new_mode}')
            if not self.msk_mode_changes or self.msk_mode_changes[-1][1] != mode_name:
                self.msk_mode_changes.append((ts, mode_name))
            return
        m = self._RE_WIG_PHASE.match(text)
        if m:
            # phase 切换文本记录 (MSKP marker 是数字; 这里是字符串)
            self.msk_chk_events.append((ts, f'WIG_AUTO phase → {m.group(1)}'))
            return
        m = self._RE_WIG_RUN.match(text)
        if m:
            # armed 边沿 latch run config (跟 MSKR BIN marker 互补)
            self.msk_auto_changes.append((ts, f'AUTO start: profile={m.group(1)} cruise={m.group(2)} strat={m.group(3)} V_TGT={m.group(4)}'))
            return
        if self._RE_WIG_EMRG.match(text):
            self.msk_emergency.append((ts, 'EMERG ' + text[:80]))
            return
        if self._RE_WIG_RECV.match(text):
            self.msk_emergency.append((ts, 'RECV ramp'))
            return
        if self._RE_WIG_ABORT.match(text):
            self.msk_chk_events.append((ts, 'ABORT_L1: ' + text[:80]))
            return

        # ═══ v7-v8 老 pattern (兼容旧 BIN, P5+ 不产生但留着不影响) ═══
        m = self._RE_MSK_MODE_OLD.match(text)
        if m:
            mode = m.group(1); gear = m.group(2) or m.group(3)
            if not self.msk_mode_changes or self.msk_mode_changes[-1][1] != mode:
                self.msk_mode_changes.append((ts, mode))
            if gear and (not self.msk_gear_changes or self.msk_gear_changes[-1][1] != int(gear)):
                self.msk_gear_changes.append((ts, int(gear)))
            return
        m = self._RE_MSK_GEAR_OLD.match(text)
        if m:
            g = int(m.group(1))
            if not self.msk_gear_changes or self.msk_gear_changes[-1][1] != g:
                self.msk_gear_changes.append((ts, g))
            return
        m = self._RE_MSK_AUTO_OLD.match(text)
        if m:
            v = m.group(1) or m.group(2)
            self.msk_auto_changes.append((ts, v))
            return
        m = self._RE_MSK_K_HB_OLD.match(text)
        if m:
            self.msk_k_history.append((ts,
                int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)),
                float(m.group(5)), float(m.group(6))))
            return
        m = self._RE_MSK_RTL_OLD.match(text)
        if m:
            self.msk_rtl_changes.append((ts, m.group(1)))
            return
        if self._RE_MSK_CHK_OLD.match(text):
            self.msk_chk_events.append((ts, text.strip()))
            return
        if self._RE_MSK_STOP_OLD.match(text):
            self.msk_emergency.append((ts, 'STOP'))
            return
        if self._RE_MSK_REL_OLD.match(text):
            self.msk_emergency.append((ts, 'released'))
            return

        # ═══ Lua / Plane 通用 ═══
        m = self._RE_MSK_ERR.match(text)
        if m:
            self.msk_errors.append((ts, m.group(1)))
            return
        m = self._RE_ATT_GUARD.match(text)
        if m:
            self.msk_att_guard.append((ts, float(m.group(1)), float(m.group(2)),
                                       float(m.group(3)), float(m.group(4))))
            return
        m = self._RE_LUA_ERR.match(text)
        if m:
            self.msk_errors.append((ts, f'LINE {m.group(1)}: {m.group(2)}'))

    def detect_armed_periods(self):
        EV_ARMED = 10; EV_DISARMED = 11
        armed_t = None
        for ts, eid in self.events:
            if eid == EV_ARMED:
                armed_t = ts
            elif eid == EV_DISARMED and armed_t is not None:
                self.armed_periods.append((armed_t, ts))
                armed_t = None
        if armed_t is not None:
            self.armed_periods.append((armed_t, self.duration))

    # ═══ 1. SERVO 配置 ═══
    def check_servo_config(self):
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  1. SERVO 配置检查", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        # v9 P4: 12 EDF (motor 1-12) + 7 倾转 (SERVO 13-19)
        # SERVO1-8 = motor function 33-40 (k_motor1..8)
        # SERVO9-12 = motor function 82-85 (k_motor9..12)
        # SERVO13-19 = scripting function 94-100 (k_scripting1..7)
        expected = {1:33,2:34,3:35,4:36,5:37,6:38,7:39,8:40,
                    9:82,10:83,11:84,12:85,
                    13:94, 14:95, 15:96, 16:97, 17:98, 18:99, 19:100}
        label = {1:'M1 SL1',2:'M2 SL2',3:'M3 SR1',4:'M4 SR2',
                 5:'M5 DFL',6:'M6 DFR',7:'M7 TL1',8:'M8 TL2',
                 9:'M9 TR1',10:'M10 TR2',11:'M11 RDL',12:'M12 RDR',
                 13:'TILT DFL (CAN)',14:'TILT DFR (CAN)',
                 15:'TILT TL1 (CAN)',16:'TILT TR1 (CAN)',
                 17:'TILT RDL (CAN)',18:'TILT RDR (CAN)',
                 19:'TILT SGRP (CAN)'}
        all_ok = True
        for ch, exp in expected.items():
            key = f'SERVO{ch}_FUNCTION'
            actual = self.params.get(key)
            if actual is None:
                status = colored("? 未知", C.YEL)
            elif int(actual) == 0:
                status = colored("✗ FUNCTION=0 (未配置！)", C.RED)
                self.warnings.append(f"{key}=0 通道不工作 ({label[ch]})")
                all_ok = False
            elif int(actual) != exp:
                status = colored(f"⚠ 期望{exp} 实际{int(actual)}", C.YEL)
                self.warnings.append(f"{key}={int(actual)} 应为 {exp} ({label[ch]})")
                all_ok = False
            else:
                status = colored("✓", C.GRN)
            print(f"  SERVO{ch:2d} {label[ch]:20s} FN={actual}  {status}")

        # CAN bitmap
        esc_bm = int(self.params.get('CAN_D1_UC_ESC_BM', 0))
        srv_bm = int(self.params.get('CAN_D1_UC_SRV_BM', 0))
        esc_na = self.params.get('CAN_D1_UC_ESC_NA')
        exp_esc = (1<<12)|(1<<13)  # 12288
        exp_srv = (1<<14)|(1<<15)  # 49152
        print()
        print(f"  CAN_D1_UC_ESC_BM = {esc_bm} (期望 {exp_esc})  " +
              (colored("✓", C.GRN) if esc_bm == exp_esc else colored("⚠", C.YEL)))
        print(f"  CAN_D1_UC_SRV_BM = {srv_bm} (期望 {exp_srv})  " +
              (colored("✓", C.GRN) if srv_bm == exp_srv else colored("⚠", C.YEL)))
        if esc_na is None:
            print(f"  CAN_D1_UC_ESC_NA = ? (上游固件, 未打 MantaShark patch)")
        else:
            na_status = colored("预检绕过启用", C.GRN) if int(esc_na) else colored("未启用 (默认)", C.YEL)
            print(f"  CAN_D1_UC_ESC_NA = {int(esc_na)}  [{na_status}]")
        return all_ok

    # ═══ 2. 涵道输出 ═══
    def check_motor_outputs(self):
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  2. 涵道输出范围（解锁时段）", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        if not self.armed_periods:
            print("  无解锁时段")
            return
        # Filter to armed periods
        is_armed = lambda ts: any(s <= ts <= e for s,e in self.armed_periods)
        for gname, gdef in MOTOR_GROUPS.items():
            vals = []
            for ts, *pwms in self.rcou:
                if not is_armed(ts): continue
                for ch in gdef['channels']:
                    vals.append(pwms[ch-1])
            if not vals:
                print(f"  {gname:4s} ({gdef['name']:5s}): 无数据")
                continue
            mn, mx = min(vals), max(vals)
            avg = sum(vals)/len(vals)
            mid = sum(1 for v in vals if 1100 <= v <= 1900) / len(vals) * 100
            status = colored("✓", C.GRN)
            if mx < 1000:
                status = colored("✗ DEAD", C.RED)
                self.warnings.append(f"{gname} 死通道（PWM<1000）")
            elif mx < 1100:
                status = colored("⚠ 几乎不动", C.YEL)
                self.warnings.append(f"{gname} 几乎无输出")
            elif mn > 1500 and gname == 'KRD':
                # Special: KRD stuck high might be wrong
                status = colored("⚠ KRD 一直高位", C.YEL)
            print(f"  {gname:4s} ({gdef['name']:5s}): "
                  f"min={mn:4.0f} max={mx:4.0f} avg={avg:6.0f}  "
                  f"工作区间 {mid:3.0f}%  {status}")

    # ═══ 3. 飞行阶段自动识别 ═══
    def detect_phases(self):
        """根据速度和姿态自动识别阶段"""
        phases = []  # (start, end, name, color)
        if not self.gps or not self.armed_periods:
            return phases
        # Build a unified speed timeline
        for arm_s, arm_e in self.armed_periods:
            samples = [(t,s) for t,s,a in self.gps if arm_s <= t <= arm_e]
            if len(samples) < 5: continue
            cur_phase = None
            cur_start = None
            for t, s in samples:
                if s < 1.5:
                    new_phase = "静止/漂浮"
                elif s < 5:
                    new_phase = "滑跑加速"
                elif s < 7:
                    new_phase = "接近驼峰"
                elif s < 9:
                    new_phase = "驼峰区"
                elif s < 11:
                    new_phase = "突破驼峰"
                elif s < 13:
                    new_phase = "离水爬升"
                else:
                    new_phase = "巡航"
                if new_phase != cur_phase:
                    if cur_phase is not None:
                        phases.append((cur_start, t, cur_phase))
                    cur_phase = new_phase
                    cur_start = t
            if cur_phase is not None:
                phases.append((cur_start, samples[-1][0], cur_phase))
        return phases

    def report_phases(self):
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  3. 飞行阶段时间线", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        phases = self.detect_phases()
        if not phases:
            print("  无足够 GPS 数据")
            return
        phase_color = {'静止/漂浮':C.BLU,'滑跑加速':C.GRN,'接近驼峰':C.YEL,
                       '驼峰区':C.MAG,'突破驼峰':C.YEL,'离水爬升':C.GRN,'巡航':C.CYN}
        print(f"  {'起始':>7s}  {'结束':>7s}  {'持续':>5s}  阶段")
        print("  " + "─"*60)
        for start, end, name in phases:
            dur = end - start
            color = phase_color.get(name, C.END)
            print(f"  {start:7.1f}s {end:7.1f}s {dur:5.1f}s  {colored(name, color)}")
        return phases

    # ═══ 4. 每阶段详细统计 ═══
    def per_phase_stats(self, phases):
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  4. 每阶段详细统计", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        for start, end, name in phases:
            if end - start < 0.5: continue  # 跳过太短的
            samples_att = [(t,r,p) for t,r,p,*_ in self.att if start <= t <= end]
            samples_gps = [s for t,s,a in self.gps if start <= t <= end]
            # rcin tuple: (t, ch1, ch2, ch3, ...)
            samples_rci = [(r[0], r[3]) for r in self.rcin if start <= r[0] <= end]
            if not samples_att or not samples_gps:
                continue
            pitches = [p for _,_,p in samples_att]
            rolls = [r for _,r,_ in samples_att]
            print(f"\n  ── {colored(name, C.CYN+C.BOLD)} ({start:.1f}~{end:.1f}s, {end-start:.1f}s) ──")
            print(f"    速度: {min(samples_gps):.1f} → {max(samples_gps):.1f}  avg {sum(samples_gps)/len(samples_gps):.1f} m/s")
            # ATT.Pitch 是 VIEW (VTOL), 加 Q_TRIM_PITCH 才是 body 绝对角度
            q_trim_pitch = self.params.get('Q_TRIM_PITCH', 0.0)
            avg_view = sum(pitches)/len(pitches)
            print(f"    俯仰 view: min={min(pitches):5.1f}° max={max(pitches):5.1f}° avg={avg_view:5.1f}° (+ Q_TRIM={q_trim_pitch:.1f} = body)")
            print(f"    横滚: min={min(rolls):5.1f}° max={max(rolls):5.1f}°")
            # 油门
            thrs = [c2 for _,c2 in samples_rci]
            if thrs:
                avg_thr = sum(thrs)/len(thrs)
                max_thr = max(thrs)
                print(f"    油门: avg PWM {avg_thr:.0f} ({(avg_thr-1000)/10:.0f}%), 最大 {max_thr:.0f}")
            # 各组电机平均输出
            for gname, gdef in MOTOR_GROUPS.items():
                vals = []
                for ts, *pwms in self.rcou:
                    if start <= ts <= end:
                        for ch in gdef['channels']:
                            vals.append(pwms[ch-1])
                if vals:
                    avg = sum(vals)/len(vals)
                    mx = max(vals)
                    print(f"    {gname:4s}: avg PWM {avg:4.0f}  max {mx:4.0f}")

    # ═══ 5. 速度-油门关系（驼峰检测）═══
    def speed_throttle_analysis(self):
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  5. 速度-油门关系（驼峰检测）", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        # Find full throttle (>1900) periods
        ft_periods = []
        in_ft = False
        ft_start = None
        for ts, *chs in self.rcin:
            if chs[2] > 1900:
                if not in_ft:
                    ft_start = ts
                    in_ft = True
            else:
                if in_ft:
                    ft_periods.append((ft_start, ts))
                    in_ft = False
        if in_ft:
            ft_periods.append((ft_start, self.duration))

        for start, end in ft_periods:
            if end - start < 1.0: continue
            speeds = [s for t,s,a in self.gps if start <= t <= end]
            if len(speeds) < 5: continue
            v_max = max(speeds)
            v_first = sum(speeds[:3])/3
            v_last = sum(speeds[-3:])/3
            print(f"\n  满油门 t={start:.1f}~{end:.1f}s ({end-start:.1f}s):")
            print(f"    Vmax={v_max:.1f}m/s  起始 {v_first:.1f} → 结束 {v_last:.1f}")
            if v_last < v_first - 0.5:
                msg = colored(f"⚠ 满油门减速 → 驼峰阻力峰约 {v_max:.1f} m/s", C.RED)
                print(f"    {msg}")
                self.warnings.append(f"驼峰未突破 V≈{v_max:.1f}")

    # ═══ 6. KRD 抬尾权限验证 ═══
    def check_krd_authority(self):
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  6. KRD 抬尾权限验证（驼峰阶段）", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        # Find times when speed is in hump region (5-10 m/s)
        hump_samples = [t for t,s,a in self.gps if 5 <= s <= 10]
        if not hump_samples:
            print("  没有进入驼峰速度区")
            return
        # Get RCOU samples in hump times
        rdl_pwms = []
        rdr_pwms = []
        for ts, *pwms in self.rcou:
            if any(abs(t-ts)<0.5 for t in hump_samples[:50]):  # only first 50 to speed up
                rdl_pwms.append(pwms[12])
                rdr_pwms.append(pwms[13])
        if not rdl_pwms:
            print("  RCOU 数据不足")
            return
        avg_rdl = sum(rdl_pwms)/len(rdl_pwms)
        avg_rdr = sum(rdr_pwms)/len(rdr_pwms)
        max_rdl = max(rdl_pwms)
        max_rdr = max(rdr_pwms)
        print(f"  驼峰区 RDL: avg PWM {avg_rdl:.0f}  max {max_rdl:.0f}")
        print(f"  驼峰区 RDR: avg PWM {avg_rdr:.0f}  max {max_rdr:.0f}")
        # 估算 KRD 推力
        thr_rdl = thrust_per_fan(avg_rdl)
        thr_rdr = thrust_per_fan(avg_rdr)
        krd_total = thr_rdl + thr_rdr
        # KRD 在驼峰处的垂直分量（假设机体俯仰 14°，KRD 世界角 ≈ 44°）
        krd_v = krd_total * math.sin(math.radians(44))
        print(f"  KRD 总推力估算 {krd_total:.1f}N，垂直分量约 {krd_v:.1f}N")
        if max_rdl < 1100:
            self.warnings.append("KRD 在驼峰几乎无输出")
            print(colored("  ✗ KRD 没工作！", C.RED))
        elif krd_v < 5:
            self.warnings.append(f"KRD 抬尾力不足 ({krd_v:.1f}N)")
            print(colored(f"  ⚠ 抬尾力偏弱", C.YEL))
        else:
            print(colored("  ✓ KRD 在驼峰有抬尾输出", C.GRN))

    # ═══ 7. 姿态超限检测 ═══
    def attitude_check(self):
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  7. 姿态超限 (P7.8p: 优先用 MSK4.pa body, fallback ATT.Pitch view+Q_TRIM)", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        # P7.8p: 优先 MSK4.pa (lua 直接 body, 单位 deg); fallback ATT.Pitch + Q_TRIM_PITCH (view→body)
        # memory: feedback_ahrs_pitch_is_body.md
        q_trim = self.params.get('Q_TRIM_PITCH', 0.0)
        for start, end in self.armed_periods:
            # 试 MSK4 (body 帧, P6+ lua 写)
            msk4_samples = [(t, m[3], m[0]) for m in self.msk4 if start <= (t := m[0]) <= end]  # (t, ra, pa)
            if msk4_samples:
                rolls = [r for _,r,_ in msk4_samples]
                pitches = [p for _,_,p in msk4_samples]
                src = 'MSK4 body'
            else:
                # fallback: ATT.Pitch 是 view, + Q_TRIM 才是 body
                samples = [(t,r,p) for t,r,p,*_ in self.att if start <= t <= end]
                if not samples: continue
                rolls = [r for _,r,_ in samples]
                pitches = [p + q_trim for _,_,p in samples]  # view → body
                src = f'ATT view + Q_TRIM={q_trim:.1f}'
            max_r = max(abs(min(rolls)), abs(max(rolls)))
            max_p_pos = max(pitches)
            max_p_neg = abs(min(pitches))
            flag_r = colored("⚠", C.RED) if max_r > 30 else (colored("⚠", C.YEL) if max_r > 15 else colored("✓", C.GRN))
            flag_p = colored("⚠", C.RED) if max_p_pos > 30 or max_p_neg > 20 else colored("✓", C.GRN)
            print(f"  t={start:6.1f}~{end:6.1f}s  body P:{min(pitches):+6.1f}~{max(pitches):+6.1f}° {flag_p}  R:±{max_r:5.1f}° {flag_r}  [{src}]")
            if max_r > 60:
                self.warnings.append(f"t={start:.0f}-{end:.0f}: 横滚 {max_r:.0f}° 可能翻飞")
            if max_p_pos > 30:
                self.warnings.append(f"t={start:.0f}-{end:.0f}: 俯仰 {max_p_pos:.0f}° 失控")

    # ═══ 8. 开关位置时间线 ═══
    def switch_timeline(self):
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  8. 开关位置变化 (v9 P7.7+: ch6=FLTMODE 切 mode 17/27/29, ch7=phase/profile, ch8=preflight)", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        # v9 P7.7: ch6 = ArduPlane FLTMODE_CH 切 mode 17 MANUAL / 27 AUTO / 29 RECV
        #          ch7 = MANUAL phase (TAXI/TRANS/CRUISE) 或 AUTO profile (MATRIX/TURN/CRUISE armed latch)
        #          ch8 = preflight (高+disarmed → orchestrator sweep)
        ch_names = {6:'ch6 mode', 7:'ch7 phase/prof', 8:'ch8 preflt'}
        last = {6:None, 7:None, 8:None}
        for ts, *chs in self.rcin:
            for ch, name in ch_names.items():
                v = chs[ch-1]
                if ch == 6:
                    # FLTMODE 实测阈值 (P7.7): <1490 → 17, 1490-1620 → 27, >=1620 → 29
                    if v < 1490: pos = 'MANUAL(17)'
                    elif v < 1620: pos = 'AUTO(27)'
                    else: pos = 'RECV(29)'
                elif ch == 7:
                    if v < 1300: pos = 'low (TAXI/MATRIX)'
                    elif v < 1700: pos = 'mid (TRANS/TURN)'
                    else: pos = 'high (CRUISE)'
                else:  # ch8
                    pos = 'PREFLT (高+disarmed)' if v > 1700 else 'idle'
                if last[ch] != pos:
                    if last[ch] is not None:
                        print(f"  t={ts:6.1f}s  {name}: {last[ch]} → {pos} (PWM {v})")
                    last[ch] = pos

    # ═══ 9. MSK 模式/档位/Auto/RTL 时间线 ═══
    def msk_timeline(self):
        has_any = (self.msk_mode_changes or self.msk_gear_changes or
                   self.msk_auto_changes or self.msk_rtl_changes)
        if not has_any:
            return
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  9. MSK Lua 模式/档位/Auto/RTL 时间线", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        events = []
        for ts, mode in self.msk_mode_changes:
            events.append((ts, 'MODE', mode))
        for ts, gear in self.msk_gear_changes:
            events.append((ts, 'GEAR', f'G{gear}'))
        for ts, auto in self.msk_auto_changes:
            events.append((ts, 'AUTO', auto))
        for ts, rtl in self.msk_rtl_changes:
            events.append((ts, 'RTL', rtl))
        events.sort()
        for ts, kind, val in events[:60]:
            col = {'MODE':C.CYN, 'GEAR':C.YEL, 'AUTO':C.MAG, 'RTL':C.RED}.get(kind, C.END)
            print(f"  t={ts:7.1f}s  {colored(kind, col):15s} → {val}")
        if len(events) > 60:
            print(f"  ... ({len(events)-60} 更多事件省略)")

        # v8: 1Hz K 心跳节区 (新增, 供调参核对实际生效 K)
        if self.msk_k_history:
            print(colored(f"\n  [K 心跳 {len(self.msk_k_history)} 条 (1Hz)]  采样首/末:", C.CYN))
            for entry in [self.msk_k_history[0], self.msk_k_history[-1]]:
                ts, ks, kdf, kt, krd, sp_e, sp_r = entry
                print(f"  t={ts:7.1f}s  S={ks:3d} DF={kdf:3d} T={kt:3d} RD={krd:3d}  spd_eff={sp_e:.1f}/真={sp_r:.1f}")

    # ═══ 10. 预检流程事件 ═══
    def preflight_events(self):
        if not self.msk_chk_events:
            return
        print(colored("\n" + "="*72, C.CYN))
        print(colored(" 10. 预检流程事件", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        for ts, txt in self.msk_chk_events[:40]:
            col = C.GRN if 'STAGE' in txt else C.CYN
            print(f"  t={ts:7.1f}s  {colored(txt, col)}")
        if len(self.msk_chk_events) > 40:
            print(f"  ... ({len(self.msk_chk_events)-40} 更多事件省略)")

    # ═══ 11. 紧急停车 / Lua 错误 ═══
    # ═══ 12. WIG_AUTO state machine + V_PI + drift + layer 分析 (P7.8p) ═══
    def wig_state_analysis(self):
        has_any = (self.msk_phase_changes or self.msk_run_starts or
                   self.msk5 or self.msk6 or self.msk8)
        if not has_any:
            return
        print(colored("\n" + "="*72, C.CYN))
        print(colored(" 12. WIG state machine + V_PI + drift + layer (MSK5/6/8/P/R)", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))

        # ── ArduPilot mode 切换 (BIN MODE message, 17/27/29 解码)
        if self.modes:
            print(colored("  [ArduPilot mode 切换 (BIN MODE)]", C.CYN))
            for ts, name, num in self.modes[:20]:
                col = C.RED if num == 29 else (C.YEL if num == 27 else C.GRN)
                print(f"  t={ts:7.1f}s  mode={num} {colored(str(name), col)}")
            if len(self.modes) > 20:
                print(f"  ... ({len(self.modes)-20} 更多)")

        # ── phase 切换序列 (state machine flow)
        if self.msk_phase_changes:
            phase_names = ['IDLE','FLOAT_TAXI','TRANS_A','TRANS_B','TRANS_C','CRUISE','TURN',
                          'DECEL_A','DECEL_B','DECEL_C','ABORT_L1','EMERGENCY']
            print(colored("  [phase 状态机]", C.CYN))
            for ts, p in self.msk_phase_changes[:40]:
                name = phase_names[int(p)] if 0 <= int(p) < len(phase_names) else f'?{int(p)}'
                print(f"  t={ts:7.1f}s  phase → {colored(name, C.CYN)}")
            if len(self.msk_phase_changes) > 40:
                print(f"  ... ({len(self.msk_phase_changes)-40} 更多)")

        # ── armed 边沿 run latch (cruise_mode/strat/profile/v_tgt)
        if self.msk_run_starts:
            print(colored("\n  [armed 边沿 run config latch]", C.CYN))
            for ts, mode, strat, prof, vtgt in self.msk_run_starts[:10]:
                cn = {0:'FRONT_VENT',1:'REAR_VENT'}.get(int(mode), f'?{int(mode)}')
                sn = {0:'STEADY',1:'BURST'}.get(int(strat), f'?{int(strat)}')
                pn = {0:'MATRIX',1:'TURN',2:'CRUISE'}.get(int(prof), f'?{int(prof)}')
                print(f"  t={ts:7.1f}s  cruise={cn}  strat={sn}  profile={pn}  V_TGT={vtgt:.1f} m/s")

        # ── V_PI 速度环饱和分析 (MSK5: vt, va, ve, ko, la)
        if self.msk5:
            print(colored("\n  [V_PI 速度环 (1Hz)]", C.CYN))
            errs = [s[3] for s in self.msk5]  # ve = v_target - v_actual
            kos  = [s[4] for s in self.msk5]  # ko = kt correction
            las  = [int(s[5]) for s in self.msk5]  # layer
            saturated = sum(1 for k in kos if abs(k) > 0.28)  # |ko| > 0.28 接近 ±0.3 clamp
            print(f"  V_err: min={min(errs):+.2f} max={max(errs):+.2f} avg={sum(errs)/len(errs):+.2f} m/s")
            print(f"  KT correction: min={min(kos):+.3f} max={max(kos):+.3f} avg={sum(kos)/len(kos):+.3f}")
            if saturated > 0:
                pct = saturated * 100 / len(kos)
                print(colored(f"  ⚠ V_PI 饱和 (|ko|>0.28) 占 {saturated}/{len(kos)} = {pct:.0f}%", C.YEL))
                if pct > 30:
                    self.warnings.append(f"V_PI 饱和率 {pct:.0f}% > 30%, target 偏高或 motor 推力不足")
            # layer 时间分布 (0=L1 / 1=L1 boost / 2=L2 SGRP / 3=L3 极限)
            from collections import Counter
            layer_dist = Counter(las)
            total = len(las)
            print(f"  Layer 时间分布:", end='')
            for L in sorted(layer_dist.keys()):
                pct = layer_dist[L] * 100 / total
                col = C.GRN if L < 2 else (C.YEL if L == 2 else C.RED)
                print(colored(f"  L{L}={pct:.0f}%", col), end='')
            print()
            if layer_dist.get(3, 0) > 0:
                self.warnings.append(f"Layer 3 (机械极限) 触发 {layer_dist[3]} 次")

        # ── K_drift 累积 (MSK6: ks_d, kdf_d, kt_d, krd_d)
        if self.msk6:
            print(colored("\n  [K_drift 累积 (lua 内学, 不写 EEPROM)]", C.CYN))
            last = self.msk6[-1]
            print(f"  最终值: KS={last[1]:+.3f}  KDF={last[2]:+.3f}  KT={last[3]:+.3f}  KRD={last[4]:+.3f}")
            for i, name in enumerate(['KS','KDF','KT','KRD'], 1):
                vals = [s[i] for s in self.msk6]
                mx = max(abs(min(vals)), abs(max(vals)))
                if mx > 0.1:
                    print(colored(f"  ⚠ {name}_drift 峰值 |{mx:.3f}| > 0.1, 控制律 trim 不当", C.YEL))

    def msk_anomalies(self):
        has_any = self.msk_emergency or self.msk_errors or self.msk_att_guard
        if not has_any:
            return
        print(colored("\n" + "="*72, C.CYN))
        print(colored(" 11. 异常事件 (紧急停车 / Lua 错误 / 姿态保护)", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        if self.msk_emergency:
            print(colored("  [紧急停车事件]", C.RED))
            for ts, what in self.msk_emergency[:30]:
                col = C.RED if what == 'STOP' else C.GRN
                print(f"  t={ts:7.1f}s  EMERGENCY {colored(what, col)}")
            if len(self.msk_emergency) > 30:
                print(f"  ... ({len(self.msk_emergency)-30} 更多)")
        if self.msk_errors:
            print(colored(f"\n  [Lua 错误 {len(self.msk_errors)} 条]", C.RED))
            for ts, err in self.msk_errors[:20]:
                print(f"  t={ts:7.1f}s  {colored(err, C.RED)}")
                self.warnings.append(f"Lua 错误 t={ts:.0f}: {err[:60]}")
        if self.msk_att_guard:
            print(colored(f"\n  [姿态保护介入 {len(self.msk_att_guard)} 次]", C.YEL))
            for ts, p, tgt, r, corr in self.msk_att_guard[:10]:
                print(f"  t={ts:7.1f}s  P={p:+5.1f}(目标 {tgt:+.0f}) R={r:+5.1f} corr={corr:+.2f}")
            if len(self.msk_att_guard) > 10:
                print(f"  ... ({len(self.msk_att_guard)-10} 更多)")

    # ═══ 12. 倾转舵输出验证 ═══
    def tilt_servo_check(self):
        if not self.rcou:
            return
        print(colored("\n" + "="*72, C.CYN))
        print(colored(" 12. 7 倾转舵 (SERVO13-19) 输出验证", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        # v9 P4 7 个 tilt: SERVO13(DFL) 14(DFR) 15(TL1) 16(TR1) 17(RDL) 18(RDR) 19(SGRP)
        tilt_chans = [(13,'DFL'),(14,'DFR'),(15,'TL1'),(16,'TR1'),
                      (17,'RDL'),(18,'RDR'),(19,'SGRP')]
        pwm_per_deg = self.params.get('TLT_PWM_PER_DEG', 11.11)
        print(f"  全局 PWM/° = {pwm_per_deg:.2f}μs/°")
        for ch, name in tilt_chans:
            zero = self.params.get(f'TLT_{name}_ZERO')
            dir_v = self.params.get(f'TLT_{name}_DIR')
            lmin = self.params.get(f'TLT_{name}_LMIN')
            lmax = self.params.get(f'TLT_{name}_LMAX')
            idx = ch - 1  # rcou idx = SERVO ch - 1
            vals = [p[idx] for p in self.rcou if len(p) > idx]
            if not vals:
                print(f"  S{ch:2d} {name:5s}: RCOU 无数据")
                continue
            mn, mx, av = min(vals), max(vals), sum(vals)/len(vals)
            zfmt = f"Z={zero:.0f}" if zero is not None else "Z=?"
            dfmt = f"D={dir_v:+.0f}" if dir_v is not None else "D=?"
            limfmt = f"L=[{lmin:.0f},{lmax:.0f}]" if lmin is not None and lmax is not None else ""
            print(f"  S{ch:2d} {name:5s} {zfmt} {dfmt} {limfmt} | PWM min={mn:.0f} max={mx:.0f} avg={av:.0f}")
            if dir_v is not None and dir_v == 0:
                print(colored(f"        ⚠ DIR=0 (锁定输出 ZERO PWM, 实机故意未校准)", C.YEL))

        # v9 P4: MSK7 角度直接 (相对机身, lua 内部计算的 abs°, 不依赖 ZERO 标定反推)
        if self.msk7:
            print()
            print(colored(" ─── MSK7 倾转角度 (abs°相对机身, commanded 加 ATC bias 后) ───", C.CYN))
            # 字段顺序: t, cDl,cDr,cTl,cTr,cRl,cRr,cS, aDl,aDr,aTl,aTr,aRl,aRr,aS, CMP
            names = ['DFL','DFR','TL1','TR1','RDL','RDR','SGRP']
            print(f"  {'路':5s}  {'cmd 范围':>12s}  {'actual 范围':>12s}  {'commanded 平均':>10s}")
            for i, n in enumerate(names):
                # 过滤 corrupted (log 有 bad header 噪声让某些字段超出物理 range)
                cmds = [r[1+i] for r in self.msk7 if -360 <= r[1+i] <= 360]
                acts = [r[8+i] for r in self.msk7 if -360 <= r[8+i] <= 360]
                if not cmds: continue
                cmd_min, cmd_max, cmd_avg = min(cmds), max(cmds), sum(cmds)/len(cmds)
                act_min, act_max = min(acts), max(acts)
                clamp_warn = ''
                if cmd_max > act_max + 1: clamp_warn = ' ⚠ commanded 超 actual (撞 LMAX)'
                if cmd_min < act_min - 1: clamp_warn += ' ⚠ commanded 低 actual (撞 LMIN)'
                print(f"  {n:5s}  {cmd_min:>5.0f}~{cmd_max:>5.0f}°  {act_min:>5.0f}~{act_max:>5.0f}°  {cmd_avg:>+8.1f}°{clamp_warn}")

    # ═══ 13. 参数修改建议 (heuristic) ═══
    def suggest_params(self):
        import statistics
        print(colored("\n" + "="*72, C.CYN))
        print(colored(" 13. 参数修改建议 (heuristic, 仅供参考)", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))

        suggestions = []   # list of (severity, current, suggested, reason)

        # 用 armed 段为基础 (近似 cruise)
        for start, end in self.armed_periods:
            if end - start < 10: continue   # 太短忽略

            # ── 1. pitch 振荡 (body std-dev) ──
            pitches = [m[1] for m in self.msk4 if start <= m[0] <= end]
            if len(pitches) >= 50:
                p_std = statistics.stdev(pitches)
                if p_std > 3.0:
                    cur = self.params.get('Q_A_RAT_PIT_D', 0.004)
                    suggestions.append(('⚠', 'pitch 振荡',
                        f'body std={p_std:.1f}° > 3° (t={start:.0f}-{end:.0f}s)',
                        f'Q_A_RAT_PIT_D {cur:.4f} → {cur*1.5:.4f} (加 50% D 阻尼) 或 Q_A_RAT_PIT_P 减 20%'))

            # ── 2. roll 振荡 ──
            rolls = [m[3] for m in self.msk4 if start <= m[0] <= end]
            if len(rolls) >= 50:
                r_std = statistics.stdev(rolls)
                if r_std > 3.0:
                    cur = self.params.get('Q_A_RAT_RLL_D', 0.004)
                    suggestions.append(('⚠', 'roll 振荡',
                        f'body std={r_std:.1f}° > 3°',
                        f'Q_A_RAT_RLL_D {cur:.4f} → {cur*1.5:.4f} (加 D)'))

            # ── 3. yaw 振荡 / drift (从 ATT) ──
            yaws = [y for t,r,p,y in self.att if start <= t <= end and -360 <= y <= 360]
            if len(yaws) >= 50:
                # 标准差检测振荡
                y_std = statistics.stdev(yaws)
                # 偏入口检测 drift (= 后 1/3 mean vs 前 1/3 mean)
                third = len(yaws) // 3
                if third > 5:
                    early_mean = sum(yaws[:third]) / third
                    late_mean  = sum(yaws[-third:]) / third
                    drift = abs(((late_mean - early_mean + 540) % 360) - 180)
                else:
                    drift = 0
                if y_std > 5.0:
                    kd = self.params.get('WIGA_HDG_KD', 10.0)
                    suggestions.append(('⚠', 'yaw 振荡',
                        f'yaw std={y_std:.1f}° > 5°',
                        f'WIGA_HDG_KD {kd:.1f} → {kd*1.5:.1f} (加 D 阻尼) 或 WIGA_HDG_KP 减 30%'))
                if drift > 10.0:
                    kp = self.params.get('WIGA_HDG_KP', 45.0)
                    suggestions.append(('⚠', 'yaw drift',
                        f'前→后 drift={drift:.1f}° > 10°',
                        f'WIGA_HDG_KP {kp:.0f} → {kp*1.3:.0f} (加 P 收紧)'))

            # ── 4. V_PI saturate (Layer 2 占比) ──
            if self.msk5:
                seg5 = [m for m in self.msk5 if start <= m[0] <= end]
                if len(seg5) >= 5:
                    sat = sum(1 for m in seg5 if m[5] >= 2) / len(seg5)
                    if sat > 0.2:
                        kt = self.params.get('MSK_BST_KT', 1.0)
                        suggestions.append(('⚠', 'V_PI saturate',
                            f'Layer≥2 占比 {sat*100:.0f}% > 20%',
                            f'MSK_BST_KT {kt:.2f} → {kt*1.2:.2f} (加速主推) 或 WIGA_V_TGT 降 1 m/s'))

            # ── 5. pitch 跟不上 target (|pa - pb| 大) ──
            if len(self.msk4) >= 50:
                segm = [m for m in self.msk4 if start <= m[0] <= end]
                if segm:
                    errs = [abs(m[1] - m[2]) for m in segm]  # |pa - pb|
                    avg_err = sum(errs) / len(errs)
                    if avg_err > 5.0:
                        cur = self.params.get('Q_A_RAT_PIT_P', 0.135)
                        suggestions.append(('⚠', 'pitch 跟不上',
                            f'avg |pa-pb|={avg_err:.1f}° > 5°',
                            f'Q_A_RAT_PIT_P {cur:.3f} → {cur*1.3:.3f} 或 MSK_BST_KDF 加 0.05'))

        # ── 6. envelope abort 频次 ──
        env_aborts = sum(1 for _,t in self.msk_emergency if 'ENVELOPE' in (t or '').upper())
        if env_aborts > 0:
            p_env = self.params.get('WIGA_P_ENV_W', 20)
            suggestions.append(('⚠', 'envelope abort 触发',
                f'{env_aborts} 次 ABORT (WIGA_P_ENV_W={p_env}°)',
                f'若属误触发, P_ENV_W → {p_env+5}°. 若真翻车, 不改, 排查 K 表 / heading'))

        # ── 7. TRANS_A timeout (从 STATUSTEXT 查) ──
        # msk_errors / msk_emergency 含 STATUSTEXT 关键字
        ta_to = sum(1 for _, txt in self.msk_emergency if 'TRANS_A' in (txt or '') and 'timeout' in (txt or '').lower())
        if ta_to > 0:
            tol = self.params.get('WIGK_TX_A_TOL', 2.0)
            suggestions.append(('⚠', 'TRANS_A timeout',
                f'{ta_to} 次 (pitch 没到 BTRIM tol={tol}°)',
                f'WIGK_TX_A_TOL {tol:.1f} → {tol+1:.1f} 放宽容差 或 WIGA_TX_TO_MS 加 2000ms'))

        if not suggestions:
            print(colored('  ✓ 数据看着 OK, 无明显参数调整建议', C.GRN))
            return
        for sev, sym, reason, sugg in suggestions:
            print(colored(f'  {sev} {sym}', C.YEL+C.BOLD))
            print(f'    数据: {reason}')
            print(colored(f'    建议: {sugg}', C.CYN))

    # ═══ 主报告 ═══
    def report(self):
        print(colored("="*72, C.BOLD))
        print(colored(f"  MantaShark 飞行日志分析: {os.path.basename(self.path)}", C.BOLD))
        print(colored(f"  时长: {self.duration:.1f}秒  解锁次数: {len(self.armed_periods)}", C.BOLD))
        print(colored(f"  采样: ATT={len(self.att)} GPS={len(self.gps)} RCIN={len(self.rcin)} RCOU={len(self.rcou)}", C.BOLD))
        msk_summary = f"MSK: 模式切换 {len(self.msk_mode_changes)}, 预检事件 {len(self.msk_chk_events)}, Lua 错误 {len(self.msk_errors)}, 紧急停车 {sum(1 for _,w in self.msk_emergency if w=='STOP')}"
        print(colored(f"  {msk_summary}", C.BOLD))
        print(colored("="*72, C.BOLD))

        self.check_servo_config()
        self.check_motor_outputs()
        self.tilt_servo_check()
        phases = self.report_phases()
        if phases:
            self.per_phase_stats(phases)
        self.speed_throttle_analysis()
        self.check_krd_authority()
        self.attitude_check()
        self.switch_timeline()
        self.msk_timeline()
        self.preflight_events()
        self.msk_anomalies()
        self.wig_state_analysis()   # P7.8p: MSK5/6/8 + MSKP/MSKR 综合
        self.suggest_params()        # P7.8ω: heuristic 参数建议

        # 总结
        # noop reach
        print(colored("\n" + "="*72, C.BOLD))
        if self.warnings:
            print(colored(f"  ⚠ 检测到 {len(self.warnings)} 个问题", C.RED+C.BOLD))
            print(colored("="*72, C.BOLD))
            for i, w in enumerate(self.warnings, 1):
                print(colored(f"  {i}. {w}", C.RED))
        else:
            print(colored("  ✓ 未检测到明显问题", C.GRN+C.BOLD))
            print(colored("="*72, C.BOLD))
        print()


def export_csv(analyzer, path):
    """导出关键数据到 CSV"""
    csv_path = path.replace('.BIN', '_data.csv')
    # Build unified time-aligned table
    # Sample at GPS rate (5Hz typically)
    rows = [['t','speed','alt','roll','pitch','yaw','des_pitch',
             'thr_in','mode_in','gear_in','auto_in',
             'avg_KS','avg_KDF','avg_KDM','avg_KT','avg_KRD']]
    # Index helpers
    att_iter = iter(sorted(analyzer.att))
    rcin_iter = iter(sorted(analyzer.rcin))
    rcou_iter = iter(sorted(analyzer.rcou))
    last_att = None; last_rcin = None; last_rcou = None
    def advance(it, last, ts):
        cur = last
        while True:
            try:
                nxt = next(it)
                if nxt[0] > ts: break
                cur = nxt
            except StopIteration:
                break
        return cur, it
    att_iter = iter(sorted(analyzer.att))
    # Re-read fresh iterators
    for t, spd, alt in sorted(analyzer.gps):
        # Find nearest att
        att = min(analyzer.att, key=lambda x: abs(x[0]-t)) if analyzer.att else None
        rcin = min(analyzer.rcin, key=lambda x: abs(x[0]-t)) if analyzer.rcin else None
        rcou = min(analyzer.rcou, key=lambda x: abs(x[0]-t)) if analyzer.rcou else None
        if not (att and rcin and rcou): continue
        row = [f"{t:.2f}", f"{spd:.2f}", f"{alt:.2f}",
               f"{att[1]:.1f}", f"{att[2]:.1f}", f"{att[3]:.1f}", f"{att[4]:.1f}",
               rcin[3], rcin[6], rcin[7], rcin[9]]  # thr=ch3 mode=ch6 gear=ch7 auto=ch9
        for gname, gdef in MOTOR_GROUPS.items():
            avg = sum(rcou[ch] for ch in gdef['channels'])/len(gdef['channels'])
            row.append(f"{avg:.0f}")
        rows.append(row)
    with open(csv_path, 'w') as f:
        for row in rows:
            f.write(','.join(str(x) for x in row) + '\n')
    print(f"CSV 已保存: {csv_path} ({len(rows)-1} 行)")


def make_plot(analyzer, path):
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib 未安装，跳过绘图")
        return
    fig, axes = plt.subplots(5, 1, figsize=(14, 12), sharex=True)
    # 1. Speed
    if analyzer.gps:
        t = [x[0] for x in analyzer.gps]
        v = [x[1] for x in analyzer.gps]
        axes[0].plot(t, v, 'b-', lw=1)
        # P7: 撤老 V1/V2/V3 PCHIP 速度断点, 改 WIGA_V_TGT (CRUISE 目标速度)
        v_tgt = self.params.get('WIGA_V_TGT', 9.0)
        axes[0].axhline(y=v_tgt, color='green', ls='--', alpha=0.5, label=f'WIGA_V_TGT={v_tgt:.1f}')
        v_min = self.params.get('WIGA_DEC_V_B', 2.0)
        axes[0].axhline(y=v_min, color='orange', ls='--', alpha=0.5, label=f'DEC_V_B={v_min:.1f}')
        axes[0].set_ylabel('Speed (m/s)')
        axes[0].legend(loc='upper right', fontsize=8)
        axes[0].grid(True, alpha=0.3)
    # 2. Pitch + Roll
    if analyzer.att:
        t = [x[0] for x in analyzer.att]
        p = [x[2] for x in analyzer.att]
        r = [x[1] for x in analyzer.att]
        dp = [x[4] for x in analyzer.att]
        axes[1].plot(t, p, 'g-', lw=1, label='Pitch')
        axes[1].plot(t, r, 'r-', lw=1, label='Roll')
        axes[1].plot(t, dp, 'g--', lw=0.5, alpha=0.5, label='Des Pitch')
        axes[1].axhline(y=8, color='gray', ls=':', alpha=0.5, label='Wing Ofs')
        axes[1].set_ylabel('Att (°)')
        axes[1].legend(loc='upper right', fontsize=8)
        axes[1].grid(True, alpha=0.3)
    # 3. Motor groups (avg PWM)
    if analyzer.rcou:
        t = [x[0] for x in analyzer.rcou]
        colors = {'KS':'#ff9f43','KDF':'#1dd1a1','KDM':'#54a0ff','KT':'#00d2d3','KRD':'#ee5a24'}
        for gname, gdef in MOTOR_GROUPS.items():
            avg = [sum(r[ch] for ch in gdef['channels'])/len(gdef['channels']) for r in analyzer.rcou]
            axes[2].plot(t, avg, color=colors[gname], label=gname, lw=1)
        axes[2].set_ylabel('Motor PWM')
        axes[2].legend(loc='upper right', fontsize=8, ncol=5)
        axes[2].grid(True, alpha=0.3)
    # 4. Throttle stick + switches
    if analyzer.rcin:
        t = [x[0] for x in analyzer.rcin]
        thr = [x[3] for x in analyzer.rcin]  # ch3
        mode = [x[6] for x in analyzer.rcin]  # ch6
        gear = [x[7] for x in analyzer.rcin]  # ch7
        auto = [x[9] for x in analyzer.rcin]  # ch9
        axes[3].plot(t, thr, 'k-', lw=1, label='Throttle (ch3)')
        axes[3].plot(t, mode, 'b-', lw=0.8, alpha=0.6, label='Mode (ch6)')
        axes[3].plot(t, gear, 'r-', lw=0.8, alpha=0.6, label='Gear (ch7)')
        axes[3].plot(t, auto, 'g-', lw=0.8, alpha=0.6, label='Auto (ch9)')
        axes[3].set_ylabel('PWM')
        axes[3].legend(loc='upper right', fontsize=8, ncol=4)
        axes[3].grid(True, alpha=0.3)
    # 5. Battery current
    if analyzer.bat:
        t = [x[0] for x in analyzer.bat]
        c = [x[2] for x in analyzer.bat]
        axes[4].plot(t, c, 'r-', lw=1)
        axes[4].set_ylabel('Current (A)')
        axes[4].set_xlabel('Time (s)')
        axes[4].grid(True, alpha=0.3)
    # Mark armed periods
    for s, e in analyzer.armed_periods:
        for ax in axes:
            ax.axvspan(s, e, alpha=0.05, color='green')
    plt.tight_layout()
    out_png = path.replace('.BIN', '_analysis.png')
    plt.savefig(out_png, dpi=100)
    print(f"图表已保存: {out_png}")


def main():
    parser = argparse.ArgumentParser(description="MantaShark 飞行日志分析 v2")
    parser.add_argument("logfile", help="ArduPilot .BIN 日志文件")
    parser.add_argument("--plot", action="store_true", help="生成图表 PNG")
    parser.add_argument("--csv", action="store_true", help="导出 CSV 数据")
    args = parser.parse_args()

    if not os.path.exists(args.logfile):
        print(f"ERROR: 文件不存在: {args.logfile}")
        sys.exit(1)

    print(f"读取 {args.logfile} ...")
    analyzer = LogAnalyzer(args.logfile)
    analyzer.parse()
    analyzer.detect_armed_periods()
    analyzer.report()

    if args.csv:
        export_csv(analyzer, args.logfile)
    if args.plot:
        make_plot(analyzer, args.logfile)


if __name__ == "__main__":
    main()
