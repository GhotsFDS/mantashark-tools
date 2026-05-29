// Yaw Tune — heading-hold 实时调参面板 (不用拔 SD / 不用下电上岸).
// 数据源: lua send_named_float YHE(heading误差) / YYO(yaw输出) @5Hz (仅 mode27 CRUISE/TURN hold-active),
//        + vfr_hud.airspeed. 滚动窗口算 RMS/饱和率, 复用 analyzer section 14 建议规则.
// 改 Q_A_ANG_YAW_P / Q_A_RAT_YAW_P/I/D 当场看响应 — 拨一档增益当场判断.
import { useEffect, useRef, useState } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';
import { useStore } from '../../store/useStore';

const GAINS = [
  { key: 'Q_A_ANG_YAW_P', label: 'ANG_YAW_P', hint: 'angle 环: heading误差→rate', step: 0.5, def: 3.0 },
  { key: 'Q_A_RAT_YAW_P', label: 'RAT_YAW_P', hint: 'rate 环 P', step: 0.02, def: 0.15 },
  { key: 'Q_A_RAT_YAW_I', label: 'RAT_YAW_I', hint: 'rate 环 I', step: 0.01, def: 0.03 },
  { key: 'Q_A_RAT_YAW_D', label: 'RAT_YAW_D', hint: 'rate 环 D (弱权限保持 0)', step: 0.001, def: 0.0 },
];
const WIN_S = 10;   // 滚动窗口秒

type Sample = { t: number; v: number };

function rms(arr: Sample[]): number {
  if (!arr.length) return 0;
  return Math.sqrt(arr.reduce((s, x) => s + x.v * x.v, 0) / arr.length);
}

