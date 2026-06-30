#!/usr/bin/env python3
"""台架 CSV 控制符号断言分析器 — MantaShark WIG 地面固定台架.

验证每个"扫角度"测试里, 倾转舵机的 body 角运动产生的力矩方向, 是否跟飞控
servo_orchestrator (actuators.lua fb_residual_sign) 假设的符号一致.
**符号反 = 正反馈发散 = 飞机扎水/翻船的根因.** 这是台架最高价值的产出.

输入: bench.py 产出的 10Hz 原始 CSV (表头含 phase / ang_* / roll_Nm/pitch_Nm/yaw_Nm).
用法: python3 sign_check.py <bench_csv>     # 退出码非0 = 有 FLAG (或错误)
      python3 sign_check.py --selftest       # 合成数据自测 (无需真 CSV)

────────────────────────────────────────────────────────────────────────
力矩符号约定 (必须跟 bench.py _derive 对齐, 否则绝对符号校验无意义):
  roll_Nm  = (V_L − V_R)·arm                 > 0 → 左升力大 (左翼上抬→右滚)
  pitch_Nm = (V_L+V_R)·前臂 − V_aft·后臂      > 0 → 前升大 = 抬头 (nose-up)
  yaw_Nm   = (H_L − H_R)·arm                  > 0 → 左推力大
力臂是占位值 → 力矩"幅值"不准, 但"符号"不受力臂标定影响, 故符号校验有效.

期望 d(力矩)/d(body角)  (body 约定: 0=喷口下吹, 45=中立, 90=水平):
  俯仰 (置信 — 来自前/后升力几何 + 上面 pitch 约定):
    SGRP/DFL/DFR 在前: +body → 前部下吹升力↓ → pitch↓        ⇒ slope < 0
    RDL/RDR 在后:      +body → 后部下吹升力↓ → −aft↑ → pitch↑ ⇒ slope > 0
  滚转 (暂定 — 绝对号待实测; TL1/TR1 互为镜像是硬约束):
    TL1 (左) roll slope < 0 ; TR1 (右) roll slope > 0

扫描单元 (同步对扫的舵机一起处理, 对称对的反对称轴会抵消):
  SDF三联 / DF对 / RD对 / T1对(同步) → 主轴 pitch (或抵消), 反对称 roll 应 ≈0
  TL1单 / TR1单 (P4 分别扫)          → 主轴 roll, 跨单元镜像
"""
import csv
import sys
import argparse

# ── 列名 / 约定 ──
ANG_COL = {'ang_S': 'S_GROUP_TILT', 'ang_DFL': 'DFL', 'ang_DFR': 'DFR',
           'ang_TL1': 'TL1', 'ang_TR1': 'TR1', 'ang_RDL': 'RDL', 'ang_RDR': 'RDR'}
MOMENTS = ['roll_Nm', 'pitch_Nm', 'yaw_Nm']
AX = {'roll_Nm': 'roll', 'pitch_Nm': 'pitch', 'yaw_Nm': 'yaw'}
COL = {'roll': 'roll_Nm', 'pitch': 'pitch_Nm', 'yaw': 'yaw_Nm'}
SWEEP_RANGE_MIN = 8.0   # ang 跨度 > 8° 才算"被扫"

# 单舵机期望 (axis, sign): 来自 actuators.lua fb_residual_sign + 角度/力矩约定
EXPECTED = {
    'S_GROUP_TILT': ('pitch', -1), 'DFL': ('pitch', -1), 'DFR': ('pitch', -1),
    'TL1': ('roll', -1), 'TR1': ('roll', +1),
    'RDL': ('pitch', +1), 'RDR': ('pitch', +1),
}


