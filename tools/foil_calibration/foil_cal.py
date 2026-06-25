#!/usr/bin/env python3
"""
水翼襟翼校准 (SERVO9-12 零位/方向/满偏) — 交互式, 实时改参舵机立即动

前置: 飞控 disarmed (此时 hover_test.lua 持续输出各舵机 HOV_<角>_ZERO),
      4 个襟翼舵机接 SERVO9-12 且通电。改 ZERO → 下一循环 (20ms) 舵机就动。

命令 (回车执行):
  机械校准 (HOV_, disarmed):
    fl +10      前左翼 ZERO +10us   (角: fl/fr/rl/rr)
    fl dir      翻前左翼方向 (+1↔-1; 校到 test+ = 增升)
    rng 450     设满偏幅度 (撞限位调小)
    test +0.5   驱动全部襟翼偏 +0.5 (验方向/行程/限位)
    test 0      襟翼归零位 (= 水平)
  控制层分层 bring-up (MSAK_):
    en 0|1      高度控制器总开关 (1=trim+PID 生效)
    trim 0.30   初始位置/托重基线 (= 主线 GOAL)
    ptrim       台架预览 trim 位置 (disarmed 摆到 trim 偏转; test 0 复位)
    fhp/fhi/fhd 0.5   高度 PID P/I/D 增益
    show        显示机械+控制全部值
    q           退出 (自动 test 归0)

校准流程 (全程 disarmed, 不用解锁/转桨):
  1. 先机械装连杆使襟翼大致水平
  2. 零位: 逐个角 fl/fr/rl/rr 用 +/- 微调 ZERO 到襟翼物理 0° (目视/角度尺)
  3. 方向: test +0.5 → 看各襟翼是否往"增升"方向偏; 反了对该角 dir
  4. 行程/限位: test +1 / -1 → 看撞不撞机械限位, 撞了 rng 调小; 测完 test 0
"""
import sys, time
from pymavlink import mavutil

CORNERS = ['FL', 'FR', 'RL', 'RR']

def main():
    dev = sys.argv[1] if len(sys.argv) > 1 else '/dev/ttyACM0'
    m = mavutil.mavlink_connection(dev, baud=115200)
    print('连接飞控...'); m.wait_heartbeat(timeout=10)
    print('已连接。确保 DISARMED + 襟翼舵机通电。\n')

    def getp(n, t=3):
        m.mav.param_request_read_send(m.target_system, m.target_component, n.encode()[:16], -1)
        t0 = time.time()
        while time.time() - t0 < t:
            msg = m.recv_match(type='PARAM_VALUE', blocking=True, timeout=1)
            if msg and msg.param_id.strip() == n:
                return msg.param_value
        return None

    def setp(n, v):
        m.mav.param_set_send(m.target_system, m.target_component, n.encode()[:16],
                             float(v), mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
        return getp(n)

    def show():
        print(f"  [机械] RNG={getp('HOV_FOIL_RNG')}  TEST={getp('HOV_FOIL_TEST')}")
        for c in CORNERS:
            print(f"    {c}: ZERO={getp('HOV_'+c+'_ZERO')}  DIR={getp('HOV_'+c+'_DIR')}")
        print(f"  [控制] EN={getp('MSAK_FOIL_EN')}  TRM={getp('MSAK_FOIL_TRM')}  "
              f"NEG={getp('MSAK_FOIL_NEG')}  P={getp('MSAK_FH_P')} I={getp('MSAK_FH_I')} D={getp('MSAK_FH_D')}")

    print('当前值:'); show()
    print("\n命令: <角> +N / -N | <角> dir | rng N | show | q")
    while True:
        try:
            line = input('cal> ').strip().lower()
        except EOFError:
            break
        if not line:
            continue
        if line == 'q':
            break
        if line == 'show':
            show(); continue
        parts = line.split()
        if parts[0] == 'rng' and len(parts) == 2:
            print('  →', 'HOV_FOIL_RNG =', setp('HOV_FOIL_RNG', float(parts[1]))); continue
        if parts[0] == 'test' and len(parts) == 2:
            v = max(-1.0, min(1.0, float(parts[1])))
            print('  →', 'HOV_FOIL_TEST =', setp('HOV_FOIL_TEST', v),
                  '(disarmed 襟翼偏转; 看方向/限位)'); continue
        # ── 控制层 (MSAK_) 分层 bring-up ──
        if parts[0] == 'en' and len(parts) == 2:
            print('  →', 'MSAK_FOIL_EN =', setp('MSAK_FOIL_EN', float(parts[1])),
                  '(高度控制器总开关; 1=trim+PID 生效)'); continue
        if parts[0] == 'trim' and len(parts) == 2:
            print('  →', 'MSAK_FOIL_TRM =', setp('MSAK_FOIL_TRM', float(parts[1])),
                  '(初始位置/托重基线)'); continue
        if parts[0] == 'ptrim':   # 台架预览 trim 位置: disarmed 把襟翼摆到 trim 偏转
            tv = getp('MSAK_FOIL_TRM') or 0
            print('  →', 'HOV_FOIL_TEST =', setp('HOV_FOIL_TEST', float(tv)),
                  f'(disarmed 预览 trim={tv} 初始位置; test 0 复位)'); continue
        if parts[0] in ('fhp','fhi','fhd') and len(parts) == 2:
            pn = {'fhp':'MSAK_FH_P','fhi':'MSAK_FH_I','fhd':'MSAK_FH_D'}[parts[0]]
            print('  →', pn, '=', setp(pn, float(parts[1])), '(高度 PID 增益)'); continue
        if len(parts) == 2 and parts[0].upper() in CORNERS:
            c = parts[0].upper(); arg = parts[1]
            if arg == 'dir':
                cur = getp('HOV_'+c+'_DIR') or 1
                print('  →', f'HOV_{c}_DIR =', setp('HOV_'+c+'_DIR', -cur)); continue
            try:
                delta = float(arg)
                cur = getp('HOV_'+c+'_ZERO') or 1500
                print('  →', f'HOV_{c}_ZERO =', setp('HOV_'+c+'_ZERO', cur + delta)); continue
            except ValueError:
                pass
        print('  ? 无法解析。例: fl +10 / rr -5 / fl dir / rng 450 / test +0.5 / show / q')
    setp('HOV_FOIL_TEST', 0.0)   # 退出务必归零, 防遗留偏转
    print('退出 (test 已归0; ZERO/DIR/RNG 实时存 EEPROM)')

if __name__ == '__main__':
    main()
