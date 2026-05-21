#!/usr/bin/env python3
"""
配置 AP_Periph CAN 节点参数 (从 .param 文件读, 支持任意节点 ID).

用法:
  # 配 node 51 (5 路 tilt)
  python3 tools/can/configure_node.py --node 51 --params scripts/node51.param

  # 配 node 52 (2 路 tilt)
  python3 tools/can/configure_node.py --node 52 --params scripts/node52.param

  # 串口 / 波特率自定义
  python3 tools/can/configure_node.py --device /dev/ttyACM0 --baud 115200 \\
      --node 51 --params scripts/node51.param

  # 不保存到 EEPROM (只测试)
  python3 tools/can/configure_node.py --node 51 --params scripts/node51.param --no-save

做的事:
  1. 用 mavcan 桥连飞控 (CAN_SLCAN_CPORT=0 时走 MAVLink TUNNEL CAN_FRAME)
  2. 读 .param 文件, 跳过注释和空行
  3. 对每个参数发 GetSet 请求, 校验返回值
  4. 调 ExecuteOpcode SAVE 落盘 EEPROM
  5. 等节点 flash 写完, 提示用户断电重启

.param 格式 (与 ArduPilot Mission Planner 兼容):
  PARAM_NAME,VALUE       # 逗号分隔
  PARAM_NAME VALUE       # 空格分隔 (也支持)
  # 行首 # 是注释

整数与浮点均支持. 节点参数类型由节点固件决定 (ESC_RATE 是 int, OUT1_MIN 是 int, 但
如果遇到 float 参数, 修改 set_param() 用 real_value).

前提: 飞控接 USB (默认 /dev/ttyACM0), 已刷我们的 fork 固件 (k_rcin17..32 扩展).
"""
import argparse
import os
import re
import sys
import time

try:
    import dronecan
except ImportError:
    print("ERROR: dronecan 库未装. pip install dronecan", file=sys.stderr)
    sys.exit(2)


