# tools/ground_station/

MantaShark 专用地面站 — 和 Mission Planner 并行使用，显示混控系统专有状态。

## 界面布局

```
┌─ 顶部状态栏 ─────────────────────────────────────────────┐
│ [CONNECTED] [DISARMED] [FLY] [G2] [AUTO] [GPS 12★] [B1:24.1V] [B2:24.0V] │
├─── 涵道布局 (俯视) ──┬─── 飞行状态 / SERVO PWM ─────────┤
│                        │  模式: FLY    档位: G2           │
│  DFL SL1 SL2 SR1 SR2  │  Auto: ON     倾转: 15.0°       │
│  DML              DMR  │  GPS: 8.1 m/s  俯仰: 8.0°      │
│      TL1 TL2 TR1 TR2  │  SERVO1-16 实时 PWM 值           │
│          RDL RDR       │                                   │
│ 5组系数条形图          │                                   │
│ KS ████████ 55         │                                   │
│ DF █████████ 65        │                                   │
│ RC 通道 (摇杆+开关)   │                                   │
├─── GCS 消息流 (横跨) ─────────────────────────────────────┤
│ 14:32:01  MSK: FLY GEAR 2 (V2锁)                         │
│ 14:32:01  MSK: AUTO ON                                    │
│ 14:32:02  MSK: FLY G2A V=8.1(8.1) P=8 TL=15 KS=55 ...   │
└───────────────────────────────────────────────────────────┘
```

## 用法

### 方式 1: MAVProxy 分发 (推荐, 同时用 Mission Planner)

```bash
# 终端 1: 启动 MAVProxy 分发
mavproxy.py --master=/dev/ttyACM0 --baudrate=115200 \
  --out=udp:127.0.0.1:14550 \
  --out=udp:127.0.0.1:14551

# Mission Planner 连接 udp:14550

# 终端 2: 启动 MantaShark 专用地面站
sim/.venv/bin/python3 tools/ground_station/msk_gcs.py \
  --master=udpin:0.0.0.0:14551
# → 浏览器打开 http://localhost:8088
```

### 方式 2: 直连串口 (不用 MP)

```bash
sim/.venv/bin/python3 tools/ground_station/msk_gcs.py \
  --master=/dev/ttyACM0 --baudrate=115200
```

### 方式 3: 连 SITL 仿真

```bash
sim/.venv/bin/python3 tools/ground_station/msk_gcs.py \
  --master=udpin:0.0.0.0:14550
```

## 显示内容

| 区域 | 内容 | 数据来源 |
|------|------|---------|
| 顶部状态栏 | 连接/解锁/模式/档位/Auto/GPS/双电池 | HEARTBEAT + SYS_STATUS + GPS_RAW |
| 涵道布局图 | 14 EDF 实时 PWM, 激活的亮绿边 | SERVO_OUTPUT_RAW |
| 倾转角指示 | DFL/DFR 当前倾转角度 | STATUSTEXT 解析 |
| 混控系数条 | KS/DF/DM/KT/RD 归一化前 ×100 | STATUSTEXT 1Hz 日志解析 |
| RC 通道 | 9 通道实时 PWM 条形 | RC_CHANNELS |
| 飞行状态 | 速度/俯仰/横滚/偏航详细值 | ATTITUDE + VFR_HUD |
| SERVO 表 | 16 路 SERVO PWM 数值 | SERVO_OUTPUT_RAW |
| 消息流 | 最近 200 条 STATUSTEXT, 按严重度着色 | STATUSTEXT |

## 依赖

- `pymavlink` (已在 sim/.venv)
- Python 标准库 `http.server` (无需 Flask)
- 前端纯 HTML/CSS/JS, 无外部依赖

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `--master` | `udpin:0.0.0.0:14551` | MAVLink 连接串 |
| `--baudrate` | `115200` | 串口波特率 |
| `--port` | `8088` | Web 服务端口 |
