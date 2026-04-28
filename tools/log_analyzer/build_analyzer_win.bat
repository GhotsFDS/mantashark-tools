@echo off
REM ============================================================
REM   MantaShark 日志分析器 - Windows 打包脚本
REM
REM   前置条件:
REM     1. 安装 Python 3.10+ (https://python.org，勾选 Add to PATH)
REM     2. 双击运行本脚本
REM
REM   输出: dist\analyze_log.exe
REM ============================================================

cd /d "%~dp0"

echo.
echo [1/4] 检查 Python...
python --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Python 未安装或未加入 PATH
    echo 请从 https://python.org 下载安装，安装时勾选 "Add Python to PATH"
    pause
    exit /b 1
)
python --version

echo.
echo [2/4] 安装依赖（pymavlink + matplotlib + pyinstaller）...
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple/ pymavlink matplotlib pyinstaller
if %ERRORLEVEL% NEQ 0 (
    echo 镜像源失败，尝试官方源...
    pip install pymavlink matplotlib pyinstaller
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: 依赖安装失败
        pause
        exit /b 1
    )
)

echo.
echo [3/4] 清理旧 build...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist analyze_log.spec del analyze_log.spec

echo.
echo [4/4] PyInstaller 打包...
pyinstaller --onefile ^
    --name analyze_log ^
    --hidden-import pymavlink.dialects.v20.ardupilotmega ^
    --hidden-import pymavlink.DFReader ^
    --collect-submodules pymavlink ^
    --noconfirm ^
    analyze_log.py

if not exist dist\analyze_log.exe (
    echo ERROR: 打包失败
    pause
    exit /b 1
)

echo.
echo ─────────────────────────────────────────
echo  打包完成: dist\analyze_log.exe
echo  用法: analyze_log.exe ^<log.BIN^> [--plot] [--csv]
echo ─────────────────────────────────────────
echo.
pause
