@echo off
chcp 65001 >nul 2>&1
title MantaShark GCS

REM Try system Python
where python >nul 2>&1 && (
    python "%~dp0msk_gcs.py" %*
    goto :end
)

REM Try venv Python
if exist "%~dp0..\..\sim\.venv\Scripts\python.exe" (
    "%~dp0..\..\sim\.venv\Scripts\python.exe" "%~dp0msk_gcs.py" %*
    goto :end
)

echo [!] Python not found
echo     Install Python 3.8+ and add to PATH
echo     Or create venv at sim\.venv

:end
pause
