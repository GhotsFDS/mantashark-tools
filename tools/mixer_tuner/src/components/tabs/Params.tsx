// 参数 tab — 仿 FlightProfile 全局拉取/保存 + dirty 计数 + fieldset 禁用
// 输入框只改本地 store, 显式按"保存"才下发 FC.
import React, { useRef, useState, useEffect, useMemo } from 'react';
import { useStore } from '../../store/useStore';
import { exportParm, importParm, exportPhaseLua, downloadText } from '../../lib/parmIO';
import { PARAM_PREFIXES, paramRange, paramLabel, SYNC_SKIP_RE, quantize, DEFAULT_PARAMS } from '../../lib/defaults';
import { gcs } from '../../lib/gcs';
import { Upload, Download, FileText, RotateCcw, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';

// 所有参与同步的 key (跟 App-level autoSync / GCS pullAll 同范围)
const SYNC_KEYS = Object.keys(DEFAULT_PARAMS).filter(k => !SYNC_SKIP_RE.test(k));

export function Params() {
  const { params, setParams, setParam, phaseConfig, resetDefaults } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string | null>(null);
  const [gcsConnected, setGcsConnected] = useState(gcs.isConnected());

  // 同步状态 (跟 FlightProfile 同模式)
  const [synced, setSynced] = useState<Record<string, number>>(() => {
    const s: Record<string, number> = {};
    for (const k of SYNC_KEYS) if (k in params) s[k] = params[k];
    return s;
  });
  const [busy, setBusy] = useState<'idle' | 'pulling' | 'pushing'>('idle');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    const off = gcs.on(m => { if (m.type === 'status') setGcsConnected(m.connected); });
    setGcsConnected(gcs.isConnected());
    return () => { off(); };
  }, []);

  // 连 FC 后 1.5s (等 App-level autoSync 落 store) 重置 synced 快照让 dirty=0
  useEffect(() => {
    if (!gcs.isConnected()) return;
    const t = setTimeout(() => {
      const fresh = useStore.getState().params;
      const s: Record<string, number> = {};
      for (const k of SYNC_KEYS) if (k in fresh) s[k] = fresh[k];
      setSynced(s);
    }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // dirty 计数 (容差 = step/2, 防 mavlink float32 round-trip 误判)
  const dirtyKeys = useMemo(() => {
    const d: string[] = [];
    for (const k of SYNC_KEYS) {
      const cur = params[k];
      const snap = synced[k];
      if (cur == null) continue;
      const step = paramRange(k).step ?? 0.01;
      const tol = step * 0.5;
      if (snap == null || Math.abs(quantize(k, cur) - quantize(k, snap)) > tol) d.push(k);
    }
    return d;
  }, [params, synced]);

  const onPull = async () => {
    if (busy !== 'idle') return;
    if (!gcsConnected) { setStatusMsg('⚠ 未连接 FC'); setTimeout(() => setStatusMsg(null), 3000); return; }
    setBusy('pulling');
    setStatusMsg(`拉取 0/${SYNC_KEYS.length}`);
    const r = await gcs.pullParams(SYNC_KEYS, (g, t) => setStatusMsg(`拉取 ${g}/${t}`));
    setTimeout(() => {
      const fresh = useStore.getState().params;
      const s: Record<string, number> = {};
      for (const k of SYNC_KEYS) if (k in fresh) s[k] = fresh[k];
      setSynced(s);
    }, 100);
    setStatusMsg(r.timedOut
      ? `⚠ 拉取超时 ${r.got}/${SYNC_KEYS.length}, 缺 ${r.missing.length}`
      : `✓ 已拉取 ${r.got} 个参数`);
    setBusy('idle');
    setTimeout(() => setStatusMsg(null), 4000);
  };

  const onSave = async () => {
    if (busy !== 'idle') return;
    if (!gcsConnected) { setStatusMsg('⚠ 未连接 FC'); setTimeout(() => setStatusMsg(null), 3000); return; }
    if (dirtyKeys.length === 0) { setStatusMsg('已是最新, 无需保存'); setTimeout(() => setStatusMsg(null), 2500); return; }
    setBusy('pushing');
    const map: Record<string, number> = {};
    for (const k of dirtyKeys) map[k] = quantize(k, params[k]);
    setStatusMsg(`保存 0/${dirtyKeys.length}`);
    const r = await gcs.pushParams(map, (a, t) => setStatusMsg(`保存 ${a}/${t}`));
    setSynced(prev => {
      const next = { ...prev };
      for (const k of dirtyKeys) {
        if (!r.missing.includes(k)) next[k] = params[k];
      }
      return next;
    });
    setStatusMsg(r.timedOut
      ? `⚠ 保存超时 ${r.acked}/${dirtyKeys.length}, 缺 ${r.missing.length}`
      : `✓ 已保存 ${r.acked} 个参数`);
    setBusy('idle');
    setTimeout(() => setStatusMsg(null), 4000);
  };

  const doExport = () => {
    downloadText('mantashark_v9.parm', exportParm(params));
    setLog('已导出 mantashark_v9.parm');
  };
  const doImport = () => fileRef.current?.click();
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      const res = importParm(ev.target?.result as string, params);
      setParams(res.updated);
      setLog(`导入 ${res.count} 个参数${res.unknown.length ? `, 未知 ${res.unknown.length} 个 (${res.unknown.slice(0,3).join(', ')}${res.unknown.length>3?'...':''})` : ''}`);
    };
    r.readAsText(f);
  };
  const doExportLua = () => {
    downloadText('phase_config.lua', exportPhaseLua(phaseConfig));
    setLog('已导出 phase_config.lua');
  };
  const doReset = () => {
    if (!confirm('重置所有参数为默认值?')) return;
    resetDefaults();
    setLog('已重置为默认');
  };

  return (
    <div className="space-y-3">
      {/* 全局 Pull/Save toolbar (跟 FlightProfile 同模式) */}
      <div className="card flex items-center gap-3 py-2">
        <span className="card-title mb-0 flex-1">参数同步 (全部 {SYNC_KEYS.length} 个)</span>
        <span className={
          'val-mono text-[11px] ' +
          (dirtyKeys.length > 0 ? 'text-warn' : 'text-fg-dim')
        }>
          {dirtyKeys.length > 0 ? `未保存 ${dirtyKeys.length} 项` : '与 FC 一致'}
        </span>
        {statusMsg && <span className="val-mono text-[11px] text-accent">{statusMsg}</span>}
        <button
          onClick={onPull}
          disabled={busy !== 'idle' || !gcsConnected}
          className="btn flex items-center gap-1.5 disabled:opacity-50"
          title={gcsConnected ? `从飞控读取 ${SYNC_KEYS.length} 个参数, 覆盖本地 (放弃未保存修改)` : '先连接 FC'}
        >
          <Download size={12} />
          拉取 ({SYNC_KEYS.length})
        </button>
        <button
          onClick={onSave}
          disabled={busy !== 'idle' || dirtyKeys.length === 0 || !gcsConnected}
          className={'btn flex items-center gap-1.5 disabled:opacity-50 ' + (dirtyKeys.length > 0 ? 'btn-primary' : '')}
          title={gcsConnected ? '把本地修改下发到飞控 (仅推送已修改项)' : '先连接 FC'}
        >
          <Upload size={12} />
          保存 ({dirtyKeys.length})
        </button>
      </div>

      {/* 文件导入/导出工具栏 */}
      <div className="card">
        <div className="card-title flex items-center gap-2">
          <span>文件 / 重置</span>
          {!gcsConnected && (
            <span className="chip text-[9px] text-warn ml-auto">未连接 FC · 拉取/保存按钮禁用</span>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-primary" onClick={doExport}>
            <Download size={12} className="inline mr-1" /> 导出 .parm (ArduPilot)
          </button>
          <button className="btn" onClick={doImport}>
            <Upload size={12} className="inline mr-1" /> 导入 .parm
          </button>
          <button className="btn" onClick={doExportLua}>
            <FileText size={12} className="inline mr-1" /> 导出 phase_config.lua
          </button>
          <button className="btn btn-warn ml-auto" onClick={doReset}>
            <RotateCcw size={12} className="inline mr-1" /> 重置默认
          </button>
          <input ref={fileRef} type="file" accept=".parm,.txt" style={{display:'none'}} onChange={onFile} />
        </div>
        {log && <div className="mt-2 text-[10px] text-ok">✓ {log}</div>}
      </div>

      {/* 拉取/保存中禁用所有输入 */}
      <fieldset disabled={busy !== 'idle'} className={'space-y-3 ' + (busy !== 'idle' ? 'opacity-60 pointer-events-none' : '')}>

      {/* 三组分组展示 (无独立按钮, 只是视觉分组 + 中文说明) */}
      {PARAM_PREFIXES.map(pfx => (
        <ParamTable key={pfx} prefix={pfx} dirtyKeys={dirtyKeys} setParam={setParam} />
      ))}

      </fieldset>
    </div>
  );
}

function ParamTable({ prefix, dirtyKeys, setParam }: { prefix: string; dirtyKeys: string[]; setParam: (k: string, v: number) => void }) {
  const { params } = useStore();
  // 只显示参与同步的 key
  const syncKeys = Object.keys(params)
    .filter(k => k.startsWith(prefix + '_') && !SYNC_SKIP_RE.test(k))
    .sort();
  if (syncKeys.length === 0) return null;
  const myDirty = dirtyKeys.filter(k => k.startsWith(prefix + '_')).length;

  return (
    <div className="card">
      <div className="card-title flex items-center gap-2 mb-2">
        <span>{prefix}_ <span className="text-[10px] text-fg-dim font-normal">({syncKeys.length})</span></span>
        {myDirty > 0 && (
          <span className="chip text-[10px] text-warn">未保存 {myDirty}</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        {syncKeys.map(k => {
          const r = paramRange(k);
          const desc = paramLabel(k);
          const isDirty = dirtyKeys.includes(k);
          return (
            <div key={k} className="flex items-center gap-2 min-w-0">
              <span className={'label val-mono w-32 shrink-0 truncate ' + (isDirty ? 'text-warn' : '')} title={k}>
                {isDirty && '● '}{k}
              </span>
              {desc ? (
                <span className="text-[10px] text-fg-mute truncate flex-1 min-w-0" title={desc}>{desc}</span>
              ) : (
                <span className="flex-1 min-w-0" />
              )}
              <input
                type="number"
                min={r.min} max={r.max} step={r.step}
                value={quantize(k, params[k] ?? 0)}
                onChange={e => setParam(k, quantize(k, parseFloat(e.target.value) || 0))}
                className={'input val-mono w-20 text-right text-[10px] shrink-0 ' + (isDirty ? 'ring-1 ring-warn' : '')}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
