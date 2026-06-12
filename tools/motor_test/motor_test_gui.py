#!/usr/bin/env python3
"""电机油门阶梯测试 GUI (配 motor_test.lua).

功能:
  - 连接 FC (串口自动枚举, 连接/断开 + 断线检测)
  - 设本次测试: 电机 / 最低油门 / 最高油门 / 步进 / 每档维持 / 缓升 / 缓降
  - ▶开始测试: lua 跑油门阶梯 (缓升→MIN→逐档+步进→MAX→缓降→0)
  - 实时显示: 油门% / 电压V / 电流A / 功率W / 状态 (V/I 来自雷迅 power module via BATTERY_STATUS)
  - 手动 ●开始记录 / ■停止记录: 独立于测试, 开了就持续逐行写盘 + flush, 中途崩溃不丢已写数据
  - 实时曲线 (油门 + 电流 vs 时间)

依赖: pymavlink, pyserial, matplotlib(TkAgg), python3-pil.imagetk
"""
from __future__ import annotations
import collections, csv, os, queue, threading, time
from datetime import datetime

import matplotlib; matplotlib.use('TkAgg')
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure
import tkinter as tk
from tkinter import ttk, messagebox
from pymavlink import mavutil
from serial.tools import list_ports

MOTOR_NAMES = {1:'SL1',2:'SL2',3:'SR1',4:'SR2',5:'DFL',6:'DFR',
               7:'TL1',8:'TL2',9:'TR1',10:'TR2',11:'RDL',12:'RDR'}
STATE_NAME = {0:'IDLE',1:'RAMP_UP',2:'HOLD',3:'RAMP_DN',4:'DONE'}
LOG_HZ = 20.0


def nv_name(msg):
    return msg.name.strip('\x00').strip() if hasattr(msg, 'name') else ''


