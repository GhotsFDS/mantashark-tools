// Mission map — 简易 tile renderer (无 leaflet dep, 离线可用).
// 支持: OSM/Google Sat tile (在线), 拖拽 WP, 平移地图, 滚轮缩放.
// 参考 MP (Mission Planner) 思路: tile 切片 (z/x/y) + 投影 (Web Mercator).
import { useEffect, useRef, useState } from 'react';
import { gcs, GcsMessage } from '../../lib/gcs';

type WP = { idx: number; lat: number; lon: number };

const MAX_WP = 10;
const STORAGE_KEY = 'mantashark_mission_v2';
const TILE_SIZE = 256;

// Tile 源 (MP 风格菜单)
type TileSource = {
  id: string;
  name: string;
  url: (z: number, x: number, y: number) => string;
  attr: string;
};
// Bing tile 用 quadkey 编码 (z/x/y → quadkey 字符串)
function tileXYToQuadKey(x: number, y: number, z: number): string {
  let q = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    q += digit.toString();
  }
  return q;
}

// Tile URL 模板 — 参考 MissionPlanner ExtLibs/GMap.NET.Core/GMap.NET.MapProviders/*
// (MP 是社区验证 10+ 年的实现, URL/server pool/lang 跟它一致)
const TILE_SOURCES: TileSource[] = [
  { id: 'none',  name: '无地图 (网格)', url: () => '', attr: '' },

  // ─── 国际 ───
  { id: 'osm',   name: 'OSM 街道',     url: (z,x,y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, attr: '© OpenStreetMap' },

  // Google: MP UrlFormat = "http://{0}{1}.google.com/vt/lyrs={2}&hl={3}&x={4}&y={5}&z={6}"
  //   lyrs: m=street, s=satellite, y=hybrid, t=terrain
  { id: 'gmap',  name: 'Google 街道',  url: (z,x,y) => `https://mt${(x+y)%4}.google.com/vt/lyrs=m&hl=en&x=${x}&y=${y}&z=${z}`, attr: '© Google' },
  { id: 'gsat',  name: 'Google 卫星',  url: (z,x,y) => `https://mt${(x+y)%4}.google.com/vt/lyrs=s&hl=en&x=${x}&y=${y}&z=${z}`, attr: '© Google' },
  { id: 'ghyb',  name: 'Google 混合',  url: (z,x,y) => `https://mt${(x+y)%4}.google.com/vt/lyrs=y&hl=en&x=${x}&y=${y}&z=${z}`, attr: '© Google' },

  // ArcGIS / Esri
  { id: 'esri',  name: 'Esri 卫星',    url: (z,x,y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, attr: '© Esri' },

  // Bing: MP UrlFormat = "http://ecn.t{0}.tiles.virtualearth.net/tiles/a{1}.jpeg?g={2}&mkt={3}&n=z{4}"
  //   g=version (MP 用 "4810"), mkt=lang (en-US), n=z 防 label
  { id: 'bing',  name: 'Bing 卫星',    url: (z,x,y) => `https://ecn.t${(x+y)%4}.tiles.virtualearth.net/tiles/a${tileXYToQuadKey(x,y,z)}.jpeg?g=4810&mkt=en-US&n=z`, attr: '© Bing' },

  // ─── 中国大陆 (国内网络优, GCJ-02 偏移 50-500m) ───
  // 注意: MP 在 C# 端设 RefererUrl="http://www.amap.com/" 通过反盗链, 浏览器 SVG <image>
  // 受 CSP 限制无法自定义 referer. 经实测: 极简 URL (无 lang/size/scale) 可加载, MP 完整
  // URL 含这些参数会被高德拒 (referer 非 amap.com).
  { id: 'amap_vec', name: '高德矢量',   url: (z,x,y) => `https://webrd0${(x%4)+1}.is.autonavi.com/appmaptile?style=7&x=${x}&y=${y}&z=${z}`, attr: '© 高德 (GCJ-02 偏)' },
  { id: 'amap_sat', name: '高德卫星',   url: (z,x,y) => `https://webst0${(x%4)+1}.is.autonavi.com/appmaptile?style=6&x=${x}&y=${y}&z=${z}`, attr: '© 高德 (GCJ-02)' },
  { id: 'amap_hyb', name: '高德混合',   url: (z,x,y) => `https://webst0${(x%4)+1}.is.autonavi.com/appmaptile?style=8&x=${x}&y=${y}&z=${z}`, attr: '© 高德 (GCJ-02)' },

  // Google China (MP 用 mt{0-3}.google.cn, gl=cn 参数)
  { id: 'gcn_sat',  name: 'Google CN 卫星', url: (z,x,y) => `https://mt${(x+y)%4}.google.cn/vt/lyrs=s&gl=cn&x=${x}&y=${y}&z=${z}`, attr: '© Google CN (GCJ-02)' },
  { id: 'gcn_hyb',  name: 'Google CN 混合', url: (z,x,y) => `https://mt${(x+y)%4}.google.cn/vt/lyrs=y&gl=cn&x=${x}&y=${y}&z=${z}`, attr: '© Google CN (GCJ-02)' },
];

// Web Mercator 投影
function lonLatToWorld(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  const x = ((lon + 180) / 360) * n * TILE_SIZE;
  const latRad = lat * Math.PI / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * TILE_SIZE;
  return { x, y };
}
function worldToLonLat(x: number, y: number, z: number): { lon: number; lat: number } {
  const n = Math.pow(2, z);
  const lon = (x / (n * TILE_SIZE)) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (n * TILE_SIZE))));
  return { lon, lat: latRad * 180 / Math.PI };
}

