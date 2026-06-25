#!/usr/bin/env python3
"""
MantaShark hover 变体调参 GUI — 全参数分页 + 实时回显

分页: 舵机校准 / 气垫 / 交接·前推 / 水翼姿态 / 高度PID
端口下拉自动识别飞控 (ArduPilot VID), 滑块实时改参舵机立即动, 底部常驻 SERVO/测距回显。
前置: 飞控 disarmed (机械校准全程不解锁), 舵机通电。

用法: python3 foil_cal_gui.py [--device /dev/ttyACM0] [--baud 115200]
"""
import argparse, threading, time
import tkinter as tk
from tkinter import ttk
from pymavlink import mavutil

CORNERS = ['FL', 'FR', 'RL', 'RR']

# 自动生成滑块的参数页: (param, 标签, lo, hi, 步进[, 'check'])
TABS = {
    '气垫': [
        ('HOV_BLOW_MAX', '下吹上限', 0, 1, 0.01),
        ('HOV_BLOW_RAMP', '软启动率/s', 0.1, 5, 0.05),
        ('HOV_PITCH_FF', 'K_ff兜底', 0, 1, 0.01),
        ('HOV_PITCH_FFMX', 'K_ff上限(ch12)', 0, 2, 0.01),
        ('HOV_PITCH_VK', '速度耦合增益(前舱∝速度)', 0, 0.2, 0.005),
        ('HOV_PITCH_KP', '俯仰反馈P(补抬头)', 0, 5, 0.05),
        ('HOV_PITCH_TGT', '俯仰目标°', 0, 15, 0.5),
        ('HOV_ROLL_KP', '横滚P', 0, 5, 0.05),
    ],
    '交接·前推': [
        ('HOV_FOIL_VLO', 'α起点速度 m/s', -2, 15, 0.5),
        ('HOV_FOIL_VHI', 'α终点速度 m/s', -2, 20, 0.5),
        ('HOV_FOIL_AUTH', '权限兜底(ch11未接)', 0, 1, 0.05),
        ('HOV_AUTH_SLEW', 'auth变化率/s', 0.1, 5, 0.1),
        ('HOV_YAW_K', '前推yaw权重', 0, 2, 0.05),
        ('HOV_HDG_KP', '航向锁P', 0, 20, 0.5),
    ],
    '水翼姿态': [
        ('HOV_FOIL_PKP', '俯仰P(前后翼差)', 0, 10, 0.1),
        ('HOV_FOIL_PKD', '俯仰D(阻尼,全浸式关键)', 0, 10, 0.1),
        ('HOV_FOIL_RKP', '横滚P(左右翼差)', 0, 10, 0.1),
        ('HOV_FOIL_RKD', '横滚D', 0, 10, 0.1),
        ('HOV_FOIL_PTGT', '俯仰目标°', 0, 15, 0.5),
    ],
    '高度PID': [
        ('MSAK_FOIL_EN', 'EN 高度控制器(总开关)', 0, 1, 1, 'check'),
        ('MSAK_FOIL_TRM', 'trim 托重基线', 0, 1, 0.01),
        ('MSAK_FOIL_NEG', '负下限(0=不下压)', -0.5, 0, 0.01),
        ('MSAK_FOIL_TGT', '目标高(0位之上)m', 0, 1, 0.01),
        ('MSAK_FOIL_TLT', '安装基准俯仰°', -20, 20, 0.5),
        ('MSAK_FOIL_TAU', '互补滤波τ s', 0.1, 3, 0.05),
        ('MSAK_FOIL_GATE', 'innovation门限 m', 0, 1, 0.01),
        ('MSAK_FH_P', '高度PID P', 0, 5, 0.05),
        ('MSAK_FH_I', '高度PID I', 0, 5, 0.05),
        ('MSAK_FH_D', '高度PID D', 0, 5, 0.05),
        ('MSAK_FH_IMAX', 'IMAX', 0, 1, 0.01),
    ],
}
# 舵机校准页用的 + 自动页里的 = 全部要读的参数
PARAMS = ([f'HOV_{c}_ZERO' for c in CORNERS] + [f'HOV_{c}_DIR' for c in CORNERS]
          + ['HOV_FOIL_RNG', 'HOV_FOIL_TEST']
          + [s[0] for rows in TABS.values() for s in rows])


