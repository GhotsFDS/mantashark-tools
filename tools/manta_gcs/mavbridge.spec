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
    # 台架 bench 后端 (已收进 manta_gcs 本目录, 地面站自包含, 不再依赖 motor_test).
    'bus485',
    'transducer_modbus',
    'current_meter_modbus',
    'profiles',
    'sign_check',
]

# PyInstaller 跑 spec 时 cwd 是 spec 文件所在目录. pathex=['.'] 让它能解析
# 同目录所有本地 .py (log_analysis/rtk/bench/bus485/profiles/sign_check/*modbus).
a = Analysis(
    ['mavbridge.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        # 关键: 直接把 .py 当 data 嵌入 EXE bundle (运行时在 sys._MEIPASS).
        # 比 hiddenimports 可靠 — PyInstaller 6.x 对顶层非包模块 hiddenimport
        # 有时静默跳过 (build log 看不到 'Analyzing hidden import log_analysis').
        # mavbridge.py 启动时把 sys._MEIPASS 加进 sys.path 让 import 能找到.
        ('log_analysis.py', '.'),
        ('rtk.py', '.'),
        # 台架 bench 后端 (本目录, 地面站自包含)
        ('bus485.py', '.'),
        ('transducer_modbus.py', '.'),
        ('current_meter_modbus.py', '.'),
        ('profiles.py', '.'),
        ('sign_check.py', '.'),
    ],
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
