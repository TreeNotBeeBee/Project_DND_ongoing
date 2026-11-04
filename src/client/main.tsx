import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

class Boundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <main className="loading-screen"><h1>页面遇到了一个问题</h1><p>服务器上已经确认的数据仍然保留。请重新读取页面。</p><details><summary>错误详情</summary><pre>{this.state.error}</pre></details><button className="button primary" onClick={() => location.reload()}>重新加载</button></main>;
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Boundary><App /></Boundary></React.StrictMode>);
