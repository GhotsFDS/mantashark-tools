# -*- mode: python ; coding: utf-8 -*-
# PyInstaller onefile spec for mavbridge.py.
# 用法: pyinstaller mavbridge.spec
# 产物: dist/mavbridge.exe (Windows) 或 dist/mavbridge (Linux/Mac)

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = []
hiddenimports += collect_submodules('pymavlink')
hiddenimports += collect_submodules('serial')
# 显式补 PyInstaller 偶尔漏的: pyserial 平台后端 + websockets 异步路径
hiddenimports += [
    'serial.tools.list_ports',
    'serial.tools.list_ports_common',
    'serial.tools.list_ports_windows',
    'serial.tools.list_ports_posix',
    'serial.tools.list_ports_linux',
    'serial.tools.list_ports_osx',
    'websockets',
    'websockets.legacy',
    'websockets.legacy.server',
    'websockets.legacy.protocol',
    'websockets.asyncio',
    'websockets.asyncio.server',
    'pymavlink.dialects.v20.ardupilotmega',
    'pymavlink.dialects.v20.all',
    'pkg_resources',
    # 同目录本地模块 (PyInstaller 不会自动打包 import xxx 语法的本地 .py)
    'log_analysis',
    'rtk',
]

# PyInstaller 跑 spec 时 cwd 是 spec 文件所在目录. 但 Analysis 默认不
# 把这个目录加进 module 搜索路径. 必须用 pathex=['.'] 显式给, hiddenimports
# 里的 log_analysis/rtk 才能解析到同目录 .py.
a = Analysis(
    ['mavbridge.py'],
    pathex=['.'],   # 让 PyInstaller 在 spec 目录找本地 .py (log_analysis, rtk)
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
