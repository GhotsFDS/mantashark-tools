"""台架动力测试 manager — manta_gcs 后端 (仿 rtk.py).

modbus 力变送器(6ch) + 电流计(16ch, HB-CT16B-JC) 串口轮询 + profile 矩阵引擎 + CSV,
WS 推送给 React Bench tab. BPT_ 参数经 mav handle 直发 (lua 50Hz 跟随).

架构对齐 rtk.RtkManager: 持 mav handle, emit callback 线程安全推 WS, lazy init.
  emit(type_str, data_dict) → mavbridge._broadcast_thread → WS broadcast
  get_voltage() → mavbridge.last_battery_voltage

bench 后端模块 (bus485/profiles/sign_check/modbus 驱动) 都在本目录, 地面站自包含.
"""
from __future__ import annotations
import sys, time, csv, threading
from pathlib import Path

HERE = Path(__file__).parent.resolve()
# 日志落盘目录: 打包(frozen)用 exe 所在目录, 源码用脚本目录.
# (PyInstaller onefile 下 __file__ → 临时 _MEI 解压目录, 退出即删 → 必须用 sys.executable)
if getattr(sys, 'frozen', False):
    APP_DIR = Path(sys.executable).parent.resolve()
else:
    APP_DIR = HERE
# bench 后端依赖 (bus485 / transducer_modbus / current_meter_modbus / profiles /
# sign_check) 现在是本目录同级模块, 地面站自包含 — 不再 reach ../motor_test.

try:
    from bus485 import Bus485
    from transducer_modbus import TransducerModbus
    from current_meter_modbus import CurrentMeterModbus, DUCT_NAMES
    from profiles import PROFILES, ID2ALIAS, GOAL
    _OK = True
except ImportError as e:
    print(f'[bench] import 失败: {e}')
    _OK = False
    DUCT_NAMES = ['SL1','SL2','SR1','SR2','DFL','DFR','TL1','TL2','TR1','TR2','RDL','RDR']
    PROFILES = {}
    ID2ALIAS = {}
    GOAL = {}

TILT_NEUTRAL = 45.0   # body = LMIN/LMAX offset + NEUTRAL (tilt_driver.lua)

# 力 6 通道 → 物理 (用户定: 垂直左右后, 水平左右后)
FORCE_MAP = {1: 'V_L', 2: 'V_R', 3: 'V_aft', 4: 'H_L', 5: 'H_R', 6: 'H_aft'}
# 力臂 (m) — 标定填实测
ARM_FRONT, ARM_AFT, ARM_LAT = 0.50, 0.90, 0.40

# BPT_ 舵机角参数名
ANG_PARAM = {'S_GROUP_TILT':'BPT_ANG_S','DFL':'BPT_ANG_DFL','DFR':'BPT_ANG_DFR',
             'TL1':'BPT_ANG_TL1','TR1':'BPT_ANG_TR1','RDL':'BPT_ANG_RDL','RDR':'BPT_ANG_RDR'}

# P0 双电池功率: 左涵道(电池 id0=L): SL1 SL2 DFL TL1 TL2 RDL = motor idx 0,1,4,6,7,10
# 右涵道(电池 id1=R): SR1 SR2 DFR TR1 TR2 RDR = idx 2,3,5,8,9,11. 跟 lua LEFT_SET 一致.
LEFT_DUCT_IDX = {0, 1, 4, 6, 7, 10}

# P1 物理包络 (body deg, 实际机械范围, 来自 CLAUDE.md). 角度梯度超此=飞控限位未标定, 收窄防顶死.
# 保守值; 飞控 TLT 限位标对(在范围内)时不影响, 默认值(超范围)时兜底.
PHYS_ENVELOPE = {
    'S_GROUP_TILT': (15, 75),   # 45±30
    'DFL': (0, 90), 'DFR': (0, 90),
    'TL1': (90, 120), 'TR1': (90, 120),   # ≥90 反向 roll, 保守上限 120
    'RDL': (50, 90), 'RDR': (50, 90),     # 90=水平 50=垂直低头
}


