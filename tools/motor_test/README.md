# 电机油门阶梯测试 (motor_test)

给选定电机跑**油门阶梯扫描**(缓升→最低→逐档+步进→最高→缓降),实时读雷迅 power module 的**电压/电流/功率**,GUI 配参数 + 实时显示 + **手动连续记录(崩溃不丢数据)**。

## 文件

| 文件 | 作用 |
|---|---|
| `motor_test.lua` | FC 端: 油门阶梯状态机, 广播 `MTHR`(commanded油门)+`MST`(状态), param 表 `MTT_` (key=87) |
| `motor_test_gui.py` | 上位机 GUI: 配参 / ▶开始测试 / 实时 V/I/W / ●记录 ■停止 / 实时曲线 |
| `logs/` | CSV 输出 (`motor_<时间>.csv`) |

## 前置

- 飞控 `BATT_MONITOR=8` (DroneCAN/雷迅 power module), `BATTERY_STATUS` 报 V/I (已确认)。
- 电机驱动靠 `set_output_pwm_chan_timeout` override + `arm_force`。

## 用法

**1. 烧录 lua**(会替换卡上脚本; 多脚本抢 Motors_dynamic 会冲突, 先删原脚本):
```bash
python3 ../fc/fetch_lua.py --device /dev/ttyACM0 --baud 115200 \
    --remote APM/scripts/<现有>.lua --out sd_backup_<现有>.bak   # 先备份
python3 ../fc/flash_lua.py motor_test.lua APM/scripts/motor_test.lua
# 删掉卡上其他 .lua (edf_windpressure 等) 避免冲突, 然后重启 FC
```

**2. 开 GUI**:
```bash
python3 motor_test_gui.py
```
- 选串口 → 连接(右上变绿)
- 勾电机 → 填 最低/最高油门、步进、每档维持、缓升、缓降
- **● 开始记录**(可在测试前就开,持续写盘)
- **▶ 开始测试**(确认框)→ lua 跑阶梯,实时看 油门/电压/电流/功率/曲线
- 跑完 **■ 停止记录** 存 CSV

## 关键特性

- **连续记录崩溃不丢**:点"开始记录"后,每 20Hz 逐行写盘 + `flush`/`fsync`,程序中途崩/断线/关窗都已落盘的数据不丢。失联/断开会自动 stop 并保存。
- **记录独立于测试**:可手动开记录跑任意油门,或测试前就开着。
- **安全**:▶启动弹确认框;■急停 / 断线 / 关窗 → 立即 `SW_ARM=0+EN=0` 停桨。

## 参数 (MTT_ 表, key=87)

| 参数 | 默认 | 说明 |
|---|---|---|
| `MTT_EN` | 0 | 1=启用 |
| `MTT_MOTOR_MSK` | 0 | bitmask, bit i = motor (i+1) |
| `MTT_THR_MIN` | 0.1 | 最低油门 |
| `MTT_THR_MAX` | 1.0 | 最高油门 |
| `MTT_THR_STEP` | 0.1 | 步进 |
| `MTT_HOLD_MS` | 2000 | 每档维持 ms |
| `MTT_RAMP_UP` | 2000 | 缓升 ms |
| `MTT_RAMP_DN` | 1500 | 缓降 ms |
| `MTT_SW_ARM` | 0 | 软触发 0→1 边沿 |

## CSV 列

`t_s, throttle_pct, state, voltage_v, current_a, power_w`
state: 0=IDLE 1=RAMP_UP 2=HOLD 3=RAMP_DN 4=DONE
