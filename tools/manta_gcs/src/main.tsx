import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// ErrorBoundary: 渲染崩溃时显示恢复按钮 + 一键清持久化, 不让用户卡白屏.
class ErrBoundary extends React.Component<{children: React.ReactNode}, {err: Error | null}> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error, info: React.ErrorInfo) {
    console.error('[Tuner crash]', err, info);
  }
  resetStore = () => {
    try { localStorage.removeItem('mantashark-tuner-v9'); } catch {}
    location.reload();
  };
  render() {
    if (this.state.err) {
      return (
        <div style={{
          padding: 40, fontFamily: 'monospace', color: '#e8eef7',
          background: '#0a0e14', minHeight: '100vh',
        }}>
          <h2 style={{ color: '#f25f5c' }}>⚠ Tuner 渲染出错</h2>
          <p style={{ color: '#8593a8', maxWidth: 700 }}>
            通常是旧的本地存储数据 (localStorage) 不兼容新版本.
            点下方按钮清掉持久化状态 + 重载, 一切回到默认.
          </p>
          <pre style={{ background: '#161b24', padding: 12, borderRadius: 4, overflow: 'auto', maxWidth: 900 }}>
            {String(this.state.err?.stack || this.state.err)}
          </pre>
          <button onClick={this.resetStore} style={{
            background: '#58b4ff', color: '#0a0e14', border: 'none', padding: '8px 16px',
            borderRadius: 4, cursor: 'pointer', fontSize: 14, fontWeight: 600,
          }}>
            清缓存并重载
          </button>
          <p style={{ color: '#5a6374', marginTop: 16, fontSize: 12 }}>
            或在 URL 后加 ?reset=1 也可清持久化.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrBoundary>
      <App />
    </ErrBoundary>
  </React.StrictMode>,
);
