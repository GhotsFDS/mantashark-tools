#!/usr/bin/env python3
"""
MantaShark 飞行日志 Web 分析器

启动一个本地 web 服务，浏览器上传 .BIN 文件，自动分析并显示报告 + 图表。

用法:
  python3 web_analyzer.py                    # 默认 0.0.0.0:8090
  python3 web_analyzer.py --port 8888
  python3 web_analyzer.py --host 127.0.0.1   # 仅本机
"""

import os
import sys
import io
import argparse
import tempfile
import base64
import re
from pathlib import Path

# Windows: 强制 UTF-8
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except (AttributeError, OSError):
        pass

try:
    from flask import Flask, request, render_template_string, send_from_directory, abort
except ImportError:
    print("ERROR: Flask 未安装。运行: pip install flask")
    sys.exit(1)

# 复用 analyze_log.py 的分析器
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze_log import LogAnalyzer, MOTOR_GROUPS, make_plot

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB 上传限制

# ─── HTML 模板（嵌入式单文件）───
INDEX_HTML = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>MantaShark 飞行日志分析器</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;}
body{background:#1a1a2e;color:#e0e0e0;min-height:100vh;}
.container{max-width:1200px;margin:0 auto;padding:30px 20px;}
h1{color:#0ff;font-size:24px;margin-bottom:20px;}
h2{color:#0ff;font-size:16px;margin:24px 0 10px;border-left:3px solid #0ff;padding-left:10px;}
.upload-zone{
  background:#16213e;border:2px dashed #0ff5;border-radius:10px;
  padding:60px 20px;text-align:center;cursor:pointer;
  transition:all 0.2s;
}
.upload-zone:hover,.upload-zone.dragover{
  background:#1e2a44;border-color:#0ff;transform:translateY(-2px);
}
.upload-zone p{color:#888;margin:8px 0;}
.upload-zone .icon{font-size:48px;color:#0ff;}
.upload-zone .hint{font-size:12px;color:#666;}
input[type=file]{display:none;}
button{
  background:#0a3d62;color:#0ff;border:1px solid #0ff;
  padding:10px 24px;border-radius:5px;cursor:pointer;font-size:14px;
  margin:10px 5px;transition:all 0.2s;
}
button:hover{background:#0ff;color:#000;}
button:disabled{opacity:0.5;cursor:not-allowed;}
.report{
  background:#0d1b2a;border:1px solid #0f3460;border-radius:8px;
  padding:20px;margin-top:20px;font-family:'Consolas','Courier New',monospace;
  font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-x:auto;
}
.report .ok{color:#0f0;}
.report .warn{color:#fa0;}
.report .err{color:#f44;font-weight:bold;}
.report .head{color:#0ff;font-weight:bold;}
.report .label{color:#888;}
.summary{
  background:#16213e;border:1px solid #0f3460;border-radius:8px;
  padding:15px;margin:10px 0;
}
.summary .num{font-size:32px;color:#0ff;font-weight:bold;}
.warnings{
  background:#3a1818;border:2px solid #f44;border-radius:8px;
  padding:15px;margin:15px 0;
}
.warnings h3{color:#f88;margin-bottom:10px;}
.warnings ol{margin-left:20px;}
.warnings li{color:#fcc;margin:4px 0;}
.no-warnings{
  background:#1a3a1a;border:2px solid #0f0;border-radius:8px;
  padding:15px;margin:15px 0;text-align:center;color:#9f9;
}
.plot{max-width:100%;margin:20px 0;border:1px solid #333;border-radius:5px;}
.spinner{
  display:inline-block;width:16px;height:16px;
  border:2px solid #0ff5;border-top-color:#0ff;border-radius:50%;
  animation:spin 0.8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg);}}
.loading{display:none;text-align:center;padding:40px;color:#0ff;}
.loading.show{display:block;}
.tabs{display:flex;gap:5px;margin:20px 0 10px;border-bottom:1px solid #333;}
.tabs button{
  background:transparent;border:none;border-bottom:2px solid transparent;
  padding:8px 16px;color:#888;cursor:pointer;border-radius:0;margin:0;
}
.tabs button.active{color:#0ff;border-bottom-color:#0ff;}
.tab-content{display:none;}
.tab-content.active{display:block;}
.footer{text-align:center;color:#555;margin-top:40px;font-size:11px;}
.file-info{
  background:#0d1b2a;padding:10px 15px;border-radius:5px;
  margin:10px 0;color:#0ff;font-size:13px;
}
</style>
</head>
<body>
<div class="container">
  <h1>MantaShark 飞行日志分析器</h1>

  <div class="upload-zone" id="zone" onclick="document.getElementById('file').click()">
    <div class="icon">⬆</div>
    <p style="font-size:18px;color:#ddd;">点击或拖拽 <code>.BIN</code> 日志文件到这里</p>
    <p class="hint">支持 ArduPilot Dataflash 日志，最大 500MB</p>
  </div>
  <input type="file" id="file" accept=".BIN,.bin" onchange="upload()">

  <div class="loading" id="loading">
    <div class="spinner"></div>
    <p style="margin-top:10px;">正在分析...（大文件可能需要 10-30 秒）</p>
  </div>

  <div id="result" style="display:none;">
    <div class="file-info" id="fileInfo"></div>
    <div class="tabs">
      <button class="active" onclick="showTab('report')">文本报告</button>
      <button onclick="showTab('plot')">图表</button>
    </div>
    <div class="tab-content active" id="tab-report">
      <div id="warnings"></div>
      <div class="report" id="reportText"></div>
    </div>
    <div class="tab-content" id="tab-plot">
      <img class="plot" id="plotImg" src="">
    </div>
  </div>

  <div class="footer">MantaShark Web Analyzer · 上传文件不会保留</div>
</div>

<script>
const zone = document.getElementById('zone');
const file = document.getElementById('file');
const loading = document.getElementById('loading');
const result = document.getElementById('result');

zone.addEventListener('dragover', e => {
  e.preventDefault();
  zone.classList.add('dragover');
});
zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
zone.addEventListener('drop', e => {
  e.preventDefault();
  zone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    file.files = e.dataTransfer.files;
    upload();
  }
});

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

async function upload() {
  if (!file.files[0]) return;
  const f = file.files[0];
  if (!f.name.toLowerCase().endsWith('.bin')) {
    alert('请上传 .BIN 文件');
    return;
  }
  loading.classList.add('show');
  result.style.display = 'none';

  const fd = new FormData();
  fd.append('file', f);
  try {
    const res = await fetch('/analyze', {method: 'POST', body: fd});
    if (!res.ok) {
      throw new Error(`服务器错误: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();

    document.getElementById('fileInfo').textContent =
      `文件: ${f.name}  大小: ${(f.size/1024/1024).toFixed(1)}MB  时长: ${data.duration.toFixed(1)}s  解锁次数: ${data.armed_count}`;
    document.getElementById('reportText').innerHTML = data.report_html;

    if (data.warnings && data.warnings.length > 0) {
      let html = '<div class="warnings"><h3>⚠ 检测到 ' + data.warnings.length + ' 个问题</h3><ol>';
      data.warnings.forEach(w => html += '<li>' + escapeHtml(w) + '</li>');
      html += '</ol></div>';
      document.getElementById('warnings').innerHTML = html;
    } else {
      document.getElementById('warnings').innerHTML = '<div class="no-warnings">✓ 未检测到明显问题</div>';
    }

    if (data.plot_b64) {
      document.getElementById('plotImg').src = 'data:image/png;base64,' + data.plot_b64;
    } else {
      document.getElementById('plotImg').src = '';
    }

    result.style.display = 'block';
  } catch (e) {
    alert('分析失败: ' + e.message);
  } finally {
    loading.classList.remove('show');
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
</script>
</body>
</html>"""


def strip_ansi(text):
    """去掉 ANSI 颜色码"""
    ansi_re = re.compile(r'\x1b\[[0-9;]*m')
    return ansi_re.sub('', text)


def colorize_html(text):
    """把文本中的特征字符变成 HTML 颜色"""
    text = strip_ansi(text)
    text = (text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))
    # 根据特征着色
    lines = text.split('\n')
    out = []
    for line in lines:
        if '✓' in line:
            line = f'<span class="ok">{line}</span>'
        elif '✗' in line or 'FAIL' in line:
            line = f'<span class="err">{line}</span>'
        elif '⚠' in line:
            line = f'<span class="warn">{line}</span>'
        elif line.startswith('  ') and '====' in line:
            line = f'<span class="head">{line}</span>'
        elif '====' in line or '────' in line:
            line = f'<span class="label">{line}</span>'
        out.append(line)
    return '\n'.join(out)


@app.route('/')
def index():
    return INDEX_HTML


@app.route('/analyze', methods=['POST'])
def analyze():
    if 'file' not in request.files:
        return 'No file', 400
    f = request.files['file']
    if not f.filename:
        return 'Empty filename', 400

    # 保存到临时文件
    with tempfile.NamedTemporaryFile(suffix='.BIN', delete=False) as tmp:
        f.save(tmp.name)
        tmp_path = tmp.name

    try:
        # 跑分析（捕获 stdout）
        analyzer = LogAnalyzer(tmp_path)
        analyzer.parse()
        analyzer.detect_armed_periods()

        # 重定向 stdout 捕获报告
        buf = io.StringIO()
        old_stdout = sys.stdout
        sys.stdout = buf
        try:
            analyzer.report()
        finally:
            sys.stdout = old_stdout

        report_text = buf.getvalue()
        report_html = colorize_html(report_text)

        # 生成图表
        plot_b64 = None
        try:
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as plt

            fig, axes = plt.subplots(5, 1, figsize=(14, 12), sharex=True)
            colors = {'KS':'#ff9f43','KDF':'#1dd1a1','KDM':'#54a0ff','KT':'#00d2d3','KRD':'#ee5a24'}
            # Speed
            if analyzer.gps:
                t = [x[0] for x in analyzer.gps]
                v = [x[1] for x in analyzer.gps]
                axes[0].plot(t, v, 'b-', lw=1)
                axes[0].axhline(y=4, color='gray', ls='--', alpha=0.5, label='V1=4')
                axes[0].axhline(y=8, color='orange', ls='--', alpha=0.5, label='V2=8')
                axes[0].axhline(y=14, color='green', ls='--', alpha=0.5, label='V3=14')
                axes[0].set_ylabel('Speed (m/s)')
                axes[0].legend(loc='upper right', fontsize=8)
                axes[0].grid(True, alpha=0.3)
            # Attitude
            if analyzer.att:
                t = [x[0] for x in analyzer.att]
                p = [x[2] for x in analyzer.att]
                r = [x[1] for x in analyzer.att]
                axes[1].plot(t, p, 'g-', lw=1, label='Pitch')
                axes[1].plot(t, r, 'r-', lw=1, label='Roll')
                axes[1].axhline(y=8, color='gray', ls=':', alpha=0.5, label='Wing Ofs')
                axes[1].set_ylabel('Att (deg)')
                axes[1].legend(loc='upper right', fontsize=8)
                axes[1].grid(True, alpha=0.3)
            # Motor groups
            if analyzer.rcou:
                t = [x[0] for x in analyzer.rcou]
                for gname, gdef in MOTOR_GROUPS.items():
                    avg = [sum(r[ch] for ch in gdef['channels'])/len(gdef['channels']) for r in analyzer.rcou]
                    axes[2].plot(t, avg, color=colors[gname], label=gname, lw=1)
                axes[2].set_ylabel('Motor PWM')
                axes[2].legend(loc='upper right', fontsize=8, ncol=5)
                axes[2].grid(True, alpha=0.3)
            # RC + switches
            if analyzer.rcin:
                t = [x[0] for x in analyzer.rcin]
                axes[3].plot(t, [x[3] for x in analyzer.rcin], 'k-', lw=1, label='Throttle')
                axes[3].plot(t, [x[6] for x in analyzer.rcin], 'b-', lw=0.8, alpha=0.6, label='Mode (ch6)')
                axes[3].plot(t, [x[7] for x in analyzer.rcin], 'r-', lw=0.8, alpha=0.6, label='Gear (ch7)')
                axes[3].plot(t, [x[9] for x in analyzer.rcin], 'g-', lw=0.8, alpha=0.6, label='Auto (ch9)')
                axes[3].set_ylabel('PWM')
                axes[3].legend(loc='upper right', fontsize=8, ncol=4)
                axes[3].grid(True, alpha=0.3)
            # Battery
            if analyzer.bat:
                t = [x[0] for x in analyzer.bat]
                c = [x[2] for x in analyzer.bat]
                axes[4].plot(t, c, 'r-', lw=1)
                axes[4].set_ylabel('Current (A)')
                axes[4].set_xlabel('Time (s)')
                axes[4].grid(True, alpha=0.3)
            for s, e in analyzer.armed_periods:
                for ax in axes:
                    ax.axvspan(s, e, alpha=0.05, color='green')
            plt.tight_layout()
            buf_img = io.BytesIO()
            plt.savefig(buf_img, format='png', dpi=90, facecolor='#1a1a2e')
            buf_img.seek(0)
            plot_b64 = base64.b64encode(buf_img.read()).decode('ascii')
            plt.close(fig)
        except ImportError:
            pass
        except Exception as e:
            print(f"Plot error: {e}", file=sys.stderr)

        return {
            'duration': analyzer.duration,
            'armed_count': len(analyzer.armed_periods),
            'report_html': report_html,
            'warnings': analyzer.warnings,
            'plot_b64': plot_b64,
        }
    finally:
        os.unlink(tmp_path)


def main():
    parser = argparse.ArgumentParser(description="MantaShark Web 日志分析器")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址 (默认 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8090, help="端口 (默认 8090)")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()

    print(f"\n  MantaShark 飞行日志 Web 分析器")
    print(f"  打开浏览器访问: http://localhost:{args.port}")
    print(f"  Ctrl+C 停止服务\n")

    if not args.no_browser:
        try:
            import webbrowser
            import threading
            threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{args.port}")).start()
        except Exception:
            pass

    app.run(host=args.host, port=args.port, debug=False)


if __name__ == "__main__":
    main()
