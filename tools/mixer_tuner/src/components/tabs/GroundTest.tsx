// v9 P7.5: 地面测试独立 tab (旧 Auto.tsx Section 6 拆出来)
//
// WIG_AUTO mode 27 + WIGA_GTEST_EN=1 → armed 边沿 lua 锁定一个 phase, 不自动推进.
// Emergency (角度+rate+monotonic) / L3 set_mode(29) / C++ heartbeat 全保留.
// 软退档 (timeout/振荡/Layer/DUR 计时) 全关.

import React from 'react';
import { useStore } from '../../store/useStore';
import { gcs } from '../../lib/gcs';
import { paramRange } from '../../lib/defaults';
import { NumInput } from '../common/NumInput';
import { AlertTriangle, RotateCcw, Save } from 'lucide-react';

// 6 phase 中英标签 (跟 wig_auto.lua GTEST_PH_MAP 一致)
const PHASE_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '1·浮筒滑水 (FLOAT_TAXI)' },
  { value: 2, label: '2·跃迁抬头 (TRANS_A)' },
  { value: 3, label: '3·跃迁推力 (TRANS_B)' },
  { value: 4, label: '4·跃迁速度环 (TRANS_C)' },
  { value: 5, label: '5·巡航 (CRUISE)' },
  { value: 6, label: '6·转向 (TURN)' },
];

const GTEST_KEYS = ['WIGA_GTEST_EN', 'WIGA_GTEST_PH', 'WIGA_GTEST_CAP'];

