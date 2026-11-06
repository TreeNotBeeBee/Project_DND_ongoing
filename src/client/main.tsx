import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// Only test child processes enable the retired UI. Vite removes that branch
// from production, so its private rules catalog never enters public assets.
const App = React.lazy(async () => import.meta.env.VITE_TEST_LEGACY_UI === '1'
  ? { default: (await import('./App')).App }
  : { default: (await import('./WorldApp')).WorldApp });

class Boundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="loading-screen"><h1>页面遇到了一个问题</h1><p>服务器上已经确认的数据仍然保留。请重新读取页面。</p><details><summary>错误详情</summary><pre>{this.state.error}</pre></details><button className="button primary" onClick={() => location.reload()}>重新加载</button></main>;
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Boundary><React.Suspense fallback={<main className="loading-screen"><h1>正在展开世界…</h1></main>}><App /></React.Suspense></Boundary></React.StrictMode>);
