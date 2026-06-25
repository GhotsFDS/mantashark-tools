# Foil Calibration (hover 变体水翼)

支线工具: **可封闭气垫 hover 变体** 的水翼襟翼(SERVO9-12)+ 离水定高传感器调试。

> ⚠️ 与 `tools/bench_calibration/`(主线 12 EDF 推力/倾转台架)是**不同机型**,通道映射/标定一概不通用,别混用。

## 包含

| 工具 | 类型 | 用途 |
|---|---|---|
| `foil_cal_gui.py` | GUI (tkinter) | 襟翼零位/方向/行程 + 控制层 trim/EN/PID,滑块实时调,回显 PWM/测距 |
| `foil_cal.py` | CLI | 同上命令行版(SSH/无显示兜底) |
| `fc_rangefinder.py` | CLI | 飞控 RNGFND1 解析距离 + 反推电压实时显示 |
| `dm858_distance.py` | CLI | Rigol DM858E 万用表读 4-20mA→电压 → 换算距离(传感器端标定) |

## 用法

```
foil_cal_gui            # 桌面: 填端口(/dev/ttyACM0 或 COM3)→连接→滑块校准
fc_rangefinder --device COM3
dm858_distance 169.254.112.67 --v1 0 --d1 50 --v2 3.3 --d2 500
```

## 约定 (对照主线 TLT_)

- **中位 ZERO = 襟翼物理水平 0°**(机械参考)
- **正方向 = 增升角方向**(`test +` 让襟翼往增升偏;反了翻 DIR)
- **trim = 初始位置**(armed 静止停的托重基线,= 主线 TLT_GOAL)
- 裸 PWM 写 SERVO9-12 绕过 ArduPilot SERVOn_TRIM/REVERSED → 零位/方向全走 `HOV_<角>_ZERO/_DIR`

## 校准流程 (全程 disarmed, 不解锁不转桨)

1. 装连杆使襟翼大致水平
2. 逐角 ZERO 微调到物理 0°
3. `test +0.5` 验方向(反了翻 DIR);`test +1` 验限位(撞了调 RNG 小)
4. `预览 trim` 看初始位置;`EN` 打开高度控制器
5. PID 增益上水再调(台架闭不了高度环)

## 打包

CI: `.github/workflows/build-foilcal.yml`(push 到此目录自动编 Win/Linux exe → artifacts)。
本地: `build_bench.sh`(在主仓 MantaShark-hover/tools/bench/,复用 PyInstaller venv)。
