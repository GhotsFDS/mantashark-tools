"""
MantaShark v9 P4 LOG analysis library
Used by mavbridge.py to handle WS 'analyze_log' requests.

Parses BIN dataflash logs and extracts:
  - MSK4 (50Hz pitch/roll target/actual/output)
  - MSK5 (10Hz V loop)
  - MSK6 (1Hz drift learning)
  - RCIN (RC stick positions, for step detection)

Then detects step events on RC2/RC3 stick (pitch/throttle), measures
rise_time / overshoot / settling_time / dominant_freq on the response,
and suggests PID adjustments per the rules:
  rise > 1.5s     → P × 1.3
  overshoot > 25% → P × 0.7
  SS err > 3°     → I × 1.5
  high freq >3Hz  → D × 1.2
  low freq < 1Hz  → I × 0.7
"""
import os
import math
from typing import Any

try:
    from pymavlink import DFReader  # type: ignore
except ImportError:
    DFReader = None  # let mavbridge surface error


# ─── parse phase ───
LOG_BLOCKS = {'MSK3', 'MSK4', 'MSK5', 'MSK6', 'MSK7', 'RCIN', 'ATT'}

# v9 P4 MSK7 tilt 通道映射 (commanded suffix c*, actual suffix a*)
TILT_CHANNELS = [
    ('DFL', 'cDl', 'aDl'), ('DFR', 'cDr', 'aDr'),
    ('TL1', 'cTl', 'aTl'), ('TR1', 'cTr', 'aTr'),
    ('RDL', 'cRl', 'aRl'), ('RDR', 'cRr', 'aRr'),
    ('SGRP', 'cS',  'aS'),
]
TILT_GROUP = {'DFL': 'DF', 'DFR': 'DF', 'TL1': 'T', 'TR1': 'T',
              'RDL': 'RD', 'RDR': 'RD', 'SGRP': 'S'}
TILT_LIMITS = {  # abs deg approximations (LMIN/LMAX from defaults)
    'DFL': (0, 75), 'DFR': (0, 75),
    'TL1': (70, 135), 'TR1': (70, 135),
    'RDL': (0, 135), 'RDR': (0, 135), 'SGRP': (0, 75),
}


def parse_bin(path: str, max_rows: int = 200_000) -> dict[str, Any]:
    """Read BIN, return traces dict keyed by block name.
    Each trace is a dict of column_name -> list[float], plus 't' (relative seconds)."""
    if DFReader is None:
        raise RuntimeError('pymavlink not installed')
    if not os.path.isfile(path):
        raise FileNotFoundError(path)

    log = DFReader.DFReader_binary(path)
    traces: dict[str, dict[str, list[float]]] = {}
    t0: float | None = None
    rows = 0

    while True:
        m = log.recv_match(type=list(LOG_BLOCKS))
        if m is None:
            break
        rows += 1
        if rows > max_rows:
            break
        name = m.get_type()
        if t0 is None:
            t0 = float(m.TimeUS) / 1e6
        t = float(m.TimeUS) / 1e6 - t0
        d = traces.setdefault(name, {'t': []})
        d['t'].append(t)
        for col in m._fieldnames:
            if col == 'TimeUS':
                continue
            v = getattr(m, col)
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            d.setdefault(col, []).append(v)

    return {
        'rows_read': rows,
        'duration_s': (traces.get('MSK4', {}).get('t', [0])[-1] if traces.get('MSK4') else 0),
        'traces': traces,
    }


