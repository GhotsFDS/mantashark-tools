# MantaShark Mixer Tuner v9

MantaShark 水上地效飞行器 (WIG) 的调参/调试 SPA, 对应 `scripts-plane/` v8 Lua 混控.

## 功能

- **PCHIP 曲线编辑** — 4 条 K 曲线 (KS/KDF/KT/KRD), 拖点调 (V, K), 和 Lua/scipy 数值一致
- **7 舵机标定** — 每舵 ZERO (0° PWM) + DIR (±1) + ±30° 实时预览 + 全局统一 PWM/°
- **12 EDF 布局** — 实时推力%可视化 (圆圈大小)
- **动态几何分析** — RDL/RDR tilt 角变化时 pitch/yaw 系数自动插值
- **S→DF 耦合** — 滑杆调 `TLT_CPL_SDF_K`, 实时看 DFL/DFR 补偿后最终角 + 饱和告警
- **Phase 状态机** — 滞回阈值实时显示, PHASE_CONFIG (5 phase × 7 tilt + trim) 表格编辑
- **力平衡** — 总推力 vs 机重 98N, T/W ratio, thrust∝throttle^1.5 非线性曲线
- **4 阶段预检模拟** — 播放 Stage 1-4, 参数可调
- **导入/导出 .parm** — ArduPilot GCS 兼容格式 + phase_config.lua 片段

## 开发

```bash
cd tools/mixer_tuner
npm install
npm run dev        # http://localhost:5173, 热重载
```

## 打包

```bash
npm run build      # 产出 dist/index.html, 单文件可离线使用
```

输出 `dist/index.html` 内联所有 JS/CSS, 无需服务器, 直接拖进浏览器即可.

## 栈

- Vite + React 18 + TypeScript
- Zustand (状态 + localStorage 持久化)
- TailwindCSS (样式)
- lucide-react (图标)
- vite-plugin-singlefile (单 HTML 产物)
- Canvas 手绘 PCHIP 曲线 + 12 电机布局

## 与 Lua 代码对齐

| Tuner | Lua 文件 | 参数前缀 |
|---|---|---|
| K 曲线 | `scripts-plane/mixer.lua` | `MSK_` (25 K + 4 V) |
| 舵机 | `scripts-plane/tilt_driver.lua` | `TLT_` (7 ZERO + 7 DIR + PWM_PER_DEG + CPL_SDF_K) |
| Phase | `scripts-plane/phases.lua` | 无 (Lua 硬编码, 本工具导 lua 片段替换) |
| 姿态 guard | `scripts-plane/guard.lua` | `GRD_` (TRIM_RATE, PIT_WARN, ROL_WARN) |
| 预检 | `scripts-plane/preflight.lua` | `PRE_` (CH/PWM/STOP/GRP_MS/TILT_MAX) |

PCHIP 实现 (`src/lib/pchip.ts`) 和 Lua 侧 (`scripts-plane/mixer.lua:interp5`) 以及
scipy.interpolate.PchipInterpolator 数值完全一致 (误差 ≤1e-4 浮点级).
