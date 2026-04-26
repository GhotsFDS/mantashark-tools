import React, { useMemo, useState, useEffect } from 'react';
import { CurveEditor } from '../common/CurveEditor';
import { useStore } from '../../store/useStore';
import type { GroupKey, TiltId } from '../../lib/types';
import { TILT_IDS, PHASES, GROUP_COLORS, GROUP_LABELS, TILTS, MOTORS, SINGLE_MOTOR_MAX_N, VEHICLE_WEIGHT_N } from '../../lib/actuators';
import { pchip5 } from '../../lib/pchip';
import { gcs } from '../../lib/gcs';
import { Upload, Download, Link2 } from 'lucide-react';

interface Props {
  effectiveSpeed: number;
  currentK: Record<GroupKey, number>;
}

// K 组 → 该组关联的 tilt id
const K_TO_TILTS: Record<GroupKey, TiltId[]> = {
  KS:  ['S_GROUP_TILT'],
  KDF: ['DFL', 'DFR'],
  KT:  ['TL1', 'TR1'],
  KRD: ['RDL', 'RDR'],
};

const ALIAS_MAP: Record<TiltId, string> = {
  DFL:'DFL', DFR:'DFR', TL1:'TL1', TR1:'TR1', RDL:'RDL', RDR:'RDR', S_GROUP_TILT:'SGRP',
};

