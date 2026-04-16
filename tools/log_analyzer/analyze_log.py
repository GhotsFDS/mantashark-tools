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
MOTOR_GROUPS = {
    'KS':  {'name':'斜吹',     'channels':[1,2,3,4],   'angle_body':37},
    'KDF': {'name':'前下吹',   'channels':[5,6],       'angle_body':90},
    'KDM': {'name':'中下吹',   'channels':[7,8],       'angle_body':90},
    'KT':  {'name':'后推',     'channels':[9,10,11,12],'angle_body':0},
    'KRD': {'name':'后斜下',   'channels':[13,14],     'angle_body':30},
}

# 实测推力表 (24V 6S 满电, QF2822 64mm)
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
    """从 PWM 估算推力（PWM 1000-2000 → throttle 0-1）"""
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
        self.att = []      # (t, roll, pitch, yaw, des_pitch)
        self.gps = []      # (t, spd, alt)
        self.rcin = []     # (t, ch1..ch16)
        self.rcou = []     # (t, ch1..ch16)
        self.bat = []      # (t, voltage, current)
        self.armed_periods = []
        self.warnings = []
        # v3+ 固件: MSK Lua 事件 (来自 MSG 文本)
        self.msk_mode_changes = []    # (t, mode_name)  NOGPS/GPS_WEAK/GPS_FULL
        self.msk_gear_changes = []    # (t, gear)
        self.msk_auto_changes = []    # (t, 'ON'|'OFF')
        self.msk_chk_events = []      # (t, stage_label)  'CHK: STAGE 1 ...', 'CHK 1.3/5 ...'
        self.msk_emergency = []       # (t, 'STOP'|'released')
        self.msk_errors = []          # (t, err_text)  MSK ERR: ...
        self.msk_att_guard = []       # (t, pitch, target, roll, corr)  ATT GUARD 事件

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
                self.modes.append((ts, m.Mode, getattr(m,'ModeNum','?')))
            elif t == 'EV':
                self.events.append((ts, m.Id))
            elif t == 'ERR':
                self.errors.append((ts, m.Subsys, m.ECode))
            elif t == 'ATT':
                self.att.append((ts, m.Roll, m.Pitch, m.Yaw, getattr(m,'DesPitch',0)))
            elif t == 'GPS':
                self.gps.append((ts, m.Spd, m.Alt))
            elif t == 'RCIN':
                self.rcin.append((ts, *[getattr(m,f'C{i}',0) for i in range(1,17)]))
            elif t == 'RCOU':
                self.rcou.append((ts, *[getattr(m,f'C{i}',0) for i in range(1,17)]))
            elif t == 'BAT':
                self.bat.append((ts, m.Volt, getattr(m,'Curr',0)))
            elif t == 'MSG':
                self._parse_msg(ts, getattr(m, 'Message', ''))
        self.duration = ts if self.first_t else 0

    _RE_MSK_MODE   = re.compile(r'^MSK:\s*(NOGPS|GPS_WEAK|GPS_FULL|GPS)\s*(?:GEAR\s*(\d+))?')
    _RE_MSK_GEAR   = re.compile(r'GEAR\s+(\d)')
    _RE_MSK_AUTO   = re.compile(r'^MSK:\s*AUTO\s+(ON|OFF)')
    _RE_MSK_CHK    = re.compile(r'^MSK\s*CHK[:\s].*')
    _RE_MSK_STOP   = re.compile(r'^MSK:\s*EMERGENCY STOP')
    _RE_MSK_REL    = re.compile(r'^MSK:\s*emergency released')
    _RE_MSK_ERR    = re.compile(r'^MSK ERR:\s*(.*)')
    _RE_ATT_GUARD  = re.compile(r'^ATT GUARD:\s*P=([-0-9.]+)\(t=([-0-9.]+)\)\s*R=([-0-9.]+)\s*corr=([-0-9.]+)')
    _RE_LUA_ERR    = re.compile(r'^Lua:\s*.*?:(\d+):\s*(.*)')

    def _parse_msg(self, ts, text):
        if not text: return
        # 模式 + 档位
        m = self._RE_MSK_MODE.match(text)
        if m:
            mode = m.group(1); gear = m.group(2)
            if not self.msk_mode_changes or self.msk_mode_changes[-1][1] != mode:
                self.msk_mode_changes.append((ts, mode))
            if gear and (not self.msk_gear_changes or self.msk_gear_changes[-1][1] != int(gear)):
                self.msk_gear_changes.append((ts, int(gear)))
            return
        # AUTO ON/OFF
        m = self._RE_MSK_AUTO.match(text)
        if m:
            self.msk_auto_changes.append((ts, m.group(1)))
            return
        # 预检
        if self._RE_MSK_CHK.match(text):
            self.msk_chk_events.append((ts, text.strip()))
            return
        # 紧急停车
        if self._RE_MSK_STOP.match(text):
            self.msk_emergency.append((ts, 'STOP'))
            return
        if self._RE_MSK_REL.match(text):
            self.msk_emergency.append((ts, 'released'))
            return
        # MSK ERR (pcall 包裹的错误)
        m = self._RE_MSK_ERR.match(text)
        if m:
            self.msk_errors.append((ts, m.group(1)))
            return
        # 姿态保护介入
        m = self._RE_ATT_GUARD.match(text)
        if m:
            self.msk_att_guard.append((ts, float(m.group(1)), float(m.group(2)),
                                       float(m.group(3)), float(m.group(4))))
            return
        # Lua 原生 runtime error (未被 pcall 捕获的)
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
        # Motor1-14 + Tilt Servo 15/16 (Scripting1/2 for DFL/DFR tilts)
        expected = {1:33,2:34,3:35,4:36,5:37,6:38,7:39,8:40,
                    9:82,10:83,11:84,12:85,13:160,14:161,
                    15:94, 16:95}
        label = {1:'M1 SL1',2:'M2 SL2',3:'M3 SR1',4:'M4 SR2',
                 5:'M5 DFL',6:'M6 DFR',7:'M7 DML',8:'M8 DMR',
                 9:'M9 TL1',10:'M10 TL2',11:'M11 TR1',12:'M12 TR2',
                 13:'M13 RDL (CAN)',14:'M14 RDR (CAN)',
                 15:'TILT DFL (CAN)',16:'TILT DFR (CAN)'}
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
            print(f"    俯仰: min={min(pitches):5.1f}° max={max(pitches):5.1f}° avg={sum(pitches)/len(pitches):5.1f}°")
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
        print(colored("  7. 姿态超限（解锁时段）", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        for start, end in self.armed_periods:
            samples = [(t,r,p) for t,r,p,*_ in self.att if start <= t <= end]
            if not samples: continue
            rolls = [r for _,r,_ in samples]
            pitches = [p for _,_,p in samples]
            max_r = max(abs(min(rolls)), abs(max(rolls)))
            max_p_pos = max(pitches)
            max_p_neg = abs(min(pitches))
            flag_r = colored("⚠", C.RED) if max_r > 30 else (colored("⚠", C.YEL) if max_r > 15 else colored("✓", C.GRN))
            flag_p = colored("⚠", C.RED) if max_p_pos > 30 or max_p_neg > 20 else colored("✓", C.GRN)
            print(f"  t={start:6.1f}~{end:6.1f}s  P:{min(pitches):+6.1f}~{max(pitches):+6.1f}° {flag_p}  R:±{max_r:5.1f}° {flag_r}")
            if max_r > 60:
                self.warnings.append(f"t={start:.0f}-{end:.0f}: 横滚 {max_r:.0f}° 可能翻飞")
            if max_p_pos > 30:
                self.warnings.append(f"t={start:.0f}-{end:.0f}: 俯仰 {max_p_pos:.0f}° 失控")

    # ═══ 8. 开关位置时间线 ═══
    def switch_timeline(self):
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  8. 开关位置变化（mode/gear/auto）", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        # Track ch6 (mode), ch7 (gear), ch9 (auto)
        ch_names = {6:'MODE', 7:'GEAR', 9:'AUTO'}
        last = {6:None, 7:None, 9:None}
        for ts, *chs in self.rcin:
            for ch, name in ch_names.items():
                v = chs[ch-1]
                if v < 1300: pos = '低'
                elif v < 1700: pos = '中'
                else: pos = '高'
                if last[ch] != pos:
                    if last[ch] is not None:
                        print(f"  t={ts:6.1f}s  {name}: {last[ch]} → {pos} (PWM {v})")
                    last[ch] = pos

    # ═══ 9. MSK 模式/档位/Auto 时间线 ═══
    def msk_timeline(self):
        has_any = self.msk_mode_changes or self.msk_gear_changes or self.msk_auto_changes
        if not has_any:
            return
        print(colored("\n" + "="*72, C.CYN))
        print(colored("  9. MSK Lua 模式时间线", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        events = []
        for ts, mode in self.msk_mode_changes:
            events.append((ts, 'MODE', mode))
        for ts, gear in self.msk_gear_changes:
            events.append((ts, 'GEAR', f'G{gear}'))
        for ts, auto in self.msk_auto_changes:
            events.append((ts, 'AUTO', auto))
        events.sort()
        for ts, kind, val in events[:60]:
            col = {'MODE':C.CYN, 'GEAR':C.YEL, 'AUTO':C.MAG}.get(kind, C.END)
            print(f"  t={ts:7.1f}s  {colored(kind, col):15s} → {val}")
        if len(events) > 60:
            print(f"  ... ({len(events)-60} 更多事件省略)")

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
        print(colored(" 12. 倾转舵 (SERVO15/16) 输出验证", C.CYN+C.BOLD))
        print(colored("="*72, C.CYN))
        lz = self.params.get('MSK_TILT_L_ZERO', 1500)
        rz = self.params.get('MSK_TILT_R_ZERO', 1500)
        ld = self.params.get('MSK_TILT_L_DIR', 1)
        rd = self.params.get('MSK_TILT_R_DIR', -1)
        uspd = self.params.get('MSK_TILT_USPD', 8.0)
        tmax = self.params.get('MSK_TILT_DEG', 30)
        print(f"  校准: L_ZERO={lz:.0f} L_DIR={ld:+.0f}  R_ZERO={rz:.0f} R_DIR={rd:+.0f}  USPD={uspd:.1f}μs/°  MAX={tmax:.0f}°")
        vl = [p[15] for p in self.rcou if len(p) > 15]  # ch15 = index 15
        vr = [p[16] for p in self.rcou if len(p) > 16]
        if not vl or not vr:
            print("  RCOU 无 C15/C16 数据")
            return
        print(f"  DFL  (S15) min={min(vl):4.0f} max={max(vl):4.0f} avg={sum(vl)/len(vl):6.0f}")
        print(f"  DFR  (S16) min={min(vr):4.0f} max={max(vr):4.0f} avg={sum(vr)/len(vr):6.0f}")
        # 镜像验证: L-ZERO 和 R-ZERO 偏移方向应该相反 (用 DIR 加权同角度应该都增或都减)
        # 测试: 倾 15° → PWM_L = LZ + LD*15*USPD, PWM_R = RZ + RD*15*USPD
        pwm_l_15 = lz + ld * 15 * uspd
        pwm_r_15 = rz + rd * 15 * uspd
        print(f"  15° 位置预期: L={pwm_l_15:.0f}  R={pwm_r_15:.0f}")
        # 如果实测范围都没达到预期，警告
        if max(vl) < pwm_l_15 - 30 and max(vl) > 1400:
            self.warnings.append(f"DFL 最大 PWM {max(vl):.0f} 未达 15° 预期 {pwm_l_15:.0f}")
        if (ld > 0 and rd > 0) or (ld < 0 and rd < 0):
            self.warnings.append(f"DIR 方向同号 (L={ld:+.0f} R={rd:+.0f}), 镜像错误!")
            print(colored(f"  ✗ DIR 方向同号, 应为一正一负!", C.RED))

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

        # 总结
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
        axes[0].axhline(y=4, color='gray', ls='--', alpha=0.5, label='V1=4')
        axes[0].axhline(y=8, color='orange', ls='--', alpha=0.5, label='V2=8')
        axes[0].axhline(y=14, color='green', ls='--', alpha=0.5, label='V3=14')
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
