# tools/log_analyzer/

ArduPilot BIN 日志离线分析 — CLI + Web UI 两种形式。
跨平台 PyInstaller 打包成单文件 EXE 由 GitHub Actions 自动出。

## 文件清单

| 文件 | 用途 |
|------|------|
| `analyze_log.py` | **CLI 主程序** — `LogAnalyzer` 类解析 BIN, 检测飞行阶段, 输出关键事件 + 姿态/电流/RC 图 |
| `web_analyzer.py` | Flask Web UI — 拖拽上传 BIN, 浏览器看分析结果和图 |
| `build_analyzer.sh` | Linux 构建 (PyInstaller --onefile) |
| `build_analyzer_win.bat` | Windows 构建 (PyInstaller --onefile, 处理 cp1252 UTF-8 问题) |

## 用法

```bash
# CLI 一键分析
sim/.venv/bin/python3 tools/log_analyzer/analyze_log.py LOGS/00000036.BIN

# Web UI (默认 8080)
sim/.venv/bin/python3 tools/log_analyzer/web_analyzer.py
# → http://localhost:8080

# 本地构建 EXE
bash tools/log_analyzer/build_analyzer.sh
```

## CI 自动构建

[`.github/workflows/build-analyzer.yml`](../../.github/workflows/build-analyzer.yml) 在 push 时自动构建:
- Linux: `analyze_log` + `analyze_log_web`
- Windows: `analyze_log.exe` + `analyze_log_web.exe`

构建产物作为 GitHub Actions Artifact 留存 30 天, 发 release 时附加到 release。

## 检测能力

- 飞行阶段识别 (静止 / 滑跑 / 离水 / 巡航 / 着陆 / 异常)
- KRD 后斜下吹组的实际权限 (LOG36 验证 SERVO13/14 是否被驱动)
- SERVO 配置一致性 (SERVO_FUNCTION 1-14)
- 姿态极值 (pitch/roll 峰值, 用于事故复盘)

## 历史

LOG36 (10kg 真机, 2026-04-01) 用此工具分析后定位"驼峰速度处 KRD 不工作 → 抬头力矩失控 → 后翻坠机"
的根因, 直接催生了 v7 mixer 的 STAGE 3 STAB FEEDBACK 预检设计。
