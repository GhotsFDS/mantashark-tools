import { useEffect, useState, useRef } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';

const FORCE_LABELS: { key: string; label: string }[] = [
  { key: 'V_L', label: '垂直左' }, { key: 'V_R', label: '垂直右' }, { key: 'V_aft', label: '垂直后' },
  { key: 'H_L', label: '水平左' }, { key: 'H_R', label: '水平右' }, { key: 'H_aft', label: '水平后' },
];
const DUCT = ['SL1','SL2','SR1','SR2','DFL','DFR','TL1','TL2','TR1','TR2','RDL','RDR'];
// SERVO 通道预览 (从 GCS tab 复制): [物理通道 idx, 名, 'M'电机|'T'倾转]
const SERVO_CH: [number, string, 'M' | 'T'][] = [
  [0,'SL1','M'],[1,'SL2','M'],[2,'SR1','M'],[3,'SR2','M'],[4,'DFL','M'],[5,'DFR','M'],
  [6,'TL1','M'],[7,'TL2','M'],[8,'TR1','M'],[9,'TR2','M'],[10,'RDL','M'],[11,'RDR','M'],
  [12,'DFL倾','T'],[13,'DFR倾','T'],[14,'TL1倾','T'],[15,'TR1倾','T'],[16,'RDL倾','T'],
  [17,'RDR倾','T'],[18,'S组倾','T'],[19,'TL2倾','T'],[20,'TR2倾','T'],
];

type Prof = { key: string; name: string; desc: string; points: number };
type Live = Extract<GcsMessage, { type: 'bench_live' }>;
type Pt = Extract<GcsMessage, { type: 'bench_point' }>;

