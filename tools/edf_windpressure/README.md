# 涵道风压 / 流速 台架测试 (edf_windpressure)

给选定 EDF 一个**固定目标油门 + 上升/下降 ramp**, 维持 N 秒, 用 I2C 空速管 (MS4525DO) 测喷流**差压 / 流速 / 盘载**, 导出 CSV.

目的: 实测验证"这台高速大推力 EDF 是高盘载推力机, P-Q 曲线对低压大流量(气垫)用途错配"。
- 盘载 = ρ·V²  (喷流速度平方直接给盘载, 不依赖测力)
- 流速 V = √(2q/ρ),  q = 原始差压 `SCALED_PRESSURE.press_diff` (不信飞控 airspeed, 它经 ARSPD_RATIO 标定)

## 文件

| 文件 | 说明 |
|---|---|
| `edf_windpressure.lua` | FC 端: 单点油门 + ramp 状态机, 广播 `WTHR`(commanded油门) + 写 dataflash `WPT` |
| `windpressure_pc.py` | 上位机 **CLI**: 设参数 / 归零 / 触发 / 读原始差压 / 算流速盘载 / 导 CSV + 统计 |
| `windpressure_gui.py` | 上位机 **GUI** (tkinter): 选电机 / 单点或多油门扫描 / 归零 / 实时大字读数 + 实时曲线 + 扫描结果表 + 自动 CSV |
| `sd_backup/` | **测试前自动备份的 SD 卡原 lua** (含 bench_test.lua, 测完用它还原) |
| `logs/` | CSV 输出 |

## 前置

空速管接 X7 I2C, 飞控参数 (已确认):
```
ARSPD_TYPE=1   ARSPD_BUS=1   ARSPD_USE=0   ARSPD_AUTOCAL=0
```

## 用法

**1. 备份当前 SD 卡 lua** (已做, 见 `sd_backup/`; 重新备份:)
```bash
python3 ../fc/fetch_lua.py --device /dev/ttyACM0 --baud 115200 \
    --remote APM/scripts/bench_test.lua --out sd_backup/bench_test.lua.bak
```

**2. 烧录测试脚本** (会替换卡上脚本; 多脚本会冲突, 先删原脚本):
```bash
# 上传 windpressure 脚本
python3 ../fc/flash_lua.py edf_windpressure.lua APM/scripts/edf_windpressure.lua
# 删除 bench_test.lua 避免双脚本抢 motor / 抢 param key=81
#   (flash_lua / MAVFTP rm, 或 GCS 文件管理器删)
# 重启 FC / 重载脚本
```

**3a. 跑测试 — GUI (推荐)**:
```bash
python3 windpressure_gui.py
```
- 顶部选串口 (默认抓 ttyACM*) → 连接
- 勾电机 / 填 hold·ramp·面积·ρ → 设油门 (单点滑杆, 或勾"扫描模式"填 `30,40,50,60,70,80`)
- **归零 (3s)** → **▶ 开始测试** (弹确认框 + 倒计时) → 看实时曲线/大字读数
- 跑完: 扫描结果表出逐点稳态 (压差/流速/盘载/流量/功率), CSV 自动存 `logs/`
- **■ 急停 Abort** 或关窗 → 立即停电机
- 依赖: `matplotlib`, `python3-pil.imagetk` (Tk 嵌图)

**3b. 跑测试 — CLI** (电机会转, 确保安全!):
```bash
# 单 EDF (motor 5 = DFL), 60% 油门, 维持 5s, 上升 2.5s / 下降 1.5s
./windpressure_pc.py --motors 5 --throttle 60 --hold 5 --ramp-up 2500 --ramp-down 1500

# 给喷口面积(cm²)→ 额外算流量 Q
./windpressure_pc.py --motors 5 --throttle 80 --area-cm2 22
```

上位机会: 设参数 → 静置归零 → **回车确认 + 3-2-1 倒计时** → 触发 → 记录 → 出 CSV + HOLD 段稳态统计 (压差/流速/盘载/电压电流功率)。

**4. 测完还原主线 lua** (从备份或 git):
```bash
# 还原 bench_test (从备份):
python3 ../fc/flash_lua.py sd_backup/bench_test.lua.<ts>.bak APM/scripts/bench_test.lua
# 删 edf_windpressure.lua
```

## 参数 (WPT_ 表, key=86 — 避开 81-85 历史占用, 防 EEPROM 残留表冲突)

| 参数 | 默认 | 说明 |
|---|---|---|
| `WPT_EN` | 0 | 1=启用 (gate) |
| `WPT_MOTOR_MSK` | 0 | bitmask, bit i = motor (i+1), 1-12 |
| `WPT_THR_TGT` | 0.5 | 目标油门 [0,1] |
| `WPT_HOLD_S` | 5 | 目标油门维持秒数 |
| `WPT_RAMP_UP` | 2000 | 0→TGT 上升 ramp ms (软启动防电流冲击) |
| `WPT_RAMP_DN` | 1500 | TGT→0 下降 ramp ms |
| `WPT_SW_ARM` | 0 | 软触发, 0→1 边沿启动 (开机强制 reset 0) |

## 安全

- 油门**软启动** (RAMP_UP ≥2s 建议), 防 ESC 电流冲击。
- `WPT_SW_ARM=0` / disarm 中途 → 立即 park 所有 motor。
- 任务跑完自动 disarm 回 IDLE。
- Ctrl-C / 异常 → 上位机自动 `WPT_SW_ARM=0 + WPT_EN=0` 停电机。
- 测高静压 (堵转) 时电机电流会飙升, 单次 ≤2-3s, 盯电流温度。

## CSV 列

`t_s, thr_cmd, state, press_diff_pa, vel_ms, disk_load_Nm2, flow_m3s, batt_v, batt_a, sensor_temp_c`

state: 0=IDLE 1=RAMP_UP 2=HOLD 3=RAMP_DN 4=DONE。统计只用 state=2 (HOLD) 稳态段。
