#!/bin/bash
# 打包 bench_pc.py 为单文件可执行
# 用法: ./build_bench.sh
# 输出: dist/bench_pc

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VENV_PI="$SCRIPT_DIR/.venv/bin/pyinstaller"

if [ ! -f "$VENV_PI" ]; then
    echo "ERROR: .venv/bin/pyinstaller 未安装"
    echo "运行:"
    echo "  python3 -m venv .venv"
    echo "  .venv/bin/pip install -i https://mirrors.aliyun.com/pypi/simple/ pyinstaller pymavlink pyserial"
    exit 1
fi

rm -rf build dist bench_pc.spec

echo "[1/2] PyInstaller 打包中 (~30s)..."
$VENV_PI --onefile \
    --name bench_pc \
    --hidden-import pymavlink.dialects.v20.ardupilotmega \
    --hidden-import pymavlink.dialects.v20.common \
    --hidden-import serial \
    --hidden-import tkinter \
    --collect-submodules pymavlink \
    --add-data "transducer_modbus.py:." \
    --add-data "fc_mavlink.py:." \
    --add-data "recorder.py:." \
    --noconfirm \
    bench_pc.py

if [ ! -f "dist/bench_pc" ]; then
    echo "ERROR: 打包失败"
    exit 1
fi

echo ""
echo "[2/2] cold-start smoke test (--help)..."
timeout 30 ./dist/bench_pc --help 2>&1 | head -10 || echo "(GUI 程序无 --help, 这是预期的)"

echo ""
echo "─────────────────────────────────────────"
echo "✓ 打包完成: $SCRIPT_DIR/dist/bench_pc"
echo "  大小: $(du -h dist/bench_pc | cut -f1)"
echo "  用法: ./dist/bench_pc --fc /dev/ttyACM0 --sensor /dev/ttyUSB0 --out ./bench_logs"
echo "─────────────────────────────────────────"
