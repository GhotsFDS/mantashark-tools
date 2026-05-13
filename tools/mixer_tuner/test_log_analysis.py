"""Unit tests for log_analysis.py — v9 P4 LOG 离线分析.
跑: cd tools/mixer_tuner && python3 -m pytest test_log_analysis.py -v
或 source sim/.venv/bin/activate 后跑.
"""
import math
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from log_analysis import (
    detect_steps, analyze_step, suggest_pids, analyze_tilt,
    PID_RULES, TILT_GROUP, TILT_LIMITS,
)


# ═══════════════════════════════════════════════════════════════════════
# fixtures
def make_traces(t_start=0, t_end=10, dt=0.02, **series_specs):
    """Build a fake traces dict. series_specs: {block_name: {col: list[float]}}"""
    n = int((t_end - t_start) / dt) + 1
    t = [t_start + i * dt for i in range(n)]
    traces = {}
    for block, cols in series_specs.items():
        traces[block] = {'t': t}
        for col, fn_or_list in cols.items():
            if callable(fn_or_list):
                traces[block][col] = [fn_or_list(ti) for ti in t]
            elif isinstance(fn_or_list, (int, float)):
                traces[block][col] = [float(fn_or_list)] * n
            else:
                traces[block][col] = list(fn_or_list)
    return traces


# ═══════════════════════════════════════════════════════════════════════
# 1. step detection
def test_detect_steps_finds_pitch_step():
    """Synthetic ch2 stick step: 1500 → 1900 at t=2s."""
    def stick_step(t):
        return 1900 if t > 2 else 1500
    traces = make_traces(t_end=5, RCIN={
        'C1': 1500, 'C2': stick_step, 'C3': 1500, 'C4': 1500,
    })
    steps = detect_steps(traces, 'pitch')
    assert len(steps) >= 1
    assert abs(steps[0]['t'] - 2.0) < 0.5  # within window
    assert steps[0]['axis'] == 'pitch'


def test_detect_steps_no_step_no_event():
    traces = make_traces(t_end=5, RCIN={
        'C1': 1500, 'C2': 1500, 'C3': 1500, 'C4': 1500,
    })
    steps = detect_steps(traces, 'pitch')
    assert len(steps) == 0


def test_detect_steps_throttle_axis():
    def thr_ramp(t):
        return 1500 if t < 1 else 1900   # 400 PWM step > thresh 300
    traces = make_traces(t_end=5, RCIN={
        'C1': 1500, 'C2': 1500, 'C3': thr_ramp, 'C4': 1500,
    })
    steps = detect_steps(traces, 'throttle')
    assert len(steps) >= 1


# ═══════════════════════════════════════════════════════════════════════
# 2. analyze_step
def test_analyze_step_first_order_response():
    """模拟一阶响应: pitch_actual 渐进逼近 0.2 rad target after step at t=1."""
    tau = 0.3
    def pa(t):
        if t < 1: return 0.0
        return 0.2 * (1 - math.exp(-(t - 1) / tau))
    def po(t): return 0.5 if t > 1 else 0.0   # ATC output 阶跃
    traces = make_traces(t_end=4, MSK4={
        'pa': pa, 'pb': 5.0, 'po': po,
        'ra': 0.0, 'ro': 0.0, 'yo': 0.0, 'to': 0.5,
    })
    step = {'t': 1.0, 'axis': 'pitch', 'channel': 'C2', 'from': 1500, 'to': 1900, 'magnitude': 400}
    result = analyze_step(traces, step, 'pitch')
    assert 'error' not in result
    assert result['rise_time_s'] > 0.4 and result['rise_time_s'] < 1.0  # 一阶 10-90% ≈ 2.2τ
    assert result['delta_deg'] > 10  # 0.2 rad ≈ 11.5°
    assert result['saturated'] is False  # output 0.5 没饱和


def test_analyze_step_overshoot_detection():
    """模拟过冲响应: pitch 冲过 target 然后回."""
    target = 0.2
    def pa(t):
        if t < 1: return 0.0
        elif t < 1.5: return target * 1.4  # 40% overshoot
        else: return target
    traces = make_traces(t_end=3, MSK4={
        'pa': pa, 'pb': 5.0, 'po': 0.7,
        'ra': 0.0, 'ro': 0.0, 'yo': 0.0, 'to': 0.5,
    })
    step = {'t': 1.0, 'axis': 'pitch', 'channel': 'C2', 'from': 1500, 'to': 1900, 'magnitude': 400}
    result = analyze_step(traces, step, 'pitch')
    assert 'error' not in result
    assert result['overshoot_pct'] > 25, f'expected overshoot > 25%, got {result["overshoot_pct"]}'


