# -*- mode: python ; coding: utf-8 -*-
# PyInstaller onefile spec for mavbridge.py.
# 用法: pyinstaller mavbridge.spec
# 产物: dist/mavbridge.exe (Windows) 或 dist/mavbridge (Linux/Mac)

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = []
hiddenimports += collect_submodules('pymavlink')
hiddenimports += collect_submodules('serial')
hiddenimports += ['websockets', 'websockets.legacy', 'websockets.legacy.server']

a = Analysis(
    ['mavbridge.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # MAVProxy / wxPython / GUI 框架不需要
    excludes=['tkinter', 'matplotlib', 'numpy.tests', 'wx', 'PyQt5', 'PySide2'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='mavbridge',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,                # 必须有控制台 (用户交互选串口)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
