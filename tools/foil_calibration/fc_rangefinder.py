#!/usr/bin/env python3
"""
实时显示飞控 ADC 解析的测距 (RNGFND1, UB500→转换模块→PC4 ADC)

直读飞控 MAVLink RANGEFINDER 消息 = ArduPilot 用 RNGFND1_SCALING/OFFSET
解析后的距离。同时反推 ADC 电压、标量程状态 (盲区/超窗/丢回波饱和)。
和万用表脚本 dm858_distance.py 对照: 两边距离应一致, 差异 = ADC 标定/分压偏差。

用法:
    python3 fc_rangefinder.py                 # 默认 /dev/ttyACM0 @115200
    python3 fc_rangefinder.py --device /dev/ttyACM0 --baud 115200 --rate 10
"""
import argparse, time
from pymavlink import mavutil

def getp(m, name, t=3):
    m.mav.param_request_read_send(m.target_system, m.target_component, name.encode()[:16], -1)
    t0 = time.time()
    while time.time() - t0 < t:
        msg = m.recv_match(type='PARAM_VALUE', blocking=True, timeout=1)
        if msg and msg.param_id.strip() == name:
            return msg.param_value
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--device', default='/dev/ttyACM0')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--rate', type=float, default=10.0, help='请求刷新率 Hz')
    args = ap.parse_args()

    m = mavutil.mavlink_connection(args.device, baud=args.baud)
    m.wait_heartbeat(timeout=10)
    print('飞控已连接, 读 RNGFND1 标定...', flush=True)

    scaling = getp(m, 'RNGFND1_SCALING') or 0.13636
    offset  = getp(m, 'RNGFND1_OFFSET')  or 0.0
    mn = (getp(m, 'RNGFND1_MIN') or 0.08)
    mx = (getp(m, 'RNGFND1_MAX') or 0.45)
    print(f'SCALING={scaling:.5f} m/V  OFFSET={offset:.5f} V  窗口 {mn*1000:.0f}-{mx*1000:.0f}mm', flush=True)

    # 请求 RANGEFINDER (id 173) 高速流
    m.mav.command_long_send(m.target_system, m.target_component,
        mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
        173, int(1e6 / max(args.rate, 1)), 0, 0, 0, 0, 0)

    print('Ctrl-C 退出\n', flush=True)
    while True:
        msg = m.recv_match(type='RANGEFINDER', blocking=True, timeout=2)
        if not msg:
            print('\r(无 RANGEFINDER — 检查 RNGFND1_TYPE/接线)        ', end='', flush=True)
            continue
        d_mm = msg.distance * 1000.0
        # 反推 ADC 电压: dist = (V - offset)*scaling → V = dist/scaling + offset
        v = msg.distance / scaling + offset if scaling else 0.0
        # 消息自带 voltage 字段 (raw, 有则更准)
        vraw = getattr(msg, 'voltage', 0.0) or 0.0
        flag = ''
        if d_mm <= mn*1000 + 1:   flag = ' [≤MIN 盲区/触底]'
        elif d_mm >= mx*1000 - 1: flag = ' [≥MAX 超窗/丢回波→PID冻结]'
        frac = (msg.distance - mn) / (mx - mn) if mx > mn else 0
        bar = '#' * max(0, min(40, int(frac * 40)))
        vtxt = f'{v:5.3f}V' + (f' (raw {vraw:5.3f})' if vraw else '')
        print(f'\r{d_mm:7.1f} mm  {vtxt}  |{bar:<40}|{flag}      ', end='', flush=True)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print()