def profile_list():
    """给前端的 profile 元信息."""
    return [{'key': k, 'name': p.name, 'desc': p.desc, 'points': len(p.points)}
            for k, p in PROFILES.items()]


class BenchManager:
    def __init__(self, mav, emit, get_voltage=None, get_param=None, get_battery=None):
        self.mav = mav                 # mavutil connection
        self.emit = emit               # emit(type_str, dict) → WS (线程安全)
        self.get_voltage = get_voltage or (lambda: 0.0)
        self.get_battery = get_battery or (lambda: {})   # P0: 双电池 {id:V} (L=0 R=1)
        self.get_param = get_param or (lambda n: None)   # 读飞控 param 缓存 (TLT_ 限位)
        self.bus = None                # Bus485 (共总线) 或 None
        self.force = None              # 双口模式
        self.curr = None
        self._shared = False
        self._live_thread = None
        self._live_stop = threading.Event()
        self._run_thread = None
        self._est_thread = None        # P2: estimate 并发守护
        self._abort = threading.Event()
        self._stopping = False     # 停止测试 (软停, 缓降); 区别于 abort (急停硬停)
        self._rc_thread = None
        self._rc_stop = threading.Event()
        self._send_lock = threading.Lock()   # P1: 串行化 mav send (多线程并发写不安全)
        self._meta = {'ge_plate': 'na', 'mount_deg': 0.0, 'note': ''}   # 运行级元数据 (start 覆盖)
        self.cal = {ch: 1.0 for ch in range(1, 7)}    # 力 N/count
        self.tare = {ch: 0.0 for ch in range(1, 7)}

    # ── 传感器连接 (共总线 force_port==curr_port → Bus485) ──
    def connect_sensors(self, force_port, curr_port, baud=115200):
        if not _OK:
            self.emit('bench_status', {'error': 'bench 模块依赖缺失'}); return
        self.disconnect_sensors()
        try:
            if force_port == curr_port:
                self.bus = Bus485(force_port, baud=baud, force_slave=1, curr_slave=30)
                self.bus.open()
                fok, cok = self.bus.handshake()
                self.bus.start(interval_ms=100)
                self._shared = True
                self.emit('bench_status', {'msg': f'共总线 {force_port}: 力{fok}/6 电流{cok}/12',
                                           'force_ok': fok, 'curr_ok': cok, 'connected': True})
            else:
                self.force = TransducerModbus(force_port, baud=baud, slave=1,
                                              channels=[1,2,3,4,5,6])
                self.curr = CurrentMeterModbus(curr_port, baud=9600, slave=30)
                self.force.open(); self.curr.open()
                fh = self.force.handshake(); ch = self.curr.handshake()
                self.force.start_continuous(100); self.curr.start_continuous(100)
                fok = sum(1 for v in fh.values() if v); cok = sum(1 for v in ch.values() if v)
                self._shared = False
                self.emit('bench_status', {'msg': f'双口: 力{fok}/6 电流{cok}/12',
                                           'force_ok': fok, 'curr_ok': cok, 'connected': True})
            self._start_live()
        except Exception as ex:
            self.emit('bench_status', {'error': f'连接失败: {ex}'})

    def disconnect_sensors(self):
        self.abort()
        self._live_stop.set()
        if self._live_thread:
            self._live_thread.join(timeout=1.0); self._live_thread = None
        self._live_stop.clear()
        for obj in (self.bus, self.force, self.curr):
            if obj:
                try: obj.close()
                except Exception: pass
        self.bus = self.force = self.curr = None
        self.emit('bench_status', {'msg': '传感器已断开', 'connected': False})

    def _get_force(self):
        if self.bus: return self.bus.get_force()
        if self.force: return self.force.get_latest()
        return {}

    def _get_current(self):
        if self.bus: return self.bus.get_current()
        if self.curr: return self.curr.get_latest()
        return {}

    # ── 力归零 / 标定 ──
    def tare_force(self):
        fz = self._get_force()
        for c in range(1, 7):
            if fz.get(c) is not None:
                self.tare[c] = fz[c]
        self.emit('bench_status', {'msg': f'力归零 {self.tare}'})

    def set_cal(self, cal_dict):
        for k, v in cal_dict.items():
            self.cal[int(k)] = float(v)
        self.emit('bench_status', {'msg': f'标定系数 {self.cal}'})

    # ── 派生物理量 (力单位 g 原始 + N 派生; 力矩 N·m) ──
    def _derive(self, fc):
        # f_g: 每通道力 g (变送器原始 count × cal; cal 默认 1.0 = 直接 count→g)
        f_g = {}
        for ch in range(1, 7):
            raw = fc.get(ch)
            f_g[FORCE_MAP[ch]] = None if raw is None else (raw - self.tare[ch]) * self.cal[ch]
        g = lambda k: f_g.get(k) or 0.0
        GRAV = 0.00981   # g → N (1g = 0.00981 N)
        lift_g = g('V_L') + g('V_R') + g('V_aft')
        thrust_g = g('H_L') + g('H_R') + g('H_aft')
        lift_N = lift_g * GRAV
        thrust_N = thrust_g * GRAV
        # 力矩 N·m (用 N 算)
        roll_m = (g('V_L') - g('V_R')) * GRAV * ARM_LAT
        pitch_m = ((g('V_L') + g('V_R')) * ARM_FRONT - g('V_aft') * ARM_AFT) * GRAV
        yaw_m = (g('H_L') - g('H_R')) * GRAV * ARM_LAT
        return f_g, lift_g, thrust_g, lift_N, thrust_N, roll_m, pitch_m, yaw_m

    # ── live 推送 (连上即看读数, 5Hz) ──
    def _start_live(self):
        if self._live_thread and self._live_thread.is_alive(): return
        self._live_thread = threading.Thread(target=self._live_loop, daemon=True)
        self._live_thread.start()

    # P0 双电池功率: 左涵道用电池 L(id0) 电压, 右涵道用 R(id1). 返回 (vL, vR, power_total)
    def _power(self, cur_list):
        batt = self.get_battery()
        vL = batt.get(0) or batt.get(1) or 0.0   # 单电池时 fallback
        vR = batt.get(1) or batt.get(0) or 0.0
        pL = vL * sum(cur_list[i] for i in range(12) if i in LEFT_DUCT_IDX)
        pR = vR * sum(cur_list[i] for i in range(12) if i not in LEFT_DUCT_IDX)
        return vL, vR, pL + pR

    def _live_loop(self):
        while not self._live_stop.is_set():
            fc = self._get_force(); cc = self._get_current()
            f_g, lift_g, thrust_g, lift_N, thrust_N, rollm, pitchm, yawm = self._derive(fc)
            cur = [cc.get(i+1) or 0.0 for i in range(12)]
            itot = sum(cur)
            vL, vR, power = self._power(cur)
            self.emit('bench_live', {
                'force_g': {k: (None if f_g[k] is None else round(f_g[k], 1)) for k in f_g},
                'lift_g': round(lift_g,1), 'thrust_g': round(thrust_g,1),
                'lift_N': round(lift_N,2), 'thrust_N': round(thrust_N,2),
                'roll_m': round(rollm,3), 'pitch_m': round(pitchm,3), 'yaw_m': round(yawm,3),
                'current': {DUCT_NAMES[i]: round(cur[i],1) for i in range(12)},
                'i_total': round(itot,1), 'volt_L': round(vL,2), 'volt_R': round(vR,2),
                'power': round(power, 0),
            })
            time.sleep(0.2)

    # ── BPT_ param 下发 (P1: 串行化, 多线程并发 send 不安全) ──
    def _set(self, name, val):
        try:
            with self._send_lock:
                self.mav.mav.param_set_send(self.mav.target_system, self.mav.target_component,
                                            name.encode()[:16], float(val), 9)
        except Exception:
            pass

    # P1: 安全关键参数 (EN/THR/SW_ARM) 重发多次 (无 ACK, 防丢包电机不停)
    def _set_critical(self, name, val, n=3):
        for _ in range(n):
            self._set(name, val); time.sleep(0.02)

    # ── 矩阵执行 (后端线程自主跑) ──
    def start(self, profile_key, thr_min=0.5, thr_max=0.8, step=0.1,
              hold=3.0, ramp=1.5, ang_step=15.0,
              ge_plate='na', mount_deg=0.0, note=''):
        if not _OK or profile_key not in PROFILES:
            self.emit('bench_status', {'error': f'无 profile {profile_key}'}); return
        if self._run_thread and self._run_thread.is_alive():
            self.emit('bench_status', {'error': '测试进行中'}); return
        # P0/P2: 输入校验 (step≤0 会死循环; thr_min>max 空跑; ramp/hold=0 record 崩)
        if step <= 0 or ang_step <= 0:
            self.emit('bench_status', {'error': f'步进必须>0 (油门step={step}, 角度step={ang_step})'}); return
        if thr_min > thr_max:
            self.emit('bench_status', {'error': f'最小油门>最大 ({thr_min}>{thr_max})'}); return
        if ramp <= 0 or hold <= 0:
            self.emit('bench_status', {'error': f'ramp/hold 必须>0 (ramp={ramp}, hold={hold})'}); return
        # 运行级元数据 (整跑恒定, 写每行 CSV — 多跑拼接时按此过滤: 地效/安装角对比)
        self._meta = {'ge_plate': str(ge_plate), 'mount_deg': float(mount_deg), 'note': str(note)}
        self._abort.clear()
        self._stopping = False
        self._run_thread = threading.Thread(
            target=self._run_loop, args=(profile_key, thr_min, thr_max, step, hold, ramp, ang_step),
            daemon=True)
        self._run_thread.start()

    # 估算: 读限位算准确角度数 + 总时长 (前端选 profile/改参数时调; 后台线程不阻塞)
    def estimate(self, profile_key, thr_min, thr_max, step, hold, ramp, ang_step):
        if not _OK or profile_key not in PROFILES:
            return
        if step <= 0 or ang_step <= 0 or thr_min > thr_max:
            return   # P0: 防 _ladder 死循环 / 空跑 (前端改参常清空输入框→0)
        if self._run_thread and self._run_thread.is_alive():
            return   # 测试中不估算 (mav 忙)
        if self._est_thread and self._est_thread.is_alive():
            return   # P2: 并发 estimate 守护 (防线程堆积)
        self._est_thread = threading.Thread(target=self._estimate_work,
                         args=(profile_key, thr_min, thr_max, step, hold, ramp, ang_step),
                         daemon=True)
        self._est_thread.start()

    def _estimate_work(self, profile_key, thr_min, thr_max, step, hold, ramp, ang_step):
        prof = PROFILES[profile_key]
        ladder_n = len(self._ladder(thr_min, thr_max, step))
        total_cfg = 0; n_fixed = 0; n_sweep = 0; detail = []
        for sp in prof.points:
            if sp.sweep:
                lim = self._read_body_limit(sp.sweep[0])   # 同舵机第二次走缓存, 快
                if lim:
                    n = len(self._ladder(lim[0], lim[1], ang_step))
                    detail.append(f'{ID2ALIAS.get(sp.sweep[0], sp.sweep[0])}[{lim[0]:.0f}-{lim[1]:.0f}°]×{n}角')
                else:
                    n = 1; detail.append(f'{sp.label}(限位读不到→1)')
                total_cfg += n; n_sweep += n
            else:
                total_cfg += 1; n_fixed += 1
        if n_fixed:   # 不扫角度的 (P0 单涵道 / P2 / P8/P9 差动) 是固定配置, 不是"角度"
            detail.insert(0, f'{n_fixed}个固定配置')
        per_angle = (ramp + 0.5) + ladder_n * (ramp + hold) + (ramp + 0.3)
        est = round(1 + total_cfg * per_angle)
        # cfg_kind: 'angle' 有角度梯度 / 'fixed' 全固定配置(涵道/差动档) / 'mixed'
        kind = 'angle' if n_sweep and not n_fixed else ('fixed' if n_fixed and not n_sweep else 'mixed')
        self.emit('bench_estimate', {
            'profile': profile_key, 'total_angles': total_cfg, 'ladder_n': ladder_n,
            'total_steps': total_cfg * ladder_n, 'est_sec': est,
            'cfg_kind': kind, 'n_sweep': n_sweep, 'n_fixed': n_fixed,
            'detail': '  '.join(detail),
        })

    # 阶梯档位: lo, lo+step, ... ≤ hi. P0 修: step≤0 死循环守卫, lo>hi 返回单点
    @staticmethod
    def _ladder(lo, hi, step):
        if step <= 0:
            return [round(lo, 3)]
        if lo > hi:
            return [round(lo, 3)]
        steps = []; t = lo
        while t <= hi + 1e-6:
            steps.append(round(t, 3)); t += step
        return steps

    # 读舵机 body 软件限位 [LMIN+45, LMAX+45] (从飞控 TLT_<alias>_LMIN/LMAX 缓存)
    def _read_body_limit(self, sid, timeout=2.5):
        alias = ID2ALIAS.get(sid, sid)
        lmin_n = f'TLT_{alias}_LMIN'; lmax_n = f'TLT_{alias}_LMAX'
        try:
            with self._send_lock:   # P1: 串行化 send
                for nm in (lmin_n, lmax_n):
                    self.mav.mav.param_request_read_send(
                        self.mav.target_system, self.mav.target_component, nm.encode()[:16], -1)
        except Exception:
            pass
        t0 = time.time()
        while time.time() - t0 < timeout:
            lo = self.get_param(lmin_n); hi = self.get_param(lmax_n)
            if lo is not None and hi is not None:
                return lo + TILT_NEUTRAL, hi + TILT_NEUTRAL
            time.sleep(0.1)
        return None

    # SweepPoint 角度梯度: sweep 非空→读限位 [lo..hi] step; 空→[None] (用 GOAL)
    # P1 限位 gate: 若限位是飞控默认值 (远超机械), 角度会扫进止档. 加物理包络兜底.
    def _angle_grid(self, sp, ang_step):
        if not sp.sweep:
            return [None]
        lim = self._read_body_limit(sp.sweep[0])
        if lim is None:
            self.emit('bench_status', {'msg': f'⚠ {sp.sweep[0]} 限位读不到, 用 GOAL 单点'})
            return [None]
        lo, hi = lim
        # 物理包络 (body deg): 超出 = 飞控限位未标定到机械极限, 收窄并告警 (防顶死/吹尾)
        env = PHYS_ENVELOPE.get(sp.sweep[0])
        if env:
            clo, chi = max(lo, env[0]), min(hi, env[1])
            if clo > lo + 0.5 or chi < hi - 0.5:
                self.emit('bench_status', {'msg':
                    f'⚠ {ID2ALIAS.get(sp.sweep[0],sp.sweep[0])} 限位[{lo:.0f},{hi:.0f}]超物理包络'
                    f'[{env[0]},{env[1]}], 已收窄到[{clo:.0f},{chi:.0f}](飞控限位未标定?)'})
            lo, hi = clo, chi
        return self._ladder(lo, hi, ang_step)

    def _run_loop(self, profile_key, thr_min, thr_max, step, hold, ramp, ang_step):
        prof = PROFILES[profile_key]
        pts = prof.points          # SweepPoint 列表
        ladder = self._ladder(thr_min, thr_max, step)
        ANGK = ['S_GROUP_TILT','DFL','DFR','TL1','TR1','RDL','RDR']
        out = APP_DIR / 'logs' / f'bench_{profile_key}_{time.strftime("%Y%m%d_%H%M%S")}.csv'
        out.parent.mkdir(exist_ok=True)
        # 原始数据全列 (D2: 全程连续记录, phase 区分 ramp_up/hold/ramp_dn)
        meta = self._meta          # 运行级元数据 (整跑恒定, 每行尾部追加)
        cols = (['t_s','profile','label','phase','thr_pct','diff'] +
                ['ang_'+k for k in ['S','DFL','DFR','TL1','TR1','RDL','RDR']] +
                [FORCE_MAP[c]+'_g' for c in range(1,7)] +
                ['lift_g','thrust_g','lift_N','thrust_N','roll_Nm','pitch_Nm','yaw_Nm'] +
                ['volt_L','volt_R','power_W'] + ['I_'+DUCT_NAMES[i] for i in range(12)] + ['I_total'] +
                ['ge_plate','mount_deg','note'])
        csvf = open(out, 'w', newline=''); w = csv.writer(csvf); w.writerow(cols); csvf.flush()
        t0 = time.time(); done_steps = 0
        last_emit = [0.0]

        # 设角度: sweep 舵机=ang (同步), 其他=GOAL; 返回当前 7 舵机角 dict
        def set_angles(ap, ang):
            ca = {}
            for sid in ANGK:
                a = ang if (ang is not None and sid in ap.sweep) else GOAL.get(sid, 45)
                self._set(ANG_PARAM[sid], a); ca[sid] = a
            return ca

        # 全程 10Hz 记录 helper (返回 True=被 abort/stop 打断)
        # P1 软停: hard=True(急停/ramp_up/hold) _abort||_stopping 都立即返回;
        #          hard=False(ramp_dn 缓降段) 只 _abort 立即返回, _stopping 让它跑满真缓降.
        # P1 防崩: last 初始化, dur≤0 时不会 UnboundLocalError.
        def record(dur, thr_pct, phase, ap, cur_ang, hard=True):
            t_h = time.time()
            last = (0.0,)*9
            while time.time() - t_h < dur:
                if self._abort.is_set() or (hard and self._stopping):
                    return True, None
                fc = self._get_force(); cc = self._get_current()
                f_g, lift_g, thrust_g, lift_N, thrust_N, rm, pm, ym = self._derive(fc)
                cur = [cc.get(i+1) or 0.0 for i in range(12)]
                itot = sum(cur)
                vL, vR, power = self._power(cur)
                last = (lift_g, thrust_g, lift_N, thrust_N, rm, pm, ym, (vL, vR), itot, power)
                w.writerow([round(time.time()-t0,2), profile_key, ap.label, phase,
                            thr_pct, ap.diff] +
                           [cur_ang.get(k,0) for k in ANGK] +
                           [round(f_g[FORCE_MAP[c]],1) if f_g.get(FORCE_MAP[c]) is not None else '' for c in range(1,7)] +
                           [round(lift_g,1),round(thrust_g,1),round(lift_N,2),round(thrust_N,2),
                            round(rm,3),round(pm,3),round(ym,3)] +
                           [round(vL,2), round(vR,2), round(power,1)] +
                           [round(x,1) for x in cur] + [round(itot,1)] +
                           [meta['ge_plate'], meta['mount_deg'], meta['note']])
                csvf.flush()
                now = time.time()
                if now - last_emit[0] > 0.2:
                    last_emit[0] = now
                    self.emit('bench_sample', {
                        'phase': phase, 'thr_pct': thr_pct,
                        'force_g': {FORCE_MAP[c]: (round(f_g[FORCE_MAP[c]],1) if f_g.get(FORCE_MAP[c]) is not None else None) for c in range(1,7)},
                        'lift_g': round(lift_g,1), 'thrust_g': round(thrust_g,1),
                        'lift_N': round(lift_N,2), 'thrust_N': round(thrust_N,2),
                        'roll_m': round(rm,3), 'pitch_m': round(pm,3), 'yaw_m': round(ym,3),
                        'current': {DUCT_NAMES[i]: round(cur[i],1) for i in range(12)},
                        'i_total': round(itot,1), 'volt_L': round(vL,2), 'volt_R': round(vR,2), 'power': round(power,0),
                    })
                time.sleep(0.1)
            return False, last
        try:
            # 台架 arm 前置: SKIPCHK + RC override → lua arm_force
            self._set('ARMING_SKIPCHK', 524287)
            self._start_rc()
            self._set('BPT_EN', 1); self._set('BPT_RAMP_MS', int(ramp*1000))
            self._set('BPT_SW_ARM', 0)
            time.sleep(1.0)
            # 预读每 SweepPoint 角度梯度 (从飞控 TLT_ 限位)
            grids = []
            for ap in pts:
                if self._abort.is_set() or self._stopping: break
                grids.append((ap, self._angle_grid(ap, ang_step)))
            total_angles = sum(len(g) for _, g in grids)
            total_steps = total_angles * len(ladder)
            # 时间估计: 每角度 = 舵机到位(ramp+0.5) + 油门档数×(缓升ramp+hold) + 缓降(ramp+0.3)
            per_angle = (ramp + 0.5) + len(ladder) * (ramp + hold) + (ramp + 0.3)
            est_sec = 1.0 + total_angles * per_angle
            self.emit('bench_status', {
                'msg': f'开始 {profile_key}: {total_angles}角度 × {len(ladder)}油门档, 预计 {est_sec/60:.1f}min',
                'running': True, 'csv': str(out), 'est_sec': round(est_sec)})
            for ap, angles in grids:
                if self._abort.is_set() or self._stopping: break
                # 组 + 差动 + B 组背景油门 (per SweepPoint)
                self._set('BPT_MSK_A', ap.msk_a); self._set('BPT_MSK_B', ap.msk_b)
                self._set('BPT_THR_B', ap.thr_b); self._set('BPT_DIFF', ap.diff)
                # ── 角度梯度: 每个角度 → 油门阶梯 ──
                for ang in angles:
                    if self._abort.is_set() or self._stopping: break
                    cur_ang = set_angles(ap, ang)      # sweep 舵机=ang, 其他 GOAL
                    self._set('BPT_THR_A', 0)
                    self._set('BPT_SW_ARM', 1)         # arm/保持 + 舵机到位
                    if self._sleep_abort(ramp + 0.5): break
                    alabel = ap.label + (f'@{ang:.0f}°' if ang is not None else '')
                    # 油门阶梯 (中间不回 0)
                    for thr in ladder:
                        if self._abort.is_set() or self._stopping: break
                        self._set('BPT_THR_A', thr)
                        pct = int(round(thr*100))
                        ab, _ = record(ramp, pct, 'ramp_up', ap, cur_ang)
                        if ab: break
                        ab, last = record(hold, pct, 'hold', ap, cur_ang)
                        if ab or last is None: break
                        done_steps += 1
                        lift_g, thrust_g, lift_N, thrust_N, rm, pm, ym, vLR, itot, power = last
                        vL, vR = vLR if isinstance(vLR, tuple) else (vLR, vLR)
                        elapsed = time.time() - t0
                        self.emit('bench_point', {
                            'idx': done_steps, 'total': total_steps, 'profile': profile_key,
                            'label': f'{alabel} @{pct}%', 'angle_idx': 0, 'angle_total': total_angles,
                            'thr_pct': pct, 'lift_g': round(lift_g,1), 'thrust_g': round(thrust_g,1),
                            'lift_N': round(lift_N,2), 'thrust_N': round(thrust_N,2),
                            'roll_m': round(rm,3), 'pitch_m': round(pm,3), 'yaw_m': round(ym,3),
                            'volt_L': round(vL,2), 'volt_R': round(vR,2), 'i_total': round(itot,1), 'power': round(power,0),
                            'elapsed_sec': round(elapsed), 'remain_sec': round(max(0, est_sec-elapsed)),
                        })
                    if self._abort.is_set(): break
                    # 角度切换: 缓降回 0 (保持 armed). ramp_dn hard=False → 软停时跑满真缓降
                    self._set('BPT_THR_A', 0)
                    ab, _ = record(ramp + 0.3, 0, 'ramp_dn', ap, cur_ang, hard=False)
                    if ab: break
                if self._abort.is_set() or self._stopping: break
        finally:
            graceful = self._stopping and not self._abort.is_set()
            self._park(graceful=graceful, ramp=ramp)   # 软停缓降 / 急停硬切
            self._stop_rc()
            csvf.flush(); csvf.close()
            aborted = self._abort.is_set()
            self.emit('bench_done', {'profile': profile_key, 'aborted': aborted,
                                     'stopped': self._stopping, 'csv': str(out)})
            # 跑完自动符号断言 (sweep profile): body角→力矩 符号 vs 控制律假设.
            # 隔离 try/except — 分析失败绝不拖累 bench 收尾.
            if not aborted:
                try:
                    from sign_check import analyze as _sign_analyze, format_report as _sign_report
                    sres = _sign_analyze(str(out))
                    print(_sign_report(sres))                 # 全文 → mavbridge/EXE 控制台
                    if sres.get('skipped'):
                        smsg = '符号校验: ' + sres['skipped']
                    elif sres.get('error'):
                        smsg = '符号校验错误: ' + sres['error']
                    else:
                        nf = len(sres.get('flags', []))
                        smsg = ('符号断言 ✗ %d FLAG (查 TLT_*_DIR / fb_sign)' % nf) if nf else '符号断言 ✓ 全 PASS'
                    self.emit('bench_sign', sres)             # 结构化 → 前端 (可加面板)
                    self.emit('bench_status', {'msg': smsg})
                except Exception as _se:                       # noqa: BLE001
                    print('[bench] 符号断言失败: %s' % _se)
            self.emit('bench_status', {
                'msg': ('急停' if aborted else ('已停止' if self._stopping else '测试完成')),
                'running': False})

    def _sleep_abort(self, secs):
        """可被 abort 打断的 sleep. 返回 True 表示被 abort."""
        t0 = time.time()
        while time.time() - t0 < secs:
            if self._abort.is_set(): return True
            time.sleep(0.05)
        return False

    # RC override 持续发 (18ch v2): 室内台架无遥控器, 满足飞控 "RC received" mandatory check.
    # ch3(throttle)=1000 低位 (bench 用 set_output_pwm 直驱, 不用 RC throttle). 让 lua arm_force 能过.
    def _rc_loop(self):
        while not self._rc_stop.is_set():
            try:
                with self._send_lock:   # P1: 串行化 send
                    self.mav.mav.rc_channels_override_send(
                        self.mav.target_system, self.mav.target_component,
                        1500, 1500, 1000, 1500, 1500, 1500, 1500, 1500, *([1500]*10))
            except Exception:
                pass
            time.sleep(0.1)   # 10Hz

    def _start_rc(self):
        if self._rc_thread and self._rc_thread.is_alive():
            return
        self._rc_stop.clear()
        self._rc_thread = threading.Thread(target=self._rc_loop, daemon=True)
        self._rc_thread.start()

    def _stop_rc(self):
        self._rc_stop.set()
        if self._rc_thread:
            self._rc_thread.join(timeout=1.0)
            self._rc_thread = None

    # P1 park: graceful(软停)→ THR=0+SW_ARM=0 保持 EN=1 等 lua 缓降到 0, 再 EN=0;
    #          硬停(急停)→ 立即 EN=0 lua 瞬停. 安全参数用 _set_critical 重发防丢包.
    def _park(self, graceful=False, ramp=1.5):
        from pymavlink import mavutil
        self._set_critical('BPT_THR_A', 0); self._set_critical('BPT_THR_B', 0)
        self._set_critical('BPT_SW_ARM', 0)
        if graceful:
            time.sleep(ramp + 0.3)   # 等 lua ramp_down_motors 缓降到 0 (避免反电动势冲击)
        self._set_critical('BPT_EN', 0)   # EN=0 → lua disarm + (硬停时)瞬停
        try:
            with self._send_lock:   # 双保险 disarm command (P3: 包 try 防 finally 中断)
                self.mav.mav.command_long_send(self.mav.target_system, self.mav.target_component,
                    mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0, 0, 21196, 0,0,0,0,0)
        except Exception:
            pass

    def stop(self):
        """停止测试 (软停): 当前档缓降到 0 + 结束矩阵, 不硬切. _run_loop 检测 _stopping 优雅退出."""
        self._stopping = True

    def abort(self):
        """急停 (硬停): 立即 EN=0 park + disarm, 不缓降."""
        self._abort.set()
        # _run_loop 没在跑时 (手动 abort), 也立即 park + 停 RC
        if not (self._run_thread and self._run_thread.is_alive()):
            self._park(graceful=False); self._stop_rc()