export function YawTune() {
  const params = useStore(s => s.params);
  const setParam = useStore(s => s.setParam);
  const [, force] = useState(0);
  const heRef = useRef<Sample[]>([]);
  const yoRef = useRef<Sample[]>([]);
  const vRef = useRef<number>(0);
  const lastHeRef = useRef<number>(0);
  const lastYoRef = useRef<number>(0);
  const liveRef = useRef<number>(0);   // 最近收到 YHE/YYO 的时刻 (判 hold-active)

  // 拉取当前增益 (mount 时)
  useEffect(() => {
    if (gcs.isConnected()) GAINS.forEach(g => gcs.readParam(g.key));
  }, []);

  // 订阅 YHE/YYO + V
  useEffect(() => {
    const trim = (arr: Sample[], now: number) => {
      const cut = now - WIN_S;
      while (arr.length && arr[0].t < cut) arr.shift();
    };
    const off = gcs.on((m: GcsMessage) => {
      const now = Date.now() / 1000;
      if (m.type === 'named_float') {
        const nm = (m as any).name, val = (m as any).value;
        if (nm === 'YHE') { heRef.current.push({ t: now, v: val }); lastHeRef.current = val; liveRef.current = now; trim(heRef.current, now); }
        else if (nm === 'YYO') { yoRef.current.push({ t: now, v: val }); lastYoRef.current = val; trim(yoRef.current, now); }
      } else if (m.type === 'vfr_hud') {
        vRef.current = (m as any).airspeed;
      }
    });
    const tick = setInterval(() => force(x => x + 1), 250);   // 4Hz 刷 UI
    return () => { off(); clearInterval(tick); };
  }, []);

  const now = Date.now() / 1000;
  const live = now - liveRef.current < 1.5;   // 1.5s 内有 YHE → hold 激活中
  const he = heRef.current, yo = yoRef.current;
  const heRms = rms(he), hePeak = he.length ? Math.max(...he.map(s => Math.abs(s.v))) : 0;
  const yoRms = rms(yo), yoPeak = yo.length ? Math.max(...yo.map(s => Math.abs(s.v))) : 0;
  const satPct = yo.length ? 100 * yo.filter(s => Math.abs(s.v) > 0.95).length / yo.length : 0;
  const V = vRef.current;
  const angP = params['Q_A_ANG_YAW_P'] ?? GAINS[0].def;
  const ratP = params['Q_A_RAT_YAW_P'] ?? GAINS[1].def;

  // 实时建议 (复用 analyzer section 14 规则树)
  const suggestions: { sev: 'warn' | 'info'; title: string; data: string; advice: string }[] = [];
  if (live && he.length >= 10) {
    if (satPct > 20 && heRms > 10) {
      suggestions.push({ sev: 'warn', title: 'yaw 饱和+大误差 = KT 权限不足',
        data: `饱和 ${satPct.toFixed(0)}% + he RMS ${heRms.toFixed(0)}°`,
        advice: `调增益无效, yaw 撞满还转不动. 查 KT 差动/机械; 或 ANG_YAW_P ${angP.toFixed(1)}→${(angP * 0.7).toFixed(1)}` });
    } else if (satPct > 20) {
      suggestions.push({ sev: 'warn', title: 'yaw 小误差就饱和 = 增益过高',
        data: `饱和 ${satPct.toFixed(0)}% 但 he 仅 ${heRms.toFixed(1)}°`,
        advice: `RAT_YAW_P ${ratP.toFixed(3)}→${(ratP * 0.8).toFixed(3)} (降 20%)` });
    } else if (heRms > 5) {
      suggestions.push({ sev: 'warn', title: 'heading 锁不紧 (有余量)',
        data: `he RMS ${heRms.toFixed(1)}° > 5°, 饱和仅 ${satPct.toFixed(0)}%`,
        advice: `先 ANG_YAW_P ${angP.toFixed(1)}→${(angP * 1.3).toFixed(1)}; 仍松再 RAT_YAW_P ${ratP.toFixed(3)}→${(ratP * 1.3).toFixed(3)}` });
    } else {
      suggestions.push({ sev: 'info', title: 'heading hold 良好',
        data: `he RMS ${heRms.toFixed(1)}° 饱和 ${satPct.toFixed(0)}%`, advice: '当前增益锁定紧且不饱和, 可保持' });
    }
  }

  const applyGain = (key: string, v: number) => {
    const nv = Math.max(0, Number(v.toFixed(4)));
    setParam(key, nv);
    if (gcs.isConnected()) gcs.setParam(key, nv);
  };

  const Bar = ({ pct, color }: { pct: number; color: string }) => (
    <div style={{ background: '#1f2937', borderRadius: 4, height: 8, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: color, transition: 'width .2s' }} />
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="card flex items-center gap-4 py-2">
        <div className="card-title m-0">Yaw 实时调参</div>
        <span className={`text-xs px-2 py-0.5 rounded ${live ? 'bg-green-700' : 'bg-gray-600'}`}>
          {live ? '● heading-hold 激活' : '○ 未激活 (需 AUTO mode27 + CRUISE/TURN)'}
        </span>
        <span className="text-xs text-gray-400">V = {V.toFixed(1)} m/s</span>
      </div>

      {/* 实时指标 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="card">
          <div className="card-title">angle 环 — heading 误差</div>
          <div className="text-2xl font-mono">{lastHeRef.current.toFixed(1)}°</div>
          <div className="text-xs text-gray-400 mb-1">RMS {heRms.toFixed(1)}° · 峰值 {hePeak.toFixed(0)}° (窗口 {WIN_S}s)</div>
          <Bar pct={heRms / 30 * 100} color={heRms > 5 ? '#f59e0b' : '#22c55e'} />
        </div>
        <div className="card">
          <div className="card-title">rate 环 — yaw 输出 (KT 差动量)</div>
          <div className="text-2xl font-mono">{lastYoRef.current.toFixed(3)}</div>
          <div className="text-xs text-gray-400 mb-1">RMS {yoRms.toFixed(3)} · 饱和 {satPct.toFixed(0)}% (|yo|&gt;0.95)</div>
          <Bar pct={satPct} color={satPct > 20 ? '#ef4444' : satPct > 5 ? '#f59e0b' : '#22c55e'} />
        </div>
      </div>

      {/* 增益编辑 */}
      <div className="card">
        <div className="card-title">增益 (改了当场看响应)</div>
        <div className="flex flex-col gap-2">
          {GAINS.map(g => {
            const v = params[g.key] ?? g.def;
            return (
              <div key={g.key} className="flex items-center gap-2">
                <div className="w-32 text-sm font-mono">{g.label}</div>
                <button className="btn text-[11px] py-0.5 px-2" onClick={() => applyGain(g.key, v - g.step)}>−</button>
                <input className="input w-24 text-center font-mono" type="number" step={g.step}
                  value={v} onChange={e => applyGain(g.key, parseFloat(e.target.value) || 0)} />
                <button className="btn text-[11px] py-0.5 px-2" onClick={() => applyGain(g.key, v + g.step)}>+</button>
                <span className="text-xs text-gray-400">{g.hint}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 实时建议 */}
      <div className="card">
        <div className="card-title">实时建议 (滚动 {WIN_S}s 窗口)</div>
        {!live && <div className="text-sm text-gray-400">等 heading-hold 激活 (AUTO mode 27 进 CRUISE/TURN)...</div>}
        {live && he.length < 10 && <div className="text-sm text-gray-400">采集中...</div>}
        {suggestions.map((s, i) => (
          <div key={i} className="mb-2 p-2 rounded" style={{ border: `1px solid ${s.sev === 'warn' ? '#f59e0b' : '#22c55e'}` }}>
            <div className="font-semibold text-sm">{s.sev === 'warn' ? '⚠' : 'ℹ'} {s.title}</div>
            <div className="text-xs text-gray-400">数据: {s.data}</div>
            <div className="text-xs" style={{ color: '#60a5fa' }}>建议: {s.advice}</div>
          </div>
        ))}
      </div>

      <div className="text-xs text-gray-500">
        提示: 飞 AUTO mode 27 进 CRUISE, 拨一档 ANG_YAW_P 当场看 heading 误差 RMS 变化;
        rate 环饱和率 &gt;20% 说明 KT 权限到顶 (调增益无效, 上水验). 数据走 NVF@5Hz, 不用拔 SD.
      </div>
    </div>
  );
}
