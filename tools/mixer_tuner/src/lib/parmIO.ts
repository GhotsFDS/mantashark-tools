// ArduPilot .parm 文件格式 I/O.
import type { ParamSet, PhaseConfig, PhaseName } from './types';
import { TILT_IDS } from './actuators';

// 导出为 .parm 文本 (ArduPilot GCS 兼容)
export function exportParm(params: ParamSet): string {
  let txt = '# MantaShark v8.0 混控参数 (由 mixer_tuner v9 导出)\n';
  txt += `# 生成: ${new Date().toISOString()}\n`;
  txt += `# 对应 Lua: scripts-plane/{mixer,tilt_driver,guard,preflight}.lua\n\n`;
  const groups: Record<string, string[]> = {
    MSK: [], TLT: [], GRD: [], PRE: [],
  };
  for (const k of Object.keys(params)) {
    const pfx = k.split('_')[0];
    if (pfx in groups) groups[pfx].push(k);
  }
  const order = ['MSK', 'TLT', 'GRD', 'PRE'];
  const titles: Record<string, string> = {
    MSK: 'mixer (25 K + 4 V, PCHIP 插值)',
    TLT: 'tilt_driver (7 ZERO + 7 DIR + 全局 PWM/deg + S→DF 耦合)',
    GRD: 'guard (Q_TRIM 斜率 + 姿态告警)',
    PRE: 'preflight (4 阶段地面预检)',
  };
  for (const pfx of order) {
    if (!groups[pfx].length) continue;
    txt += `# ═══ ${pfx}_ — ${titles[pfx]} ═══\n`;
    for (const k of groups[pfx].sort()) {
      const v = params[k];
      const vs = Number.isInteger(v) ? v.toString() : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
      txt += `${k.padEnd(22)} ${vs}\n`;
    }
    txt += '\n';
  }
  return txt;
}

// 从 .parm 文本解析
export function importParm(text: string, current: ParamSet): { updated: ParamSet; count: number; unknown: string[] } {
  const updated = { ...current };
  const unknown: string[] = [];
  let count = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z0-9_]+)[,\s]+(-?\d+\.?\d*([eE][-+]?\d+)?)/);
    if (!m) continue;
    const key = m[1];
    const val = parseFloat(m[2]);
    if (key in current) {
      updated[key] = val;
      count++;
    } else {
      unknown.push(key);
    }
  }
  return { updated, count, unknown };
}

// 导出 phase_config.lua 片段
export function exportPhaseLua(phaseConfig: Record<PhaseName, PhaseConfig>): string {
  let txt = '-- MantaShark v8 PHASE_CONFIG (mixer_tuner v9 导出)\n';
  txt += '-- 替换 scripts-plane/phases.lua 里 PHASE_CONFIG 块\n\n';
  txt += 'local PHASE_CONFIG = {\n';
  const order: PhaseName[] = ['STATIONARY', 'TAXI', 'CUSHION', 'GROUND_EFFECT', 'EMERGENCY'];
  for (const p of order) {
    const c = phaseConfig[p];
    txt += `    [STATE.${p}] = {\n`;
    txt += `        trim_deg = ${c.trim},\n`;
    txt += `        tilts = {\n`;
    for (const id of TILT_IDS) {
      txt += `            ${id} = ${c.tilts[id] ?? 0},\n`;
    }
    txt += `        },\n    },\n`;
  }
  txt += '}\n';
  return txt;
}

// 触发浏览器下载
export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