def test_analyze_step_no_response():
    """ATC failed: target jumps but pitch unchanged."""
    traces = make_traces(t_end=3, MSK4={
        'pa': 0.0, 'pb': 5.0, 'po': 0.0,
        'ra': 0.0, 'ro': 0.0, 'yo': 0.0, 'to': 0.0,
    })
    step = {'t': 1.0, 'axis': 'pitch', 'channel': 'C2', 'from': 1500, 'to': 1900, 'magnitude': 400}
    result = analyze_step(traces, step, 'pitch')
    assert 'error' in result  # delta < 0.001 rad


# ═══════════════════════════════════════════════════════════════════════
# 3. suggest_pids — 规则引擎
def test_suggest_pids_rise_too_slow():
    """rise_time > 1.5s → P × 1.3."""
    metrics = [{'axis': 'pitch', 'rise_time_s': 2.0, 'overshoot_pct': 5,
                'settling_time_s': 1.5, 'ss_err_deg': 0.5, 'dom_freq_hz': 0.5}]
    cur = {'Q_A_RAT_PIT_P': 0.05, 'Q_A_RAT_PIT_I': 0.01, 'Q_A_RAT_PIT_D': 0.0}
    res = suggest_pids(metrics, cur, 'pitch')
    assert 'Q_A_RAT_PIT_P' in res['suggested']
    new_p = res['suggested']['Q_A_RAT_PIT_P']['new']
    assert new_p > cur['Q_A_RAT_PIT_P']
    assert abs(new_p - 0.05 * 1.3) < 1e-4


def test_suggest_pids_overshoot_reduces_p():
    metrics = [{'axis': 'pitch', 'rise_time_s': 0.3, 'overshoot_pct': 35,
                'settling_time_s': 1.0, 'ss_err_deg': 0.5, 'dom_freq_hz': 0.5}]
    cur = {'Q_A_RAT_PIT_P': 0.05, 'Q_A_RAT_PIT_I': 0.01, 'Q_A_RAT_PIT_D': 0.0}
    res = suggest_pids(metrics, cur, 'pitch')
    assert 'Q_A_RAT_PIT_P' in res['suggested']
    new_p = res['suggested']['Q_A_RAT_PIT_P']['new']
    assert new_p < cur['Q_A_RAT_PIT_P']
    assert abs(new_p - 0.05 * 0.7) < 1e-4


def test_suggest_pids_no_issues_no_suggestions():
    metrics = [{'axis': 'pitch', 'rise_time_s': 0.5, 'overshoot_pct': 10,
                'settling_time_s': 1.0, 'ss_err_deg': 1.0, 'dom_freq_hz': 1.5}]
    cur = {'Q_A_RAT_PIT_P': 0.05, 'Q_A_RAT_PIT_I': 0.01, 'Q_A_RAT_PIT_D': 0.0}
    res = suggest_pids(metrics, cur, 'pitch')
    # 所有指标都在阈值内, 不应有建议
    assert len(res['suggested']) == 0


def test_suggest_pids_high_freq_jitter_boosts_d():
    metrics = [{'axis': 'pitch', 'rise_time_s': 0.5, 'overshoot_pct': 10,
                'settling_time_s': 1.0, 'ss_err_deg': 1.0, 'dom_freq_hz': 4.5}]
    cur = {'Q_A_RAT_PIT_P': 0.05, 'Q_A_RAT_PIT_I': 0.01, 'Q_A_RAT_PIT_D': 0.0}
    res = suggest_pids(metrics, cur, 'pitch')
    # D 是 0 → bootstrap 0.005
    assert 'Q_A_RAT_PIT_D' in res['suggested']
    assert res['suggested']['Q_A_RAT_PIT_D']['new'] > 0


def test_suggest_pids_empty_metrics():
    res = suggest_pids([], {}, 'pitch')
    assert 'pitch 轴未检测到 step event' in res['diagnosis'][0]
    assert res['suggested'] == {}


# ═══════════════════════════════════════════════════════════════════════
# 4. analyze_tilt — Q1 提醒检测
def test_analyze_tilt_no_data():
    res = analyze_tilt({'MSK7': {'t': [0]}})
    assert 'error' in res


def test_analyze_tilt_static_no_warnings():
    """静止 tilt: 命令稳定, 实际跟随 → 无警告."""
    n = 200
    traces = {'MSK7': {
        't': [i * 0.02 for i in range(n)],
        'cDl': [10.0] * n, 'aDl': [10.0] * n,
        'cDr': [10.0] * n, 'aDr': [10.0] * n,
        'cTl': [90.0] * n, 'aTl': [90.0] * n,
        'cTr': [90.0] * n, 'aTr': [90.0] * n,
        'cRl': [40.0] * n, 'aRl': [40.0] * n,
        'cRr': [40.0] * n, 'aRr': [40.0] * n,
        'cS':  [70.0] * n, 'aS':  [70.0] * n,
    }}
    res = analyze_tilt(traces)
    assert 'channels' in res
    # 7 通道分析
    assert len(res['channels']) == 7
    # 应该提示 ✓ 无问题
    assert any('✓' in w for w in res['warnings'])


