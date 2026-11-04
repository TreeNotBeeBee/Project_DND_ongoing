import { useEffect, useState } from 'react';
import { api } from './transport';

export interface HostStatus { status: string; url?: string | null; error?: string | null; localUrl?: string; serverId?: string; version?: string }
export function useHostStatus(token: string) {
  const [status, setStatus] = useState<HostStatus | null>(null);
  useEffect(() => {
    if (!token) return;
    let disposed = false; let busy = false;
    const poll = async () => {
      if (busy) return; busy = true;
      try { const result = await api<HostStatus>('/api/host', undefined, { 'X-Jige-Host-Token': token }); if (!disposed) setStatus(result); }
      catch (reason) { if (!disposed) setStatus({ status: 'error', error: reason instanceof Error ? reason.message : '无法读取主机状态' }); }
      finally { busy = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [token]);
  return status;
}
export function HostStatusCard({ token }: { token: string }) {
  const status = useHostStatus(token);
  return <div className="surface"><h2>公网联机</h2>{!token ? <p>从本机启动窗口中的专用链接打开页面，即可查看公网隧道状态。当前房间和玩家身份不会因此改变。</p> : !status ? <p>正在读取本机隧道状态…</p> : <><span className={`host-status ${status.status}`}><i />{status.status === 'online' ? '公网连接已就绪' : status.status === 'error' ? '公网连接遇到问题' : '当前仅本机连接'}</span>{status.url && <p><a href={status.url} target="_blank" rel="noreferrer">{status.url}</a></p>}{status.error && <p className="notice warning">{status.error}</p>}{status.status !== 'online' && <p>请检查本机启动窗口。公网恢复后，此处会自动显示新链接。</p>}<p className="muted">主机状态每 3 秒更新。公网地址变化时，玩家用自己的恢复码重新加入。</p></>}</div>;
}
