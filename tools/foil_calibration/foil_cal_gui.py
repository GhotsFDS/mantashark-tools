#!/usr/bin/env python3
"""
水翼襟翼校准 GUI (SERVO9-12 零位/方向/行程 + 控制层 trim/EN/PID)

tkinter + pymavlink, 实时改参舵机立即动, 实时回显 SERVO9-12 PWM + 测距。
前置: 飞控 disarmed (机械校准全程不用解锁), 襟翼舵机接 SERVO9-12 通电。

用法: python3 tools/bench/foil_cal_gui.py [--device /dev/ttyACM0] [--baud 115200]
"""
import argparse, threading, time, queue
import tkinter as tk
from tkinter import ttk
from pymavlink import mavutil

CORNERS = ['FL', 'FR', 'RL', 'RR']
PARAMS = ([f'HOV_{c}_ZERO' for c in CORNERS] + [f'HOV_{c}_DIR' for c in CORNERS] +
          ['HOV_FOIL_RNG', 'HOV_FOIL_TEST', 'MSAK_FOIL_EN', 'MSAK_FOIL_TRM',
           'MSAK_FH_P', 'MSAK_FH_I', 'MSAK_FH_D'])


class Mav(threading.Thread):
    """后台 MAVLink: 连接 / 参数读写队列(去重) / 遥测轮询。GUI 不直接碰 mavlink。"""
    def __init__(self, device, baud):
        super().__init__(daemon=True)
        self.device, self.baud = device, baud
        self.pending = {}          # 待写参数 (name->val, latest wins)
        self.lock = threading.Lock()
        self.params = {}           # 最近已知参数值
        self.tlm = {'servo': [None]*12, 'rngfnd': None}
        self.connected = False
        self.params_loaded = False
        self.err = None
        self._stop = False

    def set(self, name, val):
        with self.lock:
            self.pending[name] = float(val)

    def stop(self):
        self._stop = True

    def run(self):
        try:
            m = mavutil.mavlink_connection(self.device, baud=self.baud)
            m.wait_heartbeat(timeout=10)
            self.connected = True
        except Exception as e:
            self.err = str(e); return
        # 初始读全部关心参数
        for n in PARAMS:
            m.mav.param_request_read_send(m.target_system, m.target_component, n.encode()[:16], -1)
        # 请求遥测流
        for mid, us in [(36, 100000), (173, 200000)]:   # SERVO_OUTPUT_RAW, RANGEFINDER
            m.mav.command_long_send(m.target_system, m.target_component,
                mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0, mid, us, 0, 0, 0, 0, 0)
        t_load = time.time()
        while not self._stop:
            # 1) flush 待写参数
            with self.lock:
                pend = dict(self.pending); self.pending.clear()
            for n, v in pend.items():
                m.mav.param_set_send(m.target_system, m.target_component, n.encode()[:16],
                                     v, mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
                self.params[n] = v
            # 2) 收消息
            for _ in range(20):
                msg = m.recv_match(blocking=False)
                if msg is None:
                    break
                t = msg.get_type()
                if t == 'PARAM_VALUE':
                    pid = msg.param_id.strip()
                    if pid in PARAMS:
                        self.params[pid] = msg.param_value
                elif t == 'SERVO_OUTPUT_RAW':
                    self.tlm['servo'] = [getattr(msg, 'servo%d_raw' % i, None) for i in range(1, 13)]
                elif t == 'RANGEFINDER':
                    self.tlm['rngfnd'] = msg.distance * 1000.0
            if not self.params_loaded and (len(self.params) >= len(PARAMS) or time.time()-t_load > 4):
                self.params_loaded = True
            time.sleep(0.05)


class GUI:
    def __init__(self, root, device, baud):
        self.root = root
        self.device, self.baud = device, baud
        self.mav = None
        self.populated = False
        self.loading = False
        self.vars = {}
        root.title('MantaShark 水翼襟翼校准')
        self._build()
        root.after(150, self._refresh)
        root.protocol('WM_DELETE_WINDOW', self._on_close)

    def _connect(self):
        if self.mav:
            self.mav.stop()
        self.populated = False
        self.device = self.dev_var.get().strip()
        self.mav = Mav(self.device, self.baud)
        self.mav.start()

    def _set(self, name, val):
        if not self.loading:
            self.mav.set(name, val)

    def _build(self):
        pad = dict(padx=4, pady=2)
        # 连接栏 (端口可选, 打包 exe 用)
        cb = ttk.Frame(self.root); cb.grid(row=0, column=0, columnspan=4, sticky='w', **pad)
        ttk.Label(cb, text='端口').pack(side='left')
        self.dev_var = tk.StringVar(value=self.device)
        ttk.Entry(cb, textvariable=self.dev_var, width=16).pack(side='left', padx=4)
        ttk.Button(cb, text='连接', command=self._connect).pack(side='left')
        self.status = ttk.Label(cb, text='未连接', foreground='gray')
        self.status.pack(side='left', padx=8)

        # ── 机械校准 ──
        mf = ttk.LabelFrame(self.root, text='机械校准 (disarmed)')
        mf.grid(row=1, column=0, columnspan=4, sticky='ew', **pad)
        ttk.Label(mf, text='角').grid(row=0, column=0, **pad)
        ttk.Label(mf, text='ZERO (us)').grid(row=0, column=1, **pad)
        ttk.Label(mf, text='').grid(row=0, column=2)
        ttk.Label(mf, text='DIR').grid(row=0, column=4, **pad)
        ttk.Label(mf, text='实时PWM').grid(row=0, column=5, **pad)
        self.servo_lbl = {}
        for i, c in enumerate(CORNERS):
            ttk.Label(mf, text=c).grid(row=i+1, column=0, **pad)
            zv = tk.DoubleVar()
            self.vars[f'HOV_{c}_ZERO'] = zv
            sb = ttk.Spinbox(mf, from_=1000, to=2000, increment=1, width=6, textvariable=zv,
                             command=lambda c=c: self._set(f'HOV_{c}_ZERO', self.vars[f'HOV_{c}_ZERO'].get()))
            sb.grid(row=i+1, column=1, **pad)
            zv.trace_add('write', lambda *a, c=c: self._set(f'HOV_{c}_ZERO', self.vars[f'HOV_{c}_ZERO'].get()))
            bf = ttk.Frame(mf); bf.grid(row=i+1, column=2)
            ttk.Button(bf, text='−5', width=3, command=lambda c=c: self._nudge(c, -5)).pack(side='left')
            ttk.Button(bf, text='+5', width=3, command=lambda c=c: self._nudge(c, +5)).pack(side='left')
            dv = tk.StringVar(value='+')
            self.vars[f'HOV_{c}_DIR'] = dv
            ttk.Button(mf, textvariable=dv, width=3, command=lambda c=c: self._flip_dir(c)).grid(row=i+1, column=4, **pad)
            lbl = ttk.Label(mf, text='----', width=6, font=('TkFixedFont', 10))
            lbl.grid(row=i+1, column=5, **pad); self.servo_lbl[c] = lbl

        # RNG
        rf = ttk.Frame(mf); rf.grid(row=5, column=0, columnspan=6, sticky='w', **pad)
        ttk.Label(rf, text='满偏 RNG (us)').pack(side='left')
        self.vars['HOV_FOIL_RNG'] = tk.DoubleVar()
        ttk.Scale(rf, from_=100, to=700, orient='horizontal', length=200,
                  variable=self.vars['HOV_FOIL_RNG'],
                  command=lambda v: self._set('HOV_FOIL_RNG', float(v))).pack(side='left', padx=6)
        self.rng_lbl = ttk.Label(rf, text='--'); self.rng_lbl.pack(side='left')

        # TEST 偏转 (大)
        tf = ttk.LabelFrame(self.root, text='测试偏转 (disarmed 驱动襟翼: 验方向/行程/限位)')
        tf.grid(row=2, column=0, columnspan=4, sticky='ew', **pad)
        self.vars['HOV_FOIL_TEST'] = tk.DoubleVar()
        ttk.Scale(tf, from_=-1, to=1, orient='horizontal', length=320,
                  variable=self.vars['HOV_FOIL_TEST'],
                  command=lambda v: self._set('HOV_FOIL_TEST', float(v))).grid(row=0, column=0, columnspan=2, **pad)
        self.test_lbl = ttk.Label(tf, text='0.00'); self.test_lbl.grid(row=0, column=2, **pad)
        ttk.Button(tf, text='归 0', command=lambda: self._set_var('HOV_FOIL_TEST', 0)).grid(row=0, column=3, **pad)
        ttk.Button(tf, text='预览 trim', command=self._preview_trim).grid(row=0, column=4, **pad)

        # ── 控制层 ──
        cf = ttk.LabelFrame(self.root, text='控制层 (MSAK_)')
        cf.grid(row=3, column=0, columnspan=4, sticky='ew', **pad)
        self.vars['MSAK_FOIL_EN'] = tk.IntVar()
        ttk.Checkbutton(cf, text='EN 高度控制器', variable=self.vars['MSAK_FOIL_EN'],
                        command=lambda: self._set('MSAK_FOIL_EN', self.vars['MSAK_FOIL_EN'].get())).grid(row=0, column=0, **pad)
        ttk.Label(cf, text='TRIM').grid(row=0, column=1, **pad)
        self.vars['MSAK_FOIL_TRM'] = tk.DoubleVar()
        ttk.Scale(cf, from_=0, to=1, orient='horizontal', length=160, variable=self.vars['MSAK_FOIL_TRM'],
                  command=lambda v: self._set('MSAK_FOIL_TRM', float(v))).grid(row=0, column=2, **pad)
        self.trm_lbl = ttk.Label(cf, text='--'); self.trm_lbl.grid(row=0, column=3, **pad)
        for j, p in enumerate(['MSAK_FH_P', 'MSAK_FH_I', 'MSAK_FH_D']):
            ttk.Label(cf, text=p.split('_')[-1]).grid(row=1, column=j*2, **pad)
            self.vars[p] = tk.DoubleVar()
            e = ttk.Entry(cf, width=6, textvariable=self.vars[p])
            e.grid(row=1, column=j*2+1, **pad)
            e.bind('<Return>', lambda ev, p=p: self._set(p, self.vars[p].get()))

        # ── 回显 ──
        df = ttk.LabelFrame(self.root, text='实时')
        df.grid(row=4, column=0, columnspan=4, sticky='ew', **pad)
        self.rngfnd_lbl = ttk.Label(df, text='RNGFND: --- mm', font=('TkFixedFont', 11))
        self.rngfnd_lbl.grid(row=0, column=0, sticky='w', **pad)

    def _nudge(self, c, d):
        v = self.vars[f'HOV_{c}_ZERO']; v.set(round(v.get()+d))

    def _flip_dir(self, c):
        cur = self.mav.params.get(f'HOV_{c}_DIR', 1)
        nd = -1.0 if cur > 0 else 1.0
        self.vars[f'HOV_{c}_DIR'].set('+' if nd > 0 else '−')
        self._set(f'HOV_{c}_DIR', nd)

    def _set_var(self, name, v):
        self.vars[name].set(v); self._set(name, v)

    def _preview_trim(self):
        trm = self.mav.params.get('MSAK_FOIL_TRM', 0.3)
        self._set_var('HOV_FOIL_TEST', float(trm))

    def _refresh(self):
        if self.mav is None:
            self.status.config(text='未连接 (填端口→连接)', foreground='gray')
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
            self.test_lbl.config(text='%+.2f' % self.vars['HOV_FOIL_TEST'].get())
            self.rng_lbl.config(text='%.0f' % self.vars['HOV_FOIL_RNG'].get())
            self.trm_lbl.config(text='%.2f' % self.vars['MSAK_FOIL_TRM'].get())
        else:
            self.status.config(text='连接中…', foreground='orange')
        self.root.after(150, self._refresh)

    def _populate(self):
        self.loading = True
        for n in PARAMS:
            v = self.mav.params.get(n)
            if v is None:
                continue
            if n.endswith('_DIR'):
                self.vars[n].set('+' if v > 0 else '−')
            elif n == 'MSAK_FOIL_EN':
                self.vars[n].set(int(round(v)))
            else:
                self.vars[n].set(v)
        self.loading = False
        self.populated = True

    def _on_close(self):
        try:
            if self.mav:
                self.mav.set('HOV_FOIL_TEST', 0)   # 退出归零, 防遗留偏转
                time.sleep(0.3)
                self.mav.stop()
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
