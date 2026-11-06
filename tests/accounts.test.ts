import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/server/app';
import { openDatabase, SCHEMA_VERSION } from '../src/server/database';

async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'jige-accounts-'));
  let runtime = await createApplication({ dataDir: dir, hostToken: 'host-local-only' });
  let base = `http://127.0.0.1:${(await runtime.listen(0)).port}`;
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const client = () => {
    const cookies = new Map<string, string>();
    return { cookies, async request(path: string, body?: any) {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(body === undefined ? {} : { origin: base, 'x-jige-request': '1', 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(';')[0].split('='); if (value) cookies.set(name, value); else cookies.delete(name); }
      return { status: response.status, data: await response.json() as any, headers: response.headers };
    } };
  };
  return { dir, get runtime() { return runtime; }, client, async restart() { await runtime.close(); runtime = await createApplication({ dataDir: dir, hostToken: 'new-host-token' }); base = `http://127.0.0.1:${(await runtime.listen(0)).port}`; } };
}

test('accounts use Argon2id, normalize usernames, preserve passwords, and keep private fields off the wire', async t => {
  const f = await setup(t), a = f.client(), b = f.client();
  assert.equal((await a.request('/api/account')).data.account, null);
  assert.equal((await a.request('/api/account/register', { username: 'admin', password: 'short' })).status, 400);
  const registered = await a.request('/api/account/register', { username: 'Ａdmin', displayName: '团长', password: 'correct 密码!', hostToken: 'host-local-only' });
  assert.equal(registered.status, 201); assert.equal(registered.data.account.username, 'Admin'); assert.equal(registered.data.account.canCreateWorld, true);
  const row: any = f.runtime.db.prepare('SELECT * FROM accounts').get(); assert.match(row.password_hash, /^argon2id\$v=19\$m=65536,t=3,p=1\$/); assert.equal(JSON.stringify(registered.data).includes('password'), false);
  assert.equal((await b.request('/api/account/register', { username: 'ADMIN', password: 'different pass' })).status, 409);
  assert.equal((await b.request('/api/account/login', { username: 'admin', password: 'correct 密码! ' })).status, 401);
  assert.equal((await b.request('/api/account/login', { username: 'admin', password: 'correct 密码!' })).status, 200);
  assert.equal((await b.request('/api/account')).data.account.displayName, '团长');
});

test('account world list, membership reentry, world switching, restart and logout retain the right identity', async t => {
  const f = await setup(t), host = f.client(), player = f.client(), stranger = f.client();
  await host.request('/api/account/register', { username: 'owner', password: 'owner-password', hostToken: 'host-local-only' });
  await player.request('/api/account/register', { username: 'player', password: 'player-password' });
  await stranger.request('/api/account/register', { username: 'stranger', password: 'stranger-password' });
  assert.equal((await player.request('/api/campaigns', { name: 'forbidden', mode: 'ai' })).status, 403);
  const first = await host.request('/api/campaigns', { name: '第一世界', mode: 'ai' }); assert.equal(first.status, 201);
  const worldId = first.data.state.id, ownerId = first.data.session.member.id;
  assert.equal((await f.client().request('/api/join', { inviteCode: first.data.inviteCode })).status, 401);
  const joined = await player.request('/api/join', { inviteCode: first.data.inviteCode }); assert.equal(joined.status, 200);
  const playerId = joined.data.session.member.id;
  assert.equal((await player.request('/api/join', { inviteCode: first.data.inviteCode })).data.session.member.id, playerId);
  assert.equal((await stranger.request('/api/worlds')).data.worlds.length, 0);
  assert.equal((await stranger.request('/api/worlds/enter', { worldId })).status, 404);
  const second = await host.request('/api/campaigns', { name: '第二世界', mode: 'co-create', governance: { system: 'dictatorship' } }); assert.equal(second.status, 201);
  assert.notEqual(second.data.session.member.id, ownerId);
  assert.equal((await host.request('/api/worlds')).data.worlds.length, 2);
  assert.equal((await player.request('/api/worlds')).data.worlds.length, 1);
  assert.equal((await host.request('/api/worlds/enter', { worldId })).data.session.member.id, ownerId);
  assert.equal((await host.request('/api/worlds/leave', {})).status, 200);
  assert.equal((await host.request('/api/state')).status, 401);
  assert.equal((await host.request('/api/account')).data.account.canCreateWorld, true);
  await f.restart();
  assert.equal((await host.request('/api/worlds/enter', { worldId })).data.session.member.id, ownerId);
  assert.equal((await player.request('/api/state')).data.session.member.id, playerId);
  await host.request('/api/account/logout', {});
  assert.equal((await host.request('/api/worlds')).status, 401);
  assert.equal((await host.request('/api/state')).status, 401);
  assert.equal((await host.request('/api/account/login', { username: 'owner', password: 'owner-password' })).data.account.canCreateWorld, true);
});

test('old recovery links an identity exactly once, never by matching names; account/world cookies must match', async t => {
  const f = await setup(t), legacy = f.client(), a = f.client(), b = f.client();
  const old = await legacy.request('/api/campaigns', { name: '旧世界', gmName: 'same-name', mode: 'gm', hostToken: 'host-local-only' });
  const oldMember = old.data.session.member.id;
  await a.request('/api/account/register', { username: 'new-owner', displayName: 'same-name', password: 'password-A' });
  assert.equal((await a.request('/api/worlds')).data.worlds.length, 0);
  assert.equal((await a.request('/api/recover', { recoveryCode: old.data.recoveryCode })).data.session.member.id, oldMember);
  assert.equal((await a.request('/api/worlds')).data.worlds.length, 1);
  await b.request('/api/account/register', { username: 'other-owner', password: 'password-B' });
  assert.equal((await b.request('/api/recover', { recoveryCode: old.data.recoveryCode })).status, 403);
  assert.equal((await legacy.request('/api/state')).status, 401);
  b.cookies.set('jige_session', a.cookies.get('jige_session')!);
  assert.equal((await b.request('/api/state')).status, 401);
  assert.equal((await a.request('/api/state')).status, 200);
});

test('upgrading schema 2 makes a verified schema-2 backup before adding account tables', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jige-account-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = await openDatabase(dir); old.db.pragma('user_version = 2'); await old.close();
  const current = await openDatabase(dir);
  try {
    assert.equal(current.db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    assert.ok(current.db.prepare("SELECT 1 FROM sqlite_master WHERE name='account_members'").get());
    const files = await readdir(join(dir, 'backups')), manifest = files.find(name => name.endsWith('.manifest.json'))!;
    const info = JSON.parse(await readFile(join(dir, 'backups', manifest), 'utf8'));
    assert.equal(info.schemaVersion, 2); assert.match(info.sha256, /^[a-f0-9]{64}$/); assert.ok(info.gitCommit); assert.ok(info.backupId);
  } finally { await current.close(); }
});
