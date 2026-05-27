# MantaShark Bench Calibration v4

支线工具: 台架推力 / 力矩标定. 极简直通通道, 解锁触发自动油门扫描.

## 通道硬编码

| Channel | Motor / Servo | 组 |
|---|---|---|
| 1-4 | SL1/SL2/SR1/SR2 | KS |
| 5-6 | DFL/DFR | KDF |
| 7-10 | TL1/TL2/TR1/TR2 | KT |
| 11-12 | RDL/RDR | KRD |
| 13 | DFL_tilt | |
| 14 | DFR_tilt | |
| 15 | TL1_tilt | |
| 16 | TR1_tilt | |
| 17 | RDL_tilt | |
| 18 | RDR_tilt | |
| 19 | SGRP (S 整组桁架) | |
| 20 | TL2_tilt | |
| 21 | TR2_tilt | |

## 任务流程

1. **GUI 配 MSAK_ 参数 + push** → 写 FC EEPROM, EN=1
2. **拨 RC ch5 解锁** → lua arm 边沿触发任务
3. **lua 自动**: 按 ANG_1..ANG_N 列表逐角度, 每角度从 THR_MAX 降 THR_STEP 到 THR_MIN, 每档维持 HOLD_MS ms
4. 全跑完 → STATUSTEXT "BENCH DONE"
5. **disarm 立即停所有 motor**, 任务复位 (可再次 arm 跑相同任务)
6. 紧急: GUI ⛔ STOP 写 EN=0 (但建议同时 disarm)

## 参数表

### MSAK_ (key=81) 任务控制

| 参数 | 含义 | 默认 |
|---|---|---|
| `MSAK_EN` | 总开关, 0=禁 1=允许 arm 触发 | 0 |
| `MSAK_MOTOR` | 1-12 单 motor / 13-19 组 | 1 |
| `MSAK_TILT_CH` | 0=不扫 tilt, 13-21=扫该 tilt | 0 |
| `MSAK_ANG_N` | 角度数 1-8 | 1 |
| `MSAK_ANG_1..8` | 8 个角度 (deg) | 0 |
| `MSAK_THR_MAX` | 油门起始 (0-1) | 0.5 |
| `MSAK_THR_MIN` | 油门终止 (0-1) | 0.1 |
| `MSAK_THR_STEP` | 步进 (0-1) | 0.1 |
| `MSAK_HOLD_MS` | 每档保持 ms | 2000 |
| `MSAK_TILT_FIX` | 不扫的 tilt 持此角度 | 45 |
| `MSAK_CAL_CH` | 校准: 0=off, 13-21=驱该 ch | 0 |
| `MSAK_CAL_ANG` | 校准角度 | 0 |

### TLT_ (key=82) 校准表

每 tilt 3 参数: `TLT_<ID>_P0`, `TLT_<ID>_P45`, `TLT_<ID>_DIR`.
- `P0`: 0° 对应 PWM (1500 default)
- `P45`: 45° 对应 PWM (1700 default)
- `DIR`: ±1, 反向时 -1

PWM 公式: `PWM = P0 + (P45 - P0) × (DIR × angle) / 45`

PWM 物理 hard clamp `[500, 2500]` (fork 扩展).

## 校准方法

**校 P0 (角度中位 PWM)**:
1. disarmed, GUI Tilt Cal tab 选某路 → "Drive 0°"
   - 写 `MSAK_CAL_CH=ch`, `MSAK_CAL_ANG=0`
   - lua 持续驱该 servo, motor 全停
2. 调 P0 PWM 让 servo 物理对准期望中心位 (S/DF: 垂直下 / KT/KRD: 水平后)
3. "Save row" → 写 `TLT_<ID>_P0`

**校 P45**:
1. "Drive 45°" → lua 写 PWM = P0 + (P45-P0) × 1
2. 物理目测 servo 是否真到 45°, 不到调 P45 PWM
3. "Save row"

**校 DIR**:
- 驱 +45° 但 servo 反向转 → DIR 改 -1

**Stop CAL**: "Stop CAL" 按钮 写 `MSAK_CAL_CH=0`, lua 退出 CAL 模式.

## GUI 三页

1. **Tilt Cal**: 9 路逐个校 P0/P45/DIR, 自动驱动按钮
2. **Task Setup**: motor/group 下拉, 角度数组, 油门范围, push to FC
3. **Live Preview**: sensor 3 通道实时, 21 个 PWM 通道实时, STATUSTEXT 滚动

## Quick start

```bash
# 1. SD 卡装 bench_test.lua (重命名 mantashark_main.lua)
cp scripts/bench_test.lua  <SD>/APM/scripts/mantashark_main.lua

# 2. 启动 GUI
cd tools/bench_calibration
python3 bench_pc.py --fc /dev/ttyACM0 --sensor /dev/ttyUSB0 --out ../../bench_logs

# 3. GUI: Connect → Tilt Cal → Task Setup → Push → RC arm
```

## 安全 checklist

- [ ] 飞机机身机械固定 (4 螺栓 to 台架)
- [ ] 三 sensor 校零完成 (无飞机时归零)
- [ ] RC 解锁开关在 ch5, 飞前确认 disarmed
- [ ] PC 离台架 ≥ 2m, prop 旋转范围之外
- [ ] 备用断电开关 in reach (主电源)
- [ ] 第二人监督

## CSV 录制 (TODO)

录制功能当前未在 v4 GUI 复现 (旧 v3 是手动单点录制). v4 设计是: lua 自动跑全角度+油门矩阵, GUI 后台异步录全程 sensor+PWM. 后续 deliverable.

## 已知 limitation

- 单轴 Z 力 → 测不到 yaw 力矩
- bench 不模拟气垫
- bench_test.lua 直接写 PWM 绕 ArduPilot ATC (by design — 测原始 motor 响应)
- 跟 mantashark 主线 lua 是两套 (ZERO/DIR 各自独立校)
