# mantashark-tools

MantaShark 项目的**公开构建仓库** — 专门放 CI 需要的打包源码 + workflow, 生成 Windows/Linux exe。

**主仓库 (私有)**: `GhotsFDS/MantaShark` — 飞控固件、Lua 混控、全套源码。  
**此仓库 (公开)**: 只含打包用的 Python 脚本 + GitHub Actions workflow, 利用公开仓库无限免费 CI minutes。

## 包含什么

```
tools/
├── ground_station/
│   ├── msk_gcs.py        ← MantaShark 地面站 (Python HTTP 服务 + Web UI)
│   ├── README.md
│   ├── FIELD_README.md
│   └── start_gcs.bat
└── log_analyzer/
    ├── analyze_log.py    ← ArduPilot BIN 日志 CLI 分析
    ├── web_analyzer.py   ← Flask Web UI 版
    └── README.md

.github/workflows/
├── build-gcs.yml         ← 编 msk_gcs.exe + mavproxy.exe
└── build-analyzer.yml    ← 编 analyze_log.exe + web_analyzer.exe
```

## 发布产物

每次 push 触发 workflow, Actions 页面下可下载 zip artifact:

- `msk_gcs-windows.zip`: `msk_gcs.exe` + `mavproxy.exe` (独立运行, 无 Python 依赖)
- `msk_gcs-linux.tar.gz`: Linux x86_64 版
- `analyze_log-windows`: 日志分析器
- `analyze_log_web-windows`: Flask Web 版

## 同步流程

当 MantaShark 私有仓库的 `tools/ground_station/msk_gcs.py` 或 `tools/log_analyzer/*.py` 有更新时, 手动同步到此仓库:

```bash
# 从私有仓库 → 本仓库
cd /path/to/mantashark-tools
cp /path/to/MantaShark/tools/ground_station/msk_gcs.py tools/ground_station/
cp /path/to/MantaShark/tools/log_analyzer/*.py tools/log_analyzer/
git add -A
git commit -m "sync from MantaShark main: <commit-id>"
git push
# CI 自动编, 4-5 分钟后 artifact 可下载
```

## 使用 exe

Windows:
1. 下载 `msk_gcs-windows.zip`, 解压
2. 双击 `msk_gcs.exe` (如需扫描串口交互式) 或用 cmd:
   ```
   msk_gcs.exe --master=COM3 --baudrate=115200
   ```
3. 浏览器打开 `http://localhost:9088`

Linux:
```bash
tar xzf msk_gcs-linux.tar.gz
./msk_gcs --master=/dev/ttyUSB0 --baudrate=57600
```

## License

随 MantaShark 主项目, 内部使用。
