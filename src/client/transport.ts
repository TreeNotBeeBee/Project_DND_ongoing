import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, ContentEntry, MigrationReport, Snapshot } from '../shared/model';
import { prepareCommand, queueKey, validateArchiveBody } from './client-utils';

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, any>) { super(message); }
}
export async function api<T>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-Jige-Request': '1' } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const guidance: Record<string, string> = {
      MATERIAL_REQUIRED: '缺少合规施法材料。请由主持人确认已取得对应材料，并在房间设置中记录；此操作尚未消耗法术位。',
      MATERIAL_WORKFLOW_REQUIRED: '此法术同时包含消耗与可复用材料，目前材料流程尚未支持，无法施放。',
    };
    const message = String(data.error || data.message || `请求失败（${response.status}）`);
    throw new ApiError(guidance[data.code] ? `${guidance[data.code]} ${message}` : message, response.status, data);
  }
  return data as T;
}
export interface PendingCommand { command: Command; label: string; status: 'queued' | 'sending' | 'conflict' | 'rejected'; error?: string }
type Connection = 'connecting' | 'online' | 'offline';
export function useGame() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const stateRef = useRef(snapshot); stateRef.current = snapshot;
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState('');
  const [entries, setEntries] = useState<ContentEntry[]>([]);
  const [coverage, setCoverage] = useState<unknown>(null);
  const [pending, setPending] = useState<PendingCommand[]>([]);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [recoveryCode, setRecoveryCode] = useState('');
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [hostToken] = useState(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const token = hash.get('hostToken') || hash.get('host') || '';
    return token;
  });
  useEffect(() => { if (hostToken) history.replaceState(null, '', location.pathname + location.search); }, [hostToken]);
  const accepting = useRef(false);
  const acceptSnapshot = useCallback((value: Snapshot) => {
    if (!value?.state || !value?.session) return;
    const prev = stateRef.current;
    if (prev && prev.state.id === value.state.id && prev.state.rev > value.state.rev) return;
    stateRef.current = value; setSnapshot(value);
  }, []);
  const refresh = useCallback(async () => { const data = await api<Snapshot>('/api/state'); acceptSnapshot(data); return data; }, [acceptSnapshot]);
  useEffect(() => {
    let disposed = false;
    Promise.allSettled([refresh(), api<{ entries: ContentEntry[]; coverage?: unknown }>('/api/content').then(data => { if (!disposed) { setEntries(data.entries); setCoverage(data.coverage); } })]).then(results => {
      if (disposed) return;
      const result = results[0];
      if (result.status === 'rejected' && !(result.reason instanceof ApiError && result.reason.status === 401)) setError('暂时无法连接本机服务器。请确认启动窗口仍然打开。');
      if (results[1].status === 'rejected') setError('规则目录加载失败。恢复连接后请刷新页面。');
      setLoading(false);
    });
    return () => { disposed = true; };
  }, [refresh]);
  useEffect(() => {
    if (!snapshot) { setPending([]); return; }
    const key = queueKey(snapshot.session.campaignId, snapshot.session.member.id);
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '[]');
      if (Array.isArray(saved)) setPending(saved.filter(row => row?.command?.operationId).map(row => ({ ...row, status: row.status === 'sending' ? 'queued' : row.status })));
    } catch { setPending([]); }
  }, [snapshot?.session.campaignId, snapshot?.session.member.id]);
  const writePending = useCallback((rows: PendingCommand[]) => {
    pendingRef.current = rows; setPending(rows);
    const active = stateRef.current;
    if (active) try { localStorage.setItem(queueKey(active.session.campaignId, active.session.member.id), JSON.stringify(rows)); } catch { setError('待提交操作无法暂存到浏览器。请保持此页面打开。'); }
  }, []);
  useEffect(() => {
    if (!snapshot) return;
    let disposed = false, socket: WebSocket | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const connect = () => {
      if (disposed) return;
      setConnection('connecting');
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socket.onopen = () => { attempts = 0; setConnection('online'); void refresh().catch(() => {}); };
      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'snapshot') { setConnection('online'); acceptSnapshot(message.snapshot); }
          if (message.type === 'ping' && socket?.readyState === WebSocket.OPEN) { setConnection('online'); socket.send(JSON.stringify({ type: 'pong' })); }
        } catch { setError('收到无法读取的同步消息，正在重新读取房间。'); void refresh().catch(() => {}); }
      };
      socket.onerror = () => { setConnection('offline'); };
      socket.onclose = event => {
        if (disposed) return;
        setConnection('offline');
        if (event.code === 4001 || event.code === 4401) { setError('会话已结束。请使用恢复码重新加入。'); return; }
        timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** attempts++));
      };
    };
    connect();
    const onOnline = () => { if (!socket || socket.readyState === WebSocket.CLOSED) { clearTimeout(timer); connect(); } };
    const onOffline = () => setConnection('offline');
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    return () => { disposed = true; clearTimeout(timer); socket?.close(); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, [snapshot?.session.campaignId, snapshot?.session.member.id, acceptSnapshot, refresh]);
  const sendPending = useCallback(async (item: PendingCommand) => {
    if (accepting.current) return;
    accepting.current = true;
    writePending(pendingRef.current.map(row => row.command.operationId === item.command.operationId ? { ...row, status: 'sending', error: undefined } : row));
    try {
      const result = await api<{ snapshot: Snapshot }>('/api/command', item.command);
      acceptSnapshot(result.snapshot);
      setError('');
      writePending(pendingRef.current.filter(row => row.command.operationId !== item.command.operationId));
      return true;
    } catch (reason) {
      if (reason instanceof ApiError) {
        if (reason.body.snapshot) acceptSnapshot(reason.body.snapshot);
        const conflict = reason.status === 409 && reason.body.code === 'stale_revision';
        writePending(pendingRef.current.map(row => row.command.operationId === item.command.operationId ? { ...row, status: conflict ? 'conflict' : 'rejected', error: reason.message } : row));
        setError(conflict ? '房间状态已改变。请检查最新状态，再决定是否重提此操作。' : reason.message);
      } else {
        setConnection('offline');
        writePending(pendingRef.current.map(row => row.command.operationId === item.command.operationId ? { ...row, status: 'queued', error: '连接中断；恢复后可安全重试，重复请求不会再次结算。' } : row));
      }
      return false;
    } finally { accepting.current = false; }
  }, [acceptSnapshot, writePending]);
  const command = useCallback(async (type: string, actorId?: string, payload: Record<string, unknown> = {}, targetIds: string[] = [], label = type) => {
    const active = stateRef.current;
    if (!active) return false;
    if (pendingRef.current.length) { setError('请先处理待提交的操作，再继续新的操作。'); return false; }
    const item: PendingCommand = { command: prepareCommand(type, active.state.rev, actorId, payload, targetIds), label, status: 'queued' };
    writePending([item]);
    return sendPending(item);
  }, [sendPending, writePending]);
  const retry = useCallback((operationId: string, rebase = false) => {
    const row = pendingRef.current.find(item => item.command.operationId === operationId);
    if (!row) return;
    if (rebase && stateRef.current) {
      const next = { ...row, status: 'queued' as const, command: { ...row.command, expectedRev: stateRef.current.state.rev, operationId: crypto.randomUUID() } };
      writePending(pendingRef.current.map(item => item === row ? next : item));
      void sendPending(next);
    } else void sendPending(row);
  }, [sendPending, writePending]);
  const authenticate = useCallback(async (mode: 'create' | 'join' | 'recover', values: Record<string, string>) => {
    setError('');
    try {
      const result = await api<Snapshot & { recoveryCode?: string }>(mode === 'create' ? '/api/campaigns' : `/api/${mode}`, { ...values, ...(mode === 'create' ? { hostToken } : {}) });
      acceptSnapshot(result); setRecoveryCode(result.recoveryCode || ''); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '连接失败，请稍后重试。'); return false; }
  }, [hostToken, acceptSnapshot]);
  const migrate = useCallback(async (payload: unknown) => {
    validateArchiveBody({ payload });
    const result = await api<{ snapshot: Snapshot; report: MigrationReport }>('/api/migrate', { payload });
    acceptSnapshot(result.snapshot); setReport(result.report); return result.report;
  }, [acceptSnapshot]);
  const restore = useCallback(async (backup: unknown) => { validateArchiveBody({ backup }); const result = await api<{ snapshot: Snapshot }>('/api/restore', { backup }); acceptSnapshot(result.snapshot); }, [acceptSnapshot]);
  const logout = useCallback(async () => { await api('/api/logout', {}); setSnapshot(null); setRecoveryCode(''); }, []);
  return { snapshot, loading, connection, error, setError, entries, coverage, pending, recoveryCode, setRecoveryCode, hostToken, authenticate, command, retry, discard: (operationId: string) => writePending(pendingRef.current.filter(row => row.command.operationId !== operationId)), migrate, report, restore, logout, refresh };
}
export type GameClient = ReturnType<typeof useGame>;
