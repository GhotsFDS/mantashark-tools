#!/usr/bin/env python3
"""通过 fc MAVLink CAN tunnel 给 AP_Periph 节点烧 .apj 固件.

用法:
  python3 tools/can/flash_node.py --device /dev/ttyACM0 --node 51 \
      --apj firmware/archive/AP_Periph/MatekL431-DShot-AP_Periph-P7.9.24-clean.apj

流程 (DroneCAN file.BeginFirmwareUpdate protocol):
  1. PC 通过 fc MAVLink CAN tunnel 接 DroneCAN bus (PC node_id=127, fc=10)
  2. dronecan.app.file_server 提供 .apj 内容
  3. PC 发 BeginFirmwareUpdate(image_file_remote_path) 给 node
  4. Node 重启进 bootloader, 通过 file.Read 拉 .apj
  5. PC file_server 回 chunk 直到结束
  6. Node 自动重启跑新 firmware
"""
import argparse, json, base64, zlib, os, time, sys
import dronecan

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--device', default='/dev/ttyACM0')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--node', type=int, required=True, help='Target node ID (51 / 52)')
    ap.add_argument('--apj', required=True, help='.apj 固件路径')
    ap.add_argument('--source-node', type=int, default=127, help='PC 端 node_id (避免跟 fc=10 冲突)')
    ap.add_argument('--timeout', type=int, default=180)
    args = ap.parse_args()

    # 解 .apj → bin
    print(f"[1] 解 .apj: {args.apj}")
    d = json.load(open(args.apj))
    img = zlib.decompress(base64.b64decode(d['image']))
    print(f"    board_id={d['board_id']}  git={d.get('git_identity','?')}  size={len(img)}")

    # 准备 file_server 目录, 路径名 fc 端通过 MAVFTP 不复杂
    fw_dir = '/tmp/dronecan_fw'
    os.makedirs(fw_dir, exist_ok=True)
    fw_basename = f"node{args.node}_fw.bin"
    fw_path = os.path.join(fw_dir, fw_basename)
    open(fw_path, 'wb').write(img)
    print(f"[2] 写临时 bin: {fw_path}")

    # 起 dronecan node (通过 fc MAVLink CAN tunnel)
    print(f"[3] 连 fc {args.device} @ {args.baud} (PC node_id={args.source_node})")
    node = dronecan.make_node(f'mavcan:{args.device}', node_id=args.source_node, baudrate=args.baud,
                               bitrate=1000000, mavlink_target_system=1, mavlink_target_component=1)
    print("    node OK")

    # File server (节点会从这里 pull 文件)
    file_server = dronecan.app.file_server.FileServer(node, [fw_dir])
    print(f"[4] FileServer 起好, 服务 {fw_dir}")

    # 发 BeginFirmwareUpdate
    req = dronecan.uavcan.protocol.file.BeginFirmwareUpdate.Request()
    req.source_node_id = args.source_node
    req.image_file_remote_path.path = fw_basename

    done = {'ok': False, 'error': None}
    def on_begin_response(e):
        if e is None:
            done['error'] = 'BeginFW timeout (节点没回应)'
            return
        resp = e.response
        # ERROR 字段: 0=OK, 其他=fail
        print(f"[5] BeginFW response from node {args.node}: error={resp.error}")
        if resp.error != 0:
            done['error'] = f'BeginFW rejected (error code={resp.error})'
        else:
            done['ok'] = True

    print(f"[5] 发 BeginFirmwareUpdate → node {args.node}")
    node.request(req, args.node, on_begin_response, timeout=5)

    # spin 等待: 1. begin response, 2. 节点 file.Read 拉数据, 3. 节点完成
    print(f"[6] 等节点拉 firmware ({args.timeout}s timeout, 看 'GetInfo / Read' 进度)")
    end = time.time() + args.timeout
    last_print = 0
    while time.time() < end:
        try:
            node.spin(timeout=0.5)
        except Exception as e:
            print(f"spin error: {e}")
        if time.time() - last_print > 5:
            print(f"  [t+{int(time.time()-(end-args.timeout))}s] spinning...")
            last_print = time.time()

    if done['error']:
        print(f"\n✗ FLASH 失败: {done['error']}")
        sys.exit(1)
    if not done['ok']:
        print(f"\n✗ FLASH 失败: 没收到 BeginFW response")
        sys.exit(2)

    print(f"\n✓ FLASH 完成. 节点应该已 reboot 跑新固件")
    print(f"  下一步: tools/can/configure_node.py --node {args.node} --params scripts/node{args.node}.param")

if __name__ == '__main__':
    main()