# ─── step detection ───
def detect_steps(traces: dict, axis: str = 'pitch',
                 thresh_pwm: float = 300, window_s: float = 0.2) -> list[dict]:
    """Detect RC stick steps. Returns list of {t, axis, from, to, channel}.
    axis ∈ {'pitch'=ch2, 'roll'=ch1, 'throttle'=ch3}.
    A step is defined as |Δch_pwm| > thresh_pwm within window_s seconds."""
    rcin = traces.get('RCIN')
    if not rcin:
        return []
    ch_map = {'roll': 'C1', 'pitch': 'C2', 'throttle': 'C3', 'yaw': 'C4'}
    ch_key = ch_map.get(axis)
    if not ch_key or ch_key not in rcin:
        return []
    t_arr = rcin['t']
    v_arr = rcin[ch_key]
    if len(t_arr) < 10:
        return []

    steps: list[dict] = []
    last_step_t = -1.0
    i = 0
    n = len(t_arr)
    while i < n:
        t = t_arr[i]
        # find window end index
        j = i
        while j < n and t_arr[j] - t < window_s:
            j += 1
        if j > i:
            v_min = min(v_arr[i:j])
            v_max = max(v_arr[i:j])
            if v_max - v_min > thresh_pwm and t - last_step_t > 1.0:
                steps.append({
                    't': t, 'axis': axis, 'channel': ch_key,
                    'from': round(v_min, 1), 'to': round(v_max, 1),
                    'magnitude': round(v_max - v_min, 1),
                })
                last_step_t = t
        i += max(1, (j - i) // 2)
    return steps


# ─── per-step metrics ───
def analyze_step(traces: dict, step: dict, axis: str = 'pitch',
                 lookahead_s: float = 3.0) -> dict:
    """Given a step event, measure rise/overshoot/settling on actual response.
    Uses MSK4 (pitch/roll actual + ATC output)."""
    msk4 = traces.get('MSK4')
    if not msk4 or len(msk4.get('t', [])) < 10:
        return {'error': 'no MSK4 data'}

    actual_key = 'pa' if axis == 'pitch' else 'ra'
    output_key = 'po' if axis == 'pitch' else 'ro'
    if actual_key not in msk4 or output_key not in msk4:
        return {'error': f'missing {actual_key}/{output_key}'}

    t_arr = msk4['t']
    a_arr = msk4[actual_key]
    o_arr = msk4[output_key]
    t_start = step['t']
    t_end = t_start + lookahead_s

    # find slice
    i_start = 0
    while i_start < len(t_arr) and t_arr[i_start] < t_start:
        i_start += 1
    i_end = i_start
    while i_end < len(t_arr) and t_arr[i_end] < t_end:
        i_end += 1
    if i_end - i_start < 5:
        return {'error': 'window too short'}

    t_seg = t_arr[i_start:i_end]
    a_seg = a_arr[i_start:i_end]
    o_seg = o_arr[i_start:i_end]

    # baseline = 3 samples PRE-step (avoid post-step transient contaminating)
    pre_lo = max(0, i_start - 5)
    if pre_lo < i_start:
        baseline = sum(a_arr[pre_lo:i_start]) / (i_start - pre_lo)
    else:
        baseline = a_seg[0] if a_seg else 0
    # final = mean of last 5 in window
    final = sum(a_seg[-5:]) / 5
    delta = final - baseline
    if abs(delta) < 1e-3:
        return {'error': 'no response (Δ < 0.001 rad)'}

    sign = 1 if delta > 0 else -1
    a_target = final
    a_peak = max(a_seg) if sign > 0 else min(a_seg)

    # rise time: 10% to 90% of delta
    p10 = baseline + 0.1 * delta
    p90 = baseline + 0.9 * delta
    t_p10 = next((t_seg[k] for k in range(len(a_seg)) if (a_seg[k] - p10) * sign >= 0), t_start)
    t_p90 = next((t_seg[k] for k in range(len(a_seg)) if (a_seg[k] - p90) * sign >= 0), t_end)
    rise_time = max(0, t_p90 - t_p10)

    # overshoot %
    overshoot_pct = 0.0
    if abs(delta) > 1e-3:
        overshoot_pct = max(0, (a_peak - a_target) * sign / abs(delta) * 100)

    # settling time: time to stay within ±5% of final for 0.5s
    band = 0.05 * abs(delta)
    settling_time = lookahead_s
    for k in range(len(a_seg) - 1, -1, -1):
        if abs(a_seg[k] - final) > band:
            settling_time = t_seg[k] - t_start if k + 1 < len(t_seg) else lookahead_s
            break

    # SS error proxy: |a_seg final - a_target| (rad) → deg
    ss_err_deg = abs(final - a_target) * 180 / math.pi  # near 0 by definition

    # dominant freq via zero-crossing of (a - final)
    crossings = 0
    last_sign = 0
    for v in a_seg:
        s = 1 if (v - final) > 0 else -1
        if last_sign != 0 and s != last_sign:
            crossings += 1
        last_sign = s
    duration = max(1e-3, t_seg[-1] - t_seg[0])
    dom_freq_hz = crossings / (2 * duration) if crossings > 1 else 0

    # output range stats (saturation indicator)
    out_max = max(o_seg)
    out_min = min(o_seg)
    saturated = (out_max > 0.95 or out_min < -0.95)

    return {
        't_start': t_start,
        'axis': axis,
        'baseline_rad': round(baseline, 4),
        'final_rad': round(final, 4),
        'delta_deg': round(delta * 180 / math.pi, 2),
        'rise_time_s': round(rise_time, 3),
        'overshoot_pct': round(overshoot_pct, 1),
        'settling_time_s': round(settling_time, 3),
        'ss_err_deg': round(ss_err_deg, 2),
        'dom_freq_hz': round(dom_freq_hz, 2),
        'output_max': round(out_max, 3),
        'output_min': round(out_min, 3),
        'saturated': saturated,
    }


# ─── PID suggestions ───
PID_RULES = {
    'rise_too_slow':   {'cond': lambda m: m.get('rise_time_s', 0) > 1.5,
                         'param_p': lambda v: v * 1.3,
                         'msg':    '响应慢 (rise > 1.5s) → P × 1.3'},
    'overshoot':       {'cond': lambda m: m.get('overshoot_pct', 0) > 25,
                         'param_p': lambda v: v * 0.7,
                         'msg':    '超调 (>25%) → P × 0.7'},
    'ss_err':          {'cond': lambda m: m.get('ss_err_deg', 0) > 3,
                         'param_i': lambda v: v * 1.5,
                         'msg':    '稳态偏差 (>3°) → I × 1.5'},
    'high_freq_jitter':{'cond': lambda m: m.get('dom_freq_hz', 0) > 3,
                         'param_d': lambda v: v * 1.2,
                         'msg':    '高频抖 (>3Hz) → D × 1.2'},
    'low_freq_osc':    {'cond': lambda m: 0.3 < m.get('dom_freq_hz', 0) < 1.0,
                         'param_i': lambda v: v * 0.7,
                         'msg':    '低频振 (<1Hz) → I × 0.7'},
    'long_settling':   {'cond': lambda m: m.get('settling_time_s', 0) > 2.5,
                         'param_d': lambda v: v * 1.15,
                         'msg':    '稳定慢 (settling >2.5s) → D × 1.15'},
}


def suggest_pids(metrics_list: list[dict], current_params: dict[str, float],
                 axis: str = 'pitch') -> dict:
    """Aggregate metrics across all step events for one axis, output suggestions.
    metrics_list: list of analyze_step results.
    current_params: dict with Q_A_RAT_PIT_P/I/D etc.
    Returns: {diagnosis, suggested_params}"""
    valid = [m for m in metrics_list if 'error' not in m and m.get('axis') == axis]
    if not valid:
        return {'diagnosis': [f'{axis} 轴未检测到 step event'], 'suggested': {}}

    # average metrics
    avg = {}
    for k in ('rise_time_s', 'overshoot_pct', 'settling_time_s', 'ss_err_deg', 'dom_freq_hz'):
        avg[k] = sum(m.get(k, 0) for m in valid) / len(valid)

    p_key = 'Q_A_RAT_PIT_P' if axis == 'pitch' else 'Q_A_RAT_RLL_P' if axis == 'roll' else None
    i_key = 'Q_A_RAT_PIT_I' if axis == 'pitch' else 'Q_A_RAT_RLL_I' if axis == 'roll' else None
    d_key = 'Q_A_RAT_PIT_D' if axis == 'pitch' else 'Q_A_RAT_RLL_D' if axis == 'roll' else None

    cur_p = current_params.get(p_key, 0.05) if p_key else 0
    cur_i = current_params.get(i_key, 0.01) if i_key else 0
    cur_d = current_params.get(d_key, 0.0) if d_key else 0

    diagnosis: list[str] = [
        f'{axis} 轴 step events: {len(valid)}',
        f'  平均 rise_time = {avg["rise_time_s"]:.3f}s',
        f'  平均 overshoot = {avg["overshoot_pct"]:.1f}%',
        f'  平均 settling  = {avg["settling_time_s"]:.3f}s',
        f'  dominant freq  = {avg["dom_freq_hz"]:.2f}Hz',
    ]
    suggested: dict[str, dict] = {}

    new_p, new_i, new_d = cur_p, cur_i, cur_d
    flags = {'p': False, 'i': False, 'd': False}
    for rule_name, rule in PID_RULES.items():
        if rule['cond'](avg):
            diagnosis.append(f'  ✗ {rule["msg"]}')
            if 'param_p' in rule and p_key:
                new_p = rule['param_p'](new_p); flags['p'] = True
            if 'param_i' in rule and i_key:
                new_i = rule['param_i'](new_i); flags['i'] = True
            if 'param_d' in rule and d_key:
                new_d = rule['param_d'](new_d); flags['d'] = True

    if p_key and flags['p'] and abs(new_p - cur_p) > 1e-6:
        suggested[p_key] = {'cur': cur_p, 'new': round(new_p, 4),
                             'pct_change': round((new_p / cur_p - 1) * 100, 1) if cur_p else 0}
    if i_key and flags['i'] and abs(new_i - cur_i) > 1e-6:
        suggested[i_key] = {'cur': cur_i, 'new': round(new_i, 4),
                             'pct_change': round((new_i / cur_i - 1) * 100, 1) if cur_i else 0}
    if d_key and flags['d']:
        # Bootstrap: 当 cur_d=0 且规则要 boost D → 设 0.005 启动
        if cur_d <= 1e-6:
            suggested[d_key] = {'cur': cur_d, 'new': 0.005, 'pct_change': 999.0}
        elif abs(new_d - cur_d) > 1e-6:
            suggested[d_key] = {'cur': cur_d, 'new': round(new_d, 4),
                                 'pct_change': round((new_d / cur_d - 1) * 100, 1)}

    if not suggested:
        diagnosis.append('  ✓ PID 表现 OK, 无建议改动')

    return {'diagnosis': diagnosis, 'suggested': suggested, 'metrics_avg': avg, 'event_count': len(valid)}


# ─── tilt servo dynamics (Q1 detection: tilt 过冲 / 振荡 / 饱和) ───
def analyze_tilt(traces: dict) -> dict:
    """For each tilt channel, measure: lag (commanded vs actual), oscillation freq,
    saturation %, max overshoot. Returns per-channel + per-group summary."""
    msk7 = traces.get('MSK7')
    if not msk7 or len(msk7.get('t', [])) < 50:
        return {'error': 'no MSK7 data (50+ samples needed)'}

    out: dict[str, dict] = {}
    t_arr = msk7['t']
    duration = max(1e-3, t_arr[-1] - t_arr[0])

    for name, c_key, a_key in TILT_CHANNELS:
        if c_key not in msk7 or a_key not in msk7:
            continue
        cmd = msk7[c_key]
        act = msk7[a_key]
        if len(cmd) != len(act) or len(cmd) < 50:
            continue

        # 1) avg lag |cmd - act|
        lag_sum = 0.0
        max_lag = 0.0
        for i in range(len(cmd)):
            d = abs(cmd[i] - act[i])
            lag_sum += d
            if d > max_lag:
                max_lag = d
        avg_lag = lag_sum / len(cmd)

        # 2) oscillation: zero-crossings of (act - mean(act))
        mean_a = sum(act) / len(act)
        crossings = 0
        last_sign = 0
        for v in act:
            s = 1 if (v - mean_a) > 0 else -1
            if last_sign != 0 and s != last_sign:
                crossings += 1
            last_sign = s
        osc_freq = crossings / (2 * duration) if crossings > 1 else 0

        # 3) saturation: % of samples within 1° of LMIN or LMAX
        lo, hi = TILT_LIMITS.get(name, (-180, 180))
        sat_lo = sum(1 for v in act if v <= lo + 1) / len(act) * 100
        sat_hi = sum(1 for v in act if v >= hi - 1) / len(act) * 100

        # 4) overshoot: max(act - cmd) when cmd is rising; max(cmd - act) when falling
        overshoot_max = 0.0
        for i in range(1, len(cmd)):
            cmd_delta = cmd[i] - cmd[i-1]
            if cmd_delta > 0.1 and act[i] > cmd[i]:
                overshoot_max = max(overshoot_max, act[i] - cmd[i])

        out[name] = {
            'avg_lag_deg':    round(avg_lag, 2),
            'max_lag_deg':    round(max_lag, 2),
            'osc_freq_hz':    round(osc_freq, 2),
            'sat_lo_pct':     round(sat_lo, 1),
            'sat_hi_pct':     round(sat_hi, 1),
            'overshoot_deg':  round(overshoot_max, 2),
            'group':          TILT_GROUP.get(name, '?'),
        }

    # warnings (Q1 提醒)
    warnings: list[str] = []
    for name, m in out.items():
        if m['osc_freq_hz'] > 2:
            warnings.append(f'  ⚠ {name} 振荡 {m["osc_freq_hz"]:.1f}Hz — tilt rate 太快或 r_sc 太大')
        if m['avg_lag_deg'] > 5:
            warnings.append(f'  ⚠ {name} 平均 lag {m["avg_lag_deg"]:.1f}° — rate 太慢跟不上 ATC')
        if m['sat_lo_pct'] > 20 or m['sat_hi_pct'] > 20:
            warnings.append(f'  ⚠ {name} 撞限位 {max(m["sat_lo_pct"], m["sat_hi_pct"]):.0f}% 时间 — 调 LMIN/LMAX 或减 r_sc')
        if m['overshoot_deg'] > 5:
            warnings.append(f'  ⚠ {name} 过冲 {m["overshoot_deg"]:.1f}° — rate 太快或无阻尼')
    if not warnings:
        warnings.append('  ✓ 所有 tilt 通道无显著振荡/lag/饱和')

    return {'channels': out, 'warnings': warnings}


# ─── traces compaction (for transmit to frontend) ───
def compact_traces(traces: dict, max_pts: int = 2000) -> dict:
    """Downsample traces to max_pts per series for transmission."""
    out: dict[str, dict[str, list[float]]] = {}
    for name, cols in traces.items():
        n = len(cols.get('t', []))
        if n == 0:
            continue
        stride = max(1, n // max_pts)
        out[name] = {k: v[::stride] for k, v in cols.items() if isinstance(v, list)}
    return out


# ─── full pipeline ───
def analyze_log(path: str, current_params: dict[str, float] | None = None) -> dict:
    """End-to-end: parse, detect, analyze, suggest. Returns JSON-serializable dict."""
    current_params = current_params or {}
    parsed = parse_bin(path)
    traces = parsed['traces']

    pitch_steps = detect_steps(traces, 'pitch')
    throttle_steps = detect_steps(traces, 'throttle')

    pitch_metrics = [analyze_step(traces, s, 'pitch') for s in pitch_steps]
    throttle_metrics: list[dict] = []  # V loop step is a different signal — skip for now

    pitch_suggest = suggest_pids(pitch_metrics, current_params, 'pitch')
    roll_suggest = {'diagnosis': ['roll 轴未独立检测 step (合并到 pitch suggestion)'], 'suggested': {}}
    tilt_analysis = analyze_tilt(traces)

    return {
        'rows_read':     parsed['rows_read'],
        'duration_s':    parsed['duration_s'],
        'traces':        compact_traces(traces),
        'steps': {
            'pitch':    pitch_steps,
            'throttle': throttle_steps,
        },
        'metrics': {
            'pitch':    pitch_metrics,
            'throttle': throttle_metrics,
        },
        'suggestions': {
            'pitch': pitch_suggest,
            'roll':  roll_suggest,
        },
        'tilt': tilt_analysis,
    }


if __name__ == '__main__':
    import sys, json
    if len(sys.argv) < 2:
        print('Usage: python log_analysis.py <BIN_PATH>')
        sys.exit(1)
    res = analyze_log(sys.argv[1])
    print(json.dumps({k: v for k, v in res.items() if k != 'traces'}, indent=2, ensure_ascii=False))
    print(f'\n[traces compacted to {sum(len(c["t"]) for c in res["traces"].values())} pts across {len(res["traces"])} blocks]')
