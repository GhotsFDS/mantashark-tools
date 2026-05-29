import { useEffect, useState, useMemo } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';

const FIX_NAMES: Record<number, string> = {
  0: 'NO_GPS', 1: 'NO_FIX', 2: '2D', 3: '3D',
  4: 'DGPS', 5: 'RTK_FLOAT', 6: 'RTK_FIXED',
};

const FIX_COLORS: Record<number, string> = {
  0: 'text-fg-dim', 1: 'text-fg-dim', 2: 'text-warn', 3: 'text-warn',
  4: 'text-warn', 5: 'text-accent', 6: 'text-ok',
};

interface RtkPort {
  device: string;
  description: string;
  manufacturer: string;
  vid: number | null;
  pid: number | null;
}

interface SvinState {
  dur: number;
  acc_mm: number;
  obs: number;
  valid: boolean;
  active: boolean;
}

interface InjectStat {
  frames: number;
  bytes: number;
  msg_types: Record<string, number>;
  bps_in?: number;
  bps_useful?: number;
}

interface RoverGps {
  fix_type: number;
  sats: number;
  hdop: number | null;
  yaw_deg: number | null;
  alt_m: number;
}

interface NtripEntry {
  mountpoint: string;
  identifier: string;
  format: string;
  format_details: string;
  carrier: string;
  nav_system: string;
  country: string;
}

type SourceMode = '9ps' | 'ntrip';
type BaseMode = 'survey_in' | 'fixed_pos';

