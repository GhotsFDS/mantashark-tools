#!/usr/bin/env python3
"""实机首飞预期值 cheatsheet — 各模式数学模型预测 PWM / 姿态.

操作员实机时对比 live MAVLink 数据, 偏离预期 > tolerance 提前刹车.

依赖 sim/mantashark_dynamics.py 数学模型. 输出可读表给飞行员.
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'sim'))
import mantashark_dynamics as dyn


# K 表 + tilt 各 mode (跟 actuators.lua 对齐)
MODES = {
    'G1': (dyn.K_G1, dyn.TILT_G1, 5.0,  '慢滑 / GPS RTL / 浮筒承重'),
    'G2': (dyn.K_G2, dyn.TILT_G2, 11.0, '抬头建气垫 / 静态<2m/s'),
    'G3': (dyn.K_G3, dyn.TILT_G3, 8.0,  '巡航 / V≥9m/s 翼面 0° AoA'),
}


def predict_motor_pwm(throttle: float, k_table: dict, cap: float = 0.6, max_thrust: float = 23.0):
    """预测各 motor 在指定 throttle + cap + K 表下的 PWM.
    PWM = 1100 + output × 800, output = throttle × K × cap (无 ATC 差动).
    """
    pwms = {}
    for m in dyn.MOTORS:
        K = k_table[m.group]
        out = throttle * K * cap
        out = max(0.0, min(1.0, out))
        pwms[m.name] = int(1100 + out * 800)
    return pwms


def predict_tilt_pwm(tilt_dict: dict, zero_pwm: int = 1500, pwm_per_deg: float = 11.11,
                     dir_dict: dict = None):
    """预测各 tilt servo 在指定 GOAL 角度下的 PWM.
    PWM = ZERO + DIR × pwm_per_deg × (abs_deg - 45)
    """
    if dir_dict is None:
        dir_dict = {'DFL': 1, 'DFR': -1, 'TL1': 1, 'TR1': -1,
                    'RDL': 1, 'RDR': -1, 'S_GROUP_TILT': 1}
    pwms = {}
    for tilt_id, abs_deg in tilt_dict.items():
        d = dir_dict.get(tilt_id, 1)
        pwm = int(zero_pwm + d * pwm_per_deg * (abs_deg - 45))
        pwms[tilt_id] = max(500, min(2500, pwm))
    return pwms


def report_mode(mode_name: str, k_table: dict, tilt_dict: dict, base_pitch: float, desc: str):
    print('\n' + '═' * 70)
    print(f'  模式 {mode_name}: {desc}')
    print(f'  base_pitch = {base_pitch}°  K 表 = {k_table}')
    print('═' * 70)

    # 预期 motor PWM (50%, 80%, 100% throttle)
    print('\n  Motor PWM 预期 (cap=0.6 TEST):')
    print(f'  {"motor":<6}{"50%":<10}{"80%":<10}{"100%":<10}')
    pwm_50 = predict_motor_pwm(0.50, k_table)
    pwm_80 = predict_motor_pwm(0.80, k_table)
    pwm_100 = predict_motor_pwm(1.0, k_table)
    for m in dyn.MOTORS:
        n = m.name
        print(f'  {n:<6}{pwm_50[n]:<10}{pwm_80[n]:<10}{pwm_100[n]:<10}')

    # 预期 tilt PWM
    print('\n  Tilt servo PWM 预期:')
    tilt_pwms = predict_tilt_pwm(tilt_dict)
    for tilt_id, pwm in tilt_pwms.items():
        ang = tilt_dict[tilt_id]
        print(f'  SERVO {tilt_id:<14} abs={ang:>3}°  PWM={pwm}')

    # ATC 平衡 cmd (motor 内部静态)
    cmds = dyn.solve_balance_3axis(0.80, k_table, tilt_dict)
    print(f'\n  ATC 平衡 cmd @80% throttle: roll={cmds[0]:+.3f} pitch={cmds[1]:+.3f} yaw={cmds[2]:+.3f}')
    sat = max(abs(cmds[0]), abs(cmds[1]), abs(cmds[2]))
    print(f'    最大占用 {sat*100:.1f}% (余地 {(1-sat)*100:.1f}%)')

    # Wing CL @ base_pitch
    alpha = math.radians(base_pitch) - math.radians(8)  # install angle
    cl = 5.5 * max(-0.21, min(0.21, alpha))
    print(f'\n  Wing AoA 预期 @ base_pitch={base_pitch}°: alpha={math.degrees(alpha):+.1f}° CL={cl:+.2f}')


def report_phase(phase_name: str, V: float, alt: float, throttle: float, mode: str):
    """飞行阶段预期 wrench."""
    K, tilt, base_pitch, desc = MODES[mode]
    print('\n' + '─' * 70)
    print(f'  阶段 {phase_name}: V={V} m/s  alt={alt} m  throttle={throttle*100:.0f}% {mode}')
    print('─' * 70)

    # Trim pitch 搜索
    pitch_trim, F, T = dyn.find_trim_state(throttle, K, tilt, V, alt)
    print(f'  自然 trim pitch = {pitch_trim:+.1f}°  (设计 base_pitch = {base_pitch}°)')

    # 在设计 base_pitch 下的 wrench
    F0, T0 = dyn.full_wrench_at_state(throttle, K, tilt, base_pitch, V, alt)
    print(f'  在 base_pitch={base_pitch}° 时:')
    print(f'    净力 F = ({F0[0]:+.1f}, {F0[1]:+.1f}, {F0[2]:+.1f}) N')
    print(f'    净力矩 τ = ({T0[0]:+.2f}, {T0[1]:+.2f}, {T0[2]:+.2f}) N·m')
    if abs(F0[2]) < 5:
        print(f'    ✓ 垂直平衡 (vehicle 跟随 base_pitch)')
    else:
        sign = '上升' if F0[2] > 0 else '下沉'
        accel = F0[2] / dyn.MASS
        print(f'    ⚠ {sign} 加速度 {accel:+.2f} m/s² (vehicle 物理偏离 base_pitch)')


def main():
    print('═' * 70)
    print('  MantaShark 实机首飞预期值 cheatsheet')
    print('  (操作员对比 live MAVLink 数据, 偏离 > tolerance 提前刹车)')
    print('═' * 70)
    print(f'\n  机体: 10 kg / 12 EDF (QF2822 23.25N max @ 24V) / 7 倾转 / 双 6S')
    print(f'  CG: {dyn.compute_cg()} m  Mass: {dyn.MASS} kg  Max thrust per motor: {dyn.MAX_THRUST} N')
    print(f'  install_angle = -8°  (base_pitch=+8° 时 wing AoA=0°)')

    # 各模式预期
    for mode_name, (k, tilt, bp, desc) in MODES.items():
        report_mode(mode_name, k, tilt, bp, desc)

    # 飞行阶段预期 (起飞 → 巡航)
    print('\n\n' + '═' * 70)
    print('  飞行阶段预期 (起飞流程)')
    print('═' * 70)
    report_phase('1. 静水浮筒',  V=0,   alt=-0.09, throttle=0.30, mode='G1')
    report_phase('2. 慢滑跑',    V=3,   alt=0.05,  throttle=0.50, mode='G1')
    report_phase('3. 抬头建气垫', V=2,   alt=0.10,  throttle=0.80, mode='G2')
    report_phase('4. 过驼峰',    V=7.9, alt=0.30,  throttle=0.80, mode='G2')
    report_phase('5. 离水',      V=10,  alt=0.20,  throttle=0.80, mode='G3')
    report_phase('6. 巡航',      V=12,  alt=0.30,  throttle=0.80, mode='G3')

    # 紧急偏离阈值
    print('\n\n' + '═' * 70)
    print('  ⚠ 偏离阈值 (live 跟预期偏离 > 此值, 立即降油门 / RTL)')
    print('═' * 70)
    print('  ATC saturate:    任何轴 |output| > 0.95 持续 2s → integrator windup, 立刻降油门')
    print('  Pitch 偏:        ATTITUDE.pitch 跟 base_pitch 偏 > 10° → vehicle 不跟随, 检查')
    print('  Roll 漂:         ATTITUDE.roll > 5° 不归零 → roll 控制坏 (TL1/TR1 tilt 驱动)')
    print('  Motor PWM 卡:    任何 KS+KDF (SERVO 1-6) 卡 1100/1900 不变 → ATC 饱和或 ESC 故障')
    print('  Tilt 撞限:        SERVO 13-19 撞 LMIN/LMAX > 1s → ATC bias 过大或 cmd_min 单边')
    print('  V 不增:           ch3 推满 V 不涨 → KT 推力不够 / 驼峰阻力卡住')
    print('  V 暴涨:           V > 15 m/s 不收敛 → G3 PID 没工作, 立刻 RTL')


if __name__ == '__main__':
    main()
