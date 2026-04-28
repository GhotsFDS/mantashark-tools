# tools/log_analyzer/

ArduPilot BIN 日志离线分析 — CLI + Web UI 两种形式。
跨平台 PyInstaller 打包成单文件 EXE 由 GitHub Actions 自动出 (mantashark-tools 公开仓)。

## 文件清单

| 文件 | 用途 |
|---|---|
| `analyze_log.py` | CLI 主程序 — `LogAnalyzer` 类解析 BIN, 检测飞行阶段, 输出关键事件 + 姿态/电流/RC 图 |
| `web_analyzer.py` | Flask Web UI — 拖拽上传 BIN, 浏览器看分析结果和图 |
| `build_analyzer.sh` | Linux 打包 (PyInstaller --onefile) |
| `build_analyzer_win.bat` | Windows 打包 (PyInstaller --onefile, 处理 cp1252 UTF-8 问题) |

## 用法

```bash
# CLI 一键分析
sim/.venv/bin/python3 tools/log_analyzer/analyze_log.py LOGS/00000XXX.BIN

# 加图 + CSV
sim/.venv/bin/python3 tools/log_analyzer/analyze_log.py LOGS/00000XXX.BIN --plot --csv

# Web 版
sim/.venv/bin/python3 tools/log_analyzer/web_analyzer.py
# 浏览器开 http://localhost:5000
```

## 输出内容

- 基本信息: 时长 / 解锁段 / V_max / 模式切换次数
- MSK STATUSTEXT 时间线: mode (NOGPS/GPS) / gear (1/2/3) / Auto (ON/OFF) / RTL 切换
- K 心跳采样: 1Hz `MSK K: S/DF/T/RD spd=eff/real` 解析
- 预检事件: STAGE 1-4 触发记录
- 异常事件: Lua 错误 / 紧急停车 / 姿态保护介入 / EKF Yaw realign
- SERVO 校验: 12 EDF + 7 倾转 PWM 时间序列, 镜像方向检查

## v8 STATUSTEXT 兼容性

支持 v7 (`MSK: GPS GEAR 2`) 和 v8 (`MSK mode -> GPS gear=2`) 双格式正则。

## CI 打包

`.github/workflows/build-analyzer.yml` 在 `mantashark-tools` 公开仓自动出二进制:
- `analyze_log.exe` / `analyze_log` — CLI
- `analyze_log_web.exe` / `analyze_log_web` — Web

最新 release: https://github.com/GhotsFDS/mantashark-tools/releases/tag/v8.4

## v9 调整方向 (待做)

- 加 TECS `target_airspeed` 跟踪解析 (CRUISE 模式速度命令实测)
- 加 `nav_pitch_cd` / `nav_roll_cd` 解析 (桥接派 ATC 输出)
- 加 SERVO scaled output 时间线 (ATC 残差实测)
