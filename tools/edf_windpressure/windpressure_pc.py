#!/usr/bin/env python3
"""涵道风压/流速台架 上位机 (配 edf_windpressure.lua).

流程:
  1. 连 FC, 设 WPT_ 参数 (motor mask / 目标油门 / hold 秒 / 上升&下降 ramp)
  2. 拉高 SCALED_PRESSURE 流率
  3. 静置归零 (测差压零点 offset)
  4. 安全倒计时 (电机会转!) → WPT_SW_ARM 0→1 触发
  5. 记录: t / commanded油门(WTHR) / 差压(去offset Pa) / 流速 / 盘载 / 电压电流 / 状态
  6. 导出 CSV + 打印 HOLD 段稳态统计 + 峰值

差压取原始 SCALED_PRESSURE.press_diff (不信飞控 airspeed), 流速 V=sqrt(2q/rho), 盘载=rho*V^2.

示例:
  ./windpressure_pc.py --motors 5 --throttle 0.6 --hold 5 --ramp-up 2500 --ramp-down 1500
  ./windpressure_pc.py --motors 5,6 --throttle 80 --area-cm2 22   # 80%, 给喷口面积算流量Q
"""
from __future__ import annotations
import argparse, csv, math, os, sys, time
from datetime import datetime
from pymavlink import mavutil

STATE_NAME = {0: 'IDLE', 1: 'RAMP_UP', 2: 'HOLD', 3: 'RAMP_DN', 4: 'DONE'}


def motors_to_mask(s: str) -> int:
    mask = 0
    for tok in s.split(','):
        tok = tok.strip()
        if not tok:
            continue
        n = int(tok)
        if not (1 <= n <= 12):
            raise ValueError(f'motor {n} 超范围 (1-12)')
        mask |= (1 << (n - 1))
    return mask


def parse_throttle(v: float) -> float:
    """接受 0-1 或 0-100 (>1 视为百分比)."""
    return v / 100.0 if v > 1.0 else v