export function GroundTest() {
  const { params, setParam } = useStore();
  const [savedSnap, setSavedSnap] = React.useState<Record<string, number>>(() => {
    const s: Record<string, number> = {};
    for (const k of GTEST_KEYS) if (k in params) s[k] = params[k];
    return s;
  });
  const [statusMsg, setStatusMsg] = React.useState<string | null>(null);

  // dirty: 本地 ≠ 上次 saved
  const dirty = GTEST_KEYS.filter(k => {
    const cur = params[k];
    const snap = savedSnap[k];
    if (cur == null) return false;
    return snap == null || Math.abs(cur - snap) > 0.001;
  });

  const setLocal = (k: string, v: number) => setParam(k, v);

  const onSave = () => {
    if (!gcs.isConnected()) {
      setStatusMsg('⚠ 未连接 FC');
      setTimeout(() => setStatusMsg(null), 3000);
      return;
    }
    for (const k of dirty) gcs.setParam(k, params[k]);
    setSavedSnap(prev => ({ ...prev, ...Object.fromEntries(dirty.map(k => [k, params[k]])) }));
    setStatusMsg(`✓ 已保存 ${dirty.length} 个参数`);
    setTimeout(() => setStatusMsg(null), 3000);
  };

  // 强制关闭 = 软退 (lua 看 EN=0 → transition(ABORT_L1))
  const onForceClose = () => {
    if (!gcs.isConnected()) return;
    gcs.setParam('WIGA_GTEST_EN', 0);
    setParam('WIGA_GTEST_EN', 0);
    setSavedSnap(prev => ({ ...prev, WIGA_GTEST_EN: 0 }));
    setStatusMsg('✓ 已强制关闭, lua 软退到 ABORT_L1');
    setTimeout(() => setStatusMsg(null), 3000);
  };

  return (
    <div className="space-y-3">
      {!gcs.isConnected() && (
        <div className="card border-warn">
          <div className="text-warn text-[12px] flex items-center gap-2">
            <AlertTriangle size={14} /> 未连接 mavbridge.py — 实时数据 / 参数写入不可用
          </div>
        </div>
      )}

      {/* 同步 toolbar */}
      <div className="card flex items-center gap-3 py-2">
        <span className="card-title mb-0 flex-1">地面测试同步 ({GTEST_KEYS.length})</span>
        <span className={'val-mono text-[11px] ' + (dirty.length > 0 ? 'text-warn' : 'text-fg-dim')}>
          {dirty.length > 0 ? `未保存 ${dirty.length} 项` : '与 FC 一致'}
        </span>
        {statusMsg && <span className="val-mono text-[11px] text-accent">{statusMsg}</span>}
        <button
          onClick={onSave}
          disabled={dirty.length === 0 || !gcs.isConnected()}
          className={'btn flex items-center gap-1.5 disabled:opacity-50 ' + (dirty.length > 0 ? 'btn-primary' : '')}
        >
          <Save size={12} /> 保存 ({dirty.length})
        </button>
      </div>

      {/* 主配置 */}
      <div className="card">
        <div className="card-title">Ground Test 强制相位锁 (P7.3: armed 边沿 latch)</div>
        <div className="space-y-3">
          {/* GTEST_EN */}
          <div className="grid grid-cols-[160px_1fr] gap-2 items-center">
            <span className="text-[11px] text-fg-mute">GTEST_EN</span>
            <div className="flex gap-2">
              <button
                onClick={() => setLocal('WIGA_GTEST_EN', 0)}
                className={'btn flex-1 text-[11px] ' + ((params.WIGA_GTEST_EN ?? 0) < 0.5 ? 'btn-primary' : '')}
              >OFF (正常 AUTO)</button>
              <button
                onClick={() => setLocal('WIGA_GTEST_EN', 1)}
                className={'btn flex-1 text-[11px] ' + ((params.WIGA_GTEST_EN ?? 0) >= 0.5 ? 'btn-primary' : '')}
              >ON (锁 phase)</button>
            </div>
          </div>

          {/* GTEST_PH 6 phase 单列 */}
          <div className="grid grid-cols-[160px_1fr] gap-2 items-start">
            <span className="text-[11px] text-fg-mute pt-1">Lock to phase</span>
            <div className="grid grid-cols-2 gap-2">
              {PHASE_OPTIONS.map(o => (
                <button
                  key={o.value}
                  onClick={() => setLocal('WIGA_GTEST_PH', o.value)}
                  className={'btn text-[11px] text-left ' + ((params.WIGA_GTEST_PH ?? 1) === o.value ? 'btn-primary' : '')}
                >{o.label}</button>
              ))}
            </div>
          </div>

          {/* GTEST_CAP NumInput */}
          <div className="grid grid-cols-[160px_140px_1fr] gap-2 items-center">
            <span className="text-[11px] text-fg-mute">GTEST_CAP (thr cap)</span>
            <NumInput
              value={params.WIGA_GTEST_CAP ?? 0.30}
              min={paramRange('WIGA_GTEST_CAP').min}
              max={paramRange('WIGA_GTEST_CAP').max}
              step={paramRange('WIGA_GTEST_CAP').step}
              onCommit={v => setLocal('WIGA_GTEST_CAP', v)}
              className="input val-mono w-full"
            />
            <span className="text-[10px] text-fg-dim">默认 0.30, 锁住后强制 thr_cap 这值</span>
          </div>
        </div>

        <div className="mt-4 text-[10px] text-fg-mute leading-snug space-y-1 border-t border-line pt-3">
          <div>• armed 边沿 latch: 改 EN/PH/CAP 后必须 <b>点保存 + disarm + arm</b> 才生效</div>
          <div>• 同时 latch <code>WIGA_CRUISE_MODE</code> (FV/RV) + <code>WIGA_TRANS_STRAT</code> (STEADY/BURST) — 影响 TRANS_A 检测 + CRUISE tilt 配方</div>
          <div>• 锁定后: 软退档 (timeout / 振荡 / Layer / DUR 计时) 全关; Emergency / L3 set_mode(29) / heartbeat watchdog 仍激活</div>
          <div>• 1Hz STATUSTEXT: <code>WIG_AUTO GTEST LOCK=&lt;phase&gt; cap=&lt;v&gt;</code></div>
        </div>

        <button
          onClick={onForceClose}
          disabled={(params.WIGA_GTEST_EN ?? 0) < 0.5 || !gcs.isConnected()}
          className="btn mt-3 text-[11px] border-warn text-warn hover:bg-warn/10"
          title="即刻写 WIGA_GTEST_EN=0 → lua 软退到 ABORT_L1 phase"
        >
          <RotateCcw size={11} className="inline mr-1" /> 强制关闭 GTEST_EN (软退 → ABORT_L1)
        </button>
      </div>
    </div>
  );
}
