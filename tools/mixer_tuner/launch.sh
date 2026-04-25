#!/usr/bin/env bash
# MantaShark Mixer Tuner 一键启动器 (Linux/Mac).
# - 启动 mavbridge.py — 交互式让用户选串口和波特率
# - 浏览器打开 dist/index.html
# - 失败/退出都暂停 + 等回车, 不闪退

cd "$(dirname "$(readlink -f "$0")")"

pause_exit() {
    local code=$?
    echo
    echo "════════════════════════════════════════"
    if [ $code -ne 0 ]; then
        echo "[launcher] ✗ 退出码 $code"
    else
        echo "[launcher] 已退出"
    fi
    echo "════════════════════════════════════════"
    read -r -p "按回车关闭终端..."
    exit $code
}
trap pause_exit EXIT

cleanup() {
    if [ -n "${BRIDGE_PID:-}" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
        echo "[launcher] 清理桥 PID=$BRIDGE_PID"
        kill "$BRIDGE_PID" 2>/dev/null || true
        wait "$BRIDGE_PID" 2>/dev/null || true
    fi
}
trap cleanup INT TERM

# venv 路径 (脚本位置相对)
VENV="$(cd ../../sim/.venv 2>/dev/null && pwd || true)"
PY="python3"
if [ -x "$VENV/bin/python3" ]; then
    PY="$VENV/bin/python3"
    echo "[launcher] 使用 venv: $VENV"
else
    echo "[launcher] ⚠ 未找到 sim/.venv, 用系统 python3 (需 pymavlink + websockets + pyserial)"
fi

# 依赖自检
if ! "$PY" -c "import pymavlink, websockets, serial" 2>/dev/null; then
    echo "[launcher] ✗ 缺 pymavlink / websockets / pyserial"
    echo "    pip install pymavlink \"websockets<13\" pyserial"
    exit 1
fi

HTML="dist/index.html"
if [ ! -f "$HTML" ]; then
    echo "[launcher] $HTML 不存在, 构建中..."
    if command -v npm >/dev/null; then
        npm install >/dev/null 2>&1
        npm run build || { echo "[launcher] ✗ npm run build 失败"; exit 1; }
    else
        echo "[launcher] ✗ 未装 npm. 装 node 后再试."
        exit 1
    fi
fi

# 端口占用检查
if ss -ltn 2>/dev/null | grep -q ':8765 '; then
    echo "[launcher] ⚠ 端口 8765 已被占用 (mavbridge 已在跑?)"
    echo "    pkill -f mavbridge.py   关掉后重试"
    exit 1
fi

# 浏览器先开 (mavbridge 起来后 Tuner 自动连)
URL="file://$(pwd)/$HTML"
echo "[launcher] 打开 $URL"
if command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1 &
elif command -v firefox  >/dev/null; then firefox "$URL" >/dev/null 2>&1 &
elif command -v google-chrome >/dev/null; then google-chrome "$URL" >/dev/null 2>&1 &
elif command -v chromium >/dev/null; then chromium "$URL" >/dev/null 2>&1 &
else echo "[launcher] ⚠ 未找到浏览器, 手动打开: $URL"
fi

# 启动 MAVLink 桥 (前台, 交互式选串口)
echo
echo "═════ 启动 mavbridge.py ─ 选串口和波特率 ═════"

# 检测 dialout 组. 用户在组里但当前 shell 没刷新 (没重登录) → 串口报 Permission denied.
# 自动用 sg dialout 包一层让子进程拿到组身份.
NEED_SG=0
if id -nG | grep -qw dialout; then
    : # 当前进程已有 dialout
else
    if id -nG "$USER" 2>/dev/null | grep -qw dialout; then
        echo "[launcher] ℹ 当前 shell 没继承 dialout 组 (用户在组里但需重新登录或 newgrp)."
        echo "[launcher]   自动用 sg dialout 包装启动."
        NEED_SG=1
    else
        echo "[launcher] ⚠ 用户 $USER 不在 dialout 组. 串口可能拒绝访问:"
        echo "    sudo usermod -aG dialout $USER"
        echo "    然后重启或 newgrp dialout"
    fi
fi

if [ "$NEED_SG" = "1" ] && command -v sg >/dev/null; then
    sg dialout -c "$PY -u mavbridge.py"
else
    "$PY" -u mavbridge.py
fi