def set_param(m, name, value, retries=4, timeout=2.0):
    pid = name.encode('ascii').ljust(16, b'\x00')[:16]
    for _ in range(retries):
        m.mav.param_set_send(m.target_system, m.target_component, pid,
                             float(value), mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = m.recv_match(type='PARAM_VALUE', blocking=True, timeout=0.3)
            if msg and msg.param_id == name and abs(msg.param_value - value) < 1e-3:
                return True
    return False


def request_fast_pressure(m, hz=50):
    # 整体流 + 单独把 SCALED_PRESSURE(29) 拉到 hz
    m.mav.request_data_stream_send(m.target_system, m.target_component,
                                   mavutil.mavlink.MAV_DATA_STREAM_ALL, 20, 1)
    try:
        m.mav.command_long_send(m.target_system, m.target_component,
            mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
            29, int(1e6 / hz), 0, 0, 0, 0, 0)
    except Exception:
        pass


def nv_name(msg):
    return msg.name.strip('\x00').strip() if hasattr(msg, 'name') else ''


def main():
    ap = argparse.ArgumentParser(description='涵道风压/流速台架上位机')
    ap.add_argument('--device', default='/dev/ttyACM0')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--motors', required=True, help='电机号 1-12, 逗号分隔, 如 5 或 5,6')
    ap.add_argument('--throttle', type=float, required=True, help='目标油门 0-1 或 0-100 (百分比)')
    ap.add_argument('--hold', type=float, default=5.0, help='目标油门维持秒数')
    ap.add_argument('--ramp-up', type=int, default=2500, help='上升 ramp ms (软启动)')
    ap.add_argument('--ramp-down', type=int, default=1500, help='下降 ramp ms')
    ap.add_argument('--rho', type=float, default=1.20, help='空气密度 kg/m^3')
    ap.add_argument('--area-cm2', type=float, default=0.0, help='喷口面积 cm^2 (给了才算流量Q)')
    ap.add_argument('--zero-secs', type=float, default=3.0, help='归零采样秒数')
    ap.add_argument('--out', default=None, help='CSV 输出路径')
    ap.add_argument('--yes', action='store_true', help='跳过启动确认 (电机会转!)')
    args = ap.parse_args()

    mask = motors_to_mask(args.motors)
    thr = parse_throttle(args.throttle)
    if not (0.0 <= thr <= 1.0):
        sys.exit(f'油门 {thr} 超范围')
    area_m2 = args.area_cm2 * 1e-4

    print(f'连接 {args.device} @ {args.baud} ...')
    m = mavutil.mavlink_connection(args.device, baud=args.baud, dialect='ardupilotmega')
    if not m.wait_heartbeat(timeout=10):
        sys.exit('❌ 无 heartbeat')
    print(f'✓ sys={m.target_system} comp={m.target_component}')
    m.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_GCS, mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)
    request_fast_pressure(m, 50)

    def stop_motors():
        set_param(m, 'WPT_SW_ARM', 0)
        set_param(m, 'WPT_EN', 0)

    try:
        # ---- 设参数 ----
        print('设置 WPT_ 参数 ...')
        ok = True
        ok &= set_param(m, 'WPT_SW_ARM', 0)
        ok &= set_param(m, 'WPT_MOTOR_MSK', mask)
        ok &= set_param(m, 'WPT_THR_TGT', thr)
        ok &= set_param(m, 'WPT_HOLD_S', args.hold)
        ok &= set_param(m, 'WPT_RAMP_UP', args.ramp_up)
        ok &= set_param(m, 'WPT_RAMP_DN', args.ramp_down)
        ok &= set_param(m, 'WPT_EN', 1)
        if not ok:
            stop_motors()
            sys.exit('❌ 参数设置失败 (检查 lua 是否为 edf_windpressure.lua / 已加载)')
        print(f'  motors={args.motors} (mask={mask})  thr={thr*100:.0f}%  '
              f'hold={args.hold}s  ramp_up={args.ramp_up}ms  ramp_dn={args.ramp_down}ms')

        # ---- 归零 ----
        print(f'归零中 (别吹/别给气流) {args.zero_secs}s ...')
        zs, t0 = [], time.time()
        while time.time() - t0 < args.zero_secs:
            msg = m.recv_match(type='SCALED_PRESSURE', blocking=True, timeout=1)
            if msg:
                zs.append(msg.press_diff * 100.0)
        if not zs:
            stop_motors(); sys.exit('❌ 收不到 SCALED_PRESSURE (检查 ARSPD_TYPE/BUS)')
        offset = sum(zs) / len(zs)
        sd = (sum((x - offset) ** 2 for x in zs) / len(zs)) ** 0.5
        print(f'  零点 offset = {offset:+.2f} Pa  (噪声 sd={sd:.2f} Pa, n={len(zs)})')

        # ---- 安全确认 ----
        if not args.yes:
            print('\n⚠️  即将启动电机! 确认: 桨/EDF 周围无人无物, 台架固定, 皮托管到位.')
            try:
                input('   回车开始 (Ctrl-C 取消) ...')
            except KeyboardInterrupt:
                stop_motors(); print('\n已取消'); return
        for c in (3, 2, 1):
            print(f'  {c} ...', flush=True); time.sleep(1)

        # ---- 触发 + 记录 ----
        total_s = (args.ramp_up + args.ramp_down) / 1000.0 + args.hold + 3.0
        print(f'触发! 记录 ~{total_s:.0f}s\n')
        set_param(m, 'WPT_SW_ARM', 1)
        t_start = time.time()

        rows = []
        last_thr, last_state = 0.0, 0
        batt_v, batt_a = 0.0, 0.0
        seen_active = False
        deadline = t_start + total_s
        while time.time() < deadline:
            msg = m.recv_match(blocking=True, timeout=0.5)
            if msg is None:
                continue
            t = msg.get_type()
            if t == 'NAMED_VALUE_FLOAT':
                nm = nv_name(msg)
                if nm == 'WTHR':
                    last_thr = msg.value
                elif nm == 'WST':
                    last_state = int(round(msg.value))
                    if last_state in (1, 2, 3):
                        seen_active = True
            elif t in ('BATTERY_STATUS', 'SYS_STATUS'):
                v = getattr(msg, 'voltages', [None])[0] if t == 'BATTERY_STATUS' else getattr(msg, 'voltage_battery', 0)
                c = getattr(msg, 'current_battery', 0)
                if v and v != 65535:
                    batt_v = v / 1000.0
                if c and c > 0:
                    batt_a = c / 100.0
            elif t == 'SCALED_PRESSURE':
                q = msg.press_diff * 100.0 - offset
                qc = max(q, 0.0)
                vel = math.sqrt(2 * qc / args.rho)
                dl = args.rho * vel * vel               # 盘载 N/m^2 = rho*V^2
                Q = vel * area_m2 if area_m2 > 0 else 0.0
                rows.append({
                    't_s': round(time.time() - t_start, 4),
                    'thr_cmd': round(last_thr, 4),
                    'state': last_state,
                    'press_diff_pa': round(q, 2),
                    'vel_ms': round(vel, 3),
                    'disk_load_Nm2': round(dl, 1),
                    'flow_m3s': round(Q, 4),
                    'batt_v': round(batt_v, 2),
                    'batt_a': round(batt_a, 2),
                    'sensor_temp_c': round(msg.temperature / 100.0, 1),
                })
            # 任务跑完回到 IDLE → 提前结束
            if seen_active and last_state in (0, 4) and time.time() - t_start > (args.ramp_up / 1000.0 + 1):
                # DONE→IDLE 后再多收 0.5s 收尾
                time.sleep(0.5)
                break

        set_param(m, 'WPT_SW_ARM', 0)
        set_param(m, 'WPT_EN', 0)
        print('任务结束, 电机已停.\n')

        # ---- 写 CSV ----
        if not args.out:
            os.makedirs(os.path.join(os.path.dirname(__file__), 'logs'), exist_ok=True)
            stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            args.out = os.path.join(os.path.dirname(__file__), 'logs',
                                    f'wp_{stamp}_M{args.motors.replace(",", "-")}_thr{int(thr*100)}.csv')
        with open(args.out, 'w', newline='') as f:
            f.write(f'# edf_windpressure  {datetime.now().isoformat()}\n')
            f.write(f'# motors={args.motors} mask={mask} thr_tgt={thr:.3f} hold_s={args.hold} '
                    f'ramp_up_ms={args.ramp_up} ramp_dn_ms={args.ramp_down}\n')
            f.write(f'# rho={args.rho} zero_offset_pa={offset:.3f} area_cm2={args.area_cm2}\n')
            f.write('# vel=sqrt(2*q/rho)  disk_load=rho*vel^2  flow=vel*area\n')
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ['t_s'])
            w.writeheader()
            w.writerows(rows)
        print(f'✓ CSV: {args.out}  ({len(rows)} 行)')

        # ---- 统计 ----
        hold = [r for r in rows if r['state'] == 2]
        if hold:
            pds = [r['press_diff_pa'] for r in hold]
            vs = [r['vel_ms'] for r in hold]
            mean_p = sum(pds) / len(pds)
            mean_v = sum(vs) / len(vs)
            print('\n===== HOLD 段稳态 (state=HOLD) =====')
            print(f'  样本           : {len(hold)}')
            print(f'  压差(差压)     : mean={mean_p:+.1f} Pa  max={max(pds):+.1f}  min={min(pds):+.1f}')
            print(f'  流速           : mean={mean_v:.1f} m/s  max={max(vs):.1f}')
            print(f'  盘载 rho*V^2   : {args.rho * mean_v**2:.0f} N/m^2')
            if area_m2 > 0:
                print(f'  流量 Q=V*A     : {mean_v * area_m2:.3f} m^3/s')
            if hold[0]['batt_v'] > 0:
                bv = [r['batt_v'] for r in hold]; ba = [r['batt_a'] for r in hold]
                print(f'  电池           : {sum(bv)/len(bv):.2f} V  {sum(ba)/len(ba):.1f} A  '
                      f'({sum(bv)/len(bv)*sum(ba)/len(ba):.0f} W)')
        else:
            print('\n⚠ 没采到 HOLD 段数据 (检查触发/差压流). 全程峰值:')
            if rows:
                pds = [r['press_diff_pa'] for r in rows]
                print(f'  峰值压差={max(pds):.1f} Pa  峰值流速={max(r["vel_ms"] for r in rows):.1f} m/s')

    except KeyboardInterrupt:
        print('\n⚠ 中断, 停电机 ...')
        stop_motors()
    except Exception as e:
        print(f'\n❌ 异常: {e}, 停电机 ...')
        stop_motors()
        raise
    finally:
        m.close()


if __name__ == '__main__':
    main()
