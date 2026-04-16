# MantaShark GCS — 外场快速上手

零 Python 环境、零 pip 依赖，双击 exe 就能用。

## 📦 zip 里有什么

```
msk_gcs-windows.zip
├── msk_gcs.exe        （36 MB，地面站主程序）
├── mavproxy.exe       （64 MB，数传桥接，和 Mission Planner 共存时用）
├── README.md          （开发说明）
└── FIELD_README.md    （本文件）
```

## 🚀 最快上手（3 步）

1. **解压 zip 到任意目录**（两个 exe 必须放一起）
2. **接好飞控或数传**（USB / COM 口）
3. **双击 `msk_gcs.exe`**，它会列出所有 COM 口让你选

启动后终端会显示：
```
┌────────────────────────────────────────┐
│  MantaShark GCS → http://localhost:9088│
│  MAVLink: COM3                         │
└────────────────────────────────────────┘
```

打开浏览器访问 **http://localhost:9088**（Edge / Chrome 都行）

## 🔌 驱动问题

| 如果遇到 | 怎么办 |
|---|---|
| 飞控插上没 COM 口 | Windows 10/11 应该自动装。点 **设备管理器** 找 "Unknown device"，右键更新驱动 |
| 数传电台（带 Silicon Labs 字样）无法识别 | 装 [CP210x USB→UART 驱动](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers) |
| FTDI 数传无法识别 | 装 [FTDI VCP 驱动](https://ftdichip.com/drivers/vcp-drivers/) |

## 🎯 命令行用法（可选）

```cmd
rem 交互扫描
msk_gcs.exe

rem 直连飞控 USB
msk_gcs.exe --master=COM3 --baudrate=115200

rem 直连数传（一般 57600）
msk_gcs.exe --master=COM5 --baudrate=57600

rem 连到已跑的 MAVProxy / Mission Planner 转发端口
msk_gcs.exe --master=udpin:0.0.0.0:14551

rem 换端口
msk_gcs.exe --port=8080
```

## 🛫 和 Mission Planner 并行

如果想同时用 MP 和 GCS（推荐）：

1. 启动 `msk_gcs.exe`（交互模式），选飞控，它自动拉起 `mavproxy.exe` 做分发
2. Mission Planner 连 **`udp:127.0.0.1:14550`**（终端会显示具体端口）

`mavproxy.exe` 必须和 `msk_gcs.exe` 在同一目录。

## 🧰 调参工具

浏览器打开 **http://localhost:9088/tuner** 直接调所有 `MSK_*` 参数：
- 写入飞控实时生效
- 自动刷新（2 秒拉一次）
- **倾转舵校准**：4 个绿按钮一键测 0°/15°/30°/退出

## 🛑 关闭

终端按 `Ctrl+C`，或直接关终端窗口。MAVProxy 子进程会被自动终止。

## ❓ 排错

### `[MAV] ERROR: could not open port COMxxx`
- 确认 Mission Planner / uCenter / 其他程序没占用这个 COM 口
- 用设备管理器确认 COM 口号

### `[!] 端口 9088 被占`
- 加 `--port=8089` 换个端口

### 打开 http://localhost:9088 没反应
- 看终端有没有报错
- 防火墙弹窗勾"允许访问"
- 浏览器开 `http://127.0.0.1:9088`（不是 localhost）
