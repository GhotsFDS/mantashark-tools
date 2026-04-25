@echo off
REM 本地构建 Windows 发布包. 跑前装好 Python 3.11+ + Node.js.
REM 产物: tools/mixer_tuner/release/MantaSharkTuner-windows.zip
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0"
echo [build] 工作目录: %CD%

REM ── 1. 装 Python 依赖 ──
echo.
echo [build] 装 Python 依赖 (pymavlink + websockets + pyserial + pyinstaller)...
python -m pip install --upgrade pip || goto :fail
python -m pip install pymavlink "websockets<13" pyserial pyinstaller || goto :fail

REM ── 2. 构建 Tuner HTML ──
echo.
echo [build] 构建 React Tuner...
where npm >nul 2>&1
if errorlevel 1 (
    echo [build] ✗ 未装 npm. 装 Node.js 后重试.
    goto :fail
)
call npm install || goto :fail
call npm run build || goto :fail

REM ── 3. PyInstaller 打 mavbridge.exe ──
echo.
echo [build] PyInstaller 打 mavbridge.exe...
if exist build rmdir /s /q build
if exist dist\mavbridge.exe del /q dist\mavbridge.exe
pyinstaller --clean --noconfirm mavbridge.spec || goto :fail

REM ── 4. 组装发布包 ──
echo.
echo [build] 组装 release/MantaSharkTuner-windows/ ...
if exist release rmdir /s /q release
mkdir release\MantaSharkTuner-windows
copy /y dist\mavbridge.exe       release\MantaSharkTuner-windows\
copy /y dist\index.html          release\MantaSharkTuner-windows\Tuner.html
copy /y launch.bat               release\MantaSharkTuner-windows\
(
    echo @echo off
    echo chcp 65001 ^>nul 2^>^&1
    echo title MantaShark Mixer Tuner
    echo cd /d "%%~dp0"
    echo echo [launcher] 浏览器打开 Tuner.html
    echo start "" "%%CD%%\Tuner.html"
    echo echo.
    echo echo ═════ 启动 mavbridge.exe ─ 选串口和波特率 ═════
    echo mavbridge.exe
    echo echo.
    echo pause
) > release\MantaSharkTuner-windows\start.bat

(
    echo MantaShark Mixer Tuner v9 — Windows 单文件发布包
    echo.
    echo 使用:
    echo   双击 start.bat
    echo     ^|-^> 浏览器打开 Tuner.html
    echo     ^|-^> 终端启 mavbridge.exe (选 COM 口 + 波特率)
    echo.
    echo 文件:
    echo   start.bat       一键启动器
    echo   mavbridge.exe   MAVLink-^>WebSocket 桥 (含 Python 运行时)
    echo   Tuner.html      调参 UI 单文件 (含全部 JS/CSS)
    echo.
    echo 不需要装 Python 或 Node, 解压即用.
    echo.
    echo 串口权限 ^(Linux^): sudo usermod -aG dialout $USER 后重登录.
) > release\MantaSharkTuner-windows\README.txt

REM ── 5. 打 zip ──
echo.
echo [build] 打 zip...
powershell -NoProfile -Command "Compress-Archive -Path 'release\MantaSharkTuner-windows\*' -DestinationPath 'release\MantaSharkTuner-windows.zip' -Force" || goto :fail

echo.
echo ════════════════════════════════════════
echo [build] ✓ 完成
echo     release\MantaSharkTuner-windows\       目录版
echo     release\MantaSharkTuner-windows.zip    分发版
echo ════════════════════════════════════════
goto :end

:fail
echo.
echo ════════════════════════════════════════
echo [build] ✗ 构建失败
echo ════════════════════════════════════════
exit /b 1

:end
endlocal
