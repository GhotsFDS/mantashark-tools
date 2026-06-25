#!/usr/bin/env python3
"""
DM858E 读电压 (4-20mA→转换模块→电压) → 实时换算 UB500 距离 (台架标定用)

链路: UB500 (4-20mA) → 转换模块 (→0-3.3V) → 万用表读电压。
换算 = 电压两点线性标定。这两个点 (V, 距离) 直接就是 ArduPilot RNGFND 标定数据。

  距离(mm) = d1 + (d2-d1) × (V - v1) / (v2 - v1)

默认两点按 "4-20mA→0-3.3V 模块 + UB500 出厂窗口 50-500mm" 给:
  v1=0.0V→50mm, v2=3.3V→500mm   ← 必须卷尺实测两点改对! 默认只是开机看个大概
raw 电压永远真实显示, 换算 mm 取决于标定对不对。

用法:
    python3 dm858_distance.py 169.254.112.67                  # 表 IP (链路本地直连)
    python3 dm858_distance.py /dev/usbtmc0                     # USB 直连
两点标定 (卷尺):
    --v1 0.62 --d1 50  --v2 3.01 --d2 500     # 近端/远端实测电压→距离
    --curr                                     # 回退读电流模式 (拔了转换器时)
    --interval 0.3
"""
import time, socket, argparse

def make_io(target):
    if target.startswith('/dev/'):
        f = open(target, 'r+b', buffering=0)
        return (lambda c: f.write((c + '\n').encode()),
                lambda: f.read(256).decode().strip())
    s = socket.create_connection((target, 5025), timeout=3)   # DM858E 实测 5025 (5555 不开)
    s.settimeout(4)            # 读卡死保护 (表 raw socket 单客户端, 残留连接会占线 ~1min)
    buf = s.makefile('rb')
    return (lambda c: s.sendall((c + '\n').encode()),
            lambda: buf.readline().decode().strip())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('target', help='仪器 IP 或 /dev/usbtmcN')
    ap.add_argument('--v1', type=float, default=0.0,   help='近端实测电压 V')
    ap.add_argument('--d1', type=float, default=50.0,  help='近端对应距离 mm')
    ap.add_argument('--v2', type=float, default=3.3,   help='远端实测电压 V')
    ap.add_argument('--d2', type=float, default=500.0, help='远端对应距离 mm')
    ap.add_argument('--curr', action='store_true', help='读电流模式 (拔了转换器)')
    ap.add_argument('--interval', type=float, default=0.3)
    args = ap.parse_args()

    write, read = make_io(args.target)
    write('*IDN?')
    print('仪器:', read(), flush=True)

    if args.curr:
        # 电流模式: 4mA→d1, 20mA→d2 (转换器拔掉时直接读传感器)
        scpi, unit = ':MEASure:CURRent:DC?', 'mA'
        x1, x2 = 4.0, 20.0
        lo_flag, hi_flag = ' [<4mA 断线/盲区?]', ' [>20mA 超窗/丢目标?]'
        rd_scale = 1000.0
    else:
        scpi, unit = ':MEASure:VOLTage:DC?', 'V'
        x1, x2 = args.v1, args.v2
        lo_flag = f' [<{args.v1:.2f}V 近界/盲区?]'
        hi_flag = f' [>{args.v2:.2f}V 超窗/丢目标饱和?]'
        rd_scale = 1.0

    slope = (args.d2 - args.d1) / (x2 - x1)            # mm per (V 或 mA)
    span = args.v2 - args.v1 if not args.curr else 16.0
    # ArduPilot analog 后端 (FUNCTION=0 线性): dist_m = (V − OFFSET) × SCALING
    #   SCALING 单位 m/V; OFFSET 单位 V (零距离对应电压, 非米!) — 见 AP_RangeFinder_analog.cpp:96
    if not args.curr:
        sc = (args.d2 - args.d1) / 1000.0 / (args.v2 - args.v1)   # m/V
        off_v = args.v1 - (args.d1 / 1000.0) / sc                 # V (零距对应电压)
        print(f'RNGFND1_SCALING={sc:.5f}  RNGFND1_OFFSET={off_v:.5f}  '
              f'(FUNCTION=0; 卷尺两点 --v1/--d1/--v2/--d2 改对后直接填飞控)', flush=True)

    print(f'读{ "电流" if args.curr else "电压" } | 窗口 {args.d1:.0f}-{args.d2:.0f}mm | Ctrl-C 退出', flush=True)
    margin = (x2 - x1) * 0.02
    while True:
        write(scpi)
        try:
            x = float(read()) * rd_scale
        except (ValueError, socket.timeout):
            continue
        d = args.d1 + slope * (x - x1)
        flag = ''
        if x < x1 - margin:   flag = lo_flag
        elif x > x2 + margin: flag = hi_flag
        frac = (d - args.d1) / (args.d2 - args.d1) if args.d2 != args.d1 else 0
        bar = '#' * max(0, min(50, int(frac * 50)))
        print(f'\r{x:7.3f} {unit}  →  {d:7.1f} mm {bar:<50}{flag}   ',
              end='', flush=True)
        time.sleep(args.interval)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print()
