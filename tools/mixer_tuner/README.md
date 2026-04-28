# MantaShark Mixer Tuner

MantaShark WIG 飞行器调参/调试 SPA + MAVLink 桥, 对应 `scripts/` 飞控 Lua.

## 功能 (v8.4 状态)

- **K 曲线编辑** — 4 组 (KS/KDF/KT/KRD) × 5 控制点 PCHIP, 拖点调 (V, K)
- **倾转曲线** — 7 路 tilt × 5 PCHIP 控制点 (`TLTC_*`)
- **5 点 trim 曲线** — Q_TRIM_PITCH 速度曲线 (`MSK_TRIM0..4`)
- **7 舵机实时标定** — ZERO/DIR/LMIN/LMAX 拖滑杆即推 FC 生效
- **S→DF 耦合 ON/OFF** — `TLT_CPL_EN` toggle + `TLT_CPL_SDF_K` 实时调
- **12 EDF 布局** — 实时推力% 可视化 + 动态几何分析
- **GCS 标签页** — RC 12 路 + SERVO 输出 + 电池 + 模式/档位/Auto/RTL chips + STATUSTEXT (UTF-8)
- **4 阶段预检** — 模拟 + 实机触发
- **导入/导出 .parm** — ArduPilot 兼容格式
- **拉取/推送** — 同步飞控参数 (双向)

## 开发

```bash
cd tools/mixer_tuner
npm install
npm run dev    # http://localhost:5173 热重载
```

## 打包

```bash
npm run build  # dist/index.html 单文件 (内联 JS/CSS)
```

CI 在 `mantashark-tools` 公开仓自动构建 Win/Linux 二进制 release。

## 启动 (用户)

```bash
cd tools/mixer_tuner && ./launch.sh
# 自动起 mavbridge.py (ws://127.0.0.1:8765) + 浏览器
```

## 技术栈

- Vite + React 18 + TypeScript
- Zustand (状态 + localStorage 持久化, version 4)
- TailwindCSS
- lucide-react (图标)
- vite-plugin-singlefile (单 HTML 产物)

## 与 Lua 代码对齐 (v8.4 参数表)

| Tuner 模块 | Lua 文件 | 参数前缀 (key) |
|---|---|---|
| K 曲线 + 速度断点 + 模式开关 + trim 曲线 | `scripts/modules/mixer.lua` + `scripts/main.lua` | `MSK_` (81), ~37 个 |
| 舵机标定 (ZERO/DIR/LMIN/LMAX) + 耦合 | `scripts/modules/tilt_driver.lua` | `TLT_` (82), ~32 个 |
| 几何系数 (12 motor × P/R/Y) | `scripts/modules/mixer.lua` | `MGEO_` (83), 36 个 |
| 姿态 guard (TRIM_RATE / PIT_WARN / ROL_WARN) | `scripts/modules/guard.lua` | `GRD_` (84), 3 个 |
| 预检 + 实时角度预览 | `scripts/modules/preflight.lua` | `PRE_` (85), 12 个 |
| 倾转 PCHIP 曲线 (7 × 5) | `scripts/main.lua` | `TLTC_` (86), 35 个 |

PCHIP 实现 (`src/lib/pchip.ts`) 和 Lua 侧 (`scripts/modules/mixer.lua:interp5`) 数值一致, 与 scipy.interpolate.PchipInterpolator 误差 ≤1e-4。

## v9 重构方向 (待做)

- 删 PCHIP 编辑器 (K + tilt 都改 2 档静态值表)
- defaults.ts 删 ~70 PCHIP 参数, 加 ~24 静态档位参数
- FlightProfile tab 重写为 2 档参数表
- mavbridge 加 TECS target_airspeed 显示

详见 `docs/PROGRESS.md`。

## 文件树 (核心)

```
mixer_tuner/
├── src/
│   ├── App.tsx                  顶层 (tabs + status bar + toast)
│   ├── components/
│   │   ├── tabs/                FlightProfile / Tilts / Geometry / Preflight / Gcs / Params
│   │   └── common/              TiltPanel / CurveEditor / ScaledCanvas
│   ├── lib/                     gcs.ts / pchip.ts / actuators.ts / defaults.ts / types.ts
│   └── store/useStore.ts        Zustand persist (version 4)
├── mavbridge.py                 MAVLink ↔ WebSocket 桥 (Python pymavlink + websockets)
├── launch.sh / launch.bat       一键启动 (mavbridge + 浏览器)
├── package.json + vite.config   构建配置
└── dist/index.html              单文件 build 产物 (build 后)
```
