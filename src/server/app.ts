import Koa from 'koa';
import Router from '@koa/router';
import { bodyParser } from '@koa/bodyparser';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import QRCode from 'qrcode';
import type { Command, GameState, Member, Snapshot, ResultEvent, MigrationReport, Dice } from '../shared/model.js';
import { openDatabase, CODE_VERSION, SCHEMA_VERSION, onlineBackup } from './database.js';
import { ApiError, RateLimiter, authorizeCommand, confidentialProjection, cryptoDice, equalSecret, hash, secret } from './security.js';
import { validateBackupState } from './validation.js';
import { prepareActorCommand,validateActorOwnership } from './companions.js';
import { newWorld, type WorldMode } from '../shared/world';
import { isCharacterCommand, resolveCharacterCommand, projectWorld, validateWorldEnvelope, capabilities } from './world-controller';
import { resolveWorldCommand, isWorldCommand } from '../world/index';
import { advanceWorldTime } from '../world/clock';
import { executeEngine } from '../world/engine';
import { applyAiPacket, createAiExchange, previewAiPacket, resolveAiReaction, resumeAiDecisions, type AiContext, type ExchangeKind } from '../ai/protocol';
import { assetReferences, canReadAsset, exportAssets, restoreAssets, saveImageAsset, validateAssetReferences } from './assets';
import { accountInput, passwordHash, verifyPassword } from './accounts';
import { newAiDisplay } from '../shared/ai-display';
import { AiDisplayError, dispatchAiDisplayCommand, exportAiDisplay, isAiDisplayCommand, previewAiDisplay, projectAiDisplay } from '../ai/display';
import { projectAiWorld } from './ai-display-projection';

export interface ServerOptions {
  dataDir: string; distDir?: string; hostToken?: string; engine?: any; content?: any;
  publicOrigin?: string; localOrigins?: string[]; sessionDays?: number;
  dice?: Dice;
  now?: () => number;
  bodyLimits?: Partial<typeof DEFAULT_BODY_LIMITS>;
}
export const DEFAULT_BODY_LIMITS=Object.freeze({large:64*1024*1024,command:12*1024*1024,small:16*1024});
const COOKIE = 'jige_session';
const ACCOUNT_COOKIE = 'jige_account';
const MAX_MEMBERS = 12;
const copy = <T,>(v: T): T => structuredClone(v);
const cleanName = (v: unknown, fallback: string) => typeof v === 'string' ? v.trim().slice(0, 80) || fallback : fallback;
function object(v: any) { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'invalid_body', '请求数据必须为 JSON 对象'); return v; }
function json(text: string) { return JSON.parse(text); }
function canonical(v: unknown): string { if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`; if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`; return JSON.stringify(v) ?? 'null'; }