export function Bench() {
  const [profiles, setProfiles] = useState<Prof[]>([]);
  const [sel, setSel] = useState('P0');
  const [ports, setPorts] = useState<{ device: string; description: string }[]>([]);
  const [forcePort, setForcePort] = useState('');
  const [currPort, setCurrPort] = useState('');
  const [shared, setShared] = useState(true);
  const [connected, setConnected] = useState(false);
  const [sensorMsg, setSensorMsg] = useState('未连接');
  const [running, setRunning] = useState(false);
  // 油门阶梯参数 (%)
  const [thrMin, setThrMin] = useState(50);
  const [thrMax, setThrMax] = useState(80);
  const [step, setStep] = useState(10);
  const [hold, setHold] = useState(3.0);
  const [ramp, setRamp] = useState(1.5);
  const [angStep, setAngStep] = useState(15);   // 角度梯度步进 (deg, 范围从舵机限位读)
  const [rest, setRest] = useState(0);          // 角度间隔 s (每角度扫完停机散热 + 电池压降恢复)
  // 本次运行标注 (运行前设定, 整跑恒定, 写入 CSV 每行)
  const [gePlate, setGePlate] = useState('na');   // 地效下表面: with/without/na
  const [mountDeg, setMountDeg] = useState(0);    // 机体安装俯仰角 (deg)
  const [note, setNote] = useState('');           // 自由备注
  // 后端按实际限位算的估算 (角度数/点数/总时长/明细)
  const [est, setEst] = useState<{ total_angles: number; total_steps: number; est_sec: number; detail: string; cfg_kind: string } | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [servo, setServo] = useState<number[]>([]);
  const [prog, setProg] = useState<{ idx: number; total: number; label: string; remain: number } | null>(null);
  const [rows, setRows] = useState<Pt[]>([]);
  const [csvPath, setCsvPath] = useState<string | null>(null);
  // 力标定外置配置板已做 (变送器直接输出 g, 1:1), GUI 不再标定
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = (s: string) =>
    setLog(p => [...p.slice(-200), `${new Date().toLocaleTimeString()} ${s}`]);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  useEffect(() => {
    const fetch = () => { gcs.benchProfiles(); gcs.benchListPorts(); };
    fetch();
    const id = setInterval(() => {
      if (profiles.length && ports.length) { clearInterval(id); return; }
      fetch();
    }, 1500);
    return () => clearInterval(id);
  }, [profiles.length, ports.length]);

  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'bench_profiles') {
        setProfiles(m.profiles);
        if (m.profiles.length && !m.profiles.find(p => p.key === sel)) setSel(m.profiles[0].key);
      } else if (m.type === 'bench_ports') {
        if (m.error) addLog(`端口枚举错: ${m.error}`);
        else if (m.ports) {
          const list = m.ports.map((p: any) => Array.isArray(p) ? { device: p[0], description: p[1] } : p);
          setPorts(list);
          if (!forcePort && list.length) { setForcePort(list[0].device); setCurrPort(list[0].device); }
        }
      } else if (m.type === 'bench_status') {
        if (m.error) addLog(`错: ${m.error}`);
        else {
          if (m.msg) addLog(m.msg);
          if (typeof m.connected === 'boolean') {
            setConnected(m.connected);
            setSensorMsg(m.connected ? `已连 (力${m.force_ok ?? '?'}/6 电流${m.curr_ok ?? '?'}/12)` : '未连接');
          }
          if (typeof m.running === 'boolean') setRunning(m.running);
          if (m.csv) setCsvPath(m.csv);
        }
      } else if (m.type === 'bench_live' || m.type === 'bench_sample') {
        setLive(m as Live);
      } else if (m.type === 'servo') {
        setServo((m as any).channels || []);
      } else if (m.type === 'bench_point') {
        setProg({ idx: m.idx, total: m.total, label: m.label, remain: m.remain_sec ?? 0 });
        setRows(p => [...p, m]);
        addLog(`[${m.idx}/${m.total}] ${m.label}: 升${m.lift_g}g/${m.lift_N}N 推${m.thrust_g}g/${m.thrust_N}N | ${m.volt_L}/${m.volt_R}V ${m.i_total}A ${m.power}W`);
      } else if (m.type === 'bench_done') {
        setRunning(false); setProg(null); setCsvPath(m.csv);
        addLog(m.aborted ? `急停 (${m.profile})` : (m.stopped ? `已停止 (${m.profile})` : `完成 ${m.profile} → ${m.csv}`));
      } else if (m.type === 'bench_estimate') {
        if (m.profile === sel) setEst({ total_angles: m.total_angles, total_steps: m.total_steps, est_sec: m.est_sec, detail: m.detail, cfg_kind: m.cfg_kind });
      } else if (m.type === 'error') {
        addLog(`⚠ ${m.msg}`);   // P3: WS 断/错误反馈 (之前静默)
      }
    });
    // 订阅 servo 流 (通道预览)
    if (gcs.isConnected()) gcs.send({ type: 'set_msg_interval', msgid: 36, hz: 10 });
    return off;
  }, [sel, forcePort]);

  // 选 profile / 改参数 → debounce 发 estimate (后端读限位算准确总时长)
  useEffect(() => {
    if (running || !sel) return;
    const id = setTimeout(() => {
      gcs.benchEstimate(sel, thrMin / 100, thrMax / 100, step / 100, hold, ramp, angStep, rest);
    }, 500);
    return () => clearTimeout(id);
  }, [sel, thrMin, thrMax, step, hold, ramp, angStep, rest, running]);

  const onConnect = () => { connected ? gcs.benchDisconnect() : gcs.benchConnect(forcePort, shared ? forcePort : currPort); };
  const onStart = () => {
    if (thrMin > thrMax) { alert('最小油门 > 最大'); return; }
    if (step <= 0 || angStep <= 0) { alert('步进必须 > 0 (会导致后端死循环)'); return; }
    if (ramp <= 0 || hold <= 0) { alert('ramp/hold 必须 > 0'); return; }
    if (!confirm(`开始 ${sel}: 油门 ${thrMin}→${thrMax}% 步进${step}%\n会 arm + 驱动电机, 确认台架固定/桨叶安全!`)) return;
    setRows([]); setCsvPath(null); setRunning(true);   // P2: 乐观置 running, bench_done 再纠正
    gcs.benchStart(sel, thrMin/100, thrMax/100, step/100, hold, ramp, angStep, rest, gePlate, mountDeg, note);
  };

  const exportCsv = () => {
    if (!rows.length) return;
    const cols = ['idx','profile','label','thr_pct','lift_g','thrust_g','lift_N','thrust_N',
                  'roll_Nm','pitch_Nm','yaw_Nm','volt_L','volt_R','i_total_A','power_W'];
    const lines = [cols.join(',')];
    for (const r of rows)
      lines.push([r.idx, r.profile, `"${r.label}"`, r.thr_pct, r.lift_g, r.thrust_g, r.lift_N, r.thrust_N,
                  r.roll_m, r.pitch_m, r.yaw_m, r.volt_L, r.volt_R, r.i_total, r.power].join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bench_${rows[0]?.profile}_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'')}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  const selProf = profiles.find(p => p.key === sel);
  // 每角度时长 (角度数由后端按舵机限位算, 总时长开始后从 bench_status 拿)
  const ladderN = step > 0 && thrMax >= thrMin ? Math.floor((thrMax - thrMin) / step) + 1 : 0;
  const perAngle = (ramp + 0.5) + ladderN * (ramp + hold) + (ramp + 0.3);
  const fmtT = (s: number) => `${Math.floor(s / 60)}分${Math.round(s % 60)}秒`;
  const N = (v?: number) => v != null ? ((v >= 0 ? '+' : '') + v.toFixed(2)) : '--';

  return (
    <div className="flex flex-col gap-3 h-full overflow-auto text-[12px]">
     <div className="flex gap-3">
      {/* 左: 控制 */}
      <div className="w-80 flex flex-col gap-3 shrink-0">
        <div className="card">
          <div className="card-title">传感器 (485 总线)</div>
          <label className="flex items-center gap-2 text-[11px] mb-2 text-fg-mute">
            <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />
            共总线 (力+电流同口, 都 115200)
          </label>
          <div className="flex items-center gap-1 mb-1">
            <span className="label w-12">力口</span>
            <select className="input flex-1" value={forcePort}
              onChange={e => { setForcePort(e.target.value); if (shared) setCurrPort(e.target.value); }}>
              <option value="">--</option>
              {ports.map(p => <option key={p.device} value={p.device}>{p.device} {p.description}</option>)}
            </select>
          </div>
          {!shared && (
            <div className="flex items-center gap-1 mb-1">
              <span className="label w-12">电流口</span>
              <select className="input flex-1" value={currPort} onChange={e => setCurrPort(e.target.value)}>
                <option value="">--</option>
                {ports.map(p => <option key={p.device} value={p.device}>{p.device} {p.description}</option>)}
              </select>
            </div>
          )}
          <div className="flex gap-2 mt-2">
            <button className="btn btn-primary flex-1" onClick={onConnect}>{connected ? '断开' : '连接'}</button>
            <button className="btn" onClick={() => gcs.benchListPorts()}>⟳</button>
            <button className="btn" onClick={() => gcs.benchTare()} disabled={!connected}>力归零</button>
          </div>
          <div className={`text-[11px] mt-2 val-mono ${connected ? 'text-ok' : 'text-fg-mute'}`}>● {sensorMsg}</div>
        </div>

        <div className="card">
          <div className="card-title">测试 Profile</div>
          <select className="input w-full mb-2" value={sel} onChange={e => { setSel(e.target.value); setEst(null); }} disabled={running}>
            {profiles.map(p => <option key={p.key} value={p.key}>{p.key} {p.name}</option>)}
          </select>
          {selProf && <div className="text-[11px] text-fg-mute mb-2 leading-snug">{selProf.desc}</div>}
          <div className="card-section">油门阶梯 (%)</div>
          <div className="grid grid-cols-3 gap-2 mb-2">
            <label className="label">最小%<input type="number" value={thrMin} onChange={e => setThrMin(+e.target.value)} className="input w-full" disabled={running} /></label>
            <label className="label">最大%<input type="number" value={thrMax} onChange={e => setThrMax(+e.target.value)} className="input w-full" disabled={running} /></label>
            <label className="label">步进%<input type="number" min="0.1" value={step} onChange={e => setStep(+e.target.value)} className="input w-full" disabled={running} /></label>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-2">
            <label className="label">hold s<input type="number" step="0.5" value={hold} onChange={e => setHold(+e.target.value)} className="input w-full" disabled={running} /></label>
            <label className="label">缓升/降 s<input type="number" step="0.5" value={ramp} onChange={e => setRamp(+e.target.value)} className="input w-full" disabled={running} /></label>
            <label className="label">角度步进°<input type="number" step="1" min="1" value={angStep} onChange={e => setAngStep(+e.target.value)} className="input w-full" disabled={running} /></label>
            <label className="label">角度间隔 s<input type="number" step="1" min="0" value={rest} onChange={e => setRest(+e.target.value)} className="input w-full" disabled={running} title="每个角度扫完后停机 N 秒: 电调散热 + 电池压降恢复 (记 phase=rest)" /></label>
          </div>
          <div className="text-[10px] text-fg-mute mb-1">每角度: 缓升{thrMin}%→hold→+{step}%→...→{thrMax}%→缓降0; 角度从舵机限位按{angStep}°扫</div>
          <div className="card-section">运行标注 (写入 CSV 每行)</div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <label className="label">下表面
              <select value={gePlate} onChange={e => setGePlate(e.target.value)} className="input w-full" disabled={running}>
                <option value="with">带下表面</option>
                <option value="without">不带下表面</option>
                <option value="na">不适用</option>
              </select>
            </label>
            <label className="label">安装角°<input type="number" step="1" value={mountDeg} onChange={e => setMountDeg(+e.target.value)} className="input w-full" disabled={running} /></label>
          </div>
          <label className="label block mb-2">备注<input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="本次运行备注" className="input w-full" disabled={running} /></label>
          {est ? (
            <div className="text-[11px] val-mono mb-2">
              <div className="text-accent">{est.total_angles}{est.cfg_kind === 'fixed' ? '配置' : (est.cfg_kind === 'angle' ? '角度' : '配置')} × {ladderN}油门档 = {est.total_steps}点, 预计 {fmtT(est.est_sec)}</div>
              <div className="text-[10px] text-fg-mute">{est.detail}</div>
            </div>
          ) : (
            <div className="text-[11px] text-fg-mute val-mono mb-2">读限位估算中... (每角度≈{fmtT(perAngle)})</div>
          )}
          {!running ? (
            <button className="btn btn-primary w-full" onClick={onStart} disabled={!connected}>▶ 开始测试</button>
          ) : (
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={() => gcs.benchStop()}>■ 停止 (缓降)</button>
              <button className="btn btn-warn flex-1" onClick={() => gcs.benchAbort()}>⚠ 急停</button>
            </div>
          )}
          {prog && (
            <div className="mt-2">
              <div className="text-[11px] val-mono">{prog.idx}/{prog.total} — {prog.label}</div>
              <div className="h-2 bg-panel-2 rounded mt-1 overflow-hidden"><div className="h-full bg-accent" style={{ width: `${prog.idx / prog.total * 100}%` }} /></div>
              <div className="text-[10px] text-fg-mute val-mono mt-1">剩余约 {fmtT(prog.remain)}</div>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">数据 ({rows.length} 档)</div>
          <button className="btn btn-primary w-full" onClick={exportCsv} disabled={!rows.length}>⬇ 导出 CSV ({rows.length})</button>
          {csvPath && <div className="text-[10px] text-fg-mute mt-2 break-all">后端原始(10Hz): {csvPath}</div>}
        </div>
      </div>

      {/* 右: 实时 */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">
        {/* 升力/推力 (g + N) + 力矩 */}
        <div className="grid grid-cols-5 gap-2">
          {([['升力', live?.lift_g, live?.lift_N, 'g/N'], ['推力', live?.thrust_g, live?.thrust_N, 'g/N']] as const).map(([lab, vg, vn]) => (
            <div key={lab} className="card text-center !p-2">
              <div className="text-[10px] text-fg-mute">{lab}</div>
              <div className="text-lg font-bold val-mono text-accent">{vg != null ? vg.toFixed(0) : '--'}<span className="text-[10px]">g</span></div>
              <div className="text-[11px] val-mono">{vn != null ? vn.toFixed(1) : '--'}<span className="text-[9px] text-fg-mute">N</span></div>
            </div>
          ))}
          {([['roll', live?.roll_m], ['pitch', live?.pitch_m], ['yaw', live?.yaw_m]] as const).map(([lab, v]) => (
            <div key={lab} className="card text-center !p-2">
              <div className="text-[10px] text-fg-mute">{lab}</div>
              <div className="text-lg font-bold val-mono">{N(v)}</div>
              <div className="text-[9px] text-fg-mute">N·m</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {([['电压L', live?.volt_L, 'V'], ['电压R', live?.volt_R, 'V'], ['总电流', live?.i_total, 'A'], ['功率', live?.power, 'W']] as const).map(([lab, v, u]) => (
            <div key={lab} className="card text-center !p-2">
              <div className="text-[10px] text-fg-mute">{lab}</div>
              <div className="text-xl font-bold val-mono">{v != null ? v.toFixed(1) : '--'}</div>
              <div className="text-[10px] text-fg-mute">{u}</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="card">
            <div className="card-title">力 6 通道 (g)</div>
            {FORCE_LABELS.map(f => (
              <div key={f.key} className="flex justify-between text-[11px]">
                <span className="text-fg-mute">{f.label}</span>
                <span className="val-mono">{live?.force_g?.[f.key] != null ? live.force_g[f.key]!.toFixed(0) : '--'}</span>
              </div>
            ))}
          </div>
          <div className="card">
            <div className="card-title">涵道电流 (A)</div>
            <div className="grid grid-cols-2 gap-x-3">
              {DUCT.map(d => (
                <div key={d} className="flex justify-between text-[11px]">
                  <span className="text-fg-mute">{d}</span>
                  <span className="val-mono">{live?.current?.[d] != null ? live.current[d].toFixed(1) : '--'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div ref={logRef} className="card h-32 overflow-auto !p-2 font-mono text-[10px] leading-relaxed">
          {log.map((l, i) => <div key={i} className="text-fg-mute">{l}</div>)}
        </div>
      </div>
     </div>

      {/* 通道输出预览 (SERVO, 从 GCS tab 复制) */}
      <div className="card">
        <div className="card-title">通道输出预览 (12 EDF + 9 倾转)</div>
        <div className="grid grid-cols-3 gap-x-4 gap-y-1">
          {SERVO_CH.map(([idx, name, grp]) => {
            const v = servo[idx] ?? 0;
            const pct = v <= 0 ? 0 : grp === 'M'
              ? Math.max(0, Math.min(100, (v - 800) / 14))
              : Math.max(0, Math.min(100, (v - 500) / 20));
            return (
              <div key={idx} className="flex items-center gap-1.5">
                <span className="text-[10px] text-fg-mute w-12 shrink-0 truncate">{name}</span>
                <div className="h-1.5 bg-panel-2 rounded overflow-hidden flex-1 min-w-0">
                  <div className={'h-full ' + (grp === 'M' ? 'bg-accent' : 'bg-ks')} style={{ width: pct + '%' }} />
                </div>
                <span className="val-mono text-[10px] w-9 text-right">{v || '—'}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
