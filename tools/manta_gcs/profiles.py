"""台架测试矩阵 — 动力测试 11 profile.

每个 profile = 一串 SweepPoint. runner 对每个 SweepPoint:
  角度梯度(sweep 舵机从软件限位 min→max 按 ang_step) × 油门阶梯(thr_min→max 按 step).
  - sweep 非空: 扫该组舵机角度 (从飞控 TLT_<alias>_LMIN/LMAX 读, body=[LMIN+45,LMAX+45])
  - sweep 空: 舵机固定 GOAL, 只跑油门阶梯
  油门阶梯中间不回 0; 角度切换才回 0 (= motor_test 模式).

SweepPoint 字段:
  msk_a : A 组电机 bitmask (跑油门阶梯)
  msk_b, thr_b : B 组背景固定油门
  diff  : L/R 差动 [-0.5,0.5]
  sweep : 扫角度的舵机 id 元组 (同步同角); () = 不扫, 舵机用 GOAL
  label : 标签

电机 (1-based): 1 SL1 2 SL2 3 SR1 4 SR2 | 5 DFL 6 DFR | 7 TL1 8 TL2 9 TR1 10 TR2 | 11 RDL 12 RDR
舵机角约定: SGRP 15-75 / DF 0-90 / TL1·TR1 ≥90(>90反向roll) / RDL·RDR 90=水平 50=垂直低头.
"""
from __future__ import annotations
from dataclasses import dataclass, field


def m(*motors) -> int:
    return sum(1 << (k - 1) for k in motors)


KS   = m(1, 2, 3, 4)
KDF  = m(5, 6)
KT   = m(7, 8, 9, 10)
KRD  = m(11, 12)
TL1, TR1 = m(7), m(9)
FRONT6 = KS | KDF
REAR6  = KT | KRD

DIFF_LV = [0.10, 0.20, 0.30, 0.40]
DIFF_YAW = [0.20, 0.40]   # P8/P9: yaw 余量大, 审查建议砍到 2 档, 把台架时间挪给 roll

# 舵机 GOAL 默认 (不扫角度时用)
GOAL = {'S_GROUP_TILT': 40, 'DFL': 40, 'DFR': 40,
        'TL1': 90, 'TR1': 90, 'RDL': 90, 'RDR': 90}
# 舵机 id → TLT_ 参数短名 (读软件限位 LMIN/LMAX 用)
ID2ALIAS = {'S_GROUP_TILT': 'SGRP', 'DFL': 'DFL', 'DFR': 'DFR',
            'TL1': 'TL1', 'TR1': 'TR1', 'RDL': 'RDL', 'RDR': 'RDR'}
SDF = ('S_GROUP_TILT', 'DFL', 'DFR')   # S+DF 同步扫 (同角)


@dataclass
class SweepPoint:
    label: str
    msk_a: int = 0
    msk_b: int = 0
    thr_b: float = 0.0
    diff: float = 0.0
    sweep: tuple = ()      # 扫角度的舵机 id (同步), () = 固定 GOAL


@dataclass
class Profile:
    key: str
    name: str
    desc: str
    points: list = field(default_factory=list)   # SweepPoint 列表