def parse_param_file(path):
    """解析 .param 文件, 返回 [(name, value)] 列表. value 自动转 int/float."""
    out = []
    with open(path, 'r', encoding='utf-8') as f:
        for lineno, raw in enumerate(f, 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            # 去掉行内 # 注释
            line = re.split(r'\s*#', line, 1)[0].strip()
            if not line:
                continue
            # 逗号或空格分隔
            parts = re.split(r'[,\s]+', line, 1)
            if len(parts) != 2:
                print(f"WARN: {path}:{lineno} 跳过非法行: {raw.rstrip()}", file=sys.stderr)
                continue
            name, val_str = parts[0].strip(), parts[1].strip()
            # 自动 int / float
            try:
                val = int(val_str)
            except ValueError:
                try:
                    val = float(val_str)
                except ValueError:
                    print(f"WARN: {path}:{lineno} 值非数字: {val_str}", file=sys.stderr)
                    continue
            out.append((name, val))
    return out


def set_param(node, target_node_id, name, value):
    """通过 DroneCAN GetSet 写一个参数到节点, 返回 (ok, got_value)."""
    param = dronecan.uavcan.protocol.param
    val = param.Value()
    if isinstance(value, float):
        val.real_value = float(value)
    else:
        val.integer_value = int(value)

    req = param.GetSet.Request(
        index=0,
        name=name.encode(),
        value=val,
    )
    result = {"done": False, "ok": False, "got": None}

    def cb(event):
        if not event:
            result["done"] = True
            return
        resp = event.response
        if hasattr(resp.value, 'real_value') and resp.value.real_value != 0:
            result["got"] = resp.value.real_value
        elif hasattr(resp.value, 'integer_value'):
            result["got"] = resp.value.integer_value
        result["ok"] = True
        result["done"] = True

    node.request(req, target_node_id, cb, timeout=2)
    t0 = time.time()
    while not result["done"] and time.time() - t0 < 3:
        node.spin(0.05)

    got = result["got"]
    # 比较时容忍 int vs float (1 vs 1.0)
    same = ok = result["ok"]
    if ok and got is not None:
        try:
            same = abs(float(got) - float(value)) < 1e-6
        except (TypeError, ValueError):
            same = False
    return same, got


def save_node(node, target_node_id):
    """OPCODE_SAVE = 0 落盘. 不主动重启 (避免打断 flash)."""
    param = dronecan.uavcan.protocol.param
    req = param.ExecuteOpcode.Request(opcode=param.ExecuteOpcode.Request().OPCODE_SAVE)
    done = [False]
    ok = [False]

    def cb(event):
        if event and event.response:
            ok[0] = bool(event.response.ok)
        done[0] = True

    node.request(req, target_node_id, cb, timeout=5)
    t0 = time.time()
    while not done[0] and time.time() - t0 < 6:
        node.spin(0.05)
    return ok[0]


def main():
    ap = argparse.ArgumentParser(description="AP_Periph CAN 节点参数配置 (双节点支持)")
    ap.add_argument("--device", default="/dev/ttyACM0", help="飞控串口 (USB/数传)")
    ap.add_argument("--baud", type=int, default=115200, help="串口波特率")
    ap.add_argument("--node", type=int, required=True, help="目标节点 ID (实机一般 51 或 52)")
    ap.add_argument("--params", required=True, help=".param 文件路径")
    ap.add_argument("--no-save", action="store_true", help="只写不保存 (测试用)")
    ap.add_argument("--bridge-node-id", type=int, default=127,
                    help="本机 mavcan 桥的 DroneCAN node ID (避开飞控 10 + 节点们)")
    args = ap.parse_args()

    if not os.path.isfile(args.params):
        print(f"ERROR: 参数文件不存在: {args.params}", file=sys.stderr)
        sys.exit(1)

    targets = parse_param_file(args.params)
    print(f"读取 {args.params}: {len(targets)} 个参数")

    # 跳过节点配置参数 (CAN_NODE 等), 这些通常在节点 boot 时已设, 改了反而会断开连接
    # 用户如要改 CAN_NODE / CAN_BAUDRATE, 用 dronecan-gui-tool 手动改
    SKIP = {'CAN_NODE', 'CAN_BAUDRATE', 'BRD_SERIAL_NUM', 'FLASH_BOOTLOADER'}
    filtered = [(n, v) for (n, v) in targets if n not in SKIP]
    skipped = [n for (n, _) in targets if n in SKIP]
    if skipped:
        print(f"  跳过 {len(skipped)} 个节点级参数 (用 dronecan-gui-tool 改): {skipped}")

    print(f"\n连接 {args.device} @ {args.baud} (mavcan 桥)...")
    node = dronecan.make_node(
        f"mavcan:{args.device}",
        bitrate=1000000, node_id=args.bridge_node_id, mtu=8,
        baudrate=args.baud,
    )
    # 给桥点时间稳定
    t0 = time.time()
    while time.time() - t0 < 2:
        node.spin(0.1)

    # 暖机: 先发 1 个无害的 GetSet (读不存在的 dummy 参数), mavcan 桥首次 request 偶发响应丢
    print("\n暖机 mavcan 桥...")
    for _ in range(3):
        set_param(node, args.node, '_warmup_dummy_', 0)
        time.sleep(0.3)

    print(f"\n写入 {len(filtered)} 个参数到节点 {args.node}:")
    failures = []
    for name, target in filtered:
        # 自带 1 次重试 (首次失败常见于 mavcan 桥握手抖动)
        ok, got = set_param(node, args.node, name, target)
        if not ok:
            time.sleep(0.2)
            ok, got = set_param(node, args.node, name, target)
        mark = "OK" if ok else "FAIL"
        got_str = f"{got}" if got is not None else "?"
        print(f"  [{mark}] {name:24s} = {target!r:8s} (节点返回 {got_str})")
        if not ok:
            failures.append(name)

    if args.no_save:
        print("\n--no-save: 跳过 SAVE")
    else:
        print(f"\n落盘到节点 {args.node} EEPROM...")
        save_ok = save_node(node, args.node)
        print(f"  SAVE: {'OK' if save_ok else 'FAIL'}")
        if save_ok:
            print("  等 5 秒落盘...")
            t0 = time.time()
            while time.time() - t0 < 5:
                node.spin(0.1)
            print(f"  请断电重启节点 {args.node} 应用新参数")

    if failures:
        print(f"\n[!] {len(failures)} 个参数写失败: {failures}")
        sys.exit(1)
    print(f"\n✓ 节点 {args.node} 全部写入完成")


if __name__ == "__main__":
    main()