export async function createApplication(options: ServerOptions) {
  const limits={...DEFAULT_BODY_LIMITS,...options.bodyLimits};
  for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<1)throw new Error('请求体大小配置必须为正整数字节数');
  const storage = await openDatabase(options.dataDir);
  const { db } = storage;
  const clock = options.now || Date.now;
  let engine: any;
  let content: any;
  try {
    engine = options.engine || await import('../engine/index.js');
    content = options.content || await import('../content/index.js');
  } catch (error) { await storage.close(); throw error; }
  const hostToken = options.hostToken || secret();
  const origins = new Set(options.localOrigins || []);
  let localUrl: string | null = null;
  let publicOrigin = '';
  let tunnelStatus: Record<string, any> = { status: 'local', url: null, error: null };
  function setPublicOrigin(value: string | null, error?: string) {
    if (publicOrigin) origins.delete(publicOrigin);
    publicOrigin = '';
    if (value) {
      const u = new URL(value);
      if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(u.hostname) || u.port || u.pathname !== '/' || u.username || u.password || u.search || u.hash) throw new Error('无效的公网隧道地址');
      publicOrigin = u.origin; origins.add(publicOrigin);
    }
    tunnelStatus = { status: publicOrigin ? 'online' : error ? 'error' : 'local', url: publicOrigin || null, error: error || null };
  }
  if (options.publicOrigin) setPublicOrigin(options.publicOrigin);
  const limiter = new RateLimiter();
  const app = new Koa();
  const router = new Router();
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const clients = new Map<WebSocket, { memberId: string; campaignId: string; lastPong: number }>();
  const sessionDuration = Math.max(1, Math.min(365, options.sessionDays || 30)) * 86400_000;
  const ipOf = (ctx: any) => publicOrigin && ctx.host === new URL(publicOrigin).host ? ctx.get('cf-connecting-ip') || ctx.req.socket.remoteAddress || 'unknown' : ctx.req.socket.remoteAddress || 'unknown';
  function cookieToken(ctx: any) { return ctx.cookies.get(COOKIE) || ''; }
  function accountByToken(token: string) {
    if (!token || token.length > 256) return null;
    const row: any = db.prepare('SELECT a.* FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token), Date.now());
    return row ? { id: row.id as string, username: row.username as string, displayName: row.display_name as string, canCreateWorld: Boolean(row.can_host) } : null;
  }
  function currentAccount(ctx: any) { return accountByToken(ctx.cookies.get(ACCOUNT_COOKIE) || ''); }
  function accountAuth(ctx: any) { const account = currentAccount(ctx); if (!account) throw new ApiError(401, 'account_required', '请先登录账号'); return account; }
  function sessionByToken(token: string, accountToken = '', allowUnlinked = true) {
    if (!token || token.length > 256) return null;
    const row: any = db.prepare('SELECT m.*,s.expires_at FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=?').get(hash(token));
    if (!row || row.expires_at <= Date.now()) return null;
    const linked: any = db.prepare('SELECT account_id FROM account_members WHERE member_id=?').get(row.id);
    if (linked && accountByToken(accountToken)?.id !== linked.account_id || !linked && !allowUnlinked) return null;
    return { member: { id: row.id, name: row.name, role: row.role } as Member, campaignId: row.campaign_id };
  }
  function auth(ctx: any) { const session = sessionByToken(cookieToken(ctx), ctx.cookies.get(ACCOUNT_COOKIE) || ''); if (!session) throw new ApiError(401, 'unauthorized', '请先登录账号并进入世界，或恢复旧身份'); return session; }
  function gmAuth(ctx: any) { const session = auth(ctx); if (session.member.role !== 'gm') throw new ApiError(403, 'gm_only', '只有主持人可以执行此操作'); return session; }
  function hostAuth(ctx: any) { const token = ctx.get('x-jige-host-token') || ctx.get('authorization').replace(/^Bearer\s+/i, ''); if (!equalSecret(token, hostToken)) throw new ApiError(403, 'host_only', '需要本机主机凭据'); }
  function campaign(id: string) { const row: any = db.prepare('SELECT * FROM campaigns WHERE id=?').get(id); if (!row) throw new ApiError(404, 'campaign_missing', '战役不存在'); return row; }
  function worldContext(campaignId: string) {
    const members = db.prepare('SELECT id,name,role FROM members WHERE campaign_id=?').all(campaignId) as Member[];
    return { now: Math.max(0, Math.floor(clock())), members, onlineMemberIds: [...new Set([...clients.values()].filter(c => c.campaignId === campaignId).map(c => c.memberId))], dice: options.dice || cryptoDice, resolveEngine: (state: GameState, command: Command, dice: Dice) => engine.resolveCommand(state, command, dice, state.combat.active ? undefined : { economy: 'world', skipResources: state.world?.rules.energy || state.world?.mode === 'co-create' ? ['ap'] : [] }) };
  }
  function aiContext(campaignId: string, member: Member): AiContext { return { ...worldContext(campaignId), member, engine, resolveWorldCommand }; }
  function displayContext(campaignId: string, member: Member) { const context = worldContext(campaignId); return { member, members: context.members, now: context.now, dice: context.dice }; }
  function aiOwner(session: { member: Member; campaignId: string }, state: GameState) {
    if (state.world?.mode !== 'ai') throw new ApiError(400, 'ai_mode', '请在AI主持模式中使用交换工作台');
    if (state.world.ownerId !== session.member.id) throw new ApiError(403, 'owner_only', '只有房主可以导出或确认AI决策');
  }
  function snapshot(session: {member:Member;campaignId:string}): Snapshot {
    const row = campaign(session.campaignId);
    let raw = json(row.state) as GameState;
    const members = (db.prepare('SELECT id,name,role FROM members WHERE campaign_id=? ORDER BY role,id').all(session.campaignId) as Member[]).map(m => ({ ...m, online: [...clients.values()].some(c => c.memberId === m.id) }));
    if (raw.world?.ai.display) return { ...projectAiWorld(raw, session, members, projectAiDisplay(raw, session.member)!), ...(raw.world.ownerId === session.member.id ? { inviteCode: row.invite_code } : {}) };
    if (raw.world) raw = advanceWorldTime(raw, worldContext(session.campaignId)).state;
    const projected = engine.projectState ? engine.projectState(copy(raw), session.member) : raw;
    const state = confidentialProjection(projected, session.member);
    if (raw.world) return { session, members, ...projectWorld(raw, session, members, engine), ...(raw.world.ownerId === session.member.id ? { inviteCode: row.invite_code } : {}) } as Snapshot;
    return { session, state, members, ...(session.member.role === 'gm' ? { inviteCode: row.invite_code } : {}) };
  }
  const assetContext = { db, raw: (id: string) => json(campaign(id).state) as GameState, projected: snapshot };
  function issueSession(ctx: any, memberId: string) {
    revokeWorldSession(ctx);
    const token = secret();
    db.prepare('INSERT INTO sessions(token_hash,member_id,expires_at) VALUES (?,?,?)').run(hash(token), memberId, Date.now() + sessionDuration);
    const remote = publicOrigin && ctx.host === new URL(publicOrigin).host;
    ctx.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(sessionDuration/1000)}${remote ? '; Secure' : ''}`);
  }
  function clearCookie(ctx: any) { ctx.append('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${publicOrigin && ctx.host === new URL(publicOrigin).host ? '; Secure' : ''}`); }
  function revokeWorldSession(ctx: any) {
    const old = cookieToken(ctx);
    if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(old));
    for (const [ws] of clients) if ((ws as any).sessionHash === hash(old)) ws.close(4001, 'world changed');
  }
  function accountCookie(ctx: any, token: string, maxAge = Math.floor(sessionDuration / 1000)) {
    ctx.append('Set-Cookie', `${ACCOUNT_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${publicOrigin && ctx.host === new URL(publicOrigin).host ? '; Secure' : ''}`);
  }
  function issueAccountSession(ctx: any, accountId: string) {
    const old = ctx.cookies.get(ACCOUNT_COOKIE) || '';
    if (old) db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(hash(old));
    // A world cookie linked to another account must never survive switching accounts.
    const oldMember: any = db.prepare('SELECT m.id,am.account_id FROM sessions s JOIN members m ON m.id=s.member_id LEFT JOIN account_members am ON am.member_id=m.id WHERE s.token_hash=?').get(hash(cookieToken(ctx)));
    if (oldMember?.account_id && oldMember.account_id !== accountId) { revokeWorldSession(ctx); clearCookie(ctx); }
    const token = secret();
    db.prepare('INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES (?,?,?)').run(hash(token), accountId, Date.now() + sessionDuration);
    accountCookie(ctx, token);
  }
  function linkMember(accountId: string, memberId: string, campaignId: string) {
    const linked: any = db.prepare('SELECT account_id FROM account_members WHERE member_id=?').get(memberId);
    if (linked && linked.account_id !== accountId) throw new ApiError(403, 'identity_linked', '该旧身份已关联其他账号，不能再次认领');
    const occupied: any = db.prepare('SELECT member_id FROM account_members WHERE account_id=? AND campaign_id=?').get(accountId, campaignId);
    if (occupied && occupied.member_id !== memberId) throw new ApiError(409, 'world_identity_exists', '此账号在这个世界已有身份；不会覆盖角色归属');
    db.prepare('INSERT OR IGNORE INTO account_members(member_id,account_id,campaign_id) VALUES (?,?,?)').run(memberId, accountId, campaignId);
  }
  function broadcast(campaignId: string) {
    for (const [ws, client] of clients) {
      if (client.campaignId !== campaignId || ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'slow consumer'); continue; }
      const member: any = db.prepare('SELECT id,name,role FROM members WHERE id=?').get(client.memberId);
      if (!member) { ws.close(4001, 'membership revoked'); continue; }
      ws.send(JSON.stringify({ type: 'snapshot', snapshot: snapshot({ member, campaignId }) }));
    }
  }
  function persistState(id: string, state: GameState, sequence: number) { db.prepare('UPDATE campaigns SET state=?,revision=?,event_sequence=?,name=?,updated_at=? WHERE id=?').run(JSON.stringify(state), state.rev, sequence, state.name, new Date().toISOString(), id); }
  function appendEvents(before: GameState, next: GameState, drafts: any[], operationId: string, initialSequence: number) {
    let sequence = initialSequence;
    const events: ResultEvent[] = drafts.map(e => ({ ...e, id: randomUUID(), sequence: ++sequence, operationId, timestamp: new Date().toISOString() }));
    next.events = [...before.events, ...events].slice(-2000);
    return { events, sequence };
  }
  function sendJson(ctx: any, value: any, status = 200) { ctx.status = status; ctx.type = 'application/json'; ctx.body = value; }

  app.use(async (ctx: any, next: any) => {
    ctx.set('Cache-Control', 'no-store'); ctx.set('X-Content-Type-Options', 'nosniff'); ctx.set('Referrer-Policy', 'no-referrer');
    ctx.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    try { await next(); }
    catch (error: any) {
      const status = error instanceof ApiError ? error.status : error instanceof AiDisplayError || typeof engine.RuleError==='function'&&error instanceof engine.RuleError ? 400 : Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500;
      if (status === 500) console.error('[server]', error?.stack || error);
      sendJson(ctx, { error: status === 500 ? '服务器内部错误' : error.message, code: error.code || (status === 413 ? 'body_too_large' : 'request_failed'), ...(error instanceof ApiError ? error.extra : {}) }, status);
    }
  });
  app.use(async (ctx: any, next: any) => {
    if (ctx.path.startsWith('/api/') && !['GET','HEAD'].includes(ctx.method)) {
      const origin = ctx.get('origin');
      if (!origins.has(origin) || ctx.get('x-jige-request') !== '1') throw new ApiError(403, 'origin', '请求来源无效');
      if (ctx.method !== 'POST') throw new ApiError(405, 'method', '方法不支持');
      if (!ctx.is('application/json')) throw new ApiError(415, 'content_type', '请发送 application/json');
      limiter.check(`mutation:${ipOf(ctx)}`, 600);
    }
    await next();
  });
  const parsers={large:bodyParser({enableTypes:['json'],jsonLimit:limits.large}),command:bodyParser({enableTypes:['json'],jsonLimit:limits.command}),small:bodyParser({enableTypes:['json'],jsonLimit:limits.small})};
  app.use(async(ctx:any,next:any)=>{
    const path=ctx.path.replace(/\/+$/,'');
    const large=path==='/api/migrate'||path==='/api/restore';
    const small=['/api/campaigns','/api/join','/api/recover','/api/logout'].includes(path) || path.startsWith('/api/account') || path.startsWith('/api/worlds');
    const kind=large?'large':small?'small':'command';const limit=limits[kind];
    if(ctx.method==='POST'&&large){
      const session=path==='/api/restore'?gmAuth(ctx):auth(ctx);
      limiter.check(`large-body:${path}:${session.member.id}`,10);
    }
    const tooLarge=()=>new ApiError(413,'body_too_large',`请求数据超过 ${limit>=1024*1024?`${limit/(1024*1024)} MiB`:`${limit/1024} KiB`} 上限${large?'（旧存档迁移/战役恢复）':''}`,{limitBytes:limit});
    if(ctx.method==='POST'&&Number(ctx.get('content-length'))>limit)throw tooLarge();
    try{await parsers[kind](ctx,next);}catch(error:any){if(Number(error.status)===413)throw tooLarge();throw error;}
  });
  router.get('/api/health', ctx => sendJson(ctx, { ok: true, version: CODE_VERSION, serverId: storage.serverId }));
  router.get('/api/host', async (ctx: any) => { hostAuth(ctx); sendJson(ctx, { ...tunnelStatus, qrDataUrl: publicOrigin ? await QRCode.toDataURL(publicOrigin, { width: 256, margin: 2 }) : null, localUrl, serverId: storage.serverId, version: CODE_VERSION }); });
  router.get('/api/account', (ctx: any) => {
    const session = sessionByToken(cookieToken(ctx), ctx.cookies.get(ACCOUNT_COOKIE) || '');
    const linked = session && db.prepare('SELECT 1 FROM account_members WHERE member_id=?').get(session.member.id);
    sendJson(ctx, { account: currentAccount(ctx), ...(session && !linked ? { legacySession: session } : {}) });
  });
  router.post('/api/account/register', async (ctx: any) => {
    const body = object(ctx.request.body), input = accountInput(body);
    limiter.check(`register:${ipOf(ctx)}`, 8, 3600_000);
    if (db.prepare('SELECT 1 FROM accounts WHERE username_key=?').get(input.usernameKey)) throw new ApiError(409, 'username_exists', '此账号已存在，请登录或换一个账号');
    const encoded = await passwordHash(input.password);
    const id = randomUUID(), canCreateWorld = equalSecret(body.hostToken, hostToken);
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM accounts WHERE username_key=?').get(input.usernameKey)) throw new ApiError(409, 'username_exists', '此账号已存在，请登录');
      db.prepare('INSERT INTO accounts(id,username,username_key,display_name,password_hash,can_host,created_at) VALUES (?,?,?,?,?,?,?)').run(id, input.username, input.usernameKey, input.displayName, encoded, Number(canCreateWorld), new Date().toISOString());
      issueAccountSession(ctx, id);
    })();
    sendJson(ctx, { account: { id, username: input.username, displayName: input.displayName, canCreateWorld } }, 201);
  });
  router.post('/api/account/login', async (ctx: any) => {
    const body = object(ctx.request.body), input = accountInput(body);
    limiter.check(`login:${ipOf(ctx)}`, 20);
    limiter.check(`login-account:${input.usernameKey}`, 10);
    const row: any = db.prepare('SELECT * FROM accounts WHERE username_key=?').get(input.usernameKey);
    // An unknown username still performs the same password KDF, reducing account probing by timing.
    const encoded = row?.password_hash || 'argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const valid = await verifyPassword(input.password, encoded);
    if (!row || !valid) throw new ApiError(401, 'login_invalid', '账号或密码不正确');
    if (equalSecret(body.hostToken, hostToken)) db.prepare('UPDATE accounts SET can_host=1 WHERE id=?').run(row.id);
    issueAccountSession(ctx, row.id);
    sendJson(ctx, { account: { id: row.id, username: row.username, displayName: row.display_name, canCreateWorld: Boolean(row.can_host) || equalSecret(body.hostToken, hostToken) } });
  });
  router.post('/api/account/logout', (ctx: any) => {
    const token = ctx.cookies.get(ACCOUNT_COOKIE) || '';
    if (token) db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(hash(token));
    revokeWorldSession(ctx); clearCookie(ctx); accountCookie(ctx, '', 0); sendJson(ctx, { ok: true });
  });
  router.post('/api/account/link-current', (ctx: any) => {
    const account = accountAuth(ctx), session = auth(ctx);
    linkMember(account.id, session.member.id, session.campaignId);
    sendJson(ctx, { ok: true, worldId: session.campaignId });
  });
  router.get('/api/worlds', (ctx: any) => {
    const account = accountAuth(ctx);
    const rows: any[] = db.prepare('SELECT c.id,c.name,c.state,c.updated_at,m.role,m.id AS member_id FROM account_members am JOIN campaigns c ON c.id=am.campaign_id JOIN members m ON m.id=am.member_id WHERE am.account_id=? ORDER BY c.updated_at DESC,c.id').all(account.id);
    sendJson(ctx, { worlds: rows.map(row => { const state = json(row.state) as GameState; return { id: row.id, name: row.name, mode: state.world?.mode || 'gm', phase: state.world?.phase || 'running', role: row.role, isOwner: state.world ? state.world.ownerId === row.member_id : row.role === 'gm', updatedAt: row.updated_at }; }) });
  });
  router.post('/api/worlds/enter', (ctx: any) => {
    const account = accountAuth(ctx), body = object(ctx.request.body);
    const row: any = db.prepare('SELECT m.* FROM account_members am JOIN members m ON m.id=am.member_id WHERE am.account_id=? AND am.campaign_id=?').get(account.id, typeof body.worldId === 'string' ? body.worldId : '');
    if (!row) throw new ApiError(404, 'world_missing', '世界不存在或此账号没有加入权限');
    issueSession(ctx, row.id); sendJson(ctx, snapshot({ member: { id: row.id, name: row.name, role: row.role }, campaignId: row.campaign_id }));
  });
  router.post('/api/worlds/leave', (ctx: any) => { accountAuth(ctx); revokeWorldSession(ctx); clearCookie(ctx); sendJson(ctx, { ok: true }); });
  router.get('/api/content', ctx => {
    const session = sessionByToken(cookieToken(ctx), ctx.cookies.get(ACCOUNT_COOKIE) || '');
    if (!session) return sendJson(ctx, { entries: [], source: content.source || 'SRD 5.2.1 — CC BY 4.0' });
    const raw = json(campaign(session.campaignId).state) as GameState;
    if (raw.world?.ai.display) return sendJson(ctx, { entries: [], source: 'AI展示协议v2，游戏资料由AI JSON提供' });
    const owner = raw.world ? raw.world.ownerId === session.member.id : session.member.role === 'gm';
    const known = new Set(raw.actors.filter(a => a.ownerId === session.member.id).flatMap(a => a.knownEntries || []));
    const entries = (content.entries || []).filter((entry: any) => owner || !raw.world || known.has(entry.id));
    const custom = raw.world ? raw.actors.filter(a => a.kind !== 'hero' && (owner || known.has('actor:' + a.id))).map(a => { const d = engine.deriveActor(a); return { id: 'actor:' + a.id, name: a.name, category: 'monster', description: a.story || '', source: '本世界设定', automation: 'automatic', data: { abilities: a.abilities, maxHp: a.hp.max, ac: d.ac, speed: d.speed, actions: d.attacks, resistances: a.resistances, immunities: a.immunities, vulnerabilities: a.vulnerabilities } }; }) : [];
    sendJson(ctx, { entries: [...entries, ...custom], source: content.source || 'SRD 5.2.1 — CC BY 4.0', ...(owner ? { coverage: content.coverage } : {}) });
  });
  router.post('/api/assets', (ctx: any) => { const session = auth(ctx); limiter.check(`asset:${session.member.id}`, 30); sendJson(ctx, saveImageAsset(assetContext, session, object(ctx.request.body).dataUrl), 201); });
  router.get('/api/assets/:id', (ctx: any) => { const session = auth(ctx), id = ctx.params.id; if (!canReadAsset(assetContext, session, id)) throw new ApiError(404, 'asset_missing', '图片不存在或不可见'); const row = db.prepare('SELECT mime,bytes FROM assets WHERE id=?').get(id) as any; ctx.type = row.mime; ctx.body = row.bytes; });
  router.post('/api/campaigns', (ctx: any) => {
    const body = object(ctx.request.body); limiter.check(`create:${ipOf(ctx)}`, 5);
    const account = currentAccount(ctx);
    if (!(account?.canCreateWorld || equalSecret(body.hostToken, hostToken))) throw new ApiError(403, 'host_only', '创建世界需要在本机启动器地址登录并授权');
    if (account && body.mode === undefined) throw new ApiError(400, 'world_mode', '请选择世界模式');
    const id = randomUUID(), memberId = randomUUID(), recoveryCode = secret();
    const name = cleanName(body.name, '新的冒险'); const member: Member = { id: memberId, name: cleanName(body.gmName, account?.displayName || '主持人'), role: 'gm' };
    const state: GameState = engine.createGameState(name); state.id = id; state.rev = 0; state.events ||= []; state.choices ||= [];
    if (body.mode !== undefined) {
      if (!['gm','ai','co-create'].includes(body.mode)) throw new ApiError(400, 'world_mode', '请选择有效的房间模式');
      const governance = body.governance === undefined ? {} : object(body.governance);
      if (governance.system !== undefined && !['democracy','dictatorship'].includes(governance.system) || governance.ownerVeto !== undefined && typeof governance.ownerVeto !== 'boolean') throw new ApiError(400, 'governance', '治理方式无效');
      state.world = newWorld(memberId, body.mode as WorldMode, governance);
      if (body.mode === 'ai' && (account || body.aiProtocol === 2)) {
        if (body.freedom !== undefined && !['A','B','C'].includes(body.freedom)) throw new ApiError(400, 'ai_freedom', '请选择自由度 A、B 或 C');
        state.world.ai.display = newAiDisplay(body.freedom || 'B');
      }
    }
    const inviteCode = randomBytes(9).toString('base64url').toUpperCase();
    db.transaction(() => {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO campaigns(id,name,invite_code,state,created_at,updated_at,account_required) VALUES (?,?,?,?,?,?,?)').run(id, name, inviteCode, JSON.stringify(state), now, now, Number(Boolean(account)));
      db.prepare('INSERT INTO members(id,campaign_id,name,role,recovery_hash) VALUES (?,?,?,?,?)').run(memberId,id,member.name,'gm',hash(recoveryCode));
      if (account) linkMember(account.id, memberId, id);
      issueSession(ctx, memberId);
    })();
    sendJson(ctx, { ...snapshot({member,campaignId:id}), recoveryCode }, 201);
  });
  router.post('/api/join', (ctx: any) => {
    const body = object(ctx.request.body); limiter.check(`join:${ipOf(ctx)}`, 20);
    const invite = String(body.inviteCode || '').trim().toUpperCase();
    const row: any = db.prepare('SELECT id,account_required FROM campaigns WHERE invite_code=?').get(invite);
    if (!row) throw new ApiError(404, 'invite_invalid', '邀请码无效');
    const account = row.account_required ? accountAuth(ctx) : currentAccount(ctx);
    const existing: any = account && db.prepare('SELECT m.* FROM account_members am JOIN members m ON m.id=am.member_id WHERE am.account_id=? AND am.campaign_id=?').get(account.id, row.id);
    if (existing) { issueSession(ctx, existing.id); return sendJson(ctx, snapshot({ member: { id: existing.id, name: existing.name, role: existing.role }, campaignId: row.id })); }
    const member: Member = {id:randomUUID(),name:cleanName(body.name,account?.displayName || '冒险者'),role:'player'}, recoveryCode = secret();
    db.transaction(() => {
      const count: any = db.prepare('SELECT COUNT(*) AS n FROM members WHERE campaign_id=?').get(row.id);
      if (count.n >= MAX_MEMBERS) throw new ApiError(409, 'room_full', '房间已满（含主持人最多 12 人）');
      db.prepare('INSERT INTO members(id,campaign_id,name,role,recovery_hash) VALUES (?,?,?,?,?)').run(member.id,row.id,member.name,'player',hash(recoveryCode));
      if (account) linkMember(account.id, member.id, row.id);
      issueSession(ctx, member.id);
    })();
    sendJson(ctx, { ...snapshot({member,campaignId:row.id}), recoveryCode }); broadcast(row.id);
  });
  router.post('/api/recover', (ctx: any) => {
    const body = object(ctx.request.body); limiter.check(`recover:${ipOf(ctx)}`, 10);
    const code = String(body.recoveryCode || '').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new ApiError(401, 'recovery_invalid', '个人恢复码无效');
    const row: any = db.prepare('SELECT * FROM members WHERE recovery_hash=?').get(hash(code));
    if (!row) throw new ApiError(401, 'recovery_invalid', '个人恢复码无效');
    const linked: any = db.prepare('SELECT account_id FROM account_members WHERE member_id=?').get(row.id);
    const account = currentAccount(ctx);
    if (linked && linked.account_id !== account?.id) throw new ApiError(403, 'identity_linked', '此身份已关联账号，请使用该账号和密码登录');
    if (campaign(row.campaign_id).account_required && !account) throw new ApiError(401, 'account_required', '请先登录账号');
    if (account) linkMember(account.id, row.id, row.campaign_id);
    issueSession(ctx,row.id); sendJson(ctx,snapshot({member:{id:row.id,name:row.name,role:row.role},campaignId:row.campaign_id}));
  });
  router.post('/api/logout', (ctx: any) => {
    revokeWorldSession(ctx); clearCookie(ctx);
    sendJson(ctx,{ok:true});
  });
  router.get('/api/state', (ctx: any) => sendJson(ctx,snapshot(auth(ctx))));
  router.post('/api/ai/export', (ctx: any) => {
    const session = auth(ctx), body = object(ctx.request.body); limiter.check(`ai-export:${session.member.id}`, 30);
    const result = db.transaction(() => {
      const row = campaign(session.campaignId), before = json(row.state) as GameState; aiOwner(session, before);
      const advanced = before.world?.ai.display ? { state: before, events: [] } : advanceWorldTime(before, worldContext(row.id));
      if(advanced.events.length)advanced.state.world!.gameplayRev++;
      const exported = before.world?.ai.display ? exportAiDisplay(advanced.state, body.kind as ExchangeKind, displayContext(row.id, session.member)) : createAiExchange(advanced.state, body.kind as ExchangeKind, { ...aiContext(row.id, session.member), exchangeId: body.exchangeId });
      // Exchanging context changes the server receipt, not the gameplay revision echoed by the AI.
      exported.state.rev = before.rev + 1;
      const operationId = `ai-export:${exported.packet.exchangeId}`;
      const appended = appendEvents(before, exported.state, [...advanced.events,{ type: 'ai.export', message: '房主已导出AI交换上下文', gmOnly: true }], operationId, row.event_sequence);
      persistState(row.id, exported.state, appended.sequence);
      db.prepare('INSERT INTO operations(campaign_id,member_id,operation_id,command_type,command_json,before_state,events,created_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id, session.member.id, operationId, 'ai.export', JSON.stringify({ kind: body.kind }), JSON.stringify(before), JSON.stringify(appended.events), new Date().toISOString());
      return { packet: exported.packet, schema: exported.schema, prompt: exported.prompt };
    })();
    sendJson(ctx, result); broadcast(session.campaignId);
  });
  router.post('/api/ai/preview', (ctx: any) => {
    const session = auth(ctx), state = json(campaign(session.campaignId).state) as GameState; aiOwner(session, state);
    limiter.check(`ai-preview:${session.member.id}`, 60);
    sendJson(ctx, state.world?.ai.display ? previewAiDisplay(state, object(ctx.request.body).packet, displayContext(session.campaignId, session.member)) : previewAiPacket(advanceWorldTime(state,worldContext(session.campaignId)).state, object(ctx.request.body).packet, aiContext(session.campaignId, session.member)));
  });
  router.post('/api/command', (ctx: any) => {
    const session = auth(ctx); limiter.check(`command:${session.member.id}`, 180);
    const command = copy(object(ctx.request.body)) as Command;
    let result: {events:ResultEvent[];duplicate?:boolean};
    result = db.transaction(() => {
      const row = campaign(session.campaignId), persistedState = json(row.state) as GameState;
      let state = persistedState;
      // Check a committed operation before revision and ownership: retries must return its exact result.
      if (typeof command.operationId === 'string') {
        const committed: any = db.prepare('SELECT events,command_json FROM operations WHERE campaign_id=? AND member_id=? AND operation_id=?').get(row.id,session.member.id,command.operationId);
        if (committed) {
          if (canonical(json(committed.command_json)) !== canonical(command)) throw new ApiError(409,'operation_reused','操作编号已经用于其他指令');
          return {events:json(committed.events),duplicate:true};
        }
      }
      const displayMode = Boolean(state.world?.ai.display);
      const advanced = state.world && !displayMode && command.type !== 'gm.undo' ? advanceWorldTime(state,worldContext(session.campaignId)) : {state,events:[]};
      state = advanced.state;
      const originalCommand = copy(command);
      if (state.world) {
        validateWorldEnvelope(command);
        const owner = state.world.ownerId === session.member.id;
        if (displayMode && !isAiDisplayCommand(command.type) && !(owner && ['gm.pause','gm.undo','world.start'].includes(command.type))) throw new ApiError(403, 'ai_display_only', '此AI世界只呈现AI结果，请提交角色行为或使用AI JSON工作台');
        const directInventory = command.type === 'inventory.equip';
        if (directInventory && !owner && !capabilities(state, session.member).includes('manage.characters')) throw new ApiError(403, 'intent_required', '请提交角色行动，按当前模式审核或回合结算');
        if (state.world.mode === 'ai' && ['round.settle','intent.review'].includes(command.type)) throw new ApiError(403, 'ai_exchange_required', '请在AI工作台确认整轮决策，保持所选骰源与结算一致');
        if (!displayMode && !isCharacterCommand(command.type) && !isWorldCommand(command.type) && !['ai.apply','ai.configure'].includes(command.type)) {
          const admin = owner && ['gm.pause','gm.undo'].includes(command.type);
          const dictatorshipMap = owner && state.world.mode === 'co-create' && state.world.governance.system === 'dictatorship' && command.type === 'scene.update';
          if (!admin && !dictatorshipMap && !(owner && state.world.mode === 'gm') && command.type !== 'choice.resolve') throw new ApiError(403, 'intent_required', '当前模式要求先提交行动意图或世界提案');
          authorizeCommand(state,command,session.member,{allowPlayerFinalization:typeof engine.validateBuild==='function'});
        }
      } else authorizeCommand(state,command,session.member,{allowPlayerFinalization:typeof engine.validateBuild==='function'});
      if (command.expectedRev !== row.revision) throw new ApiError(409,'stale_revision','战役已更新，请根据最新状态重试',{snapshot:snapshot(session)});
      validateAssetReferences(assetContext, session, command.payload);
      let next: GameState, drafts: any[];
      if (command.type === 'gm.undo') {
        const previous: any = db.prepare("SELECT rowid,* FROM operations WHERE campaign_id=? AND undone=0 AND command_type!='gm.undo' ORDER BY rowid DESC LIMIT 1").get(row.id);
        if (!previous) throw new ApiError(409,'nothing_to_undo','没有可撤销的操作');
        const wanted = command.payload?.operationId;
        if (wanted && wanted !== previous.operation_id) throw new ApiError(409,'undo_order','只能撤销最近尚未撤销的操作');
        next = json(previous.before_state); next.id = state.id;
        if (state.world && next.world) { next.world.ownerId = state.world.ownerId; next.world.mode = state.world.mode; next.world.governance = copy(state.world.governance); }
        drafts = [{type:'gm.undo',actorId:command.actorId,message:`主持人撤销了 ${previous.command_type}`,gmOnly:false,changes:{operationId:previous.operation_id}}];
        const priorCommand=json(previous.command_json);
        if(previous.command_type==='migration') db.prepare('DELETE FROM migrations WHERE campaign_id=? AND fingerprint=?').run(row.id,priorCommand.fingerprint);
        if(previous.command_type==='restore'&&Array.isArray(priorCommand.beforeMigrations)){
          db.prepare('DELETE FROM migrations WHERE campaign_id=?').run(row.id);
          const insert=db.prepare('INSERT INTO migrations(campaign_id,fingerprint,member_id,report) VALUES (?,?,?,?)');
          for(const record of priorCommand.beforeMigrations)insert.run(row.id,record.fingerprint,record.member_id,record.report);
        }
        db.prepare('UPDATE operations SET undone=1 WHERE rowid=?').run(previous.rowid);
      } else {
        const roles=new Map<string,Member['role']>((db.prepare('SELECT id,role FROM members WHERE campaign_id=?').all(row.id) as Member[]).map(member=>[member.id,member.role]));
        const modern = Boolean(state.world);
        if (!modern) prepareActorCommand(state,command,session.member,roles);
        let resolution: any;
        try {
          if (displayMode && command.type === 'gm.pause') {
            if (typeof command.payload?.paused !== 'boolean' || Object.keys(command.payload).length !== 1) throw new ApiError(400, 'pause_format', '暂停参数必须为布尔值');
            const paused = copy(state); paused.paused = command.payload.paused;
            resolution = { state: paused, events: [{ type: 'gm.pause', message: paused.paused ? '房主暂停了世界' : '房主继续了世界', gmOnly: true }] };
          }
          else if (displayMode) resolution = dispatchAiDisplayCommand(state, command, displayContext(session.campaignId, session.member));
          else if (modern && isCharacterCommand(command.type)) resolution = resolveCharacterCommand(state, command, session.member, worldContext(session.campaignId).members, engine, clock());
          else if (modern && command.type === 'ai.apply') { aiOwner(session, state); if(state.paused)throw new ApiError(400,'WORLD_PAUSED','世界已暂停，请房主继续后再采用AI决策'); resolution = applyAiPacket(state, command.payload?.packet, aiContext(session.campaignId, session.member)); }
          else if (modern && command.type === 'ai.configure') {
            aiOwner(session, state);
            if (!['program','ai'].includes(String(command.payload?.diceSource)) || Object.keys(command.payload || {}).some(key => key !== 'diceSource')) throw new ApiError(400, 'ai_dice_source', '请选择程序或AI骰源');
            if (state.choices.length || state.world!.ai.exchanges.some(e => Object.values((e.payload._decisions || {}) as Record<string, any>).some(receipt => receipt.status === 'pending')) || state.world!.round.intents.some(i => i.status === 'executed')) throw new ApiError(400, 'ai_dice_pending', '请先完成当前决策或进入下一轮，再切换骰源');
            const configured = copy(state); configured.world!.ai.diceSource = command.payload!.diceSource as 'program' | 'ai';
            resolution = { state: configured, events: [{ type: command.type, message: `房主将骰源设为${command.payload!.diceSource === 'program' ? '程序' : 'AI'}`, gmOnly: false }] };
          }
          else if (modern && isWorldCommand(command.type)) resolution = resolveWorldCommand(state, command, session.member, worldContext(session.campaignId));
          else if (modern && state.world!.mode === 'ai' && command.type === 'choice.resolve') {
            resolution = resolveAiReaction(state, command, options.dice || cryptoDice, (value, nextCommand, dice) => executeEngine(value, nextCommand, { ...worldContext(session.campaignId), dice }));
            const owner = worldContext(session.campaignId).members.find(m => m.id === state.world!.ownerId)!;
            const resumed = resumeAiDecisions(resolution.state, aiContext(session.campaignId, owner));
            resolution = { state: resumed.state, events: [...resolution.events, ...resumed.events] };
          }
          else resolution = modern ? executeEngine(state,command,worldContext(session.campaignId)) : engine.resolveCommand(copy(state),command,options.dice||cryptoDice);
        }
        catch (error: any) { if (error instanceof ApiError) throw error; throw new ApiError(400,error instanceof AiDisplayError || typeof engine.RuleError==='function'&&error instanceof engine.RuleError?error.code:'rule_validation',error?.message || '数据格式未通过'); }
        if (!resolution?.state || !Array.isArray(resolution.events)) throw new Error('规则引擎返回格式无效');
        next = resolution.state; drafts = resolution.events;
        if (resolution.choices) next.choices = resolution.choices;
        if (command.type === 'actor.create' && session.member.role === 'player') {
          const oldIds = new Set(state.actors.map(a => a.id));
          next.actors.filter(a => !oldIds.has(a.id)).forEach(a => { a.ownerId = session.member.id; a.hidden = false;if(typeof engine.validateBuild!=='function')a.draft=true; });
        }
        if(!modern&&session.member.role==='player'&&typeof engine.validateBuild==='function')for(const actor of next.actors.filter(a=>a.ownerId===session.member.id&&!a.draft)){
          const problems=engine.validateBuild(actor);if(!Array.isArray(problems)||problems.length)throw new ApiError(400,'invalid_build',Array.isArray(problems)?problems.join('；'):'建卡验证未通过');
        }
        if(session.member.role==='player')for(const actor of next.actors.filter(a=>a.ownerId===session.member.id)){
          const parentId=actor.choices?.parentActorId??actor.choices?.ownerActorId;if(parentId===undefined||parentId===null||parentId==='')continue;
          if(actor.kind!=='companion'||typeof parentId!=='string')throw new ApiError(400,'companion_parent','只有随从可以关联主人角色');
          const seen=new Set([actor.id]);let cursor:string|undefined=parentId;
          while(cursor){if(seen.has(cursor))throw new ApiError(400,'companion_cycle','随从主人关系不能形成循环');seen.add(cursor);const parent=next.actors.find(a=>a.id===cursor);if(!parent||parent.ownerId!==session.member.id)throw new ApiError(403,'ownership','只能关联自己的主人角色');cursor=parent.choices?.parentActorId as string|undefined;}
        }
        if(next.actors.length>500)throw new ApiError(400,'actor_limit','单战役角色数量超过 500');
        validateActorOwnership(next,roles);
      }
      if (state.world && next.world && (advanced.events.length || !['profile.update','draft.save','draft.delete','vote.cast','vote.preference','governance.grant'].includes(command.type) && !(command.type === 'ai.apply' && !drafts.length))) next.world.gameplayRev = state.world.gameplayRev + 1;
      next.id = state.id; next.rev = state.rev + 1;
      const appended = appendEvents(persistedState,next,[...advanced.events,...drafts],command.operationId,row.event_sequence);
      persistState(row.id,next,appended.sequence);
      db.prepare('INSERT INTO operations(campaign_id,member_id,operation_id,command_type,command_json,before_state,events,created_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id,session.member.id,command.operationId,command.type,JSON.stringify(originalCommand),JSON.stringify(persistedState),JSON.stringify(appended.events),new Date().toISOString());
      return {events:appended.events};
    })();
    const snap = snapshot(session);
    const allowedEvents = new Set(snap.state.events.map(e=>e.id));
    sendJson(ctx,{snapshot:snap,events:result.events.filter(e=>allowedEvents.has(e.id)).map(e=>session.member.role==='gm'?e:{...e,changes:undefined}),...(result.duplicate?{duplicate:true}:{})});
    if (!result.duplicate) broadcast(session.campaignId);
  });
  router.post('/api/migrate', (ctx: any) => {
    const session = auth(ctx); limiter.check(`migrate:${session.member.id}`,10);
    const current = json(campaign(session.campaignId).state) as GameState;
    if (current.world?.ai.display) throw new ApiError(403, 'ai_display_only', 'AI展示世界请通过初始化或更新JSON导入资料，旧卡迁移入口保留给原生角色世界');
    if (current.world && current.world.ownerId !== session.member.id) throw new ApiError(403, 'owner_only', '旧卡导入由房主管理，玩家请领取角色');
    const body = object(ctx.request.body); if (!body.payload || typeof body.payload !== 'object') throw new ApiError(400,'migration_invalid','请选择有效的旧 JSON 存档');
    const fingerprint = hash(canonical(body.payload));
    const report = db.transaction(() => {
      const existing: any = db.prepare('SELECT report,member_id FROM migrations WHERE campaign_id=? AND fingerprint=?').get(session.campaignId,fingerprint);
      if (existing) { if(existing.member_id!==session.member.id && session.member.role!=='gm') throw new ApiError(409,'already_imported','此存档已由其他成员导入'); return json(existing.report); }
      const row = campaign(session.campaignId); const state:GameState = json(row.state);
      const migrated = engine.migrateLegacy(copy(body.payload),fingerprint);
      if (!Array.isArray(migrated?.actors) || !migrated.report) throw new Error('迁移引擎返回格式无效');
      if (!migrated.actors.length) throw new ApiError(400,'migration_empty','存档中没有可迁移的角色');
      const known = new Set(state.actors.map(a=>a.id));
      for (const actor of migrated.actors) { if(known.has(actor.id)) throw new ApiError(409,'migration_collision','迁移角色编号冲突'); actor.ownerId=session.member.id; actor.hidden=false; if(state.world && actor.kind === 'hero'){actor.registration='available';actor.hidden=true;} state.actors.push(actor); known.add(actor.id); }
      const before:GameState = json(row.state); state.rev++;
      const operationId=`migration:${fingerprint}:${randomUUID()}`;
      const appended=appendEvents(before,state,[{type:'migration',message:`${session.member.name} 复制迁移了 ${migrated.actors.length} 张旧角色卡`,gmOnly:true}],operationId,row.event_sequence);
      persistState(row.id,state,appended.sequence);
      db.prepare('INSERT INTO migrations(campaign_id,fingerprint,member_id,report) VALUES (?,?,?,?)').run(row.id,fingerprint,session.member.id,JSON.stringify(migrated.report));
      db.prepare('INSERT INTO operations(campaign_id,member_id,operation_id,command_type,command_json,before_state,events,created_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id,session.member.id,operationId,'migration',JSON.stringify({operationId,type:'migration',fingerprint,report:migrated.report}),JSON.stringify(before),JSON.stringify(appended.events),new Date().toISOString());
      return migrated.report as MigrationReport;
    })();
    sendJson(ctx,{snapshot:snapshot(session),report}); broadcast(session.campaignId);
  });
  router.get('/api/export', (ctx: any) => {
    const session=auth(ctx); const row=campaign(session.campaignId); const state:GameState=json(row.state);
    ctx.set('Content-Disposition',`attachment; filename="jigerpg-${row.id}.json"`);
    if(session.member.role!=='gm'){
      if(state.world?.ai.display){const view=projectAiDisplay(state,session.member)!;return sendJson(ctx,{format:'jigerpg-ai-player',version:2,exportedAt:new Date().toISOString(),display:view,assets:exportAssets(db,row.id,assetReferences(view))});}
      const projected=state.world?projectWorld(state,session,worldContext(row.id).members,engine).state!:confidentialProjection(engine.projectState?engine.projectState(copy(state),session.member):state,session.member);const actors=projected.actors.filter(a=>a.ownerId===session.member.id);return sendJson(ctx,{format:'jigerpg-actors',version:1,exportedAt:new Date().toISOString(),actors,assets:exportAssets(db,row.id,assetReferences(actors))});}
    sendJson(ctx,{format:'jigerpg-campaign',version:1,schemaVersion:SCHEMA_VERSION,codeVersion:CODE_VERSION,serverId:storage.serverId,campaignId:row.id,exportedAt:new Date().toISOString(),state,assets:exportAssets(db,row.id),members:db.prepare('SELECT id,name,role FROM members WHERE campaign_id=?').all(row.id),migrations:db.prepare('SELECT report FROM migrations WHERE campaign_id=?').all(row.id).map((r:any)=>json(r.report))});
  });
  router.post('/api/restore',async(ctx:any)=>{
    const session=gmAuth(ctx), body=object(ctx.request.body), backup=object(body.backup);
    if(backup.format!=='jigerpg-campaign'||backup.version!==1||!Number.isInteger(backup.schemaVersion)||backup.schemaVersion<1||backup.schemaVersion>SCHEMA_VERSION||backup.campaignId!==session.campaignId) throw new ApiError(400,'backup_invalid','请选择当前战役、兼容版本的完整备份');
    const candidate=validateBackupState(copy(object(backup.state)));
    if(candidate.world?.ai.display){const knownMembers=new Set(worldContext(session.campaignId).members.map(member=>member.id));for(const id of Object.keys(candidate.world.ai.display.bindings))if(!knownMembers.has(id))throw new ApiError(400,'backup_invalid','AI角色绑定引用了其他世界的成员');}
    validateActorOwnership(candidate,new Map((db.prepare('SELECT id,role FROM members WHERE campaign_id=?').all(session.campaignId) as Member[]).map(member=>[member.id,member.role])));
    if(candidate.id!==session.campaignId||!Array.isArray(candidate.actors)||candidate.actors.length>500||!Array.isArray(candidate.events)||!Array.isArray(candidate.choices)||!candidate.scene||!candidate.combat) throw new ApiError(400,'backup_invalid','备份状态结构无效');
    const actorIds=new Set<string>();
    for(const actor of candidate.actors){if(!actor?.id||actorIds.has(actor.id)) throw new ApiError(400,'backup_invalid','备份包含重复角色'); actorIds.add(actor.id); if(!actor.draft){const validation=[...(engine.validateActor?.(actor)||[]),...(engine.validateBuild?.(actor)||[])]; if(validation.length) throw new ApiError(400,'backup_invalid',`角色数据无效：${validation.join('；')}`);}}
    await onlineBackup(db,join(storage.dataDir,'backups'),'before-restore');
    db.transaction(()=>{
      const row=campaign(session.campaignId),before:GameState=json(row.state); candidate.rev=before.rev+1;
      if (before.world) {
        if (!candidate.world) { candidate.world = newWorld(before.world.ownerId, before.world.mode, before.world.governance); for (const actor of candidate.actors.filter(a => a.kind === 'hero')) { actor.registration = 'requested'; actor.requestedBy = actor.ownerId; actor.hidden = true; } }
        candidate.world.ownerId = before.world.ownerId; candidate.world.mode = before.world.mode; candidate.world.governance = copy(before.world.governance); candidate.world.gameplayRev = before.world.gameplayRev + 1;
      }
      restoreAssets(db, row.id, backup.assets, new Set(worldContext(row.id).members.map(member => member.id)));
      const beforeMigrations=db.prepare('SELECT fingerprint,member_id,report FROM migrations WHERE campaign_id=?').all(row.id);
      const operationId=`restore:${randomUUID()}`;
      const appended=appendEvents(before,candidate,[{type:'restore',message:'主持人恢复了战役备份',gmOnly:true}],operationId,row.event_sequence);
      persistState(row.id,candidate,appended.sequence);
      db.prepare('DELETE FROM migrations WHERE campaign_id=?').run(row.id);
      for(const report of Array.isArray(backup.migrations)?backup.migrations:[]){if(typeof report?.fingerprint!=='string'||!Array.isArray(report.actors))throw new ApiError(400,'backup_invalid','备份迁移报告无效');const owner=candidate.actors.find(a=>report.actors.some((r:any)=>r.newId===a.id))?.ownerId||session.member.id;db.prepare('INSERT INTO migrations(campaign_id,fingerprint,member_id,report) VALUES (?,?,?,?)').run(row.id,report.fingerprint,owner,JSON.stringify(report));}
      db.prepare('INSERT INTO operations(campaign_id,member_id,operation_id,command_type,command_json,before_state,events,created_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id,session.member.id,operationId,'restore',JSON.stringify({operationId,type:'restore',beforeMigrations}),JSON.stringify(before),JSON.stringify(appended.events),new Date().toISOString());
    })();
    sendJson(ctx,{snapshot:snapshot(session)});broadcast(session.campaignId);
  });
  app.use(router.routes());app.use(router.allowedMethods());
  const distDir=options.distDir?resolve(options.distDir):null;
  app.use(async(ctx:any)=>{
    if(ctx.path.startsWith('/api')||ctx.path==='/ws'){sendJson(ctx,{error:'接口不存在',code:'not_found'},404);return;}
    if(!distDir||!['GET','HEAD'].includes(ctx.method)){ctx.status=404;return;}
    let rel:string;try{rel=decodeURIComponent(ctx.path);}catch{ctx.status=404;return;}
    if(rel.includes('\0')||rel.includes('\\')||rel.split('/').some(p=>p==='..'||p.startsWith('.'))){ctx.status=404;return;}
    const requested=resolve(distDir,'.'+rel);
    if(requested!==distDir&&!requested.startsWith(distDir+sep)){ctx.status=404;return;}
    let file=rel==='/'?join(distDir,'index.html'):requested;
    // Only compiled assets and front-end navigation are public; never fall back for file probes.
    if(rel!=='/'&&!rel.startsWith('/assets/')&&!['/favicon.ico','/manifest.webmanifest','/robots.txt'].includes(rel)){
      if(extname(rel)){ctx.status=404;return;}file=join(distDir,'index.html');
    }
    try{const actual=await realpath(file),root=await realpath(distDir);if(actual!==root&&!actual.startsWith(root+sep)){ctx.status=404;return;}const info=await stat(actual);if(!info.isFile()){ctx.status=404;return;}ctx.type=extname(actual);ctx.body=await readFile(actual);if(rel.startsWith('/assets/'))ctx.set('Cache-Control','public,max-age=31536000,immutable');}catch{ctx.status=404;}
  });

  server.on('request',app.callback());
  server.on('upgrade',(req,socket,head)=>{
    let path='';try{path=new URL(req.url||'/','http://localhost').pathname;}catch{}
    const origin=String(req.headers.origin||'');
    if(path!=='/ws'||!origins.has(origin)){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    const cookies=String(req.headers.cookie||'').split(';').map(v=>v.trim());
    const cookie=cookies.find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
    const accountToken=cookies.find(v=>v.startsWith(ACCOUNT_COOKIE+'='))?.slice(ACCOUNT_COOKIE.length+1)||'';
    const session=sessionByToken(cookie,accountToken);
    if(!session){socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    const count=[...clients.values()].filter(c=>c.memberId===session.member.id).length;
    if(count>=6){socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      (ws as any).sessionHash=hash(cookie); (ws as any).accountSessionHash=accountToken?hash(accountToken):null;clients.set(ws,{memberId:session.member.id,campaignId:session.campaignId,lastPong:Date.now()});
      ws.on('message',(raw,binary)=>{if(binary)return ws.close(1003,'json required');try{const msg=json(String(raw));if(msg?.type==='pong'){const c=clients.get(ws);if(c)c.lastPong=Date.now();}else ws.close(1008,'only heartbeat messages accepted');}catch{ws.close(1007,'invalid json');}});
      ws.on('pong',()=>{const c=clients.get(ws);if(c)c.lastPong=Date.now();});
      ws.on('close',()=>{clients.delete(ws);broadcast(session.campaignId);});ws.on('error',()=>{});
      broadcast(session.campaignId);
    });
  });
  const heartbeat=setInterval(()=>{
    for(const[ws,c]of clients){const active=db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get((ws as any).sessionHash,Date.now());const accountActive=!(ws as any).accountSessionHash||db.prepare('SELECT 1 FROM account_sessions WHERE token_hash=? AND expires_at>?').get((ws as any).accountSessionHash,Date.now());if(!active||!accountActive){ws.close(4001,'session expired');continue;}if(Date.now()-c.lastPong>65_000){ws.terminate();continue;}if(ws.readyState===WebSocket.OPEN){ws.ping();ws.send(JSON.stringify({type:'ping'}));}}
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').run(Date.now());
  },25_000);heartbeat.unref();
  const worldClock=setInterval(()=>{
    try {
      for(const record of db.prepare('SELECT id,state FROM campaigns').all() as {id:string;state:string}[]){
        const probe=json(record.state) as GameState;
        if(probe.world?.ai.display || !probe.world?.proposals.some(p=>p.status==='open'&&p.closesAt<=clock()))continue;
        let changed=false;
        db.transaction(()=>{
          const row=campaign(record.id),before=json(row.state) as GameState;
          const result=advanceWorldTime(before,worldContext(record.id));
          if(!result.events.length)return;
          const operationId=`clock:${record.id}:${before.rev}`;
          result.state.rev=before.rev+1; result.state.world!.gameplayRev=before.world!.gameplayRev+1;
          const appended=appendEvents(before,result.state,result.events,operationId,row.event_sequence);
          persistState(row.id,result.state,appended.sequence);
          db.prepare('INSERT INTO operations(campaign_id,member_id,operation_id,command_type,command_json,before_state,events,created_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id,'__clock__',operationId,'world.clock',JSON.stringify({operationId,type:'world.clock',expectedRev:before.rev}),JSON.stringify(before),JSON.stringify(appended.events),new Date().toISOString());
          changed=true;
        })();
        if(changed)broadcast(record.id);
      }
    }catch(error){console.error('[world-clock]',error instanceof Error?error.message:'时钟更新失败');}
  },1000);worldClock.unref();
  let closed=false;
  return { app,server,db,hostToken,serverId:storage.serverId,dataDir:storage.dataDir,setPublicOrigin,
    getTunnelStatus:()=>({...tunnelStatus}),
    listen:async(port=8080,host='127.0.0.1')=>{await new Promise<void>((ok,no)=>{server.once('error',no);server.listen(port,host,()=>{server.off('error',no);ok();});});const address=server.address() as AddressInfo;localUrl=`http://localhost:${address.port}`;origins.add(localUrl);origins.add(`http://127.0.0.1:${address.port}`);return address;},
    close:async()=>{if(closed)return;closed=true;clearInterval(heartbeat);clearInterval(worldClock);for(const ws of clients.keys())ws.terminate();await new Promise<void>(ok=>wss.close(()=>ok()));if(server.listening)await new Promise<void>((ok,no)=>server.close(e=>e?no(e):ok()));await storage.close();}
  };
}
