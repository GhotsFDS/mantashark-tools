import React, { useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import { exportParm, importParm, exportPhaseLua, downloadText } from '../../lib/parmIO';
import { PARAM_PREFIXES, paramRange } from '../../lib/defaults';
import { Upload, Download, FileText, RotateCcw } from 'lucide-react';

export function Params() {
  const { params, setParams, phaseConfig, resetDefaults } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string | null>(null);

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

  const groupsCount = PARAM_PREFIXES.reduce((acc, p) => {
    acc[p] = Object.keys(params).filter(k => k.startsWith(p + '_')).length;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="space-y-3">
      <div className="card">
        <div className="card-title">导入 / 导出</div>
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
              p === 'PRE' ? 'preflight 预检' : ''
            }</div>
          </div>
        ))}
      </div>

      {PARAM_PREFIXES.map(pfx => (
        <ParamTable key={pfx} prefix={pfx} />
      ))}
    </div>
  );
}

function ParamTable({ prefix }: { prefix: string }) {
  const { params, setParam } = useStore();
  const keys = Object.keys(params).filter(k => k.startsWith(prefix + '_')).sort();

  return (
    <div className="card">
      <div className="card-title">{prefix}_</div>
      <div className="grid grid-cols-3 gap-x-6 gap-y-1">
        {keys.map(k => {
          const r = paramRange(k);
          return (
            <div key={k} className="flex items-center gap-2">
              <span className="label flex-1 truncate" title={k}>{k}</span>
              <input
                type="number"
                min={r.min} max={r.max} step={r.step}
                value={params[k]}
                onChange={e => setParam(k, parseFloat(e.target.value) || 0)}
                className="input val-mono w-24 text-right text-[10px]"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