def _f(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _strip_angle(label):
    """'RD@60°' → 'RD'; 'SDF_diff20@30°' → 'SDF_diff20'."""
    return label.split('@')[0] if label else (label or '')


def _linreg(xs, ys):
    """最小二乘 slope + R² (纯 stdlib)."""
    n = len(xs)
    if n < 2:
        return 0.0, 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0:
        return 0.0, 0.0
    slope = sxy / sxx
    r2 = (sxy * sxy) / (sxx * syy) if syy > 0 else 0.0
    return slope, r2


def _monotonic_frac(ys):
    """相邻差分同号占比 (1.0 = 完全单调)."""
    diffs = [b - a for a, b in zip(ys, ys[1:])]
    diffs = [d for d in diffs if abs(d) > 1e-12]
    if not diffs:
        return 1.0
    pos = sum(1 for d in diffs if d > 0)
    return max(pos, len(diffs) - pos) / len(diffs)


def _classify(members):
    """扫描单元 → (主轴, 期望号, 反对称轴, 置信, 描述). 主轴='cancel' = 对称抵消."""
    s = frozenset(members)
    if s == {'S_GROUP_TILT', 'DFL', 'DFR'}:
        return ('pitch', -1, 'roll', True, 'SDF同步前抬: pitch斜率<0, roll对称≈0')
    if s == {'DFL', 'DFR'}:
        return ('pitch', -1, 'roll', True, 'DF对: pitch斜率<0, roll≈0')
    if s == {'RDL', 'RDR'}:
        return ('pitch', +1, 'roll', True, 'RD对: pitch斜率>0, roll≈0')
    if s == {'TL1', 'TR1'}:
        return ('cancel', 0, 'roll', True, 'T1对称同步: roll应抵消≈0 (本profile不测roll绝对符号)')
    if s == {'TL1'}:
        return ('roll', -1, 'pitch', False, 'TL1单扫: roll斜率<0 (暂定; 与TR1镜像为硬约束)')
    if s == {'TR1'}:
        return ('roll', +1, 'pitch', False, 'TR1单扫: roll斜率>0 (暂定; 与TL1镜像)')
    if len(s) == 1:
        m = next(iter(s))
        ax, sg = EXPECTED.get(m, ('pitch', 0))
        anti = 'roll' if ax == 'pitch' else 'pitch'
        return (ax, sg, anti, ax == 'pitch', '%s单扫' % m)
    return (None, 0, None, False, '未知组合 %s' % sorted(s))


def analyze(csv_path):
    """读 bench CSV → 结构化符号校验结果 dict. 给 CLI 和 mavbridge 用."""
    res = {'csv': csv_path, 'units': [], 'flags': [], 'skipped': None, 'error': None}
    try:
        with open(csv_path, newline='') as fh:
            rows = list(csv.DictReader(fh))
    except Exception as e:                      # noqa: BLE001 — 任何读错都优雅返回
        res['error'] = '读 CSV 失败: %s' % e
        return res
    if not rows:
        res['skipped'] = '空文件'
        return res
    need = set(ANG_COL) | set(MOMENTS) | {'phase', 'label', 'thr_pct'}
    miss = need - set(rows[0].keys())
    if miss:
        res['error'] = '缺列: %s' % sorted(miss)
        return res

    hold = [r for r in rows if r.get('phase') == 'hold']
    if not hold:
        res['skipped'] = '无 hold 行 (全 ramp?) — 稳态数据缺失'
        return res

    # 全局有没有任何被扫舵机
    any_swept = False
    for col in ANG_COL:
        vals = [_f(r[col]) for r in hold]
        vals = [v for v in vals if v is not None]
        if vals and (max(vals) - min(vals)) > SWEEP_RANGE_MIN:
            any_swept = True
            break
    if not any_swept:
        res['skipped'] = '无角度扫描 (固定配置 profile 如 P0/P2/P8/P13) → 符号校验跳过'
        return res

    # 按 label 前缀分组 (区分 P4 的 TL1/TR1 段、P7 的 diff 档)
    groups = {}
    for r in hold:
        groups.setdefault(_strip_angle(r['label']), []).append(r)

    for prefix, grp in sorted(groups.items()):
        swept = []
        for col in ANG_COL:
            vals = [_f(r[col]) for r in grp]
            vals = [v for v in vals if v is not None]
            if vals and (max(vals) - min(vals)) > SWEEP_RANGE_MIN:
                swept.append(col)
        if not swept:
            continue
        members = [ANG_COL[c] for c in swept]
        thrs = [_f(r['thr_pct']) for r in grp]
        thrs = [t for t in thrs if t is not None]
        if not thrs:
            continue
        top = max(thrs)                         # 最高油门档 = 最好信噪比
        sub = [r for r in grp if _f(r['thr_pct']) == top]

        acol = swept[0]                         # 同步扫 → 任一列做角度轴
        bins = {}
        for r in sub:
            a = _f(r[acol])
            if a is None:
                continue
            b = bins.setdefault(round(a), {m: [] for m in MOMENTS})
            for m in MOMENTS:
                v = _f(r[m])
                if v is not None:
                    b[m].append(v)
        angles = sorted(bins)
        exp_axis, exp_sign, anti_axis, confident, desc = _classify(members)
        u = {'prefix': prefix, 'members': members, 'top_thr': top,
             'desc': desc, 'confident': confident, 'flags': [], 'checks': []}
        if len(angles) < 3:
            u['note'] = '角度点 %d<3, 无法回归' % len(angles)
            u['flags'].append('少点')
            res['flags'].append('%s: 角度点不足 (%d)' % (prefix, len(angles)))
            res['units'].append(u)
            continue
        means = {m: [sum(bins[a][m]) / len(bins[a][m]) if bins[a][m] else 0.0
                     for a in angles] for m in MOMENTS}
        reg = {m: _linreg(angles, means[m]) for m in MOMENTS}
        span = angles[-1] - angles[0]
        strength = {m: abs(reg[m][0]) * span for m in MOMENTS}
        dom = max(MOMENTS, key=lambda m: strength[m])
        u.update({'angles': [angles[0], angles[-1]], 'dominant': AX[dom],
                  'slopes': {AX[m]: round(reg[m][0], 4) for m in MOMENTS},
                  'r2': {AX[m]: round(reg[m][1], 2) for m in MOMENTS}})

        def chk(name, ok, detail):
            u['checks'].append((name, 'PASS' if ok else 'FLAG', detail))
            if not ok:
                u['flags'].append(name)
                res['flags'].append('%s: %s — %s' % (prefix, name, detail))

        if exp_axis == 'cancel':                # 对称同步: 抵消轴应远小于其它
            anti_s = strength[COL[anti_axis]]
            other = max((strength[m] for m in MOMENTS if AX[m] != anti_axis), default=1e-9)
            chk('对称抵消', anti_s < 0.5 * other or anti_s < 1e-6,
                '%s强度=%.3f vs 其它=%.3f (应抵消)' % (anti_axis, anti_s, other))
        else:
            exp_s = strength[COL[exp_axis]]
            anti_s = strength[COL[anti_axis]]
            slope = reg[COL[exp_axis]][0]
            chk('轴匹配', AX[dom] == exp_axis, '实测主轴=%s 期望=%s' % (AX[dom], exp_axis))
            if exp_sign != 0:
                ok = abs(slope) > 1e-9 and (slope > 0) == (exp_sign > 0)
                tag = '' if confident else '(暂定)'
                chk('绝对符号%s' % tag, ok,
                    '%s斜率=%+.4f 期望%s' % (exp_axis, slope, '+' if exp_sign > 0 else '−'))
            chk('反对称≈0', anti_s < 0.3 * max(exp_s, 1e-9),
                '%s强度=%.3f vs %s=%.3f (反对称应小)' % (anti_axis, anti_s, exp_axis, exp_s))
            chk('单调', _monotonic_frac(means[COL[exp_axis]]) >= 0.8,
                '%s单调比=%.0f%%' % (exp_axis, _monotonic_frac(means[COL[exp_axis]]) * 100))
        res['units'].append(u)

    # 跨单元 L/R 镜像 (P4: TL1单 vs TR1单 的 roll 斜率必相反号)
    by_set = {frozenset(u['members']): u for u in res['units'] if 'slopes' in u}
    tl1, tr1 = by_set.get(frozenset({'TL1'})), by_set.get(frozenset({'TR1'}))
    if tl1 and tr1:
        a, b = tl1['slopes']['roll'], tr1['slopes']['roll']
        ok = abs(a) > 1e-9 and abs(b) > 1e-9 and (a < 0) != (b < 0)
        res['units'].append({'prefix': 'TL1↔TR1', 'mirror': True,
                             'status': 'PASS' if ok else 'FLAG',
                             'detail': 'TL1 roll斜率=%+.4f, TR1=%+.4f (应相反号)' % (a, b)})
        if not ok:
            res['flags'].append('L/R镜像: TL1=%+.4f TR1=%+.4f 同号或缺信号!' % (a, b))
    return res


def format_report(res):
    L = ['═══ 符号断言: %s ═══' % res.get('csv', '')]
    if res.get('error'):
        return '\n'.join(L + ['  ✗ 错误: %s' % res['error']])
    if res.get('skipped'):
        return '\n'.join(L + ['  ⊘ 跳过: %s' % res['skipped']])
    for u in res['units']:
        if u.get('mirror'):
            mark = '✓' if u['status'] == 'PASS' else '✗'
            L.append('  [%s] %s L/R镜像: %s' % (mark, u['prefix'], u['detail']))
            continue
        L.append('  ▸ %s (%s) @%s%% %s  — %s' % (
            u['prefix'], '+'.join(u['members']), u.get('top_thr', '?'),
            ('%.0f→%.0f°' % (u['angles'][0], u['angles'][1])) if 'angles' in u else u.get('note', ''),
            u.get('desc', '')))
        if 'slopes' in u:
            L.append('      斜率N·m/°: ' + '  '.join(
                '%s=%+.4f(R²%.2f)' % (ax, u['slopes'][ax], u['r2'][ax]) for ax in ('roll', 'pitch', 'yaw')))
            L.append('      主轴=%s' % u['dominant'])
        for name, st, detail in u.get('checks', []):
            L.append('      [%s] %s: %s' % ('✓' if st == 'PASS' else '✗', name, detail))
    nf = len(res.get('flags', []))
    L.append('  ' + ('✗ %d 个 FLAG — 见上 (符号反/不对称 = 发散风险, 查 TLT_*_DIR 或 fb_residual_sign)' % nf
                     if nf else '✓ 全部 PASS — 符号与控制律假设一致'))
    return '\n'.join(L)


# ────────────────────────────── 自测 ──────────────────────────────
def _synth_csv(path, prefixes):
    """合成台架 CSV. prefixes: [(prefix, ang_col列表, 角度序列, lambda b→(roll,pitch,yaw))]."""
    cols = ['phase', 'label', 'thr_pct'] + list(ANG_COL) + MOMENTS
    with open(path, 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for prefix, acols, angs, fn in prefixes:
            for b in angs:
                roll, pitch, yaw = fn(b)
                for _ in range(3):              # 每角度 3 行 hold
                    row = {c: 45 for c in ANG_COL}
                    for ac in acols:
                        row[ac] = b
                    row.update({'roll_Nm': roll, 'pitch_Nm': pitch, 'yaw_Nm': yaw})
                    w.writerow(['hold', '%s@%d°' % (prefix, b), 80]
                               + [row[c] for c in ANG_COL] + [row['roll_Nm'], row['pitch_Nm'], row['yaw_Nm']])


def selftest():
    import tempfile, os
    d = tempfile.mkdtemp(prefix='signchk_')
    fails = 0

    def expect(name, path, want_flags):
        nonlocal fails
        res = analyze(path)
        got = len(res.get('flags', [])) > 0
        ok = got == want_flags
        print('  [%s] %s: flags=%s (期望%s)' % ('✓' if ok else '✗', name, got, want_flags))
        if not ok:
            fails += 1
            print(format_report(res))

    # 1. 正常 RD: body 90→50, pitch 随 body 增大而增大 (slope>0, 期望+), roll≈0
    p1 = os.path.join(d, 'good_rd.csv')
    _synth_csv(p1, [('RD', ['ang_RDL', 'ang_RDR'], [90, 80, 70, 60, 50],
                     lambda b: (0.0, 0.02 * (b - 70), 0.0))])
    expect('正常RD(pitch+)', p1, False)

    # 2. 反号 RD: pitch 随 body 反向 (slope<0) → 应 FLAG 绝对符号
    p2 = os.path.join(d, 'rev_rd.csv')
    _synth_csv(p2, [('RD', ['ang_RDL', 'ang_RDR'], [90, 80, 70, 60, 50],
                     lambda b: (0.0, -0.02 * (b - 70), 0.0))])
    expect('反号RD(应FLAG)', p2, True)

    # 3. P4 镜像: TL1 roll<0, TR1 roll>0 → 镜像 PASS
    p3 = os.path.join(d, 'p4_mirror.csv')
    _synth_csv(p3, [('TL1', ['ang_TL1'], [90, 100, 110, 120], lambda b: (-0.01 * (b - 90), 0.0, 0.0)),
                    ('TR1', ['ang_TR1'], [90, 100, 110, 120], lambda b: (+0.01 * (b - 90), 0.0, 0.0))])
    expect('P4镜像(正常)', p3, False)

    # 4. P4 镜像破裂: 两个都 roll<0 (一路 DIR 反了) → 应 FLAG
    p4 = os.path.join(d, 'p4_broken.csv')
    _synth_csv(p4, [('TL1', ['ang_TL1'], [90, 100, 110, 120], lambda b: (-0.01 * (b - 90), 0.0, 0.0)),
                    ('TR1', ['ang_TR1'], [90, 100, 110, 120], lambda b: (-0.01 * (b - 90), 0.0, 0.0))])
    expect('P4镜像破裂(应FLAG)', p4, True)

    # 5. SDF 同步: pitch slope<0 (期望-), roll≈0 → PASS
    p5 = os.path.join(d, 'sdf.csv')
    _synth_csv(p5, [('SDF', ['ang_S', 'ang_DFL', 'ang_DFR'], [15, 30, 45, 60, 75],
                     lambda b: (0.0, -0.015 * (b - 45), 0.0))])
    expect('SDF(pitch−,roll≈0)', p5, False)

    # 6. 固定配置 (无扫角) → 优雅跳过, 无 flag
    p6 = os.path.join(d, 'p0.csv')
    _synth_csv(p6, [('M1', [], [45], lambda b: (0.0, 0.5, 0.0))])
    r6 = analyze(p6)
    ok6 = r6.get('skipped') is not None and not r6.get('flags')
    print('  [%s] 无扫角P0: skipped=%r' % ('✓' if ok6 else '✗', r6.get('skipped')))
    if not ok6:
        fails += 1

    print('═══ 自测 %s (%d 失败) ═══' % ('通过' if fails == 0 else '失败', fails))
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser(description='台架 CSV 控制符号断言分析器')
    ap.add_argument('csv', nargs='?', help='bench CSV 路径')
    ap.add_argument('--selftest', action='store_true', help='合成数据自测')
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    if not a.csv:
        ap.error('需要 CSV 路径 (或 --selftest)')
    res = analyze(a.csv)
    print(format_report(res))
    sys.exit(1 if (res.get('flags') or res.get('error')) else 0)


if __name__ == '__main__':
    main()
