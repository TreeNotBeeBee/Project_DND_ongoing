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
import { assetReferences, canReadAsset, exportAssets, restoreAssets, saveImageAsset, validateAssetReferences } from './assets';

export interface ServerOptions {
  dataDir: string; distDir?: string; hostToken?: string; engine?: any; content?: any;
  publicOrigin?: string; localOrigins?: string[]; sessionDays?: number;
  dice?: Dice;
  now?: () => number;
  bodyLimits?: Partial<typeof DEFAULT_BODY_LIMITS>;
}
export const DEFAULT_BODY_LIMITS=Object.freeze({large:64*1024*1024,command:12*1024*1024,small:16*1024});
const COOKIE = 'jige_session';
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
  function sessionByToken(token: string) {
    if (!token || token.length > 256) return null;
    const row: any = db.prepare('SELECT m.*,s.expires_at FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=?').get(hash(token));
    if (!row || row.expires_at <= Date.now()) return null;
    return { member: { id: row.id, name: row.name, role: row.role } as Member, campaignId: row.campaign_id };
  }
  function auth(ctx: any) { const session = sessionByToken(cookieToken(ctx)); if (!session) throw new ApiError(401, 'unauthorized', '请加入房间或使用个人恢复码'); return session; }
  function gmAuth(ctx: any) { const session = auth(ctx); if (session.member.role !== 'gm') throw new ApiError(403, 'gm_only', '只有主持人可以执行此操作'); return session; }
  function hostAuth(ctx: any) { const token = ctx.get('x-jige-host-token') || ctx.get('authorization').replace(/^Bearer\s+/i, ''); if (!equalSecret(token, hostToken)) throw new ApiError(403, 'host_only', '需要本机主机凭据'); }
  function campaign(id: string) { const row: any = db.prepare('SELECT * FROM campaigns WHERE id=?').get(id); if (!row) throw new ApiError(404, 'campaign_missing', '战役不存在'); return row; }
  function worldContext(campaignId: string) {
    const members = db.prepare('SELECT id,name,role FROM members WHERE campaign_id=?').all(campaignId) as Member[];
    return { now: Math.max(0, Math.floor(clock())), members, onlineMemberIds: [...new Set([...clients.values()].filter(c => c.campaignId === campaignId).map(c => c.memberId))], dice: options.dice || cryptoDice, resolveEngine: (state: GameState, command: Command, dice: Dice) => engine.resolveCommand(state, command, dice, state.combat.active ? undefined : { economy: 'world', skipResources: state.world?.rules.energy || state.world?.mode === 'co-create' ? ['ap'] : [] }) };
  }
  function snapshot(session: {member:Member;campaignId:string}): Snapshot {
    const row = campaign(session.campaignId);
    let raw = json(row.state) as GameState;
    if (raw.world) raw = advanceWorldTime(raw, worldContext(session.campaignId)).state;
    const projected = engine.projectState ? engine.projectState(copy(raw), session.member) : raw;
    const state = confidentialProjection(projected, session.member);
    const members = (db.prepare('SELECT id,name,role FROM members WHERE campaign_id=? ORDER BY role,id').all(session.campaignId) as Member[]).map(m => ({ ...m, online: [...clients.values()].some(c => c.memberId === m.id) }));
    if (raw.world) return { session, members, ...projectWorld(raw, session, members, engine), ...(raw.world.ownerId === session.member.id ? { inviteCode: row.invite_code } : {}) } as Snapshot;
    return { session, state, members, ...(session.member.role === 'gm' ? { inviteCode: row.invite_code } : {}) };
  }
  const assetContext = { db, raw: (id: string) => json(campaign(id).state) as GameState, projected: snapshot };
  function issueSession(ctx: any, memberId: string) {
    const token = secret();
    db.prepare('INSERT INTO sessions(token_hash,member_id,expires_at) VALUES (?,?,?)').run(hash(token), memberId, Date.now() + sessionDuration);
    const remote = publicOrigin && ctx.host === new URL(publicOrigin).host;
    ctx.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(sessionDuration/1000)}${remote ? '; Secure' : ''}`);
  }
  function clearCookie(ctx: any) { ctx.append('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${publicOrigin && ctx.host === new URL(publicOrigin).host ? '; Secure' : ''}`); }
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
      const status = error instanceof ApiError ? error.status : typeof engine.RuleError==='function'&&error instanceof engine.RuleError ? 400 : Number(error.status) >= 400 && Number(error.status) < 500 ? Number(error.status) : 500;
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
    const small=['/api/campaigns','/api/join','/api/recover','/api/logout'].includes(path);
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
  router.get('/api/content', ctx => {
    const session = sessionByToken(cookieToken(ctx));
    if (!session) return sendJson(ctx, { entries: [], source: content.source || 'SRD 5.2.1 — CC BY 4.0' });
    const raw = json(campaign(session.campaignId).state) as GameState;
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
    if (!equalSecret(body.hostToken, hostToken)) throw new ApiError(403, 'host_only', '创建战役需要本机主机凭据');
    const id = randomUUID(), memberId = randomUUID(), recoveryCode = secret();
    const name = cleanName(body.name, '新的冒险'); const member: Member = { id: memberId, name: cleanName(body.gmName, '主持人'), role: 'gm' };
    const state: GameState = engine.createGameState(name); state.id = id; state.rev = 0; state.events ||= []; state.choices ||= [];
    if (body.mode !== undefined) {
      if (!['gm','ai','co-create'].includes(body.mode)) throw new ApiError(400, 'world_mode', '请选择有效的房间模式');
      const governance = body.governance === undefined ? {} : object(body.governance);
      if (governance.system !== undefined && !['democracy','dictatorship'].includes(governance.system) || governance.ownerVeto !== undefined && typeof governance.ownerVeto !== 'boolean') throw new ApiError(400, 'governance', '治理方式无效');
      state.world = newWorld(memberId, body.mode as WorldMode, governance);
    }
    const inviteCode = randomBytes(9).toString('base64url').toUpperCase();
    db.transaction(() => {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO campaigns(id,name,invite_code,state,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, name, inviteCode, JSON.stringify(state), now, now);
      db.prepare('INSERT INTO members(id,campaign_id,name,role,recovery_hash) VALUES (?,?,?,?,?)').run(memberId,id,member.name,'gm',hash(recoveryCode));
      issueSession(ctx, memberId);
    })();
    sendJson(ctx, { ...snapshot({member,campaignId:id}), recoveryCode }, 201);
  });
  router.post('/api/join', (ctx: any) => {
    const body = object(ctx.request.body); limiter.check(`join:${ipOf(ctx)}`, 20);
    const invite = String(body.inviteCode || '').trim().toUpperCase();
    const row: any = db.prepare('SELECT id FROM campaigns WHERE invite_code=?').get(invite);
    if (!row) throw new ApiError(404, 'invite_invalid', '邀请码无效');
    const member: Member = {id:randomUUID(),name:cleanName(body.name,'冒险者'),role:'player'}, recoveryCode = secret();
    db.transaction(() => {
      const count: any = db.prepare('SELECT COUNT(*) AS n FROM members WHERE campaign_id=?').get(row.id);
      if (count.n >= MAX_MEMBERS) throw new ApiError(409, 'room_full', '房间已满（含主持人最多 12 人）');
      db.prepare('INSERT INTO members(id,campaign_id,name,role,recovery_hash) VALUES (?,?,?,?,?)').run(member.id,row.id,member.name,'player',hash(recoveryCode));
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
    issueSession(ctx,row.id); sendJson(ctx,snapshot({member:{id:row.id,name:row.name,role:row.role},campaignId:row.campaign_id}));
  });
  router.post('/api/logout', (ctx: any) => {
    const old = cookieToken(ctx); if (old) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(old)); clearCookie(ctx);
    for (const [ws, client] of clients) if ((ws as any).sessionHash === hash(old)) ws.close(4001,'logged out');
    sendJson(ctx,{ok:true});
  });
  router.get('/api/state', (ctx: any) => sendJson(ctx,snapshot(auth(ctx))));
  router.post('/api/command', (ctx: any) => {
    const session = auth(ctx); limiter.check(`command:${session.member.id}`, 180);
    const command = copy(object(ctx.request.body)) as Command;
    let result: {events:ResultEvent[];duplicate?:boolean};
    result = db.transaction(() => {
      const row = campaign(session.campaignId); const state: GameState = json(row.state);
      // Check a committed operation before revision and ownership: retries must return its exact result.
      if (typeof command.operationId === 'string') {
        const committed: any = db.prepare('SELECT events,command_json FROM operations WHERE campaign_id=? AND member_id=? AND operation_id=?').get(row.id,session.member.id,command.operationId);
        if (committed) {
          if (canonical(json(committed.command_json)) !== canonical(command)) throw new ApiError(409,'operation_reused','操作编号已经用于其他指令');
          return {events:json(committed.events),duplicate:true};
        }
      }
      const originalCommand = copy(command);
      if (state.world) {
        validateWorldEnvelope(command);
        const owner = state.world.ownerId === session.member.id;
        const directInventory = command.type === 'inventory.equip';
        if (directInventory && !owner && !capabilities(state, session.member).includes('manage.characters')) throw new ApiError(403, 'intent_required', '请提交角色行动，按当前模式审核或回合结算');
        if (!isCharacterCommand(command.type) && !isWorldCommand(command.type) && command.type !== 'ai.apply') {
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
          if (modern && isCharacterCommand(command.type)) resolution = resolveCharacterCommand(state, command, session.member, worldContext(session.campaignId).members, engine, clock());
          else if (modern && isWorldCommand(command.type)) resolution = resolveWorldCommand(state, command, session.member, worldContext(session.campaignId));
          else resolution = engine.resolveCommand(copy(state),command,options.dice||cryptoDice);
        }
        catch (error: any) { if (error instanceof ApiError) throw error; throw new ApiError(400,typeof engine.RuleError==='function'&&error instanceof engine.RuleError?error.code:'rule_validation',error?.message || '规则校验未通过'); }
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
      if (state.world && next.world && !['profile.update','draft.save','draft.delete','vote.cast','vote.preference','governance.grant'].includes(command.type)) next.world.gameplayRev = state.world.gameplayRev + 1;
      next.id = state.id; next.rev = state.rev + 1;
      const appended = appendEvents(state,next,drafts,command.operationId,row.event_sequence);
      persistState(row.id,next,appended.sequence);
      db.prepare('INSERT INTO operations(campaign_id,member_id,operation_id,command_type,command_json,before_state,events,created_at) VALUES (?,?,?,?,?,?,?,?)').run(row.id,session.member.id,command.operationId,command.type,JSON.stringify(originalCommand),JSON.stringify(state),JSON.stringify(appended.events),new Date().toISOString());
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
      for (const actor of migrated.actors) { if(known.has(actor.id)) throw new ApiError(409,'migration_collision','迁移角色编号冲突'); actor.ownerId=session.member.id; actor.hidden=false; state.actors.push(actor); known.add(actor.id); }
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
    if(session.member.role!=='gm'){const projected=state.world?projectWorld(state,session,worldContext(row.id).members,engine).state!:confidentialProjection(engine.projectState?engine.projectState(copy(state),session.member):state,session.member);const actors=projected.actors.filter(a=>a.ownerId===session.member.id);return sendJson(ctx,{format:'jigerpg-actors',version:1,exportedAt:new Date().toISOString(),actors,assets:exportAssets(db,row.id,assetReferences(actors))});}
    sendJson(ctx,{format:'jigerpg-campaign',version:1,schemaVersion:SCHEMA_VERSION,codeVersion:CODE_VERSION,serverId:storage.serverId,campaignId:row.id,exportedAt:new Date().toISOString(),state,assets:exportAssets(db,row.id),members:db.prepare('SELECT id,name,role FROM members WHERE campaign_id=?').all(row.id),migrations:db.prepare('SELECT report FROM migrations WHERE campaign_id=?').all(row.id).map((r:any)=>json(r.report))});
  });
  router.post('/api/restore',async(ctx:any)=>{
    const session=gmAuth(ctx), body=object(ctx.request.body), backup=object(body.backup);
    if(backup.format!=='jigerpg-campaign'||backup.version!==1||![1,SCHEMA_VERSION].includes(backup.schemaVersion)||backup.campaignId!==session.campaignId) throw new ApiError(400,'backup_invalid','请选择当前战役、兼容版本的完整备份');
    const candidate=validateBackupState(copy(object(backup.state)));
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
    const cookie=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
    const session=sessionByToken(cookie);
    if(!session){socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    const count=[...clients.values()].filter(c=>c.memberId===session.member.id).length;
    if(count>=6){socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      (ws as any).sessionHash=hash(cookie);clients.set(ws,{memberId:session.member.id,campaignId:session.campaignId,lastPong:Date.now()});
      ws.on('message',(raw,binary)=>{if(binary)return ws.close(1003,'json required');try{const msg=json(String(raw));if(msg?.type==='pong'){const c=clients.get(ws);if(c)c.lastPong=Date.now();}else ws.close(1008,'only heartbeat messages accepted');}catch{ws.close(1007,'invalid json');}});
      ws.on('pong',()=>{const c=clients.get(ws);if(c)c.lastPong=Date.now();});
      ws.on('close',()=>{clients.delete(ws);broadcast(session.campaignId);});ws.on('error',()=>{});
      broadcast(session.campaignId);
    });
  });
  const heartbeat=setInterval(()=>{
    for(const[ws,c]of clients){const active=db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get((ws as any).sessionHash,Date.now());if(!active){ws.close(4001,'session expired');continue;}if(Date.now()-c.lastPong>65_000){ws.terminate();continue;}if(ws.readyState===WebSocket.OPEN){ws.ping();ws.send(JSON.stringify({type:'ping'}));}}
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  },25_000);heartbeat.unref();
  const worldClock=setInterval(()=>{
    try {
      for(const record of db.prepare('SELECT id,state FROM campaigns').all() as {id:string;state:string}[]){
        const probe=json(record.state) as GameState;
        if(!probe.world?.proposals.some(p=>p.status==='open'&&p.closesAt<=clock()))continue;
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