class Mav(threading.Thread):
    def __init__(self, device, baud):
        super().__init__(daemon=True)
        self.device, self.baud = device, baud
        self.pending = {}; self.lock = threading.Lock()
        self.params = {}; self.tlm = {'servo': [None]*12, 'rngfnd': None, 'rngfnd_v': None}
        self.connected = False; self.params_loaded = False; self.err = None; self._stop = False

    def set(self, name, val):
        with self.lock:
            self.pending[name] = float(val)

    def stop(self):
        self._stop = True

    def run(self):
        try:
            m = mavutil.mavlink_connection(self.device, baud=self.baud)
            m.wait_heartbeat(timeout=10); self.connected = True
        except Exception as e:
            self.err = str(e); return
        for n in PARAMS:
            m.mav.param_request_read_send(m.target_system, m.target_component, n.encode()[:16], -1)
        for mid, us in [(36, 100000), (173, 200000)]:
            m.mav.command_long_send(m.target_system, m.target_component,
                mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0, mid, us, 0, 0, 0, 0, 0)
        t0 = time.time()
        while not self._stop:
            with self.lock:
                pend = dict(self.pending); self.pending.clear()
            for n, v in pend.items():
                m.mav.param_set_send(m.target_system, m.target_component, n.encode()[:16],
                                     v, mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
                self.params[n] = v
            for _ in range(25):
                try:
                    msg = m.recv_match(blocking=False)
                except Exception:
                    msg = None
                if msg is None:
                    break
                t = msg.get_type()
                if t == 'PARAM_VALUE' and msg.param_id.strip() in PARAMS:
                    self.params[msg.param_id.strip()] = msg.param_value
                elif t == 'SERVO_OUTPUT_RAW':
                    self.tlm['servo'] = [getattr(msg, 'servo%d_raw' % i, None) for i in range(1, 13)]
                elif t == 'RANGEFINDER':
                    self.tlm['rngfnd'] = msg.distance * 1000.0
                    self.tlm['rngfnd_v'] = getattr(msg, 'voltage', 0.0) or 0.0
            if not self.params_loaded and (len(self.params) >= len(PARAMS) or time.time()-t0 > 5):
                self.params_loaded = True
            time.sleep(0.05)


class GUI:
    FC_STRONG = ('1209', 'ardupilot', 'cuav', 'px4', 'pixhawk')

    def __init__(self, root, device, baud):
        self.root = root; self.device, self.baud = device, baud
        self.mav = None; self.populated = False; self.loading = False
        self.vars = {}; self.servo_lbl = {}
        root.title('MantaShark hover 调参')
        self._build()
        root.after(150, self._refresh)
        root.protocol('WM_DELETE_WINDOW', self._on_close)

    # ---- 连接 ----
    def _scan_ports(self, auto_connect=False):
        ports = []
        try:
            from serial.tools import list_ports
            ports = list(list_ports.comports())
        except Exception:
            pass
        items, best = [], None
        for p in ports:
            hwid = (p.hwid or '').lower(); desc = (p.description or '').lower()
            if not ('usb' in hwid or 'acm' in p.device.lower() or (desc and desc != 'n/a')):
                continue
            items.append(p.device)
            blob = '%s %s %s %s' % (p.device.lower(), desc, (getattr(p, 'manufacturer', '') or '').lower(), hwid)
            if best is None and any(k in blob for k in self.FC_STRONG):
                best = p.device
        self.port_cb['values'] = items
        cur = self.dev_var.get().strip()
        if best:
            self.dev_var.set(best)
        elif items and cur not in items:
            self.dev_var.set(items[0])
        if best:
            self.status.config(text='识别%d口→飞控%s(自动连)' % (len(items), best), foreground='blue')
        elif items:
            self.status.config(text='识别%d口,未确认飞控(选口→连接)' % len(items), foreground='orange')
        else:
            self.status.config(text='未发现串口(手填COMx→连接)', foreground='gray')
        if auto_connect and best:
            self._connect()

    def _connect(self):
        if self.mav:
            self.mav.stop()
        self.populated = False
        self.device = self.dev_var.get().strip()
        if not self.device:
            return
        self.mav = Mav(self.device, self.baud); self.mav.start()

    # ---- 构建 ----
    def _build(self):
        pad = dict(padx=4, pady=2)
        cb = ttk.Frame(self.root); cb.pack(fill='x', **pad)
        ttk.Label(cb, text='端口').pack(side='left')
        self.dev_var = tk.StringVar(value=self.device)
        self.port_cb = ttk.Combobox(cb, textvariable=self.dev_var, width=20, values=[])
        self.port_cb.pack(side='left', padx=4)
        ttk.Button(cb, text='刷新', width=5, command=self._scan_ports).pack(side='left')
        ttk.Button(cb, text='连接', width=5, command=self._connect).pack(side='left')
        self.status = ttk.Label(cb, text='未连接', foreground='gray'); self.status.pack(side='left', padx=8)

        nb = ttk.Notebook(self.root); nb.pack(fill='both', expand=True, **pad)
        self._build_servo_tab(nb)
        for title, rows in TABS.items():
            self._build_auto_tab(nb, title, rows)

        # 底部常驻回显
        df = ttk.LabelFrame(self.root, text='实时')
        df.pack(fill='x', **pad)
        self.rngfnd_lbl = ttk.Label(df, text='RNGFND: --- mm', font=('TkFixedFont', 11))
        self.rngfnd_lbl.pack(side='left', padx=8)
        self._scan_ports(auto_connect=True)

    def _build_servo_tab(self, nb):
        pad = dict(padx=4, pady=2)
        f = ttk.Frame(nb); nb.add(f, text='舵机校准')
        ttk.Label(f, text='角  ZERO(us)        DIR  实时PWM').grid(row=0, column=0, columnspan=6, sticky='w', **pad)
        for i, c in enumerate(CORNERS):
            ttk.Label(f, text=c).grid(row=i+1, column=0, **pad)
            zv = tk.DoubleVar(); self.vars[f'HOV_{c}_ZERO'] = zv
            sb = ttk.Spinbox(f, from_=500, to=2500, increment=1, width=6, textvariable=zv)
            sb.grid(row=i+1, column=1, **pad)
            zv.trace_add('write', lambda *a, c=c: self._set(f'HOV_{c}_ZERO', self.vars[f'HOV_{c}_ZERO'].get()))
            bf = ttk.Frame(f); bf.grid(row=i+1, column=2)
            ttk.Button(bf, text='−5', width=3, command=lambda c=c: self._nudge(c, -5)).pack(side='left')
            ttk.Button(bf, text='+5', width=3, command=lambda c=c: self._nudge(c, +5)).pack(side='left')
            dv = tk.StringVar(value='+'); self.vars[f'HOV_{c}_DIR'] = dv
            ttk.Button(f, textvariable=dv, width=3, command=lambda c=c: self._flip_dir(c)).grid(row=i+1, column=3, **pad)
            lbl = ttk.Label(f, text='----', width=6, font=('TkFixedFont', 10)); lbl.grid(row=i+1, column=4, **pad)
            self.servo_lbl[c] = lbl
        # RNG + TEST
        self._add_scale(f, 5, 'HOV_FOIL_RNG', '满偏RNG(us)', 100, 950, 5, span=5)
        self._add_scale(f, 6, 'HOV_FOIL_TEST', '测试偏转(disarmed)', -1, 1, 0.05, span=5)
        bf2 = ttk.Frame(f); bf2.grid(row=7, column=0, columnspan=5, sticky='w', **pad)
        ttk.Button(bf2, text='TEST归0', command=lambda: self._set_var('HOV_FOIL_TEST', 0)).pack(side='left')
        ttk.Button(bf2, text='预览trim', command=self._preview_trim).pack(side='left', padx=4)

    def _build_auto_tab(self, nb, title, rows):
        f = ttk.Frame(nb); nb.add(f, text=title)
        for r, spec in enumerate(rows):
            kind = spec[5] if len(spec) > 5 else 'scale'
            if kind == 'check':
                self._add_check(f, r, spec[0], spec[1])
            else:
                self._add_scale(f, r, spec[0], spec[1], spec[2], spec[3], spec[4])

    def _add_scale(self, parent, r, name, label, lo, hi, res, span=None):
        v = tk.DoubleVar(); self.vars[name] = v
        s = tk.Scale(parent, from_=lo, to=hi, resolution=res, orient='horizontal', length=300,
                     variable=v, label=label, showvalue=1,
                     command=lambda x, n=name: self._set(n, float(x)))
        if span:
            s.grid(row=r, column=0, columnspan=span, sticky='w', padx=6, pady=1)
        else:
            s.grid(row=r//2, column=r % 2, sticky='w', padx=6, pady=1)

    def _add_check(self, parent, r, name, label):
        v = tk.IntVar(); self.vars[name] = v
        ttk.Checkbutton(parent, text=label, variable=v,
                        command=lambda n=name: self._set(n, self.vars[n].get())
                        ).grid(row=r//2, column=r % 2, sticky='w', padx=6, pady=3)

    # ---- 动作 ----
    def _set(self, name, val):
        if not self.loading and self.mav:
            self.mav.set(name, val)

    def _set_var(self, name, v):
        self.vars[name].set(v); self._set(name, v)

    def _nudge(self, c, d):
        v = self.vars[f'HOV_{c}_ZERO']; v.set(round(v.get()+d))

    def _flip_dir(self, c):
        cur = self.mav.params.get(f'HOV_{c}_DIR', 1) if self.mav else 1
        nd = -1.0 if cur > 0 else 1.0
        self.vars[f'HOV_{c}_DIR'].set('+' if nd > 0 else '−')
        self._set(f'HOV_{c}_DIR', nd)

    def _preview_trim(self):
        trm = self.mav.params.get('MSAK_FOIL_TRM', 0.3) if self.mav else 0.3
        self._set_var('HOV_FOIL_TEST', float(trm))

    # ---- 刷新 ----
    def _refresh(self):
        if self.mav is None:
            self.status.config(text='未连接(填端口→连接)', foreground='gray')
        elif self.mav.err:
            self.status.config(text='连接失败: ' + self.mav.err, foreground='red')
        elif self.mav.connected and self.mav.params_loaded:
            if not self.populated:
                self._populate()
            self.status.config(text='已连接 ' + self.mav.device, foreground='green')
            sv = self.mav.tlm['servo']
            for i, c in enumerate(CORNERS):
                p = sv[8+i]
                self.servo_lbl[c].config(text=str(p) if p else '----')
            rf = self.mav.tlm['rngfnd']
            self.rngfnd_lbl.config(text='RNGFND: %.1f mm' % rf if rf is not None else 'RNGFND: --- mm')
        else:
            self.status.config(text='连接中…', foreground='orange')
        self.root.after(150, self._refresh)

    def _populate(self):
        self.loading = True
        for n, var in self.vars.items():
            v = self.mav.params.get(n)
            if v is None:
                continue
            if n.endswith('_DIR'):
                var.set('+' if v > 0 else '−')
            elif n == 'MSAK_FOIL_EN':
                var.set(int(round(v)))
            else:
                var.set(v)
        self.loading = False
        self.populated = True

    def _on_close(self):
        try:
            if self.mav:
                self.mav.set('HOV_FOIL_TEST', 0); time.sleep(0.3); self.mav.stop()
        except Exception:
            pass
        self.root.destroy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--device', default='/dev/ttyACM0')
    ap.add_argument('--baud', type=int, default=115200)
    args = ap.parse_args()
    root = tk.Tk()
    GUI(root, args.device, args.baud)
    root.mainloop()


if __name__ == '__main__':
    main()