export function FlightProfile({ effectiveSpeed, currentK }: Props) {
  const { params, setParam, selectedCurve, setSelectedCurve, setPhaseConfig,
          phaseConfig, currentPhase, currentSpeed, setSpeed, currentGear, setGear, simulateArmed,
          curveMode, setCurveMode, mergeLR, setMergeLR } = useStore();

  const [gcsConnected, setGcsConnected] = useState(gcs.isConnected());
  useEffect(() => {
    const off = gcs.on(m => { if (m.type === 'status') setGcsConnected(m.connected); });
    setGcsConnected(gcs.isConnected());
    return () => { off(); };
  }, []);

  const V1 = params.MSK_V1, V2 = params.MSK_V2;
  const isK = curveMode === 'k';
  const isJoint = curveMode === 'joint';

  // joint 模式下倾转曲线限制 (selectedCurve 关联的 tilt series id)
  const tiltRestrict = useMemo(() => {
    if (mergeLR) {
      return { KS:['SGRP'], KDF:['DF'], KT:['T1'], KRD:['RD'] }[selectedCurve];
    }
    return {
      KS: ['SGRP'],
      KDF: ['DFL','DFR'],
      KT:  ['TL1','TR1'],
      KRD: ['RDL','RDR'],
    }[selectedCurve];
  }, [selectedCurve, mergeLR]);

  // 当前 K 组关联的 tilt 实时角度
  const liveTilts = useMemo(() => {
    const out: Record<TiltId, number> = {} as any;
    for (const t of TILTS) {
      const a = ALIAS_MAP[t.id];
      const K = [0,1,2,3,4].map(i => params[`TLTC_${a}_K${i}`] ?? 45);
      out[t.id] = pchip5(effectiveSpeed, V1, V2, params.MSK_V3, params.MSK_V_MAX, K[0],K[1],K[2],K[3],K[4]);
    }
    return out;
  }, [effectiveSpeed, params, V1, V2]);

  const tiltsForGroup = K_TO_TILTS[selectedCurve];

  // ─── 力平衡 (基于当前 K) ───
  const totalThrust = MOTORS.reduce((s, m) => s + Math.max(0, Math.min(1, currentK[m.group] ?? 0)) * SINGLE_MOTOR_MAX_N, 0);
  const tw = totalThrust / VEHICLE_WEIGHT_N;
  const liftMargin = totalThrust - VEHICLE_WEIGHT_N;

  // 当前 mode 涉及的参数 keys
  const curveKeys = useMemo(() => {
    if (isK) {
      const ks: string[] = ['MSK_V1','MSK_V2','MSK_V3','MSK_V_MAX'];
      for (const g of ['KS','KDF','KT','KRD']) {
        for (let i=0; i<5; i++) ks.push(`MSK_${g}${i}`);
      }
      return ks;
    } else {
      const ks: string[] = [];
      for (const t of TILTS) for (let i=0; i<5; i++) ks.push(`TLTC_${t.alias}_K${i}`);
      return ks;
    }
  }, [isK]);

  const [syncBusy, setSyncBusy] = useState<null | { mode:'pull'|'push'; got:number; total:number; msg?:string }>(null);

  const saveCurves = async () => {
    if (syncBusy) return;
    if (!gcs.isConnected()) { setSyncBusy({ mode:'push', got:0, total:0, msg:'❌ 未连接 FC' }); setTimeout(() => setSyncBusy(null), 2500); return; }
    const map: Record<string, number> = {};
    for (const k of curveKeys) if (k in params) map[k] = params[k];
    setSyncBusy({ mode:'push', got:0, total:Object.keys(map).length });
    const r = await gcs.pushParams(map, (s, t) => setSyncBusy({ mode:'push', got:s, total:t }));
    setSyncBusy({ mode:'push', got:r.acked, total:Object.keys(map).length,
      msg: r.timedOut ? `⚠ 超时 ack ${r.acked}/${Object.keys(map).length}` : `✓ 已保存 ${r.acked}` });
    setTimeout(() => setSyncBusy(null), 2500);
  };
  const pullCurves = async () => {
    if (syncBusy) return;
    if (!gcs.isConnected()) { setSyncBusy({ mode:'pull', got:0, total:0, msg:'❌ 未连接 FC' }); setTimeout(() => setSyncBusy(null), 2500); return; }
    setSyncBusy({ mode:'pull', got:0, total:curveKeys.length });
    const r = await gcs.pullParams(curveKeys, (g, t) => setSyncBusy({ mode:'pull', got:g, total:t }));
    setSyncBusy({ mode:'pull', got:r.got, total:curveKeys.length,
      msg: r.timedOut ? `⚠ 超时 ${r.got}/${curveKeys.length}` : `✓ 已拉取 ${r.got}` });
    setTimeout(() => setSyncBusy(null), 2500);
  };

  return (
    <div className="grid grid-cols-12 gap-3">
      {/* ═══ 顶部行: 速度 + 档位 + 模式切换 + 同步 (单行紧凑, 组别由曲线下方 chip 选) ═══ */}
      <div className="card col-span-12 py-2">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-[260px] flex-1">
            <span className="label whitespace-nowrap">速度</span>
            <input type="range" min={0} max={params.MSK_V_MAX ?? 20} step={0.1}
                   value={currentSpeed}
                   onChange={e => setSpeed(parseFloat(e.target.value))}
                   className="slider flex-1" />
            <span className="val-mono text-accent w-14 text-right">{currentSpeed.toFixed(1)}</span>
            <span className="text-fg-dim text-[10px]">m/s</span>
          </div>
          <div className="flex border border-line rounded overflow-hidden">
            {[1,2,3].map(g => (
              <button key={g} onClick={() => setGear(g as 1|2|3)}
                      className={'px-2 py-1 text-[11px] ' + (currentGear === g ? 'bg-accent text-bg' : 'text-fg-mute hover:text-fg')}>
                档{g}{g===1?' V1':g===2?' V2':' 全'}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-fg-dim">评估 {effectiveSpeed.toFixed(1)}</span>

          <label className="flex items-center gap-1 text-[10px] cursor-pointer">
            <input type="checkbox" checked={mergeLR}
                   onChange={e => setMergeLR(e.target.checked)}
                   className="accent-accent" />
            <Link2 size={10}/>合并左右
          </label>

          <div className="flex border border-line rounded overflow-hidden">
            <button className={'px-3 py-1 text-[11px] ' + (curveMode === 'joint' ? 'bg-accent text-bg' : 'text-fg-mute hover:text-fg')}
                    onClick={() => setCurveMode('joint')} title="联调: 当前组 K + 关联倾转 同图双 Y 轴">联调</button>
            <button className={'px-3 py-1 text-[11px] border-l border-line ' + (curveMode === 'k' ? 'bg-accent text-bg' : 'text-fg-mute hover:text-fg')}
                    onClick={() => setCurveMode('k')}>K 曲线</button>
            <button className={'px-3 py-1 text-[11px] border-l border-line ' + (curveMode === 'tilt' ? 'bg-accent text-bg' : 'text-fg-mute hover:text-fg')}
                    onClick={() => setCurveMode('tilt')}>倾转曲线</button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {syncBusy && !syncBusy.msg && <span className="text-[10px] text-accent val-mono">{syncBusy.mode==='pull'?'⇣':'⇡'} {syncBusy.got}/{syncBusy.total}</span>}
            {syncBusy?.msg && <span className={'text-[10px] val-mono ' + (syncBusy.msg.startsWith('✓') ? 'text-ok' : 'text-warn')}>{syncBusy.msg}</span>}
            <button className="btn text-[11px] py-0.5 px-2"
                    onClick={pullCurves} disabled={!!syncBusy || !gcsConnected}>
              <Download size={11} className="inline mr-0.5"/>拉取
            </button>
            <button className="btn btn-primary text-[11px] py-0.5 px-2"
                    onClick={saveCurves} disabled={!!syncBusy || !gcsConnected}>
              <Upload size={11} className="inline mr-0.5"/>保存
            </button>
          </div>
        </div>
      </div>

      {/* ═══ 主区: 单 CurveEditor (joint 自带双 Y 轴, K/倾转单图) ═══ */}
      <div className="card col-span-8">
        <div className="card-title flex items-center gap-2">
          {isJoint ? (
            <>
              <span style={{ color: GROUP_COLORS[selectedCurve] }}>● 联调 {selectedCurve}</span>
              <span className="text-[10px] text-fg-dim font-normal">
                K (实线 ← 左轴) + 关联倾转 (虚线 → 右轴 °)
              </span>
            </>
          ) : (
            <>
              {isK ? 'K 曲线' : '倾转曲线'}
              <span className="text-[10px] text-fg-dim font-normal">
                {isK ? '4 组 · 速度 → 油门系数' : `7 路 tilt · 速度 → abs°`}
              </span>
            </>
          )}
        </div>
        <CurveEditor effectiveSpeed={effectiveSpeed} height={420} showAll={true} mode={curveMode}/>
      </div>

      {/* 右侧: 实时数值 + 力平衡 */}
      <div className="col-span-4 flex flex-col gap-3">
        {/* 当前组实时值 (flex-1 撑满剩余高度对齐左侧曲线) */}
        <div className="card flex-1 flex flex-col">
          <div className="card-title text-[11px]">@ {effectiveSpeed.toFixed(1)} m/s 实时</div>
          <div className="space-y-1.5">
            {(['KS','KDF','KT','KRD'] as GroupKey[]).map(g => (
              <div key={g} className="flex items-center gap-2">
                <span className="val-mono text-[10px] w-10" style={{ color: GROUP_COLORS[g] }}>{g}</span>
                <div className="h-1.5 bg-panel-2 rounded overflow-hidden flex-1">
                  <div className="h-full transition-all" style={{ width: (currentK[g]*100)+'%', background: GROUP_COLORS[g] }} />
                </div>
                <span className="val-mono text-[10px] w-10 text-right">{(currentK[g]*100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
          <div className="card-section mt-2">关联 tilt</div>
          <div className="space-y-0.5">
            {tiltsForGroup.map(tid => (
              <div key={tid} className="flex items-center text-[10px]">
                <span className="val-mono w-16">{tid}</span>
                <span className="val-mono ml-auto">{liveTilts[tid].toFixed(0)}°</span>
                <span className="text-fg-dim ml-1">({(liveTilts[tid]-45 >= 0 ? '+':'')}{(liveTilts[tid]-45).toFixed(0)})</span>
              </div>
            ))}
          </div>
        </div>

        {/* 力平衡 */}
        <div className="card">
          <div className="card-title text-[11px]">力平衡 @ 100% 油门</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-[9px] text-fg-mute">总推力</div>
              <div className="val-mono text-[14px]">{totalThrust.toFixed(0)}<span className="text-fg-dim text-[9px]">N</span></div>
            </div>
            <div>
              <div className="text-[9px] text-fg-mute">机重</div>
              <div className="val-mono text-[14px]">{VEHICLE_WEIGHT_N}<span className="text-fg-dim text-[9px]">N</span></div>
            </div>
            <div>
              <div className="text-[9px] text-fg-mute">T/W</div>
              <div className={'val-mono text-[14px] ' + (tw < 1 ? 'text-err' : tw < 1.5 ? 'text-warn' : 'text-ok')}>
                {tw.toFixed(2)}
              </div>
            </div>
          </div>
          <div className="mt-2 text-[10px] text-center">
            <span className="text-fg-mute">富余 </span>
            <span className={'val-mono ' + (liftMargin < 0 ? 'text-err' : liftMargin < 20 ? 'text-warn' : 'text-ok')}>
              {liftMargin >= 0 ? '+' : ''}{liftMargin.toFixed(0)} N
            </span>
          </div>
        </div>

        {/* Phase 信息 (离线 reference) */}
        <div className="card border border-warn/20">
          <div className="card-title text-[10px] flex items-center gap-1">
            离线 Phase <span className="chip text-[8px] text-warn">未接入飞控</span>
          </div>
          <div className="text-[10px] text-fg-mute">
            根据 V1/V2 推断: <b className={'val-mono ' + (currentPhase === 'EMERGENCY' ? 'text-err' : 'text-accent')}>{currentPhase}</b>
          </div>
          <div className="text-[9px] text-fg-dim mt-1">飞控用 v7 三档 (RC ch{params.MSK_GEAR_CH ?? 7})</div>
        </div>
      </div>

      {/* ═══ 底部: 阶段配置表 (折叠, 离线 reference) ═══ */}
      <details className="card col-span-12">
        <summary className="cursor-pointer card-title flex items-center gap-2 mb-0">
          阶段配置 (PHASE_CONFIG, 离线 reference)
          <span className="chip text-[9px] text-warn">未接入飞控</span>
          <span className="text-[10px] text-fg-dim font-normal">点击展开</span>
        </summary>
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-fg-mute border-b border-line">
                <th className="text-left p-1">Phase</th>
                <th className="text-center p-1">Q_TRIM°</th>
                {TILT_IDS.map(id => <th key={id} className="text-center p-1 min-w-[55px]">{id}</th>)}
              </tr>
            </thead>
            <tbody>
              {PHASES.map(p => (
                <tr key={p} className="border-b border-line/30">
                  <td className="p-1 val-mono">{p}</td>
                  <td className="p-1">
                    <input type="number" step={0.5}
                           value={phaseConfig[p].trim}
                           onChange={e => setPhaseConfig(p, 'trim', parseFloat(e.target.value) || 0)}
                           className="input w-full val-mono text-right text-[10px]" />
                  </td>
                  {TILT_IDS.map(id => (
                    <td key={id} className="p-1">
                      <input type="number" step={1}
                             value={phaseConfig[p].tilts[id]}
                             onChange={e => setPhaseConfig(p, id, parseFloat(e.target.value) || 0)}
                             className="input w-full val-mono text-right text-[10px]" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
