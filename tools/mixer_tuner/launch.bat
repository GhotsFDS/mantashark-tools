@echo off
chcp 65001 >nul 2>&1
title MantaShark Mixer Tuner
setlocal

cd /d "%~dp0"

echo [launcher] MantaShark Mixer Tuner 启动中...
echo.

REM ── 找 Python ──
set "PY="
if exist "..\..\sim\.venv\Scripts\python.exe" (
    set "PY=..\..\sim\.venv\Scripts\python.exe"
    echo [launcher] 使用 venv: ..\..\sim\.venv
) else (
    where python >nul 2>&1
    if errorlevel 1 (
        echo [launcher] ✗ 未找到 Python. 装 Python 3.8+ 加入 PATH 后重试.
        goto :pause_end
    )
    set "PY=python"
    echo [launcher] 使用系统 Python
)

REM ── 依赖自检 ──
%PY% -c "import pymavlink, websockets, serial" >nul 2>&1
if errorlevel 1 (
    echo [launcher] ✗ 缺 pymavlink / websockets / pyserial
    echo     %PY% -m pip install pymavlink websockets^<13 pyserial
    goto :pause_end
)

REM ── HTML 检查 ──
if not exist "dist\index.html" (
    echo [launcher] dist\index.html 不存在.
    where npm >nul 2>&1
    if errorlevel 1 (
        echo     缺 npm 无法自动构建. 用单文件版: ..\MantaSharkTuner.html
        goto :pause_end
    )
    echo [launcher] npm install ^&^& npm run build...
    call npm install >nul 2>&1
    call npm run build
    if errorlevel 1 (
        echo [launcher] ✗ 构建失败
        goto :pause_end
    )
)

REM ── 端口占用检查 (8765) ──
netstat -ano | findstr ":8765 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [launcher] ⚠ 端口 8765 已被占用 ^(mavbridge 已在跑?^)
    echo     任务管理器关掉 python 后重试.
    goto :pause_end
)

REM ── 浏览器开 HTML ──
set "URL=file:///%CD:\=/%/dist/index.html"
echo [launcher] 浏览器打开: %URL%
start "" "%URL%"

echo.
echo ═════ 启动 mavbridge.py ─ 选串口和波特率 ═════
%PY% -u mavbridge.py
set "BRIDGE_RC=%errorlevel%"

:pause_end
echo.
echo ════════════════════════════════════════
if defined BRIDGE_RC (
    echo [launcher] mavbridge 退出码 %BRIDGE_RC%
) else (
    echo [launcher] 已退出
)
echo ════════════════════════════════════════
pause
endlocal