def _build() -> dict:
    P = {}
    names = ['SL1','SL2','SR1','SR2','DFL','DFR','TL1','TL2','TR1','TR2','RDL','RDR']

    # P0 单涵道基线: 12 电机各 1 点, 不扫角度(GOAL), 油门阶梯
    P['P0'] = Profile('P0', '单涵道基线', '逐涵道油门阶梯 — 每涵道推力曲线+电流',
        [SweepPoint(f'M{i}({names[i-1]})', msk_a=m(i)) for i in range(1, 13)])

    # P1 S+DF 整体: 1 点, 扫 S+DF 角度梯度(同角), 油门阶梯
    P['P1'] = Profile('P1', 'S+DF整体', 'S+DF角度梯度(限位min→max)×油门阶梯 — 前升/推分解',
        [SweepPoint('SDF', msk_a=FRONT6, sweep=SDF)])

    # P2 后6纯前推: 1 点, 不扫(@90), 油门阶梯
    P['P2'] = Profile('P2', '后6纯前推', 'KT+KRD @90° 油门阶梯 — 最大前推',
        [SweepPoint('REAR6@90', msk_a=REAR6)])

    # P3 RD 单独: 1 点, 扫 RD 角度梯度(同角), 油门阶梯
    P['P3'] = Profile('P3', 'RD单独', 'RD角度梯度(限位min→max)×油门阶梯 — 低头力矩',
        [SweepPoint('RD', msk_a=KRD, sweep=('RDL', 'RDR'))])

    # P4 T1 单独(左右分): 2 点, 各扫 TL1/TR1 角度梯度(含>90), 油门阶梯
    P['P4'] = Profile('P4', 'T1单独(左右分)', 'TL1/TR1各自角度梯度×油门阶梯 — roll 能力',
        [SweepPoint('TL1', msk_a=TL1, sweep=('TL1',)),
         SweepPoint('TR1', msk_a=TR1, sweep=('TR1',))])

    # P5 后90+前6: 1 点, 后6@90背景 + 扫 S+DF 角度梯度, 油门阶梯
    P['P5'] = Profile('P5', '后90+前6', '后6@90背景 + S+DF角度梯度×油门阶梯 — 巡航态',
        [SweepPoint('F6+R6@70', msk_a=FRONT6, msk_b=REAR6, thr_b=0.70, sweep=SDF)])

    # P6 S+DF固定+RD扫: 1 点, 前6@GOAL背景 + 扫 RD 角度梯度, 油门阶梯
    P['P6'] = Profile('P6', 'S+DF固定+RD扫', '前6背景 + RD角度梯度×油门阶梯 — RD俯仰权',
        [SweepPoint('RD+F6@70', msk_a=KRD, msk_b=FRONT6, thr_b=0.70, sweep=('RDL', 'RDR'))])

    # P7 S/DF 差动: 各差动档 1 点, 扫 S+DF 角度梯度 + 差动, 油门阶梯
    P['P7'] = Profile('P7', 'S/DF差动', '各差动档 S+DF角度梯度×油门阶梯 — 气垫roll',
        [SweepPoint(f'SDF_diff{int(d*100)}', msk_a=FRONT6, diff=d, sweep=SDF) for d in DIFF_LV])

    # P8 KT yaw 差动: 砍到 2 档 (yaw 余量大)
    P['P8'] = Profile('P8', 'KT yaw差动', 'KT@90 各差动档油门阶梯 — yaw 余量(2档)',
        [SweepPoint(f'KT@90_diff{int(d*100)}', msk_a=KT, diff=d) for d in DIFF_YAW])

    # P9 T1@90 差动: 砍到 2 档
    P['P9'] = Profile('P9', 'T1@90差动', 'TL1+TR1@90 各差动档油门阶梯 — roll纯推态(2档)',
        [SweepPoint(f'T1@90_diff{int(d*100)}', msk_a=TL1|TR1, diff=d) for d in DIFF_YAW])

    # P10 T1+T2: 全KT组 + 扫 T1 角度梯度(同角)
    P['P10'] = Profile('P10', 'T1+T2', '全KT组 T1角度梯度×油门阶梯 — 后推+roll协同',
        [SweepPoint('KT_T1', msk_a=KT, sweep=('TL1', 'TR1'))])

    # P11 组合 roll 权限 (审查最大缺失, 直击离水翻船): 气垫差动 + T1 反向倾转 同时施加
    # 各差动档下扫 TL1/TR1 反向角度. 回答"两个 roll 源一起够不够离水不翻"
    P['P11'] = Profile('P11', '组合roll权限', '气垫差动+T1反向倾转 同时×油门 — 离水翻船核心',
        [SweepPoint(f'roll_d{int(d*100)}', msk_a=FRONT6|TL1|TR1, diff=d, sweep=('TL1', 'TR1'))
         for d in DIFF_LV])

    # P12 DF 单独角度扫 (高带宽 pitch 主控隔离, 从没单独测过): S 固定 GOAL, 只扫 DF
    P['P12'] = Profile('P12', 'DF单独', 'DF角度梯度×油门(S固定) — 高带宽pitch主控隔离',
        [SweepPoint('DF', msk_a=KDF, sweep=('DFL', 'DFR'))])

    # P13 DF 差动 (快 roll 备选, DF 惯量小可能比气垫差动更快)
    P['P13'] = Profile('P13', 'DF差动', 'DF各差动档油门 — 快roll备选(惯量小)',
        [SweepPoint(f'DF_d{int(d*100)}', msk_a=KDF, diff=d) for d in DIFF_LV])

    return P


PROFILES = _build()


def list_profiles():
    for k, p in PROFILES.items():
        nsweep = sum(1 for sp in p.points if sp.sweep)
        print(f'  {k:4} {p.name:14} {len(p.points)}点({nsweep}个扫角度) — {p.desc}')


if __name__ == '__main__':
    print('台架测试矩阵 (角度梯度 × 油门阶梯):')
    list_profiles()
    print('\n角度范围从飞控 TLT_<舵机>_LMIN/LMAX 读 (body=[LMIN+45,LMAX+45]), 步进 GUI 设')
