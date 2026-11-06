import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, ContentEntry, MigrationReport, Snapshot } from '../shared/model';
import { prepareCommand, queueKey, validateArchiveBody } from './transport-utils';

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
export interface PendingCommand { command: Command; label: string; status: 'queued' | 'sending' | 'conflict' | 'rejected'; error?: string; outcomeUnknown?: boolean }
export interface Account { id: string; username: string; displayName: string; canCreateWorld: boolean }
export interface AccountInfo { account: Account | null; legacySession?: Snapshot['session'] }
export interface WorldSummary { id: string; name: string; mode: 'gm' | 'ai' | 'co-create'; phase: 'setup' | 'running'; role: 'gm' | 'player'; isOwner: boolean; updatedAt: string }

function definiteRejection(reason: unknown): reason is ApiError {
  const semanticConflicts = ['already_claimed','character_taken','already_registered','scene_full','pending_intent','nothing_to_undo','undo_order','paused','draft_actor','build_review_required'];
  return reason instanceof ApiError && ([400, 401, 403, 404, 405, 413, 415, 422].includes(reason.status) || reason.status === 409 && semanticConflicts.includes(reason.body?.code))
    && typeof reason.body?.code === 'string' && reason.body.code.length > 0 && typeof reason.body.error === 'string';
}
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
  const [account, setAccount] = useState<Account | null>(null), [legacySession, setLegacySession] = useState<Snapshot['session']>();
  const [accountError, setAccountError] = useState(''), [worlds, setWorlds] = useState<WorldSummary[]>([]), [transitioning, setTransitioning] = useState(false);
  const accountRef = useRef(account); accountRef.current = account;
  const navigationLock = useRef(false), generation = useRef(0);
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
  const refresh = useCallback(async () => { const epoch = generation.current; const data = await api<Snapshot>('/api/state'); if (epoch === generation.current && !navigationLock.current) acceptSnapshot(data); return data; }, [acceptSnapshot]);
  const refreshWorlds = useCallback(async () => { const epoch = generation.current; const data = await api<{ worlds: WorldSummary[] }>('/api/worlds'); if (epoch === generation.current) setWorlds(Array.isArray(data.worlds) ? data.worlds : []); return data.worlds; }, []);
  const refreshAccount = useCallback(async () => {
    const epoch = generation.current, data = await api<AccountInfo>('/api/account');
    if (epoch === generation.current) { accountRef.current = data.account; setAccount(data.account); setLegacySession(data.legacySession); setAccountError(''); }
    return data;
  }, []);
  useEffect(() => {
    let disposed = false;
    Promise.allSettled([refresh(), api<{ entries: ContentEntry[]; coverage?: unknown }>('/api/content').then(data => { if (!disposed) { setEntries(data.entries); setCoverage(data.coverage); } }), refreshAccount().then(async data => { if (data.account && !disposed) await refreshWorlds(); }).catch(reason => { if (!disposed) setAccountError(reason instanceof Error ? reason.message : '账号服务读取失败'); })]).then(results => {
      if (disposed) return;
      const result = results[0];
      if (result.status === 'rejected' && !(result.reason instanceof ApiError && result.reason.status === 401)) setError('暂时无法连接本机服务器。请确认启动窗口仍然打开。');
      if (results[1].status === 'rejected') setError('规则目录加载失败。恢复连接后请刷新页面。');
      setLoading(false);
    });
    return () => { disposed = true; };
  }, [refresh, refreshAccount, refreshWorlds]);
  const contentKey = snapshot?.world?.ownerId === snapshot?.session.member.id
    ? snapshot?.state.actors.filter(a => a.kind !== 'hero').map(a => `${a.id}:${a.name}:${a.hp.max}:${JSON.stringify(a.customActions || [])}`).join('|')
    : snapshot?.state.actors.filter(a => a.ownerId === snapshot.session.member.id).flatMap(a => a.knownEntries || []).sort().join('|');
  useEffect(() => {
    if (!snapshot) { setEntries([]); setCoverage(null); return; }
    let disposed = false;
    void api<{ entries: ContentEntry[]; coverage?: unknown }>('/api/content').then(data => { if (!disposed) { setEntries(data.entries); setCoverage(data.coverage ?? null); } }).catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : '图鉴读取失败'); });
    return () => { disposed = true; };
  }, [snapshot?.session.campaignId, snapshot?.session.member.id, contentKey]);
  const writePending = useCallback((rows: PendingCommand[]) => {
    pendingRef.current = rows; setPending(rows);
    const active = stateRef.current;
    if (active) try {
      const key = queueKey(active.session.campaignId, active.session.member.id);
      if (rows.length) localStorage.setItem(key, JSON.stringify(rows)); else localStorage.removeItem(key);
    } catch { setError('待提交操作无法暂存到浏览器。请保持此页面打开。'); }
  }, []);
  useEffect(() => {
    if (!snapshot) { writePending([]); return; }
    const key = queueKey(snapshot.session.campaignId, snapshot.session.member.id);
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '[]');
      const rows: PendingCommand[] = Array.isArray(saved) ? saved.filter(row => typeof row?.command?.operationId === 'string').map(row => ({
        ...row, status: row.status === 'conflict' && !row.outcomeUnknown ? 'conflict' : 'queued',
        outcomeUnknown: row.status === 'conflict' ? Boolean(row.outcomeUnknown) : true,
        ...(row.status === 'rejected' ? { error: '上次操作的结果需核验。请按原操作编号安全重试；不能直接作为新操作重提。' } : {}),
      })) : [];
      writePending(rows);
    } catch { pendingRef.current = []; setPending([]); }
  }, [snapshot?.session.campaignId, snapshot?.session.member.id, writePending]);
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
        if (disposed) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'snapshot' && message.snapshot?.session?.campaignId === snapshot.session.campaignId && message.snapshot?.session?.member?.id === snapshot.session.member.id && stateRef.current?.session.campaignId === snapshot.session.campaignId && stateRef.current?.session.member.id === snapshot.session.member.id && !navigationLock.current) { setConnection('online'); acceptSnapshot(message.snapshot); }
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
    if (accepting.current || !stateRef.current) return false;
    const session = stateRef.current.session;
    const sameSession = () => stateRef.current?.session.campaignId === session.campaignId && stateRef.current.session.member.id === session.member.id;
    accepting.current = true;
    writePending(pendingRef.current.map(row => row.command.operationId === item.command.operationId ? { ...row, status: 'sending', error: undefined } : row));
    try {
      const result = await api<{ snapshot: Snapshot }>('/api/command', item.command);
      if (!sameSession()) return false;
      if (result?.snapshot?.state?.id !== session.campaignId || result.snapshot?.session?.campaignId !== session.campaignId || result.snapshot.session.member?.id !== session.member.id || !Number.isSafeInteger(result.snapshot.state.rev) || result.snapshot.state.rev <= item.command.expectedRev) throw new Error('服务器确认内容不完整；请保留原操作编号安全重试。');
      acceptSnapshot(result.snapshot);
      setError('');
      writePending(pendingRef.current.filter(row => row.command.operationId !== item.command.operationId));
      return true;
    } catch (reason) {
      if (!sameSession()) return false;
      if (reason instanceof ApiError) {
        if (reason.body.snapshot) acceptSnapshot(reason.body.snapshot);
        const conflict = reason.status === 409 && reason.body.code === 'stale_revision' && !item.outcomeUnknown;
        if (definiteRejection(reason) && !item.outcomeUnknown) writePending(pendingRef.current.filter(row => row.command.operationId !== item.command.operationId));
        else writePending(pendingRef.current.map(row => row.command.operationId === item.command.operationId ? { ...row, status: conflict ? 'conflict' : 'queued', outcomeUnknown: !conflict, error: conflict ? reason.message : `操作结果尚未确认；请保留原编号安全重试。${reason.message}` } : row));
        setError(conflict ? '房间状态已改变。请检查最新状态，再决定是否重提此操作。' : reason.message);
      } else {
        setConnection('offline');
        writePending(pendingRef.current.map(row => row.command.operationId === item.command.operationId ? { ...row, status: 'queued', outcomeUnknown: true, error: '服务器尚未确认结果；恢复后请用原操作编号安全重试，重复请求不会再次结算。' } : row));
        setError(reason instanceof Error ? reason.message : '服务器尚未确认操作结果，请安全重试。');
      }
      return false;
    } finally { accepting.current = false; }
  }, [acceptSnapshot, writePending]);
  const command = useCallback(async (type: string, actorId?: string, payload: Record<string, unknown> = {}, targetIds: string[] = [], label = type) => {
    const active = stateRef.current;
    if (!active || accepting.current || navigationLock.current) return false;
    if (pendingRef.current.length) { setError('请先处理待提交的操作，再继续新的操作。'); return false; }
    const item: PendingCommand = { command: prepareCommand(type, active.state.rev, actorId, payload, targetIds), label, status: 'queued' };
    writePending([item]);
    return sendPending(item);
  }, [sendPending, writePending]);
  const retry = useCallback(async (operationId: string, rebase = false) => {
    if (accepting.current) return false;
    const row = pendingRef.current.find(item => item.command.operationId === operationId);
    if (!row) return false;
    if (rebase && row.status === 'conflict' && !row.outcomeUnknown && stateRef.current) {
      const next = { ...row, status: 'queued' as const, command: { ...row.command, expectedRev: stateRef.current.state.rev, operationId: crypto.randomUUID() } };
      writePending(pendingRef.current.map(item => item === row ? next : item));
      return sendPending(next);
    } else return sendPending(row);
  }, [sendPending, writePending]);
  const clearWorld = useCallback(() => { stateRef.current = null; setSnapshot(null); pendingRef.current = []; setPending([]); setRecoveryCode(''); setEntries([]); setCoverage(null); setConnection('offline'); }, []);
  const beginNavigation = useCallback((recovering = false) => {
    if (navigationLock.current || accepting.current || !recovering && pendingRef.current.length) { setError('请先核验或处理当前世界的待提交操作，再切换世界或账号。'); return false; }
    navigationLock.current = true; generation.current++; setTransitioning(true); setError(''); return true;
  }, []);
  const finishNavigation = useCallback(() => { navigationLock.current = false; setTransitioning(false); }, []);
  const authenticate = useCallback(async (mode: 'create' | 'join' | 'recover', values: Record<string, unknown>) => {
    if (!beginNavigation(mode === 'recover')) return false;
    const previous = stateRef.current?.session, waiting = pendingRef.current.length > 0;
    setError('');
    try {
      const result = await api<Snapshot & { recoveryCode?: string }>(mode === 'create' ? '/api/campaigns' : `/api/${mode}`, { ...values, ...(mode === 'create' ? { hostToken } : {}) });
      const different = waiting && previous && (previous.campaignId !== result.session.campaignId || previous.member.id !== result.session.member.id);
      if (different) clearWorld();
      acceptSnapshot(result); setRecoveryCode(accountRef.current ? '' : result.recoveryCode || ''); if (accountRef.current) { setLegacySession(undefined); await refreshWorlds().catch(() => {}); }
      if (different) setError('恢复到了另一个身份。原世界的待核验操作仍按原编号保存在此浏览器，请回到原世界安全核验。');
      return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '连接失败，请稍后重试。'); return false; } finally { finishNavigation(); }
  }, [hostToken, acceptSnapshot, beginNavigation, finishNavigation, refreshWorlds, clearWorld]);
  const accountAuthenticate = useCallback(async (mode: 'register' | 'login', values: { username: string; password: string; displayName?: string }) => {
    if (!beginNavigation()) return false;
    try {
      const result = await api<AccountInfo>(`/api/account/${mode}`, { ...values, ...(hostToken ? { hostToken } : {}) });
      if (!result.account) throw new Error('服务器未确认账号，请重新登录。');
      accountRef.current = result.account; setAccount(result.account); setAccountError(''); clearWorld();
      await refreshAccount(); await refreshWorlds(); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '账号连接失败'); return false; } finally { finishNavigation(); }
  }, [beginNavigation, finishNavigation, clearWorld, hostToken, refreshAccount, refreshWorlds]);
  const enterWorld = useCallback(async (worldId: string) => {
    if (!beginNavigation()) return false;
    try { const result = await api<Snapshot>('/api/worlds/enter', { worldId }); clearWorld(); acceptSnapshot(result); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '进入世界失败'); return false; } finally { finishNavigation(); }
  }, [beginNavigation, finishNavigation, clearWorld, acceptSnapshot]);
  const leaveWorld = useCallback(async () => {
    if (!beginNavigation()) return false;
    try { await api('/api/worlds/leave', {}); clearWorld(); await refreshWorlds(); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '返回主菜单失败'); return false; } finally { finishNavigation(); }
  }, [beginNavigation, finishNavigation, clearWorld, refreshWorlds]);
  const linkCurrent = useCallback(async () => {
    if (!beginNavigation()) return false;
    try { await api('/api/account/link-current', {}); clearWorld(); await refreshAccount(); await refreshWorlds(); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '关联旧身份失败'); return false; } finally { finishNavigation(); }
  }, [beginNavigation, finishNavigation, clearWorld, refreshAccount, refreshWorlds]);
  const accountLogout = useCallback(async () => {
    if (!beginNavigation()) return false;
    try { await api('/api/account/logout', {}); clearWorld(); accountRef.current = null; setAccount(null); setWorlds([]); setLegacySession(undefined); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '退出账号失败'); return false; } finally { finishNavigation(); }
  }, [beginNavigation, finishNavigation, clearWorld]);
  const migrate = useCallback(async (payload: unknown) => {
    validateArchiveBody({ payload });
    const result = await api<{ snapshot: Snapshot; report: MigrationReport }>('/api/migrate', { payload });
    acceptSnapshot(result.snapshot); setReport(result.report); return result.report;
  }, [acceptSnapshot]);
  const restore = useCallback(async (backup: unknown) => { validateArchiveBody({ backup }); const result = await api<{ snapshot: Snapshot }>('/api/restore', { backup }); acceptSnapshot(result.snapshot); }, [acceptSnapshot]);
  const logout = useCallback(async () => { if (accountRef.current) { await leaveWorld(); return; } if (!beginNavigation()) return; try { await api('/api/logout', {}); clearWorld(); } finally { finishNavigation(); } }, [leaveWorld, beginNavigation, finishNavigation, clearWorld]);
  return { snapshot, loading, connection, error, setError, entries, coverage, pending, recoveryCode, setRecoveryCode, hostToken, authenticate, command, retry, discard: (operationId: string) => { if (!accepting.current) writePending(pendingRef.current.filter(row => row.command.operationId !== operationId)); }, migrate, report, restore, logout, refresh, account, accountError, legacySession, worlds, transitioning, accountAuthenticate, accountLogout, refreshAccount, refreshWorlds, enterWorld, leaveWorld, linkCurrent };
}
export type GameClient = ReturnType<typeof useGame>;