class FCWorker(threading.Thread):
    """所有 MAVLink I/O + 连续记录 在本线程; GUI 通过命令队列 + 共享状态(锁)交互。"""
    def __init__(self):
        super().__init__(daemon=True)
        self.master = None; self._sys = self._comp = 0
        self._stop = threading.Event(); self._cmd = queue.Queue(); self.lock = threading.Lock()
        # 共享
        self.connected = False; self.conn_state = 'disconnected'; self.busy = 'idle'
        self.live = dict(thr=0.0, state=0, v=0.0, i=0.0, p=0.0)
        self.plot = collections.deque(maxlen=3000)   # (t, thr%, current)
        self.status = collections.deque(maxlen=300)
        self.rec_on = False; self.rec_path = None; self.rec_rows = 0
        # 内部
        self._last_rx = 0.0
        self._logf = None; self._log_t0 = 0.0; self._last_write = 0.0; self._last_fsync = 0.0
        self._test_active = False; self._test_seen_active = False; self._test_deadline = 0.0

    # GUI 调用 (仅入队)
    def cmd_connect(self, port, baud): self._cmd.put(('connect', port, baud))
    def cmd_disconnect(self):          self._cmd.put(('disconnect',))
    def cmd_start(self, cfg):          self._cmd.put(('start', cfg))
    def cmd_abort(self):               self._cmd.put(('abort',))
    def cmd_log_start(self, path):     self._cmd.put(('log_start', path))
    def cmd_log_stop(self):            self._cmd.put(('log_stop',))
    def shutdown(self):                self._stop.set()

    def snap(self):
        with self.lock:
            return dict(connected=self.connected, conn_state=self.conn_state, busy=self.busy,
                        live=dict(self.live), plot=list(self.plot), status=list(self.status),
                        rec_on=self.rec_on, rec_path=self.rec_path, rec_rows=self.rec_rows)

    # ---------- 主循环 ----------
    def run(self):
        last_hb = 0.0
        while not self._stop.is_set():
            try: cmd = self._cmd.get_nowait()
            except queue.Empty: cmd = None
            if cmd: self._handle_cmd(cmd)
            if self.master is None:
                time.sleep(0.05); continue
            now = time.time()
            if now - last_hb > 2.0:
                try: self.master.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_GCS,
                                                     mavutil.mavlink.MAV_AUTOPILOT_INVALID,0,0,0)
                except Exception as e: self._link_lost(f'心跳失败:{e}'); continue
                last_hb = now
            # 测试看门: state 回 IDLE/DONE 即结束
            if self._test_active:
                st = self.live['state']
                if st in (1,2,3): self._test_seen_active = True
                if (self._test_seen_active and st in (0,4)) or now > self._test_deadline:
                    self._send('MTT_SW_ARM',0); self._send('MTT_EN',0)
                    self._test_active = False
                    with self.lock: self.busy='idle'
                    self._push('测试结束')
            # 收消息
            try:
                msg = self.master.recv_match(blocking=True, timeout=0.02)
                if msg:
                    self._last_rx = now; self._on_msg(msg, now)
                    while True:
                        m2 = self.master.recv_match(blocking=False)
                        if not m2: break
                        self._on_msg(m2, now)
            except Exception as e:
                self._link_lost(f'接收异常:{e}'); continue
            if self._last_rx and now - self._last_rx > 5.0:
                self._link_lost('5s 无数据 (FC 断开/重启?)'); continue
            # 连续记录 (20Hz, 逐行 flush, 崩溃不丢)
            if self.rec_on and self._logf and now - self._last_write >= 1.0/LOG_HZ:
                self._write_row(now); self._last_write = now

    # ---------- 命令 ----------
    def _handle_cmd(self, cmd):
        n = cmd[0]
        if n == 'connect': self._do_connect(cmd[1], cmd[2])
        elif n == 'disconnect': self._do_disconnect()
        elif n == 'start': self._begin_test(cmd[1])
        elif n == 'abort': self._abort()
        elif n == 'log_start': self._log_start(cmd[1])
        elif n == 'log_stop': self._log_stop()

    def _do_connect(self, port, baud):
        try:
            self.master = mavutil.mavlink_connection(port, baud=baud, dialect='ardupilotmega')
            if not self.master.wait_heartbeat(timeout=8):
                self.master = None
                with self.lock: self.conn_state='disconnected'
                self._push('❌ 无 heartbeat'); return
            self._sys = self.master.target_system; self._comp = self.master.target_component
            self.master.mav.request_data_stream_send(self._sys,self._comp,
                mavutil.mavlink.MAV_DATA_STREAM_ALL, 20, 1)
            self._last_rx = time.time()
            with self.lock: self.connected=True; self.conn_state='connected'
            self._push(f'✓ 连接 sys={self._sys}')
        except Exception as e:
            self.master=None
            with self.lock: self.conn_state='disconnected'
            self._push(f'❌ 连接失败:{e}')

    def _send(self, name, val):
        if self.master is None: return
        pid = name.encode('ascii').ljust(16,b'\x00')[:16]
        try:
            for _ in range(2):
                self.master.mav.param_set_send(self._sys,self._comp,pid,float(val),
                                               mavutil.mavlink.MAV_PARAM_TYPE_REAL32)
        except Exception as e: self._push(f'发送失败({name}):{e}')

    def _push(self, t):
        with self.lock: self.status.append((time.time(), t))

    def _on_msg(self, msg, now):
        t = msg.get_type()
        if t == 'NAMED_VALUE_FLOAT':
            nm = nv_name(msg)
            with self.lock:
                if nm == 'MTHR': self.live['thr'] = msg.value
                elif nm == 'MST': self.live['state'] = int(round(msg.value))
        elif t == 'BATTERY_STATUS':
            v = list(getattr(msg,'voltages',[0]))[0]; c = getattr(msg,'current_battery',0)
            with self.lock:
                if v and v != 65535: self.live['v'] = v/1000.0
                if c is not None and c >= 0: self.live['i'] = c/100.0
                self.live['p'] = self.live['v']*self.live['i']
                self.plot.append((now, self.live['thr']*100.0, self.live['i']))
        elif t == 'SYS_STATUS':
            v = getattr(msg,'voltage_battery',0)
            with self.lock:
                if v and self.live['v']==0: self.live['v']=v/1000.0
        elif t == 'STATUSTEXT':
            tx = getattr(msg,'text','')
            if tx: self._push(tx)

    # ---------- 测试 ----------
    def _begin_test(self, cfg):
        if not self.connected: return
        self._send('MTT_SW_ARM',0)
        self._send('MTT_MOTOR_MSK',cfg['mask'])
        self._send('MTT_THR_MIN',cfg['thr_min'])
        self._send('MTT_THR_MAX',cfg['thr_max'])
        self._send('MTT_THR_STEP',cfg['thr_step'])
        self._send('MTT_HOLD_MS',cfg['hold_ms'])
        self._send('MTT_RAMP_UP',cfg['ramp_up'])
        self._send('MTT_RAMP_DN',cfg['ramp_dn'])
        self._send('MTT_EN',1)
        self._send('MTT_SW_ARM',1)
        nsteps = max(1, int((cfg['thr_max']-cfg['thr_min'])/max(cfg['thr_step'],0.01))+1)
        dur = cfg['ramp_up']/1000.0 + nsteps*cfg['hold_ms']/1000.0 + cfg['ramp_dn']/1000.0 + 5
        self._test_active = True; self._test_seen_active = False; self._test_deadline = time.time()+dur
        with self.lock: self.busy='testing'
        self._push(f'测试开始: {cfg["thr_min"]*100:.0f}->{cfg["thr_max"]*100:.0f}% 步进{cfg["thr_step"]*100:.0f}%')

    def _abort(self):
        self._test_active = False
        self._send('MTT_SW_ARM',0); self._send('MTT_EN',0)
        with self.lock: self.busy='idle'
        self._push('⚠ ABORT - 电机已停')

    # ---------- 连续记录 ----------
    def _log_start(self, path):
        try:
            f = open(path,'w',newline='')
            f.write(f'# motor_test {datetime.now().isoformat()}\n')
            f.write('# t_s,throttle_pct,state,voltage_v,current_a,power_w\n')
            f.flush()
            self._logf = f; self._log_t0 = time.time(); self._last_write = 0.0
            with self.lock: self.rec_on=True; self.rec_path=path; self.rec_rows=0
            self._push(f'● 开始记录: {os.path.basename(path)}')
        except Exception as e:
            self._push(f'❌ 记录打开失败:{e}')

    def _write_row(self, now):
        lv = self.live
        try:
            self._logf.write(f'{now-self._log_t0:.3f},{lv["thr"]*100:.2f},{lv["state"]},'
                             f'{lv["v"]:.3f},{lv["i"]:.3f},{lv["p"]:.2f}\n')
            self._logf.flush()
            if now - self._last_fsync > 1.0:
                os.fsync(self._logf.fileno()); self._last_fsync = now
            with self.lock: self.rec_rows += 1
        except Exception as e:
            self._push(f'写盘异常:{e}')

    def _log_stop(self):
        if self._logf:
            try: self._logf.flush(); os.fsync(self._logf.fileno()); self._logf.close()
            except Exception: pass
        self._logf = None
        with self.lock:
            n = self.rec_rows; self.rec_on=False
        self._push(f'■ 停止记录 ({n} 行已保存)')

    # ---------- 断开 / 失联 ----------
    def _do_disconnect(self):
        self._test_active = False
        self._send('MTT_SW_ARM',0); self._send('MTT_EN',0)
        if self.rec_on: self._log_stop()
        try:
            if self.master: self.master.close()
        except Exception: pass
        self.master=None; self._last_rx=0.0
        with self.lock: self.connected=False; self.conn_state='disconnected'; self.busy='idle'
        self._push('已断开连接')

    def _link_lost(self, why):
        was = self.connected; self._test_active=False
        if self.rec_on: self._log_stop()    # 失联也保住日志
        try:
            if self.master: self.master.close()
        except Exception: pass
        self.master=None; self._last_rx=0.0
        with self.lock: self.connected=False; self.conn_state='lost'; self.busy='idle'
        if was: self._push(f'⚠ 连接丢失:{why}')