def test_analyze_tilt_oscillation_detected():
    """模拟 5Hz tilt 振荡 → 应警告."""
    n = 500
    t = [i * 0.02 for i in range(n)]
    # 5Hz sin wave 在 actual 上, commanded 稳定
    aDl = [10 + 3 * math.sin(2 * math.pi * 5 * ti) for ti in t]
    traces = {'MSK7': {
        't': t,
        'cDl': [10.0] * n, 'aDl': aDl,
        'cDr': [10.0] * n, 'aDr': [10.0] * n,
        'cTl': [90.0] * n, 'aTl': [90.0] * n,
        'cTr': [90.0] * n, 'aTr': [90.0] * n,
        'cRl': [40.0] * n, 'aRl': [40.0] * n,
        'cRr': [40.0] * n, 'aRr': [40.0] * n,
        'cS':  [70.0] * n, 'aS':  [70.0] * n,
    }}
    res = analyze_tilt(traces)
    assert res['channels']['DFL']['osc_freq_hz'] > 2  # 检测到振荡
    assert any('DFL 振荡' in w for w in res['warnings'])


def test_analyze_tilt_saturation_detected():
    """模拟 RDL 持续撞上限 (135°)."""
    n = 200
    t = [i * 0.02 for i in range(n)]
    traces = {'MSK7': {
        't': t,
        'cDl': [10.0] * n, 'aDl': [10.0] * n,
        'cDr': [10.0] * n, 'aDr': [10.0] * n,
        'cTl': [90.0] * n, 'aTl': [90.0] * n,
        'cTr': [90.0] * n, 'aTr': [90.0] * n,
        'cRl': [135.0] * n, 'aRl': [135.0] * n,  # 撞 LMAX
        'cRr': [40.0] * n, 'aRr': [40.0] * n,
        'cS':  [70.0] * n, 'aS':  [70.0] * n,
    }}
    res = analyze_tilt(traces)
    assert res['channels']['RDL']['sat_hi_pct'] > 50
    assert any('RDL 撞限位' in w for w in res['warnings'])


def test_analyze_tilt_lag_detected():
    """模拟 commanded 大幅领先 actual (rate-limit 跟不上)."""
    n = 200
    t = [i * 0.02 for i in range(n)]
    # commanded 阶跃 0→50, actual 慢慢爬
    cmd = [50.0 if ti > 1 else 10.0 for ti in t]
    act = [10.0 + (50 - 10) * min(1, max(0, (ti - 1) / 5)) for ti in t]
    traces = {'MSK7': {
        't': t,
        'cDl': cmd, 'aDl': act,
        'cDr': [10.0] * n, 'aDr': [10.0] * n,
        'cTl': [90.0] * n, 'aTl': [90.0] * n,
        'cTr': [90.0] * n, 'aTr': [90.0] * n,
        'cRl': [40.0] * n, 'aRl': [40.0] * n,
        'cRr': [40.0] * n, 'aRr': [40.0] * n,
        'cS':  [70.0] * n, 'aS':  [70.0] * n,
    }}
    res = analyze_tilt(traces)
    assert res['channels']['DFL']['avg_lag_deg'] > 5
    assert any('DFL 平均 lag' in w for w in res['warnings'])


# ═══════════════════════════════════════════════════════════════════════
# 5. constants sanity
def test_tilt_groups_complete():
    assert set(TILT_GROUP.keys()) == {'DFL', 'DFR', 'TL1', 'TR1', 'RDL', 'RDR', 'SGRP'}
    # 每个 alias 必须有 limit
    for alias in TILT_GROUP:
        assert alias in TILT_LIMITS
        lo, hi = TILT_LIMITS[alias]
        assert lo < hi


def test_pid_rules_callable():
    """所有 PID rule 的 cond 函数能用 dict 测."""
    for name, rule in PID_RULES.items():
        result = rule['cond']({'rise_time_s': 0, 'overshoot_pct': 0,
                                'ss_err_deg': 0, 'dom_freq_hz': 0,
                                'settling_time_s': 0})
        assert isinstance(result, bool)


if __name__ == '__main__':
    import inspect
    funcs = [(n, f) for n, f in globals().items()
             if n.startswith('test_') and callable(f)]
    passed, failed = 0, 0
    for name, fn in funcs:
        try:
            fn()
            print(f'  ✓ {name}')
            passed += 1
        except AssertionError as e:
            print(f'  ✗ {name}: AssertionError {e}')
            failed += 1
        except Exception as e:
            print(f'  ✗ {name}: {type(e).__name__}: {e}')
            failed += 1
    print(f'\n══ Result: {passed} passed, {failed} failed (out of {len(funcs)}) ══')
    sys.exit(1 if failed else 0)
