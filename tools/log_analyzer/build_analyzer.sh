#!/bin/bash
#
# 打包 analyze_log.py 为单文件可执行
#
# 用法: ./build_analyzer.sh
# 输出: dist/analyze_log
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VENV_PY="$SCRIPT_DIR/.venv/bin/python3"
PYINSTALLER="$SCRIPT_DIR/.venv/bin/pyinstaller"

if [ ! -f "$PYINSTALLER" ]; then
    echo "ERROR: PyInstaller 未安装"
    echo "运行: .venv/bin/pip install pyinstaller matplotlib"
    exit 1
fi

# 清理旧 build
rm -rf build dist analyze_log.spec

echo "[1/2] PyInstaller 打包中..."
$PYINSTALLER --onefile \
    --name analyze_log \
    --hidden-import pymavlink.dialects.v20.ardupilotmega \
    --hidden-import pymavlink.DFReader \
    --collect-submodules pymavlink \
    --noconfirm \
    analyze_log.py

if [ ! -f "dist/analyze_log" ]; then
    echo "ERROR: 打包失败"
    exit 1
fi

echo ""
echo "[2/2] 测试可执行文件..."
./dist/analyze_log /home/fusha/MantaShark/LOGS/00000036.BIN 2>&1 | tail -15

echo ""
echo "─────────────────────────────────────────"
echo "✓ 打包完成: $SCRIPT_DIR/dist/analyze_log"
echo "  大小: $(du -h dist/analyze_log | cut -f1)"
echo "  用法: ./dist/analyze_log <log.BIN> [--plot] [--csv]"
echo "─────────────────────────────────────────"