# ───────────────────── GUI ─────────────────────
class App:
    def __init__(self, root):
        self.root = root; self.fc = FCWorker(); self.fc.start(); self.motor_vars = {}
        root.title('电机油门阶梯测试 — motor_test')
        root.protocol('WM_DELETE_WINDOW', self._on_close)
        self._build(); self._refresh()

    def _build(self):
        top = ttk.Frame(self.root, padding=6); top.pack(side='top', fill='x')
        ttk.Label(top, text='串口:').pack(side='left')
        self.port_cb = ttk.Combobox(top, width=16, values=self._ports())
        acm = [p for p in self._ports() if 'ACM' in p]
        self.port_cb.set(acm[0] if acm else (self._ports()[0] if self._ports() else ''))
        self.port_cb.pack(side='left', padx=3)
        ttk.Button(top, text='⟳', width=3, command=lambda: self.port_cb.config(values=self._ports())).pack(side='left')
        ttk.Label(top, text='波特:').pack(side='left', padx=(8,0))
        self.baud_e = ttk.Entry(top, width=8); self.baud_e.insert(0,'115200'); self.baud_e.pack(side='left',padx=3)
        self.conn_btn = ttk.Button(top, text='连接', command=self._toggle_conn); self.conn_btn.pack(side='left',padx=6)
        self.conn_lbl = ttk.Label(top, text='● 未连接', foreground='gray'); self.conn_lbl.pack(side='left',padx=6)

        body = ttk.Frame(self.root, padding=6); body.pack(side='top', fill='both', expand=True)
        left = ttk.Frame(body); left.pack(side='left', fill='y')

        mf = ttk.LabelFrame(left, text='电机 (勾要测的)', padding=4); mf.pack(fill='x', pady=3)
        for i in range(1,13):
            v = tk.BooleanVar(value=(i==1)); self.motor_vars[i]=v
            r,c = divmod(i-1,3)
            ttk.Checkbutton(mf, text=f'{i} {MOTOR_NAMES[i]}', variable=v).grid(row=r,column=c,sticky='w',padx=2)

        cf = ttk.LabelFrame(left, text='油门阶梯参数', padding=6); cf.pack(fill='x', pady=4)
        self._row(cf,0,'最低油门 %:','min_e','10')
        self._row(cf,1,'最高油门 %:','max_e','100')
        self._row(cf,2,'步进 %:','step_e','10')
        self._row(cf,3,'每档维持 ms:','hold_e','2000')
        self._row(cf,4,'缓升 ms:','rampup_e','2000')
        self._row(cf,5,'缓降 ms:','rampdn_e','1500')

        tf = ttk.Frame(left); tf.pack(fill='x', pady=6)
        self.start_btn = ttk.Button(tf, text='▶ 开始测试', command=self._start); self.start_btn.pack(side='left')
        ttk.Button(tf, text='■ 急停', command=self.fc.cmd_abort).pack(side='left', padx=6)

        lf = ttk.LabelFrame(left, text='日志记录 (独立, 崩溃不丢)', padding=6); lf.pack(fill='x', pady=4)
        lb = ttk.Frame(lf); lb.pack(fill='x')
        self.log_btn = ttk.Button(lb, text='● 开始记录', command=self._toggle_log); self.log_btn.pack(side='left')
        self.log_lbl = ttk.Label(lf, text='未记录', foreground='gray'); self.log_lbl.pack(anchor='w', pady=2)

        right = ttk.Frame(body, padding=4); right.pack(side='left', fill='both', expand=True)
        rd = ttk.LabelFrame(right, text='实时', padding=6); rd.pack(fill='x')
        self.big = {}
        for idx,(k,lab) in enumerate([('thr','油门 %'),('v','电压 V'),('i','电流 A'),('p','功率 W'),('state','状态')]):
            f = ttk.Frame(rd); f.grid(row=0,column=idx,padx=10)
            ttk.Label(f, text=lab, foreground='gray').pack()
            l = ttk.Label(f, text='--', font=('TkDefaultFont',16,'bold')); l.pack()
            self.big[k]=l

        self.fig = Figure(figsize=(6,2.6), dpi=90)
        self.ax1 = self.fig.add_subplot(111); self.ax2 = self.ax1.twinx()
        self.ax1.set_xlabel('t (s)'); self.ax1.set_ylabel('Throttle (%)', color='tab:orange')
        self.ax2.set_ylabel('Current (A)', color='tab:red')
        self.fig.tight_layout()
        self.canvas = FigureCanvasTkAgg(self.fig, master=right)
        self.canvas.get_tk_widget().pack(fill='both', expand=True, pady=4)

        logf = ttk.LabelFrame(right, text='日志(STATUSTEXT)', padding=2); logf.pack(fill='both', expand=True)
        self.log = tk.Text(logf, height=6, font=('TkFixedFont',9)); self.log.pack(fill='both', expand=True)

    def _row(self, parent, r, label, attr, default):
        ttk.Label(parent, text=label).grid(row=r,column=0,sticky='w',pady=1)
        e = ttk.Entry(parent, width=10); e.insert(0, default); e.grid(row=r,column=1,sticky='w',padx=4)
        setattr(self, attr, e)

    def _ports(self): return [p.device for p in list_ports.comports()]
    def _toggle_conn(self):
        if self.fc.snap()['connected']: self.fc.cmd_disconnect()
        else:
            try: baud=int(self.baud_e.get())
            except ValueError: messagebox.showerror('错误','波特率无效'); return
            self.fc.cmd_connect(self.port_cb.get(), baud)

    def _mask(self):
        m=0
        for i,v in self.motor_vars.items():
            if v.get(): m |= (1<<(i-1))
        return m

    def _start(self):
        mask=self._mask()
        if mask==0: messagebox.showerror('错误','至少勾一个电机'); return
        try:
            tmin=float(self.min_e.get())/100; tmax=float(self.max_e.get())/100
            tstep=float(self.step_e.get())/100; hold=int(self.hold_e.get())
            ru=int(self.rampup_e.get()); rd=int(self.rampdn_e.get())
        except ValueError: messagebox.showerror('错误','参数格式无效'); return
        if not (0<=tmin<=tmax<=1.0): messagebox.showerror('错误','油门范围无效 (0≤最低≤最高≤100)'); return
        names=[MOTOR_NAMES[i] for i in self.motor_vars if self.motor_vars[i].get()]
        if not messagebox.askyesno('确认启动',
                f'电机: {", ".join(names)}\n油门: {tmin*100:.0f}→{tmax*100:.0f}% 步进{tstep*100:.0f}%\n'
                f'每档{hold}ms 缓升{ru}ms 缓降{rd}ms\n\n⚠️ 电机会转! 确认台架固定、周围安全。'):
            return
        self.fc.cmd_start(dict(mask=mask,thr_min=tmin,thr_max=tmax,thr_step=tstep,
                               hold_ms=hold,ramp_up=ru,ramp_dn=rd))

    def _toggle_log(self):
        if self.fc.snap()['rec_on']:
            self.fc.cmd_log_stop()
        else:
            os.makedirs(os.path.join(os.path.dirname(__file__),'logs'), exist_ok=True)
            stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            path = os.path.join(os.path.dirname(__file__),'logs',f'motor_{stamp}.csv')
            self.fc.cmd_log_start(path)

    def _refresh(self):
        s = self.fc.snap(); cs = s['conn_state']
        if cs=='connected':
            self.conn_lbl.config(text=f'● 已连接 ({s["busy"]})', foreground='green'); self.conn_btn.config(text='断开')
        elif cs=='lost':
            self.conn_lbl.config(text='● 连接丢失!', foreground='red'); self.conn_btn.config(text='连接')
        else:
            self.conn_lbl.config(text='● 未连接', foreground='gray'); self.conn_btn.config(text='连接')
        self.start_btn.config(state=('normal' if cs=='connected' else 'disabled'))
        lv = s['live']
        self.big['thr'].config(text=f'{lv["thr"]*100:.0f}')
        self.big['v'].config(text=f'{lv["v"]:.2f}')
        self.big['i'].config(text=f'{lv["i"]:.1f}')
        self.big['p'].config(text=f'{lv["p"]:.0f}')
        self.big['state'].config(text=STATE_NAME.get(lv['state'],'?'))
        # 记录状态
        if s['rec_on']:
            self.log_btn.config(text='■ 停止记录')
            self.log_lbl.config(text=f'● 记录中: {os.path.basename(s["rec_path"] or "")}  {s["rec_rows"]} 行',
                                foreground='red')
        else:
            self.log_btn.config(text='● 开始记录')
            self.log_lbl.config(text='未记录', foreground='gray')
        # 曲线
        plot = s['plot']
        if plot:
            t_now = plot[-1][0]
            d = [(t-t_now, th, c) for (t,th,c) in plot if t_now-t<=30]
            xs=[x[0] for x in d]; ths=[x[1] for x in d]; cs2=[x[2] for x in d]
            self.ax1.clear(); self.ax2.clear()
            self.ax1.plot(xs, ths, color='tab:orange', lw=1.0)
            self.ax2.plot(xs, cs2, color='tab:red', lw=1.2)
            self.ax1.set_xlabel('t (s, rel)'); self.ax1.set_ylabel('Throttle (%)', color='tab:orange')
            self.ax1.set_ylim(0,100); self.ax2.set_ylabel('Current (A)', color='tab:red')
            self.ax1.grid(True, alpha=0.3); self.canvas.draw_idle()
        # STATUSTEXT
        msgs = s['status']
        if len(msgs) != getattr(self,'_last_n',-1):
            self._last_n = len(msgs); self.log.delete('1.0','end')
            for (t,tx) in list(msgs)[-40:]:
                self.log.insert('end', f'{datetime.fromtimestamp(t).strftime("%H:%M:%S")} {tx}\n')
            self.log.see('end')
        self.root.after(120, self._refresh)

    def _on_close(self):
        self.fc.cmd_log_stop(); self.fc.cmd_abort(); self.fc.cmd_disconnect()
        self.fc.shutdown(); time.sleep(0.3); self.root.destroy()


def main():
    root = tk.Tk()
    try: ttk.Style().theme_use('clam')
    except Exception: pass
    App(root); root.mainloop()


if __name__ == '__main__':
    main()
