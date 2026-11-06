// Manual acceptance: two real Quick Tunnels, accounts, AI v2, HTTPS/WSS and URL-change recovery.
// Uses only generated QA credentials and an isolated ignored data directory.
import { register } from 'tsx/esm/api';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
register();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createApplication } = await import('../src/server/app.ts');
const { codeCommit, SCHEMA_VERSION } = await import('../src/server/database.ts');
const directory = join(root, 'work', 'ai-public-' + randomUUID()), dataDir = join(directory, 'data');
const binary = process.env.JIGE_CLOUDFLARED || join(root, '.tools', 'cloudflared.exe');
let runtime, child;
const delay = ms => new Promise(ok => setTimeout(ok, ms));
async function stopTunnel() { const owned = child; child = undefined; if (!owned || owned.exitCode !== null) return; await new Promise(ok => { const timer = setTimeout(ok, 5000); owned.once('exit', () => { clearTimeout(timer); ok(); }); owned.kill(); }); }
async function tunnel(port) {
  child = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const owned = child;
  const origin = await new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error('Quick Tunnel URL timed out')), 60000); let tail = '';
    const read = chunk => { tail = (tail + String(chunk)).slice(-16000); const found = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0]; if (found) { clearTimeout(timer); ok(found); } };
    owned.stdout.on('data', read); owned.stderr.on('data', read);
    owned.once('error', error => { clearTimeout(timer); no(error); }); owned.once('exit', code => { clearTimeout(timer); no(new Error('Quick Tunnel exited: ' + code)); });
  });
  runtime.setPublicOrigin(origin);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { try { if ((await fetch(origin + '/api/health', { signal: AbortSignal.timeout(10000) })).ok) return origin; } catch {} if (owned.exitCode !== null) throw new Error('Quick Tunnel stopped'); await delay(1000); }
  throw new Error('Quick Tunnel HTTPS readiness timed out');
}
function client() {
  const jar = new Map();
  return { get cookies() { return [...jar].map(([key, value]) => `${key}=${value}`).join('; '); }, async request(origin, path, body) {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(jar.size ? { Cookie: this.cookies } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-Jige-Request': '1' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const payload = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${payload.error || ''}`);
    for (const cookie of response.headers.getSetCookie()) { if (origin.startsWith('https:')) assert.match(cookie, /; Secure/); const [key, value] = cookie.split(';')[0].split('='); if (value) jar.set(key, value); else jar.delete(key); }
    return payload;
  } };
}
async function observe(origin, client) {
  const socket = new WebSocket(origin.replace('https:', 'wss:') + '/ws', { headers: { Origin: origin, Cookie: client.cookies }, handshakeTimeout: 30000 });
  try { return await new Promise((ok, no) => { const timer = setTimeout(() => no(new Error('WSS snapshot timed out')), 30000); socket.on('error', error => { clearTimeout(timer); no(error); }); socket.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' })); if (message.type === 'snapshot') { clearTimeout(timer); ok(message.snapshot); } }); }); } finally { socket.close(); }
}
const field = value => ({ value, source: 'module', visibility: 'public' });
try {
  runtime = await createApplication({ dataDir, distDir: join(root, 'dist') });
  let address = await runtime.listen(0), local = `http://127.0.0.1:${address.port}`;
  const owner = client(), player = client(), password = randomUUID();
  await owner.request(local, '/api/account/register', { username: 'public-owner', password: randomUUID(), hostToken: runtime.hostToken });
  const world = await owner.request(local, '/api/campaigns', { name: 'Fictional AI public QA', mode: 'ai', freedom: 'B' });
  const exported = await owner.request(local, '/api/ai/export', { kind: 'initialize' }), e = exported.packet;
  const packet = { protocol: 'jigerpg-ai', version: 2, packetType: 'initialize', campaignId: e.campaignId, exchangeId: e.exchangeId, displayRevision: e.displayRevision, payload: { decisionId: 'public-init', initialization: { freedom: 'B', rules: { edition: '5e2024', fields: {} }, pcs: [{ id: 'hero', name: 'QA Hero', kind: 'pc', source: 'module', visibility: 'public', fields: { hp: field({ current: 0, max: -10 }) } }], background: { fields: {} }, setting: { fields: {}, entities: [{ id: 'secret', name: 'UNREVEALED QA ENEMY', kind: 'enemy', source: 'module', visibility: 'gm', fields: {} }] }, opening: { fields: { description: field('A fictional harbor at dawn.') } } } } };
  const command = async (client, origin, type, payload = {}) => { const state = await client.request(origin, '/api/state'); return client.request(origin, '/api/command', { operationId: randomUUID(), expectedRev: state.state.rev, type, payload }); };
  await command(owner, local, 'ai.display.initialize', { packet });
  await command(owner, local, 'world.start');
  const first = await tunnel(address.port);
  await player.request(first, '/api/account/register', { username: 'public-player', password });
  const joined = await player.request(first, '/api/join', { inviteCode: world.inviteCode });
  await command(player, first, 'ai.display.select', { actorId: 'hero' });
  const state = await player.request(first, '/api/state');
  const action = { operationId: randomUUID(), expectedRev: state.state.rev, type: 'ai.display.action', payload: { actorId: 'hero', type: 'explore', text: 'I inspect the public harbor.' } };
  await player.request(first, '/api/command', action);
  const observed = await observe(first, player); assert.equal(observed.world.ai.display.ownPcId, 'hero'); assert.equal(observed.world.ai.display.entities[0].fields.hp.value.current, 0); assert.ok(!JSON.stringify(observed).includes('UNREVEALED QA ENEMY'));
  assert.equal((await fetch(first + '/')).status, 200);
  for (const path of ['/.git/config', '/data/game.sqlite', '/src/server/app.ts']) assert.equal((await fetch(first + path)).status, 404);
  console.log(JSON.stringify({ stage: 'first', https: true, wss: true, secureAccountAndWorldCookies: true, hiddenDataFiltered: true }));
  const serverId = runtime.serverId;
  await stopTunnel(); runtime.setPublicOrigin(null); assert.equal((await fetch(local + '/api/health')).status, 200);
  await runtime.close(); runtime = await createApplication({ dataDir, distDir: join(root, 'dist') }); address = await runtime.listen(0);
  const second = await tunnel(address.port); assert.notEqual(first, second); assert.equal(runtime.serverId, serverId);
  const recovered = client(); await recovered.request(second, '/api/account/login', { username: 'public-player', password });
  const worlds = await recovered.request(second, '/api/worlds'); assert.equal(worlds.worlds.length, 1);
  const entered = await recovered.request(second, '/api/worlds/enter', { worldId: world.state.id }); assert.equal(entered.session.member.id, joined.session.member.id);
  const again = await recovered.request(second, '/api/command', action); assert.equal(again.duplicate, true);
  const restored = await observe(second, recovered); assert.equal(restored.world.ai.display.actions.length, 1); assert.equal(restored.world.ai.display.ownPcId, 'hero');
  const result = { commit: codeCommit(), schemaVersion: SCHEMA_VERSION, https: true, wss: true, secureCookies: true, urlChanged: true, accountAndRoleRestored: true, aiDisplayRestored: true, duplicateActionCount: 1, localDuringTunnelFailure: true, hiddenDataFiltered: true };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await stopTunnel(); await runtime?.close(); }
