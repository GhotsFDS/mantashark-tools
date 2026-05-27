#!/usr/bin/env python3
"""bench_cli.py — 无 GUI 全流程跑通台架扫描.

用法 (最小):
  python3 bench_cli.py --fc /dev/ttyACM0 --motors 1,2,3,4 --tilts SGRP \
                       --angles 30,60 --thr-start 0.1 --thr-max 0.25 --step 0.05 \
                       --out ./bench_logs

带 sensor:
  python3 bench_cli.py --fc /dev/ttyACM0 --sensor /dev/ttyUSB0 \
                       --motors KS --tilts SGRP --angles 30,60,90 ...

闭环流程:
  1. 连飞控 (+ 可选 sensor)
  2. 配置 MSAK_* 参数
  3. 启录制 (CSV 含任务配置备注)
  4. SW_ARM 0→1 强边沿触发
  5. 监听 STATUSTEXT, 看 BENCH DONE 标志结束
  6. 收尾 CSV + SW_ARM=0 + EN=0
  7. 退出
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from typing import Optional

from fc_mavlink import FCMavlink
from transducer_ascii import TransducerAscii
from recorder import Recorder


# 跟 bench_pc.py 一致的映射
TILT_LIST = [
    ('DFL',  13), ('DFR',  14), ('TL1',  15), ('TR1',  16),
    ('RDL',  17), ('RDR',  18), ('SGRP', 19), ('TL2',  20), ('TR2',  21),
]
TILT_NAME_TO_IDX = {nm: i for i, (nm, _) in enumerate(TILT_LIST)}

MOTOR_GROUP_ALIAS = {
    'KS':  [1, 2, 3, 4],
    'KDF': [5, 6],
    'KT-OUTER': [7, 9],  'KT_OUTER': [7, 9],
    'KT-INNER': [8, 10], 'KT_INNER': [8, 10],
    'KT':  [7, 8, 9, 10],
    'KRD': [11, 12],
    'ALL': list(range(1, 13)),
}


def parse_motors(s: str) -> int:
    """'KS' / '1,2,3,4' / 'M1,M5' → bitmask"""
    mask = 0
    for tok in s.split(','):
        tok = tok.strip().upper()
        if not tok: continue
        if tok in MOTOR_GROUP_ALIAS:
            for m in MOTOR_GROUP_ALIAS[tok]:
                mask |= (1 << (m - 1))
        else:
            n = int(tok.lstrip('M'))
            if 1 <= n <= 12: mask |= (1 << (n - 1))
    return mask


def parse_tilts(s: str) -> int:
    """'SGRP,DFL' / 'all' → bitmask"""
    mask = 0
    if s.strip().lower() == 'all':
        return (1 << len(TILT_LIST)) - 1
    for tok in s.split(','):
        tok = tok.strip().upper()
        if tok in TILT_NAME_TO_IDX:
            mask |= (1 << TILT_NAME_TO_IDX[tok])
    return mask


def mask_to_motor_str(mask: int) -> str:
    return ','.join(f'M{m}' for m in range(1, 13) if mask & (1 << (m - 1))) or 'none'

def mask_to_tilt_str(mask: int) -> str:
    return ','.join(nm for i, (nm, _) in enumerate(TILT_LIST) if mask & (1 << i)) or 'none'


def set_param(fc: FCMavlink, name: str, val) -> bool:
    return fc.set_param(name, float(val))


def main():
    ap = argparse.ArgumentParser(description='台架扫描 CLI 全流程',
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__)
    ap.add_argument('--fc',     default='/dev/ttyACM0', help='飞控串口')
    ap.add_argument('--fc-baud', type=int, default=115200)
    ap.add_argument('--sensor', default=None, help='传感器串口 (可选)')
    ap.add_argument('--sensor-baud', type=int, default=9600)
    ap.add_argument('--out',    default='./bench_logs')

    ap.add_argument('--motors', required=True,
                    help='电机 (e.g. KS / 1,2,3,4 / M1,M5 / ALL)')
    ap.add_argument('--tilts',  default='',
                    help='倾转 (e.g. SGRP / DFL,DFR / ALL / 空=不扫)')
    ap.add_argument('--angles', required=True,
                    help='角度列表, 逗号分隔 (e.g. 30,60,90)')

    ap.add_argument('--thr-start', type=float, default=0.10)
    ap.add_argument('--thr-max',   type=float, default=0.25)
    ap.add_argument('--step',      type=float, default=0.05)
    ap.add_argument('--hold-ms',   type=int,   default=1200)
    ap.add_argument('--ramp-ms',   type=int,   default=400)
    ap.add_argument('--ramp-dn',   type=int,   default=1000)
    ap.add_argument('--cpl-en',    type=int,   default=1)
    ap.add_argument('--cpl-k',     type=float, default=1.0)

    ap.add_argument('--timeout',   type=int,   default=120,
                    help='整体超时 (秒, 防卡死)')
    ap.add_argument('--repeat',    type=int,   default=1,
                    help='重复跑多少次 (默 1, 每次独立 CSV)')
    ap.add_argument('--repeat-delay', type=float, default=3.0,
                    help='两次任务之间间隔 (秒, 让 lua 退 IDLE, 默 3)')
    ap.add_argument('--no-sensor-required', action='store_true',
                    help='已默认, 保留兼容: 没 sensor 也跑')

    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    # 解析任务参数
    m_mask = parse_motors(args.motors)
    if m_mask == 0:
        print(f'ERROR: --motors {args.motors!r} 解析为空', file=sys.stderr); sys.exit(2)
    t_mask = parse_tilts(args.tilts) if args.tilts else 0
    angles = [float(x) for x in args.angles.split(',') if x.strip()]
    if not (1 <= len(angles) <= 8):
        print(f'ERROR: --angles 必须 1-8 个', file=sys.stderr); sys.exit(2)

    print('=' * 60)
    print('MantaShark 台架 CLI 全流程')
    print('=' * 60)
    print(f'电机: {mask_to_motor_str(m_mask)}  (mask={m_mask})')
    print(f'倾转: {mask_to_tilt_str(t_mask)}  (mask={t_mask})')
    print(f'角度: {angles}')
    print(f'油门: {args.thr_start:.2f} → {args.thr_max:.2f} step {args.step:.2f}')
    print(f'  hold={args.hold_ms}ms ramp_up={args.ramp_ms}ms ramp_dn={args.ramp_dn}ms')
    print(f'输出: {args.out}/')
    print('=' * 60)

    # 1. 连飞控
    print(f'\n[1/6] 连飞控 {args.fc} @ {args.fc_baud}...')
    fc = FCMavlink(args.fc, baud=args.fc_baud)
    fc.connect(timeout=15)
    print(f'   ✓ sys={fc._sys}')

    # 1b. 连 sensor (可选)
    sensor = None
    if args.sensor:
        print(f'   连 sensor {args.sensor} @ {args.sensor_baud}...')
        try:
            sensor = TransducerAscii(args.sensor, baud=args.sensor_baud, channels=[1, 2, 3])
            sensor.open()
            hs = sensor.handshake()
            ok = sum(1 for v in hs.values() if v)
            sensor.start_continuous(interval_ms=100, fmt=1)
            print(f'   ✓ sensor 握手 {ok}/3')
        except Exception as e:
            print(f'   传感器连接失败: {e} (继续无 sensor 录制)')
            sensor = None

    # 2. 配置参数 — 先彻底清状态等 lua 退 IDLE, 再写新任务
    print(f'\n[2/6] 一次性配置全局参数...')
    set_param(fc, 'ARMING_REQUIRE', 0)
    set_param(fc, 'MSAK_EN', 0); set_param(fc, 'MSAK_SW_ARM', 0)
    set_param(fc, 'MSAK_CAL_CH', 0); set_param(fc, 'MSAK_CAL_PWM', 0)
    set_param(fc, 'TLT_CPL_EN', args.cpl_en)
    set_param(fc, 'TLT_CPL_SDF_K', args.cpl_k)
    print('   等 1.5s 让 lua 退 IDLE...')
    time.sleep(1.5)
    fc.drain_statustext()
    set_param(fc, 'MSAK_MOTOR_MSK', m_mask)
    set_param(fc, 'MSAK_TILT_MSK',  t_mask)
    set_param(fc, 'MSAK_ANG_N',     len(angles))
    for i, a in enumerate(angles, start=1):
        set_param(fc, f'MSAK_ANG_{i}', a)
    set_param(fc, 'MSAK_THR_START', args.thr_start)
    set_param(fc, 'MSAK_THR_MAX',   args.thr_max)
    set_param(fc, 'MSAK_THR_STEP',  args.step)
    set_param(fc, 'MSAK_HOLD_MS',   args.hold_ms)
    set_param(fc, 'MSAK_RAMP_MS',   args.ramp_ms)
    set_param(fc, 'MSAK_RAMP_DN',   args.ramp_dn)
    set_param(fc, 'MSAK_EN', 1)
    print('   ✓ 参数已写')

    # 3. 主循环 (--repeat N 次)
    print(f'\n[3] 主循环 {args.repeat} 次扫描')
    n_ok = 0; n_fail = 0
    for run_idx in range(1, args.repeat + 1):
        ok, _ = run_one(fc, sensor, args, m_mask, t_mask, angles, run_idx)
        if ok: n_ok += 1
        else:  n_fail += 1
        if run_idx < args.repeat:
            print(f'  → 等 {args.repeat_delay}s 后跑下一次...')
            time.sleep(args.repeat_delay)
    print(f'\n[4] 总结: {n_ok} 完成 / {n_fail} 失败 / {args.repeat} 总计')

    # 收尾
    print(f'\n[5] 收尾...')
    fc.set_param('MSAK_SW_ARM', 0); fc.set_param('MSAK_EN', 0)
    fc.set_param('ARMING_REQUIRE', 1)
    if sensor:
        try: sensor.close()
        except: pass
    fc.close()
    print('完成.' if n_fail == 0 else f'警告: {n_fail} 次未完整 DONE.')
    sys.exit(0 if n_fail == 0 else 1)


# ─── 单次运行函数 (供 --repeat 循环复用) ─────────────────────
def run_one(fc, sensor, args, m_mask, t_mask, angles, run_idx):
    n_runs_str = f' [{run_idx}/{args.repeat}]' if args.repeat > 1 else ''
    print(f'\n=== 第 {run_idx} 次扫描{n_runs_str} ===')

    # 启录制
    recorder = Recorder(args.out)
    cfg = {
        '起始油门 (THR_START)': f'{args.thr_start:.2f}',
        '终点油门 (THR_MAX)':   f'{args.thr_max:.2f}',
        '步进 (THR_STEP)':      f'{args.step:.2f}',
        '每档保持 (HOLD)':      f'{args.hold_ms} ms',
        '启动 ramp':            f'{args.ramp_ms} ms',
        '结束缓降':              f'{args.ramp_dn} ms',
        '电机详单':              mask_to_motor_str(m_mask),
        '倾转详单':              mask_to_tilt_str(t_mask),
        '角度列表':              ','.join(f'{a:.0f}' for a in angles),
        'S→DF 解耦':            f'EN={args.cpl_en} K={args.cpl_k:.2f}',
        'CLI 启动':              '是',
        '重复 idx':              f'{run_idx}/{args.repeat}',
    }
    csv_path = recorder.start_task(
        motors_str=mask_to_motor_str(m_mask).replace(',', '-'),
        tilts_str=mask_to_tilt_str(t_mask).replace(',', '-'),
        angles_str='-'.join(f'{a:.0f}' for a in angles),
        thr_range_str=f'{int(args.thr_start*100)}-{int(args.thr_max*100)}',
        config=cfg,
    )
    print(f'  录制: {os.path.basename(csv_path)}')

    # SW_ARM 强 0→1 边沿
    fc.set_param('MSAK_SW_ARM', 0)
    time.sleep(0.3)
    fc.drain_statustext()   # 清残留消息, 等 lua 真正回 IDLE
    fc.set_param('MSAK_SW_ARM', 1)

    # 监听
    t0 = time.time()
    pwm_1_16 = [0] * 16; pwm_17_21 = [0] * 5
    cur_phase = 'WAIT'; cur_ang_idx = 0; cur_ang_deg = 0.0; cur_thr = 0.0
    last_sample = 0; last_log = 0
    done = False
    while time.time() - t0 < args.timeout:
        for _, sev, txt in fc.drain_statustext():
            if 'STT:' in txt: continue
            if 'BENCH' in txt and 'IDLE' not in txt:
                print(f'  [{time.time()-t0:5.1f}] {txt}')
            if 'BENCH' in txt:
                m = re.search(r'ang\[(\d+)/\d+\]=(-?[\d.]+)\s+thr=(\d+)%', txt)
                if m:
                    cur_ang_idx = int(m.group(1))
                    cur_ang_deg = float(m.group(2))
                    cur_thr = float(m.group(3))
                if 'RAMP_UP'   in txt: cur_phase = 'RAMP_UP'
                elif 'HOLD'    in txt: cur_phase = 'HOLD'
                elif 'RAMP_DOWN' in txt: cur_phase = 'RAMP_DOWN'
                elif 'START'   in txt: cur_phase = 'START'
                elif 'DONE'    in txt:
                    cur_phase = 'DONE'; done = True
                elif 'ABORT'   in txt:
                    cur_phase = 'ABORT'; done = True
        now = time.time()
        if now - last_sample >= 0.1:
            last_sample = now
            servo = fc.latest_servo()
            if servo and servo.pwm:
                pwm_1_16 = list(servo.pwm[:16])
                pwm_17_21 = list(servo.pwm[16:21])
            sensor_vals = sensor.get_latest() if sensor else {}
            recorder.write_task(
                t_pc=now - t0, sensor=sensor_vals,
                pwm_1_16=pwm_1_16, pwm_17_21=pwm_17_21,
                phase=cur_phase, ang_idx=cur_ang_idx,
                ang_deg=cur_ang_deg, thr_pct=cur_thr, fc_status='',
            )
            if now - last_log >= 1.0:
                last_log = now
                s_str = '  '.join(f's{c}={sensor_vals.get(c, "-")}' for c in [1,2,3])
                print(f'  [{now-t0:5.1f}] {cur_phase:8s} ang[{cur_ang_idx}]={cur_ang_deg:.0f}° '
                      f'thr={cur_thr:.0f}%  M1={pwm_1_16[0]} {s_str}')
        if done:
            time.sleep(0.5)
            break
        time.sleep(0.05)

    fc.set_param('MSAK_SW_ARM', 0)
    path, n_rows = recorder.end_point()
    status = '完成' if done else '超时未完整'
    print(f'  {status} · CSV {n_rows} 行 → {os.path.basename(path)}')
    return done, csv_path

    # (旧 step 3-6 已撤, 主循环已在 main 内提前)
    pass

def _old_unused():
    # 3. 启录制
    print(f'\n[3/6] 启动录制...')
    recorder = Recorder(args.out)
    cfg = {
        '起始油门 (THR_START)': f'{args.thr_start:.2f}',
        '终点油门 (THR_MAX)':   f'{args.thr_max:.2f}',
        '步进 (THR_STEP)':      f'{args.step:.2f}',
        '每档保持 (HOLD)':      f'{args.hold_ms} ms',
        '启动 ramp':            f'{args.ramp_ms} ms',
        '结束缓降':              f'{args.ramp_dn} ms',
        '电机详单':              mask_to_motor_str(m_mask),
        '倾转详单':              mask_to_tilt_str(t_mask),
        '角度列表':              ','.join(f'{a:.0f}' for a in angles),
        'S→DF 解耦':            f'EN={args.cpl_en} K={args.cpl_k:.2f}',
        'CLI 启动':              '是',
    }
    csv_path = recorder.start_task(
        motors_str=mask_to_motor_str(m_mask).replace(',', '-'),
        tilts_str=mask_to_tilt_str(t_mask).replace(',', '-'),
        angles_str='-'.join(f'{a:.0f}' for a in angles),
        thr_range_str=f'{int(args.thr_start*100)}-{int(args.thr_max*100)}',
        config=cfg,
    )
    print(f'   ✓ {csv_path}')

    # 4. SW_ARM 0→1 强边沿
    print(f'\n[4/6] SW_ARM=0 → 0.3s → SW_ARM=1 (强边沿)...')
    set_param(fc, 'MSAK_SW_ARM', 0)
    time.sleep(0.3)
    set_param(fc, 'MSAK_SW_ARM', 1)
    print('   ✓ 触发')

    # 5. 监听 + 录制 直到 DONE / timeout
    print(f'\n[5/6] 监听 (timeout {args.timeout}s)...')
    t0 = time.time()
    pwm_1_16 = [0] * 16
    pwm_17_21 = [0] * 5
    cur_phase = 'WAIT'
    cur_ang_idx = 0
    cur_ang_deg = 0.0
    cur_thr = 0.0
    last_sample = 0
    last_log = 0
    done = False

    while time.time() - t0 < args.timeout:
        # 抓 STATUSTEXT
        for _, sev, txt in fc.drain_statustext():
            if 'STT:' in txt: continue
            if 'BENCH' in txt:
                tag = '[飞控]' if 'IDLE' not in txt else ''
                if tag: print(f'  [{time.time()-t0:5.1f}] {txt}')
                m = re.search(r'ang\[(\d+)/\d+\]=(-?[\d.]+)\s+thr=(\d+)%', txt)
                if m:
                    cur_ang_idx = int(m.group(1))
                    cur_ang_deg = float(m.group(2))
                    cur_thr = float(m.group(3))
                if 'RAMP_UP'   in txt: cur_phase = 'RAMP_UP'
                elif 'HOLD'    in txt: cur_phase = 'HOLD'
                elif 'RAMP_DOWN' in txt: cur_phase = 'RAMP_DOWN'
                elif 'START'   in txt: cur_phase = 'START'
                elif 'DONE'    in txt:
                    cur_phase = 'DONE'
                    done = True
                elif 'ABORT'   in txt:
                    cur_phase = 'ABORT'
                    done = True
        # 10Hz 抓 servo + sensor 写 CSV
        now = time.time()
        if now - last_sample >= 0.1:
            last_sample = now
            servo = fc.latest_servo()
            if servo and servo.pwm:
                pwm_1_16 = list(servo.pwm[:16])
                pwm_17_21 = list(servo.pwm[16:21])
            sensor_vals = sensor.get_latest() if sensor else {}
            recorder.write_task(
                t_pc=now - t0, sensor=sensor_vals,
                pwm_1_16=pwm_1_16, pwm_17_21=pwm_17_21,
                phase=cur_phase, ang_idx=cur_ang_idx,
                ang_deg=cur_ang_deg, thr_pct=cur_thr, fc_status='',
            )
            if now - last_log >= 1.0:
                last_log = now
                s_str = '  '.join(f's{c}={sensor_vals.get(c, "-")}' for c in [1,2,3])
                print(f'  [{now-t0:5.1f}] {cur_phase:8s} ang[{cur_ang_idx}]={cur_ang_deg:.0f}° '
                      f'thr={cur_thr:.0f}%  M1={pwm_1_16[0]} {s_str}')
        if done:
            time.sleep(0.5)  # 多录一会儿 DONE 后状态
            break
        time.sleep(0.05)

    if not done:
        print(f'  ✗ 超时 ({args.timeout}s), 任务未完成')

    # 6. 收尾
    print(f'\n[6/6] 收尾...')
    set_param(fc, 'MSAK_SW_ARM', 0); set_param(fc, 'MSAK_EN', 0)
    set_param(fc, 'ARMING_REQUIRE', 1)
    path, n_rows = recorder.end_point()
    print(f'   ✓ CSV: {n_rows} 行 → {path}')
    if sensor:
        try: sensor.close()
        except: pass
    fc.close()
    print('\n完成.' if done else '\n警告: 未完整 DONE.')
    sys.exit(0 if done else 1)


if __name__ == '__main__':
    main()