// P7.9.18: WP 不再走 param, 走 MAVLink MISSION 协议 (跟 MP/QGC 互通)

export function Map() {
  // P7.9.18: WP 走 MISSION 协议, 不再读 store.params 里 WPM_WPxx_LAT/LON
  const [cur, setCur] = useState<{ lat: number; lon: number; hdg: number } | null>(null);
  // P7.9.18: 防御性 localStorage 解析 (旧版 schema 不兼容时 fallback default, 不抛错让 ErrorBoundary 接)
  const safeReadStorage = (key: string): any => {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  };
  const stored = safeReadStorage(STORAGE_KEY);
  const validLatLon = (v: any) =>
    v && typeof v === 'object' && typeof v.lat === 'number' && typeof v.lon === 'number' &&
    !isNaN(v.lat) && !isNaN(v.lon);

  const [home, setHome] = useState<{ lat: number; lon: number } | null>(
    validLatLon(stored?.home) ? stored.home : null
  );
  const [center, setCenter] = useState<{ lat: number; lon: number }>(
    validLatLon(stored?.center) ? stored.center :
    validLatLon(stored?.home) ? stored.home :
    { lat: 39.9, lon: 116.4 }
  );
  const [zoom, setZoom] = useState<number>(
    typeof stored?.zoom === 'number' && stored.zoom >= 3 && stored.zoom <= 20 ? stored.zoom : 17
  );
  const [tileId, setTileId] = useState<string>(
    typeof stored?.tile === 'string' ? stored.tile : 'gsat'
  );
  const [wps, setWps] = useState<WP[]>(() => {
    const raw = safeReadStorage('mantashark_wps_v1');
    if (!Array.isArray(raw)) return [];
    return raw.filter((w: any) => w && typeof w.lat === 'number' && typeof w.lon === 'number' && !isNaN(w.lat) && !isNaN(w.lon))
              .map((w: any, i: number) => ({ idx: i + 1, lat: w.lat, lon: w.lon }));
  });
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [dragWp, setDragWp] = useState<number | null>(null);
  const [panStart, setPanStart] = useState<{ mx: number; my: number; cx: number; cy: number } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);

  // persist
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        home, center, zoom, tile: tileId,
      }));
    } catch {}
  }, [home, center, zoom, tileId]);

  // GPS 订阅
  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if (m.type === 'gps') {
        const lat = (m as any).lat / 1e7;
        const lon = (m as any).lon / 1e7;
        const hdg = (m as any).hdg / 100;
        if (lat !== 0 && lon !== 0) {
          setCur({ lat, lon, hdg });
          if (!home) {
            setHome({ lat, lon });
            setCenter({ lat, lon });
          }
        }
      }
    });
    return () => { off(); };
  }, [home]);

  // 本地 wps 持久 localStorage (撤 params 同步, 因为 WP 现在走 MISSION 协议不在 param)
  useEffect(() => {
    try { localStorage.setItem('mantashark_wps_v1', JSON.stringify(wps)); } catch {}
  }, [wps]);

  // 监听 fc → Tuner 的 mission_list (mission_download 响应) + upload 完成
  useEffect(() => {
    const off = gcs.on((m: GcsMessage) => {
      if ((m as any).type === 'mission_list') {
        // fc 上当前 mission (含 home @ seq=0). 跳过 home, 转 WP
        const items = (m as any).wps as Array<{ seq: number; lat: number; lon: number; alt: number }>;
        const out: WP[] = [];
        for (const it of items) {
          if (it.seq === 0) continue;  // home
          if (it.lat === 0 && it.lon === 0) continue;
          out.push({ idx: it.seq, lat: it.lat, lon: it.lon });
        }
        setWps(out);
        setUploadStatus(`✓ 从 fc 下载 ${out.length} WP`);
        setTimeout(() => setUploadStatus(''), 3000);
      } else if ((m as any).type === 'mission_upload_started') {
        setUploadStatus(`↑ 上传中 (${(m as any).count} WP)...`);
      } else if ((m as any).type === 'mission_uploaded') {
        const ok = (m as any).result === 0;
        setUploadStatus(ok ? `✓ 上传 ${(m as any).count} WP 完成` : `✗ 上传失败: ${(m as any).result_name}`);
        setTimeout(() => setUploadStatus(''), 4000);
      } else if ((m as any).type === 'mission_cleared') {
        setUploadStatus('✓ fc mission 已清空');
        setTimeout(() => setUploadStatus(''), 3000);
      }
    });
    return () => { off(); };
  }, []);

  // 视口
  const W = 900, H = 600;
  const centerW = lonLatToWorld(center.lon, center.lat, zoom);

  // 屏幕 → world
  const screenToWorld = (sx: number, sy: number) => ({
    x: centerW.x + (sx - W / 2),
    y: centerW.y + (sy - H / 2),
  });
  // world → 屏幕
  const worldToScreen = (wx: number, wy: number) => ({
    x: W / 2 + (wx - centerW.x),
    y: H / 2 + (wy - centerW.y),
  });
  // lat/lon → 屏幕
  const project = (lat: number, lon: number) => {
    const w = lonLatToWorld(lon, lat, zoom);
    return worldToScreen(w.x, w.y);
  };

  // 可见 tile 范围
  const tileSource = TILE_SOURCES.find(t => t.id === tileId) || TILE_SOURCES[0];
  const tiles: Array<{ z: number; x: number; y: number; sx: number; sy: number }> = [];
  if (tileSource.id !== 'none') {
    const topLeft = screenToWorld(0, 0);
    const bottomRight = screenToWorld(W, H);
    const x0 = Math.floor(topLeft.x / TILE_SIZE);
    const y0 = Math.floor(topLeft.y / TILE_SIZE);
    const x1 = Math.floor(bottomRight.x / TILE_SIZE);
    const y1 = Math.floor(bottomRight.y / TILE_SIZE);
    const n = Math.pow(2, zoom);
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        const wy = ty;
        const scr = worldToScreen(tx * TILE_SIZE, ty * TILE_SIZE);
        tiles.push({ z: zoom, x: wx, y: wy, sx: scr.x, sy: scr.y });
      }
    }
  }

  // 右键菜单 state (跟 MP FlightPlanner.cs contextMenuStrip 同思路)
  type CtxMenu = { sx: number; sy: number; lat: number; lon: number; wp?: WP };
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const onContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();   // 阻止浏览器默认右键
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * H;
    const w = screenToWorld(mx, my);
    const { lat, lon } = worldToLonLat(w.x, w.y, zoom);
    // 是不是点中 WP
    let hitWp: WP | undefined;
    for (const wp of wps) {
      const p = project(wp.lat, wp.lon);
      if (Math.hypot(p.x - mx, p.y - my) < 14) { hitWp = wp; break; }
    }
    setCtxMenu({ sx: e.clientX, sy: e.clientY, lat, lon, wp: hitWp });
  };

  // 鼠标事件
  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button === 2) return;   // 右键不参与拖拽逻辑 (走 onContextMenu)
    setCtxMenu(null);              // 左键点开关菜单
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * H;
    // 检查点中 WP
    for (const w of wps) {
      const p = project(w.lat, w.lon);
      if (Math.hypot(p.x - mx, p.y - my) < 12) {
        setDragWp(w.idx);
        return;
      }
    }
    // 否则 pan
    setPanStart({ mx, my, cx: center.lon, cy: center.lat });
  };
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * H;
    if (dragWp !== null) {
      const w = screenToWorld(mx, my);
      const { lat, lon } = worldToLonLat(w.x, w.y, zoom);
      setWps(prev => prev.map(p => p.idx === dragWp ? { ...p, lat, lon } : p));
    } else if (panStart) {
      // 屏幕像素 → 经纬度偏移
      const w = screenToWorld(mx, my);
      const startW = lonLatToWorld(panStart.cx, panStart.cy, zoom);
      const dx = (w.x - centerW.x);   // 当前指针 world dx
      const dy = (w.y - centerW.y);
      const newCw = { x: startW.x - (mx - panStart.mx), y: startW.y - (my - panStart.my) };
      const ll = worldToLonLat(newCw.x, newCw.y, zoom);
      setCenter({ lat: ll.lat, lon: ll.lon });
    }
  };
  const onMouseUp = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragWp === null && panStart) {
      // 短按 (没拖) 加 WP
      const rect = svgRef.current!.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * W;
      const my = ((e.clientY - rect.top) / rect.height) * H;
      const dx = mx - panStart.mx, dy = my - panStart.my;
      if (Math.hypot(dx, dy) < 5 && wps.length < MAX_WP) {
        const w = screenToWorld(mx, my);
        const { lat, lon } = worldToLonLat(w.x, w.y, zoom);
        setWps([...wps, { idx: wps.length + 1, lat, lon }]);
      }
    }
    setDragWp(null);
    setPanStart(null);
  };
  // 滚轮事件: React onWheel 是 passive listener, e.preventDefault() 无效, 必须手动 addEventListener
  // 防滚轮事件穿透浏览器滚动条
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      setZoom(z => Math.max(3, Math.min(20, z + delta)));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => { el.removeEventListener('wheel', handler); };
  }, []);

  const delWp = (idx: number) => {
    setWps(wps.filter(w => w.idx !== idx).map((w, i) => ({ ...w, idx: i + 1 })));
  };
  const updWp = (idx: number, lat: number, lon: number) => {
    setWps(wps.map(w => w.idx === idx ? { ...w, lat, lon } : w));
  };

  // P7.9.18: 走 MAVLink MISSION 协议 (跟 MP saveWPs 同), 撤 param_set 路径
  const upload = () => {
    if (wps.length === 0) return;
    gcs.send({
      type: 'mission_upload',
      wps: wps.map(w => ({ lat: w.lat, lon: w.lon, alt: 50 })),  // 默认 alt 50m (WIG 水面飞)
    });
    setUploadStatus(`↑ 发送 MISSION_COUNT (${wps.length})...`);
  };

  const downloadFromFc = () => {
    setUploadStatus('↓ 从 fc 下载 mission...');
    gcs.send({ type: 'mission_download' });
  };

  const clearOnFc = () => {
    if (!confirm('清空 fc 上 mission?')) return;
    gcs.send({ type: 'mission_clear' });
  };

  // 状态计算 (供侧栏显示)
  const cosLatHome = Math.cos((home?.lat || 0) * Math.PI / 180);
  const distHome = home && cur ? Math.sqrt(
    Math.pow((cur.lat - home.lat) * 111000, 2) +
    Math.pow((cur.lon - home.lon) * 111000 * cosLatHome, 2)
  ) : null;

  return (
    <div className="space-y-2">
      {/* ═══ 顶栏: 3 组 ─ 导航 / 编辑 / 上传 ═══ */}
      <div className="flex items-center justify-between flex-wrap gap-3 p-2 bg-bg-2 rounded border border-line/40 text-xs">
        <div className="text-sm font-medium">🗺 Mission 航点编辑</div>

        {/* 导航组 */}
        <div className="flex gap-1.5 items-center">
          <label className="label">地图:</label>
          <select
            className="input"
            value={tileId}
            onChange={e => setTileId(e.target.value)}
          >
            <optgroup label="国际">
              {TILE_SOURCES.filter(t => !t.id.startsWith('amap') && !t.id.startsWith('tdt')).map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </optgroup>
            <optgroup label="中国">
              {TILE_SOURCES.filter(t => t.id.startsWith('amap') || t.id.startsWith('tdt')).map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </optgroup>
          </select>
          <div className="flex border border-line rounded overflow-hidden">
            <button className="px-2 py-1 hover:bg-panel-2" onClick={() => setZoom(z => Math.max(3, z - 1))}>−</button>
            <span className="input rounded-none border-y-0 min-w-[36px] text-center val-mono">{zoom}</span>
            <button className="px-2 py-1 hover:bg-panel-2" onClick={() => setZoom(z => Math.min(20, z + 1))}>+</button>
          </div>
          <button className="input hover:bg-panel-2 disabled:opacity-50"
            onClick={() => { if (home) setCenter(home); }}
            disabled={!home}
            title={home ? `Lat ${home.lat.toFixed(5)} Lon ${home.lon.toFixed(5)}` : '等 GPS fix'}
          >📍 HOME</button>
          <button className="input hover:bg-panel-2 disabled:opacity-50"
            onClick={() => { if (cur) setCenter(cur); }}
            disabled={!cur}
          >🛩 当前</button>
        </div>

        {/* mission 协议组: 下载/清/上传 */}
        <div className="flex gap-1.5 items-center">
          <button className="input hover:bg-panel-2"
            onClick={downloadFromFc}
            title="从 fc 下载当前 mission (MAVLink MISSION_REQUEST_LIST)"
          >↓ 下载</button>
          <button className="input hover:bg-panel-2 text-fg-mute"
            onClick={clearOnFc}
            title="清空 fc 上 mission (MISSION_CLEAR_ALL)"
          >⌫ fc 清</button>
          <button className="input hover:bg-panel-2 text-fg-mute disabled:opacity-50"
            onClick={() => { setWps([]); }}
            disabled={wps.length === 0}
            title="只清本地 WP, 不动 fc"
          >🗑 本地清</button>
          <button className="input hover:bg-accent/30 border-accent bg-accent/20 disabled:opacity-50 font-medium"
            onClick={upload} disabled={wps.length === 0}
          >⬆ 上传 ({wps.length})</button>
        </div>
      </div>
      {uploadStatus && (
        <div className="text-xs px-2 py-1 bg-bg-2 border border-line/40 rounded">{uploadStatus}</div>
      )}

      {/* ═══ 主区: 左地图 / 右侧栏 (无 gap, 紧贴) ═══ */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>

      {/* 左 — SVG 地图 (动态宽度, 高度按 16:9 比例算, 不撑大) */}
      <div className="bg-bg-2 rounded-l border border-line/40 overflow-hidden border-r-0" style={{ touchAction: 'none', aspectRatio: '16 / 9' }}>
        <svg
          ref={svgRef}
          width="100%" height="100%" viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid slice"
          style={{ background: '#1a1a1a', cursor: dragWp !== null ? 'grabbing' : panStart ? 'move' : 'crosshair', display: 'block', width: '100%', height: '100%' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => { setDragWp(null); setPanStart(null); }}
          onContextMenu={onContextMenu}
        >
          {/* tile 图层 */}
          {tiles.map(t => (
            <image
              key={`${t.z}/${t.x}/${t.y}`}
              x={t.sx} y={t.sy}
              width={TILE_SIZE} height={TILE_SIZE}
              href={tileSource.url(t.z, t.x, t.y)}
              preserveAspectRatio="none"
            />
          ))}

          {/* 无 tile 模式: 网格 */}
          {tileSource.id === 'none' && Array.from({ length: 20 }).map((_, i) => (
            <g key={'g' + i}>
              <line x1={i * 50} y1={0} x2={i * 50} y2={H} stroke="#2a2a2a" strokeWidth={0.5} />
              <line x1={0} y1={i * 50} x2={W} y2={i * 50} stroke="#2a2a2a" strokeWidth={0.5} />
            </g>
          ))}

          {/* WP 路径线 */}
          {wps.length > 1 && (
            <polyline
              points={wps.map(w => { const p = project(w.lat, w.lon); return `${p.x},${p.y}`; }).join(' ')}
              fill="none" stroke="#3b82f6" strokeWidth={2.5} strokeDasharray="6,3"
            />
          )}

          {/* home marker */}
          {home && (() => {
            const p = project(home.lat, home.lon);
            return (
              <g>
                <circle cx={p.x} cy={p.y} r={9} fill="#10b981" stroke="#fff" strokeWidth={2} />
                <text x={p.x} y={p.y + 24} fill="#10b981" fontSize="12" textAnchor="middle" fontWeight="bold"
                  stroke="#000" strokeWidth={2} paintOrder="stroke">HOME</text>
              </g>
            );
          })()}

          {/* WP markers */}
          {wps.map(w => {
            const p = project(w.lat, w.lon);
            return (
              <g key={w.idx} style={{ cursor: 'grab' }}>
                <circle cx={p.x} cy={p.y} r={12} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
                <text x={p.x} y={p.y + 5} fill="#000" fontSize="13" textAnchor="middle" fontWeight="bold">{w.idx}</text>
              </g>
            );
          })}

          {/* 当前位置 marker */}
          {cur && (() => {
            const p = project(cur.lat, cur.lon);
            const hr = cur.hdg * Math.PI / 180;
            const tipX = p.x + Math.sin(hr) * 20;
            const tipY = p.y - Math.cos(hr) * 20;
            return (
              <g>
                <circle cx={p.x} cy={p.y} r={14} fill="none" stroke="#ef4444" strokeWidth={2.5} />
                <circle cx={p.x} cy={p.y} r={3} fill="#ef4444" />
                <line x1={p.x} y1={p.y} x2={tipX} y2={tipY} stroke="#ef4444" strokeWidth={2.5} />
                <text x={p.x + 18} y={p.y} fill="#ef4444" fontSize="11" stroke="#000" strokeWidth={2} paintOrder="stroke">
                  {cur.hdg.toFixed(0)}°
                </text>
              </g>
            );
          })()}

          {/* attribute */}
          {tileSource.attr && (
            <text x={W - 5} y={H - 5} fill="#fff" fontSize="9" textAnchor="end"
              stroke="#000" strokeWidth={2} paintOrder="stroke">{tileSource.attr}</text>
          )}

          {/* center crosshair */}
          <g opacity={0.4}>
            <line x1={W/2-8} y1={H/2} x2={W/2+8} y2={H/2} stroke="#fff" strokeWidth={1} />
            <line x1={W/2} y1={H/2-8} x2={W/2} y2={H/2+8} stroke="#fff" strokeWidth={1} />
          </g>
        </svg>

        {/* 右键菜单 (参考 MP FlightPlanner contextMenuStrip1) */}
        {ctxMenu && (
          <>
            {/* 透明遮罩, 点其他地方关菜单 */}
            <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null); }} />
            <div className="fixed z-50 bg-bg-2 border border-line rounded shadow-lg text-xs py-1 min-w-[180px]"
              style={{ left: ctxMenu.sx, top: ctxMenu.sy }}>
              <div className="px-3 py-1 text-fg-mute border-b border-line/30 font-mono text-[10px]">
                {ctxMenu.lat.toFixed(6)}, {ctxMenu.lon.toFixed(6)}
                {ctxMenu.wp && <span className="ml-1 text-amber-400">WP #{ctxMenu.wp.idx}</span>}
              </div>
              {ctxMenu.wp ? (
                <>
                  <button className="block w-full text-left px-3 py-1.5 hover:bg-bg-1"
                    onClick={() => {
                      // 插入新 WP 在当前 WP 之后
                      if (wps.length >= MAX_WP) { setCtxMenu(null); return; }
                      const ins = ctxMenu.wp!.idx;
                      const newWps = [...wps];
                      newWps.splice(ins, 0, { idx: 0, lat: ctxMenu.lat, lon: ctxMenu.lon });
                      setWps(newWps.map((w, i) => ({ ...w, idx: i + 1 })));
                      setCtxMenu(null);
                    }}
                  >➕ 在此后插入 WP</button>
                  <button className="block w-full text-left px-3 py-1.5 hover:bg-bg-1 text-err"
                    onClick={() => {
                      const out = wps.filter(x => x.idx !== ctxMenu.wp!.idx).map((w, i) => ({ ...w, idx: i + 1 }));
                      setWps(out);
                      setCtxMenu(null);
                    }}
                  >🗑 删除 WP #{ctxMenu.wp.idx}</button>
                </>
              ) : (
                <>
                  <button className="block w-full text-left px-3 py-1.5 hover:bg-bg-1"
                    onClick={() => {
                      if (wps.length >= MAX_WP) { setCtxMenu(null); return; }
                      setWps([...wps, { idx: wps.length + 1, lat: ctxMenu.lat, lon: ctxMenu.lon }]);
                      setCtxMenu(null);
                    }}
                  >➕ 在此添加 WP</button>
                  <button className="block w-full text-left px-3 py-1.5 hover:bg-bg-1"
                    onClick={() => {
                      setHome({ lat: ctxMenu.lat, lon: ctxMenu.lon });
                      setCtxMenu(null);
                    }}
                  >📍 设为 HOME</button>
                </>
              )}
              <button className="block w-full text-left px-3 py-1.5 hover:bg-bg-1 text-fg-mute border-t border-line/30"
                onClick={() => { setCenter({ lat: ctxMenu.lat, lon: ctxMenu.lon }); setCtxMenu(null); }}
              >🎯 居中到此</button>
            </div>
          </>
        )}
      </div>

      {/* 右 — 侧栏: 状态 + WP 列表 + 帮助 (跟地图紧贴, 共用边框) */}
      <div className="flex flex-col bg-bg-2 rounded-r border border-line/40 min-w-0 overflow-hidden">

        {/* 状态卡 */}
        <div className="p-2 text-xs space-y-1 border-b border-line/30">
          <div className="text-fg-dim font-medium border-b border-line/30 pb-1 mb-1">状态</div>
          <div className="flex justify-between"><span className="text-fg-dim">HOME</span>
            <span className="font-mono">{home ? `${home.lat.toFixed(5)}, ${home.lon.toFixed(5)}` : '等 GPS fix'}</span>
          </div>
          <div className="flex justify-between"><span className="text-fg-dim">当前</span>
            <span className="font-mono">{cur ? `${cur.lat.toFixed(5)}, ${cur.lon.toFixed(5)}` : '—'}</span>
          </div>
          <div className="flex justify-between"><span className="text-fg-dim">距 home</span>
            <span className="font-mono">{distHome !== null ? `${distHome.toFixed(0)} m` : '—'}</span>
          </div>
          <div className="flex justify-between"><span className="text-fg-dim">航向</span>
            <span className="font-mono">{cur ? `${cur.hdg.toFixed(0)}°` : '—'}</span>
          </div>
          <div className="flex justify-between"><span className="text-fg-dim">WP 数</span>
            <span className="font-mono">{wps.length} / {MAX_WP}</span>
          </div>
        </div>

        {/* WP 列表 (紧凑, flex-1 占满剩余) */}
        <div className="flex-1 min-h-0 overflow-y-auto border-b border-line/30">
          <div className="text-xs text-fg-dim font-medium px-2 py-1.5 border-b border-line/30 sticky top-0 bg-bg-2 z-10">
            航点 ({wps.length})
          </div>
          {wps.length === 0 ? (
            <div className="text-[10px] text-fg-dim p-3 text-center">
              点击地图加 WP<br/>
              <span className="opacity-60">最多 {MAX_WP} 个</span>
            </div>
          ) : (
            <table className="text-[11px] w-full">
              <tbody>
                {wps.map(w => {
                  const dist = home ? Math.sqrt(
                    Math.pow((w.lat - home.lat) * 111000, 2) +
                    Math.pow((w.lon - home.lon) * 111000 * cosLatHome, 2)
                  ) : 0;
                  return (
                    <tr key={w.idx} className="border-t border-line/20 hover:bg-bg-1">
                      <td className="px-1.5 py-1 text-amber-400 font-bold w-6">{w.idx}</td>
                      <td className="px-1 py-1 font-mono leading-tight">
                        <div>{w.lat.toFixed(6)}</div>
                        <div className="text-fg-dim">{w.lon.toFixed(6)}</div>
                      </td>
                      <td className="px-1 py-1 text-fg-dim text-right whitespace-nowrap">{dist.toFixed(0)}m</td>
                      <td className="px-1 py-1 text-center w-6">
                        <button className="text-err hover:bg-err/20 rounded px-1" onClick={() => delWp(w.idx)} title="删除">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* 帮助 (折叠, 共用底框) */}
        <details className="text-[10px] text-fg-dim">
          <summary className="px-2 py-1 cursor-pointer hover:bg-bg-1 select-none">💡 操作提示</summary>
          <div className="p-2 space-y-0.5 border-t border-line/30">
            <div>• 点击空白加 WP</div>
            <div>• 拖 WP 改位置</div>
            <div>• 拖空白平移地图</div>
            <div>• 滚轮缩放 zoom 3-20</div>
            <div className="pt-1 border-t border-line/20 mt-1">
              <div>🟢 HOME (第一次 GPS fix, localStorage)</div>
              <div>🔴 当前位置 + heading 箭头</div>
              <div>🟠 WP + 编号</div>
              <div className="pt-1 text-warn">⚠ 高德/天地图 GCJ-02 偏 50-500m</div>
            </div>
          </div>
        </details>
      </div>

      </div>
    </div>
  );
}
