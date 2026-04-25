import React, { useRef, useState, useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { exportParm, importParm, exportPhaseLua, downloadText } from '../../lib/parmIO';
import { PARAM_PREFIXES, paramRange, paramLabel, SYNC_SKIP_RE, quantize } from '../../lib/defaults';
import { gcs } from '../../lib/gcs';
import { Upload, Download, FileText, RotateCcw, ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';

type SyncState = null | { mode:'pull'|'push'; prefix:string; got:number; total:number; msg?:string };

export function Params() {
  const { params, setParams, phaseConfig, resetDefaults } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState<SyncState>(null);
  const [gcsConnected, setGcsConnected] = useState(gcs.isConnected());

  useEffect(() => {
    const off = gcs.on(m => { if (m.type === 'status') setGcsConnected(m.connected); });
    setGcsConnected(gcs.isConnected());
    return () => { off(); };
  }, []);

  const doExport = () => {
    downloadText('mantashark_v8.parm', exportParm(params));
    setLog('已导出 mantashark_v8.parm');
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

  // 拉取整组
  const pullPrefix = async (pfx: string) => {
    if (syncBusy) return;
    if (!gcsConnected) {
      setSyncBusy({ mode:'pull', prefix:pfx, got:0, total:0, msg:'❌ 未连接 FC, 先去 GCS tab 连接' });
      setTimeout(() => setSyncBusy(null), 2500);
      return;
    }
    const keys = Object.keys(params).filter(k => k.startsWith(pfx + '_') && !SYNC_SKIP_RE.test(k));
    setSyncBusy({ mode:'pull', prefix:pfx, got:0, total:keys.length });
    const r = await gcs.pullParams(keys, (g, t) => setSyncBusy({ mode:'pull', prefix:pfx, got:g, total:t }));
    setSyncBusy({ mode:'pull', prefix:pfx, got:r.got, total:keys.length,
      msg: r.timedOut ? `⚠ 超时, 收到 ${r.got}/${keys.length}, 缺 ${r.missing.length}` : `✓ ${pfx}_ 已拉取 ${r.got}` });
    setTimeout(() => setSyncBusy(null), 3000);
  };
  const pushPrefix = async (pfx: string) => {
    if (syncBusy) return;
    if (!gcsConnected) {
      setSyncBusy({ mode:'push', prefix:pfx, got:0, total:0, msg:'❌ 未连接 FC, 先去 GCS tab 连接' });
      setTimeout(() => setSyncBusy(null), 2500);
      return;
    }
    const keys = Object.keys(params).filter(k => k.startsWith(pfx + '_') && !SYNC_SKIP_RE.test(k));
    const map: Record<string, number> = {};
    keys.forEach(k => map[k] = params[k]);
    setSyncBusy({ mode:'push', prefix:pfx, got:0, total:keys.length });
    const r = await gcs.pushParams(map, (s, t) => setSyncBusy({ mode:'push', prefix:pfx, got:s, total:t }));
    setSyncBusy({ mode:'push', prefix:pfx, got:r.acked, total:keys.length,
      msg: r.timedOut ? `⚠ 超时, ack ${r.acked}/${keys.length}, 缺 ${r.missing.length}` : `✓ ${pfx}_ 已保存 ${r.acked}` });
    setTimeout(() => setSyncBusy(null), 3000);
  };

  const groupsCount = PARAM_PREFIXES.reduce((acc, p) => {
    acc[p] = Object.keys(params).filter(k => k.startsWith(p + '_')).length;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="space-y-3">
      <div className="card">
        <div className="card-title flex items-center gap-2">
          <span>导入 / 导出</span>
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

      <div className="grid grid-cols-4 gap-3 text-center">
        {PARAM_PREFIXES.map(p => (
          <div key={p} className="card">
            <div className="text-[10px] text-fg-mute">{p}_ 参数</div>
            <div className="val-mono text-[18px] text-accent">{groupsCount[p]}</div>
            <div className="text-[9px] text-fg-dim">{
              p === 'MSK' ? 'mixer K 曲线 + V 断点' :
              p === 'TLT' ? 'tilt_driver 舵机标定' :
              p === 'GRD' ? 'guard 姿态' :
              p === 'PRE' ? 'preflight 预检' :
              p === 'MGEO' ? '电机几何系数' :
              p === 'TLTC' ? '倾转曲线' :
              p === 'LAY'  ? '布局位置 (UI 持久化)' : ''
            }</div>
          </div>
        ))}
      </div>

      {PARAM_PREFIXES.map(pfx => (
        <ParamTable
          key={pfx} prefix={pfx}
          pullPrefix={pullPrefix} pushPrefix={pushPrefix}
          syncBusy={syncBusy} gcsConnected={gcsConnected}
        />
      ))}
    </div>
  );
}

interface ParamTableProps {
  prefix: string;
  pullPrefix: (p: string) => void;
  pushPrefix: (p: string) => void;
  syncBusy: SyncState;
  gcsConnected: boolean;
}

function ParamTable({ prefix, pullPrefix, pushPrefix, syncBusy, gcsConnected }: ParamTableProps) {
  const { params, setParam } = useStore();
  const keys = Object.keys(params).filter(k => k.startsWith(prefix + '_')).sort();
  if (keys.length === 0) return null;

  const myBusy = syncBusy && syncBusy.prefix === prefix;
  const otherBusy = syncBusy && syncBusy.prefix !== prefix;

  return (
    <div className="card">
      <div className="flex items-center mb-2 gap-2">
        <div className="card-title mb-0 flex-1">{prefix}_ <span className="text-[10px] text-fg-dim font-normal">({keys.length})</span></div>
        {myBusy && !myBusy.msg && (
          <span className="text-[10px] text-accent val-mono">
            {myBusy.mode === 'pull' ? '⇣ 拉取中' : '⇡ 保存中'} {myBusy.got}/{myBusy.total}
          </span>
        )}
        {myBusy?.msg && (
          <span className={'text-[10px] val-mono ' + (myBusy.msg.startsWith('✓') ? 'text-ok' : 'text-warn')}>
            {myBusy.msg}
          </span>
        )}
        <button className="btn text-[10px] py-0.5 px-2"
                disabled={!gcsConnected || !!syncBusy}
                onClick={() => pullPrefix(prefix)}
                title={gcsConnected ? `从 FC 拉取 ${prefix}_` : '先去 GCS tab 连接 FC'}>
          <ArrowDownToLine size={11} className="inline mr-0.5"/>
          {myBusy?.mode === 'pull' && !myBusy.msg ? '拉取中…' : (otherBusy ? '请稍等' : '拉取')}
        </button>
        <button className="btn btn-primary text-[10px] py-0.5 px-2"
                disabled={!gcsConnected || !!syncBusy}
                onClick={() => pushPrefix(prefix)}
                title={gcsConnected ? `推送 ${prefix}_ 到 FC` : '先去 GCS tab 连接 FC'}>
          <ArrowUpFromLine size={11} className="inline mr-0.5"/>
          {myBusy?.mode === 'push' && !myBusy.msg ? '保存中…' : (otherBusy ? '请稍等' : '保存到 FC')}
        </button>
      </div>

      {/* 行布局: [参数名] [中文说明 truncate] [输入框] */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        {keys.map(k => {
          const r = paramRange(k);
          const desc = paramLabel(k);
          return (
            <div key={k} className="flex items-center gap-2 min-w-0">
              <span className="label val-mono w-32 shrink-0 truncate" title={k}>{k}</span>
              {desc ? (
                <span
                  className="text-[10px] text-fg-mute truncate flex-1 min-w-0"
                  title={desc}
                >{desc}</span>
              ) : (
                <span className="flex-1 min-w-0" />
              )}
              <input
                type="number"
                min={r.min} max={r.max} step={r.step}
                value={quantize(k, params[k] ?? 0)}
                onChange={e => setParam(k, quantize(k, parseFloat(e.target.value) || 0))}
                className="input val-mono w-20 text-right text-[10px] shrink-0"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