export function RtkSetup() {
  const [ports, setPorts] = useState<RtkPort[]>([]);
  const [selectedPort, setSelectedPort] = useState('');
  const [baud, setBaud] = useState(115200);
  const [rtkConnected, setRtkConnected] = useState(false);
  const [rtkError, setRtkError] = useState<string | null>(null);

  const [minDur, setMinDur] = useState(60);
  const [accMm, setAccMm] = useState(2500);

  const [svin, setSvin] = useState<SvinState | null>(null);
  const [inject, setInject] = useState(false);
  const [injectStat, setInjectStat] = useState<InjectStat | null>(null);

  const [rover, setRover] = useState<RoverGps | null>(null);

  // Source + base mode
  const [sourceMode, setSourceMode] = useState<SourceMode>('9ps');
  const [baseMode, setBaseMode] = useState<BaseMode>('survey_in');

  // Fixed-Pos coords (用 Survey-In 收敛后的坐标填进来下次直接用)
  const [fpLat, setFpLat] = useState(0);
  const [fpLon, setFpLon] = useState(0);
  const [fpAlt, setFpAlt] = useState(0);
  const [fpAccMm, setFpAccMm] = useState(100);

  // NTRIP
  const [ntripHost, setNtripHost] = useState('rtk2go.com');
  const [ntripPort, setNtripPort] = useState(2101);
  const [ntripMp, setNtripMp] = useState('');
  const [ntripUser, setNtripUser] = useState('');
  const [ntripPass, setNtripPass] = useState('');
  const [ntripConnected, setNtripConnected] = useState(false);
  const [ntripV1, setNtripV1] = useState(false);
  const [sourceTable, setSourceTable] = useState<NtripEntry[]>([]);

  const [log, setLog] = useState<string[]>([]);
  const addLog = (s: string) => setLog(L => [...L.slice(-99), `[${new Date().toLocaleTimeString()}] ${s}`]);

  // WS subscriber
  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'rtk_ports') {
        if (m.error) addLog(`端口枚举错: ${m.error}`);
        else if (m.ports) setPorts(m.ports);
      } else if (m.type === 'rtk_status') {
        if (m.error) {
          setRtkError(m.error);
          addLog(`RTK 错: ${m.error}`);
        } else {
          setRtkError(null);
          // Discriminate 9PS vs NTRIP by presence of `ntrip` key
          // (9PS status: connected/port/baud; NTRIP status: ntrip/host/mountpoint)
          if (typeof m.ntrip === 'boolean') {
            setNtripConnected(m.ntrip);
            if (m.ntrip) addLog(`NTRIP 连上 @ ${m.host || ntripHost} mp=${m.mountpoint || ntripMp}`);
            else if (m.note) addLog(`NTRIP: ${m.note}`);
            else addLog('NTRIP 断开');
          } else if (typeof m.connected === 'boolean') {
            // 9PS serial connect/disconnect (no ntrip key)
            setRtkConnected(m.connected);
            if (m.connected) {
              addLog(`9PS 连上 @ ${m.port || '?'} ${m.baud || ''}`);
            } else {
              addLog('9PS 断开' + (m.note ? ` (${m.note})` : ''));
            }
          }
          if (m.svin_started) addLog(`Survey-In 启动: min_dur=${m.min_dur}s acc=${m.acc_mm}mm`);
          if (m.fixed_pos_started) addLog(`Fixed-Pos: lat=${m.lat?.toFixed(7)} lon=${m.lon?.toFixed(7)} alt=${m.alt}m`);
          if (typeof m.injecting === 'boolean') {
            setInject(m.injecting);
            addLog(m.injecting ? '✓ RTCM 注入开始' : 'RTCM 注入停');
          }
        }
      } else if (m.type === 'rtk_sourcetable') {
        if (m.error) addLog(`Sourcetable 拉取失败: ${m.error}`);
        else if (m.entries) {
          setSourceTable(m.entries);
          addLog(`Sourcetable: ${m.entries.length} 个 mountpoint`);
        }
      } else if (m.type === 'rtk_svin') {
        setSvin({ dur: m.dur, acc_mm: m.acc_mm, obs: m.obs, valid: m.valid, active: m.active });
      } else if (m.type === 'rtk_inject') {
        setInjectStat(m);
      } else if (m.type === 'gps') {
        setRover({
          fix_type: m.fix_type, sats: m.sats, hdop: m.hdop ?? null,
          yaw_deg: m.yaw_deg ?? null, alt_m: m.alt_m ?? 0,
        });
      }
    });
    // Initial port refresh
    if (gcs.isConnected()) gcs.rtkListPorts();
    return off;
  }, []);

  // Auto-pick u-blox port if found
  useEffect(() => {
    if (!selectedPort && ports.length > 0) {
      const ublox = ports.find(p => p.vid === 0x1546);
      const cp210 = ports.find(p => p.vid === 0x10c4);
      const pick = ublox?.device || cp210?.device || ports[0].device;
      if (pick) setSelectedPort(pick);
    }
  }, [ports, selectedPort]);

  const handleRefreshPorts = () => {
    if (gcs.isConnected()) {
      gcs.rtkListPorts();
      addLog('刷新串口列表');
    } else {
      addLog('GCS 未连 — 先到 GCS tab 连接 mavbridge');
    }
  };

  const handleConnect9ps = () => {
    if (!selectedPort) return;
    gcs.rtkConnect(selectedPort, baud);
  };

  const handleDisconnect9ps = () => {
    gcs.rtkDisconnect();
  };

  const handleStartSurvey = () => {
    gcs.rtkSurveyStart(minDur, accMm);
  };

  const handleStopSurvey = () => {
    gcs.rtkSurveyStop();
  };

  const toggleInject = () => {
    gcs.rtkInject(!inject);
  };

  const handleStartFixedPos = () => {
    gcs.rtkFixedPos(fpLat, fpLon, fpAlt, fpAccMm);
  };

  const handleNtripConnect = () => {
    if (!ntripHost || !ntripMp) {
      addLog('NTRIP: host/mountpoint 必填');
      return;
    }
    gcs.rtkNtripConnect(ntripHost, ntripPort, ntripMp, ntripUser, ntripPass, ntripV1);
  };

  const handleNtripDisconnect = () => {
    gcs.rtkNtripDisconnect();
  };

  const handleFetchSourcetable = () => {
    if (!ntripHost) {
      addLog('NTRIP: host 必填');
      return;
    }
    gcs.rtkNtripSourcetable(ntripHost, ntripPort);
    addLog(`拉 sourcetable: ${ntripHost}:${ntripPort}`);
  };

  // Auto-fill Fixed-Pos coords from current rover RTK fix (一键存)
  const handleSnapshotCoords = () => {
    if (!rover || rover.fix_type < 5) {
      addLog('Snapshot: rover 必须 RTK_FLOAT/FIXED 才能截当前位置');
      return;
    }
    // Trigger global pos read — actual coords come from GLOBAL_POSITION_INT we don't track here
    // For now, just notify user to read from GCS tab
    addLog('Snapshot: 请从 GCS tab 复制 lat/lon/alt 填入 Fixed-Pos');
  };

  const svinProgressPct = useMemo(() => {
    if (!svin) return 0;
    const durPct = Math.min(100, (svin.dur / minDur) * 100);
    const accPct = svin.acc_mm > 0 ? Math.min(100, (accMm / svin.acc_mm) * 100) : 0;
    return Math.min(durPct, accPct);
  }, [svin, minDur, accMm]);

  return (
    <div className="space-y-3">
      {/* 流程总览 + 源模式切换 */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>RTK 配置</span>
          <div className="flex gap-1 text-[10px]">
            <button className={`px-2 py-0.5 rounded ${sourceMode === '9ps' ? 'bg-accent text-bg' : 'bg-panel-2 text-fg-dim'}`}
                    onClick={() => setSourceMode('9ps')}>本地 9PS</button>
            <button className={`px-2 py-0.5 rounded ${sourceMode === 'ntrip' ? 'bg-accent text-bg' : 'bg-panel-2 text-fg-dim'}`}
                    onClick={() => setSourceMode('ntrip')}>NTRIP / CORS</button>
          </div>
        </div>
        <div className="text-[11px] text-fg-mute leading-snug">
          {sourceMode === '9ps' ? (
            <>本地 9PS USB 模式: 9PS 接 PC → Survey-In/Fixed-Pos → RTCM3 → mavbridge → 飞控 → 2HP. 离线野外可用, 无网络依赖, 基线 ≤10km.</>
          ) : (
            <>NTRIP 网络模式: PC 联千寻/CORS → mountpoint 订阅 → RTCM3 流 → mavbridge → 飞控 → 2HP. 厘米精度全国覆盖, 需 GCS 联网.</>
          )}
        </div>
      </div>

      {/* 9PS 模式: 串口连接 */}
      {sourceMode === '9ps' && (
      <>
      {/* 9PS 连接 */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>9PS 基站连接</span>
          <span className={`val-mono text-[10px] ${rtkConnected ? 'text-ok' : 'text-fg-dim'}`}>
            {rtkConnected ? `● 已连 ${selectedPort} @ ${baud}` : '○ 未连'}
          </span>
        </div>
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-5">
            <div className="label mb-1">COM port</div>
            <select className="input val-mono w-full text-[11px]"
                    value={selectedPort}
                    onChange={e => setSelectedPort(e.target.value)}>
              <option value="">— 选串口 —</option>
              {ports.map(p => (
                <option key={p.device} value={p.device}>
                  {p.device} {p.description ? `(${p.description})` : ''} {p.vid === 0x1546 ? '★ u-blox' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2">
            <div className="label mb-1">Baud</div>
            <select className="input val-mono w-full text-[11px]"
                    value={baud}
                    onChange={e => setBaud(parseInt(e.target.value))}>
              {[9600, 38400, 57600, 115200, 230400, 460800].map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <button className="btn btn-secondary w-full text-[11px] py-1" onClick={handleRefreshPorts}>
              刷新
            </button>
          </div>
          <div className="col-span-3">
            {rtkConnected ? (
              <button className="btn btn-warn w-full text-[11px] py-1" onClick={handleDisconnect9ps}>
                断开 9PS
              </button>
            ) : (
              <button className="btn btn-primary w-full text-[11px] py-1"
                      onClick={handleConnect9ps}
                      disabled={!selectedPort}>
                连接 9PS
              </button>
            )}
          </div>
        </div>
        {rtkError && (
          <div className="mt-2 text-[10px] text-warn val-mono">⚠ {rtkError}</div>
        )}
      </div>

      {/* Base Mode 选择: Survey-In vs Fixed-Pos */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>基站模式</span>
          <div className="flex gap-1 text-[10px]">
            <button className={`px-2 py-0.5 rounded ${baseMode === 'survey_in' ? 'bg-accent text-bg' : 'bg-panel-2 text-fg-dim'}`}
                    onClick={() => setBaseMode('survey_in')}>Survey-In</button>
            <button className={`px-2 py-0.5 rounded ${baseMode === 'fixed_pos' ? 'bg-accent text-bg' : 'bg-panel-2 text-fg-dim'}`}
                    onClick={() => setBaseMode('fixed_pos')}>Fixed-Pos</button>
          </div>
        </div>
        <div className="text-[10px] text-fg-mute leading-snug">
          {baseMode === 'survey_in' ? (
            <>9PS 自标 (5min Survey-In 收敛到目标精度), 完成后输出 RTCM3.</>
          ) : (
            <>已知坐标直接进 Fixed-Pos, 跳过 Survey-In. 用上次 Survey-In 完成后的 lat/lon/alt 填进来.</>
          )}
        </div>
      </div>

      {baseMode === 'survey_in' && (
      <div className="card">
        <div className="card-title">Survey-In + RTCM 注入</div>
        <div className="grid grid-cols-12 gap-2 items-end mb-3">
          <div className="col-span-3">
            <div className="label mb-1">最小时长 (s)</div>
            <input type="number" className="input val-mono w-full text-[11px]"
                   value={minDur} min={30} max={600}
                   onChange={e => setMinDur(parseInt(e.target.value) || 60)}
                   disabled={svin?.active} />
          </div>
          <div className="col-span-3">
            <div className="label mb-1">最大精度 (mm)</div>
            <input type="number" className="input val-mono w-full text-[11px]"
                   value={accMm} min={500} max={10000} step={100}
                   onChange={e => setAccMm(parseInt(e.target.value) || 2500)}
                   disabled={svin?.active} />
          </div>
          <div className="col-span-3">
            {svin?.active ? (
              <button className="btn btn-warn w-full text-[11px] py-1" onClick={handleStopSurvey}>
                停 Survey-In
              </button>
            ) : (
              <button className="btn btn-primary w-full text-[11px] py-1"
                      onClick={handleStartSurvey}
                      disabled={!rtkConnected}>
                开始 Survey-In
              </button>
            )}
          </div>
          <div className="col-span-3">
            <button className={`btn w-full text-[11px] py-1 ${inject ? 'btn-warn' : 'btn-secondary'}`}
                    onClick={toggleInject}
                    disabled={!rtkConnected}>
              {inject ? '关闭注入' : '手动开注入'}
            </button>
          </div>
        </div>

        {/* Survey-In 状态 */}
        {svin && (
          <div className="bg-panel-2 border border-line rounded p-2 space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span>Survey-In: <b className={svin.valid ? 'text-ok' : svin.active ? 'text-warn' : 'text-fg-dim'}>
                {svin.valid ? '✓ VALID (已收敛)' : svin.active ? '◌ Active...' : '— Idle'}
              </b></span>
              <span className="val-mono text-fg-mute">obs={svin.obs}</span>
            </div>
            <div className="flex items-center gap-3 text-[10px] val-mono">
              <span>时长 <b className="text-accent">{svin.dur}s</b> / {minDur}s</span>
              <span>精度 <b className={svin.acc_mm <= accMm ? 'text-ok' : 'text-warn'}>{svin.acc_mm.toFixed(1)}mm</b> ≤ {accMm}mm</span>
            </div>
            <div className="h-1 bg-bg rounded overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${svinProgressPct}%` }} />
            </div>
          </div>
        )}

        {/* 注入统计 */}
        {injectStat && inject && (
          <div className="mt-2 text-[10px] val-mono text-fg-mute">
            注入: {injectStat.frames} 帧 / {(injectStat.bytes / 1024).toFixed(1)} KB
            {(injectStat.bps_in != null || injectStat.bps_useful != null) && (
              <span className="ml-2">
                {injectStat.bps_in ?? 0} bps in / {injectStat.bps_useful ?? 0} bps RTCM
              </span>
            )}
            {injectStat.msg_types && Object.keys(injectStat.msg_types).length > 0 && (
              <span className="ml-2">
                {Object.entries(injectStat.msg_types).map(([t, c]) => `${t}:${c}`).join(' ')}
              </span>
            )}
          </div>
        )}
      </div>
      )}

      {baseMode === 'fixed_pos' && (
      <div className="card">
        <div className="card-title">Fixed-Pos (已知基站坐标)</div>
        <div className="grid grid-cols-12 gap-2 items-end mb-2">
          <div className="col-span-3">
            <div className="label mb-1">纬度 lat (°)</div>
            <input type="number" className="input val-mono w-full text-[11px]"
                   value={fpLat} step={0.0000001}
                   onChange={e => setFpLat(parseFloat(e.target.value) || 0)} />
          </div>
          <div className="col-span-3">
            <div className="label mb-1">经度 lon (°)</div>
            <input type="number" className="input val-mono w-full text-[11px]"
                   value={fpLon} step={0.0000001}
                   onChange={e => setFpLon(parseFloat(e.target.value) || 0)} />
          </div>
          <div className="col-span-2">
            <div className="label mb-1">高度 alt (m)</div>
            <input type="number" className="input val-mono w-full text-[11px]"
                   value={fpAlt} step={0.01}
                   onChange={e => setFpAlt(parseFloat(e.target.value) || 0)} />
          </div>
          <div className="col-span-2">
            <div className="label mb-1">精度 (mm)</div>
            <input type="number" className="input val-mono w-full text-[11px]"
                   value={fpAccMm} min={10} max={5000} step={10}
                   onChange={e => setFpAccMm(parseInt(e.target.value) || 100)} />
          </div>
          <div className="col-span-2">
            <button className="btn btn-primary w-full text-[11px] py-1"
                    onClick={handleStartFixedPos}
                    disabled={!rtkConnected || !fpLat || !fpLon}>
              进 Fixed-Pos
            </button>
          </div>
        </div>
        <div className="flex gap-2 mb-2">
          <button className="btn btn-secondary text-[10px] py-0.5 px-2" onClick={handleSnapshotCoords}>
            从 rover 抓当前坐标
          </button>
          <button className={`btn text-[10px] py-0.5 px-2 ${inject ? 'btn-warn' : 'btn-secondary'}`}
                  onClick={toggleInject}
                  disabled={!rtkConnected}>
            {inject ? '关闭注入' : '开注入'}
          </button>
        </div>
        <div className="text-[10px] text-fg-mute leading-snug">
          典型用法: 第一次架站做 Survey-In 收敛, 记下 GLOBAL_POSITION_INT 的 lat/lon/alt, 填进这里; 下次回同一点直接 Fixed-Pos 跳过 5min Survey-In.
          精度填得越紧越好 (推荐 100mm = 10cm).
        </div>
      </div>
      )}

      </>
      )}

      {/* NTRIP 模式 */}
      {sourceMode === 'ntrip' && (
      <>
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span>NTRIP / CORS 配置</span>
          <span className={`val-mono text-[10px] ${ntripConnected ? 'text-ok' : 'text-fg-dim'}`}>
            {ntripConnected ? '● 已连' : '○ 未连'}
          </span>
        </div>
        <div className="grid grid-cols-12 gap-2 items-end mb-2">
          <div className="col-span-5">
            <div className="label mb-1">Caster Host</div>
            <input className="input val-mono w-full text-[11px]"
                   value={ntripHost}
                   onChange={e => setNtripHost(e.target.value)}
                   placeholder="rtk.ntrip.qxwz.com / rtk2go.com" />
          </div>
          <div className="col-span-2">
            <div className="label mb-1">Port</div>
            <input type="number" className="input val-mono w-full text-[11px]"
                   value={ntripPort}
                   onChange={e => setNtripPort(parseInt(e.target.value) || 2101)} />
          </div>
          <div className="col-span-3">
            <div className="label mb-1">Mountpoint</div>
            <input className="input val-mono w-full text-[11px]"
                   value={ntripMp}
                   onChange={e => setNtripMp(e.target.value)}
                   placeholder="RTCM32_GGB" />
          </div>
          <div className="col-span-2">
            <button className="btn btn-secondary w-full text-[11px] py-1"
                    onClick={handleFetchSourcetable}>
              拉 Sourcetable
            </button>
          </div>
          <div className="col-span-3">
            <div className="label mb-1">User</div>
            <input className="input val-mono w-full text-[11px]"
                   value={ntripUser}
                   onChange={e => setNtripUser(e.target.value)}
                   placeholder="账号" />
          </div>
          <div className="col-span-3">
            <div className="label mb-1">Password</div>
            <input type="password" className="input val-mono w-full text-[11px]"
                   value={ntripPass}
                   onChange={e => setNtripPass(e.target.value)}
                   placeholder="密码" />
          </div>
          <div className="col-span-2 flex items-center gap-1 text-[10px]">
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={ntripV1} onChange={e => setNtripV1(e.target.checked)} />
              <span className="text-fg-mute">NTRIP v1 (HTTP/1.0 ICY)</span>
            </label>
          </div>
          <div className="col-span-1"></div>
          <div className="col-span-3">
            {ntripConnected ? (
              <button className="btn btn-warn w-full text-[11px] py-1" onClick={handleNtripDisconnect}>
                断开 NTRIP
              </button>
            ) : (
              <button className="btn btn-primary w-full text-[11px] py-1"
                      onClick={handleNtripConnect}
                      disabled={!ntripHost || !ntripMp}>
                连接 + 自动注入
              </button>
            )}
          </div>
        </div>
        {sourceTable.length > 0 && (
          <div className="mt-2">
            <div className="label mb-1 text-[10px]">Sourcetable ({sourceTable.length}, 点击填入 mountpoint)</div>
            <div className="bg-panel-2 border border-line rounded max-h-32 overflow-auto text-[10px]">
              <table className="w-full val-mono">
                <thead className="text-fg-dim sticky top-0 bg-panel-2">
                  <tr><th className="px-1 text-left">MP</th><th className="px-1">Format</th><th className="px-1">Nav</th><th className="px-1">Country</th></tr>
                </thead>
                <tbody>
                  {sourceTable.slice(0, 60).map((e, i) => (
                    <tr key={i} className="hover:bg-bg cursor-pointer"
                        onClick={() => setNtripMp(e.mountpoint)}>
                      <td className="px-1 text-accent">{e.mountpoint}</td>
                      <td className="px-1">{e.format}</td>
                      <td className="px-1">{e.nav_system}</td>
                      <td className="px-1 text-fg-dim">{e.country}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {/* NTRIP 注入统计 */}
        {injectStat && ntripConnected && (
          <div className="mt-2 text-[10px] val-mono text-fg-mute">
            注入: {injectStat.frames} 帧 / {(injectStat.bytes / 1024).toFixed(1)} KB
            {Object.keys(injectStat.msg_types).length > 0 && (
              <span className="ml-2">
                {Object.entries(injectStat.msg_types).map(([t, c]) => `${t}:${c}`).join(' ')}
              </span>
            )}
          </div>
        )}
      </div>
      </>
      )}

      {/* Rover 状态 */}
      <div className="card">
        <div className="card-title">2HP Rover (机上 GPS) 实时状态</div>
        <div className="grid grid-cols-5 gap-3 text-[11px]">
          <div>
            <div className="label">Fix Type</div>
            <div className={`val-mono text-[14px] font-bold ${rover ? FIX_COLORS[rover.fix_type] : 'text-fg-dim'}`}>
              {rover ? `${rover.fix_type} ${FIX_NAMES[rover.fix_type] || '?'}` : '—'}
            </div>
          </div>
          <div>
            <div className="label">Sats</div>
            <div className="val-mono text-[14px]">{rover?.sats ?? '—'}</div>
          </div>
          <div>
            <div className="label">HDOP (m)</div>
            <div className="val-mono text-[14px]">{rover?.hdop?.toFixed(2) ?? '—'}</div>
          </div>
          <div>
            <div className="label">GPS Yaw (°)</div>
            <div className="val-mono text-[14px]">{rover?.yaw_deg?.toFixed(1) ?? '—'}</div>
          </div>
          <div>
            <div className="label">Alt (m)</div>
            <div className="val-mono text-[14px]">{rover?.alt_m?.toFixed(1) ?? '—'}</div>
          </div>
        </div>
        <div className="mt-2 text-[10px] text-fg-mute leading-snug">
          目标: <b className="text-ok">RTK_FIXED (6)</b> = 厘米级位置. <b className="text-accent">RTK_FLOAT (5)</b> = 还在收敛.
          基站 Survey-In 完成 + 注入开 + 天空开阔 + 距离 ≤10km, 大约 1-3 分钟内 fix 升 5/6.
          GPS Yaw 字段非空 = 2HP 双天线 moving baseline 已 lock.
        </div>
      </div>

      {/* 日志 */}
      <div className="card">
        <div className="card-title">日志</div>
        <div className="bg-panel-2 border border-line rounded p-2 h-32 overflow-auto val-mono text-[10px]">
          {log.length === 0 ? <span className="text-fg-dim">— 等待事件 —</span> :
            log.map((l, i) => <div key={i}>{l}</div>)
          }
        </div>
      </div>
    </div>
  );
}
