import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { createApplication } from '../src/server/app';
import type { Snapshot, Command } from '../src/shared/model';
import { DEFAULT_RULES } from '../src/shared/world';

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'jige-world-api-'));
  let now = 10_000;
  let runtime = await createApplication({ dataDir: directory, hostToken: 'world-api-host', now: () => now, dice: () => 1 });
  let base = `http://127.0.0.1:${(await runtime.listen(0)).port}`;
  const clients: any[] = [];
  function client() {
    let cookie = '';
    const api = async (path: string, data?: unknown) => {
      const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { Origin: base, 'X-Jige-Request': '1', 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
      const body = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer();
      return { status: response.status, body };
    };
    const state = async () => { const result = await api('/api/state'); assert.equal(result.status, 200); return result.body as Snapshot; };
    const command = async (type: string, payload: Record<string, unknown> = {}, actorId?: string, expected = 200) => {
      const cmd: Command = { operationId: randomUUID(), expectedRev: (await state()).state.rev, type, actorId, payload };
      const result = await api('/api/command', cmd); assert.equal(result.status, expected, result.body?.error); return { ...result, command: cmd };
    };
    const value = { api, state, command }; clients.push(value); return value;
  }
  t.after(async () => { await runtime.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && basename(directory).startsWith('jige-world-api-')); await rm(directory, { recursive: true, force: true }); });
  const owner = client();
  const create = async (mode = 'gm', governance = { system: 'democracy', ownerVeto: false }) => { const result = await owner.api('/api/campaigns', { hostToken: 'world-api-host', name: '测试世界', gmName: '测试房主', mode, governance }); assert.equal(result.status, 201); return result.body as Snapshot; };
  const joinPlayer = async (name: string) => { const player = client(); const result = await player.api('/api/join', { inviteCode: (await owner.state()).inviteCode, name }); assert.equal(result.status, 200); return player; };
  const register = async (player: ReturnType<typeof client>) => { const created = await owner.command('character.create'); const actorId = created.body.snapshot.offers.find((o: any) => o.registration === 'available').id; await player.command('character.claim', { actorId }); await owner.command('character.register', { actorId, approved: true }); return actorId as string; };
  return { owner, create, joinPlayer, register, client, advance: (ms: number) => { now += ms; }, restart: async () => { await runtime.close(); runtime = await createApplication({ dataDir: directory, hostToken: 'new-process-host-token', now: () => now, dice: () => 1 }); base = `http://127.0.0.1:${(await runtime.listen(0)).port}`; }, get runtime() { return runtime; } };
}

test('real world API grants one default card and enforces private profiles, per-character knowledge and direct-command boundaries', async t => {
  const f = await setup(t); await f.create();
  const p1 = await f.joinPlayer('甲'), p2 = await f.joinPlayer('乙');
  const a = await f.register(p1), b = await f.register(p2);
  assert.equal((await p1.state()).state.actors[0].hp.max, 10);
  await p1.command('actor.create', {}, undefined, 403); await p1.command('character.create', {}, undefined, 403);
  await f.owner.command('character.patch', { actorId: b, patch: { story: '故事公开样本', notes: 'PRIVATE-NOTES-DO-NOT-SEND', abilities: { str: 100, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } } });
  const before = await p1.state(); assert.equal(before.state.actors.length, 1); assert.equal(before.profiles!.find(p => p.id === b)!.stats, undefined);
  assert.ok(!JSON.stringify(before).includes('PRIVATE-NOTES-DO-NOT-SEND'));
  await p2.command('profile.update', { actorId: b, publicGroups: ['story'] });
  assert.equal((await p1.state()).profiles!.find(p => p.id === b)!.story, '故事公开样本');
  assert.equal((await p1.state()).profiles!.find(p => p.id === b)!.stats, undefined);
  assert.equal((await p1.api('/api/content')).body.entries.length, 0);
  const catalog = (await f.owner.api('/api/content')).body.entries;
  const monsterId = catalog.find((entry: any) => entry.category === 'monster').id;
  await f.owner.command('knowledge.unlock', { actorId: a, entryId: monsterId });
  assert.ok((await p1.api('/api/content')).body.entries.some((entry: any) => entry.id === monsterId));
  assert.equal((await p2.api('/api/content')).body.entries.length, 0);
  assert.equal((await f.client().api('/api/content')).body.entries.length, 0);
  await f.owner.command('world.configure', { mode: 'co-create' }, undefined, 400);
  assert.equal((await f.owner.state()).world!.mode, 'gm');
});

test('dictatorship owner permissions are persistent, scoped and revocable across actual HTTP sessions', async t => {
  const f = await setup(t); await f.create('co-create', { system: 'dictatorship', ownerVeto: false });
  const p1 = await f.joinPlayer('甲'), p2 = await f.joinPlayer('乙'); const actorId = await f.register(p1);
  const p2id = (await p2.state()).session.member.id;
  await f.owner.command('world.configure', { rules: { ...structuredClone(DEFAULT_RULES), energy: { maximum: 10, perRound: 3, recoveryMode: 'round', recovery: 1 }, costs: { move: 0.5, action: 1, narrative: 1, proposal: 1 } } });
  await f.owner.command('world.start');
  await p2.command('character.patch', { actorId, patch: { manual: { maxHp: 50 } } }, undefined, 403);
  await f.owner.command('governance.grant', { memberId: p2id, capabilities: ['manage.characters'] });
  await p2.command('character.patch', { actorId, patch: { manual: { maxHp: 50 } } });
  assert.equal((await p1.state()).state.actors[0].hp.max, 50);
  await p2.command('governance.grant', { memberId: (await p1.state()).session.member.id, capabilities: ['manage.characters'] }, undefined, 400);
  await f.owner.command('governance.grant', { memberId: p2id, capabilities: [] });
  await p2.command('character.patch', { actorId, patch: { name: '未授权修改' } }, undefined, 403);
  const ownerId = (await f.owner.state()).world!.ownerId;
  await f.restart();
  assert.equal((await f.owner.state()).world!.ownerId, ownerId);
  assert.deepEqual((await p2.state()).world!.capabilities, []);
});

test('unified-round settlement is idempotent across ACK replay and server restart, with fractional AP and hourly offline recovery', async t => {
  const f = await setup(t); await f.create('co-create'); const player = await f.joinPlayer('甲'); const actorId = await f.register(player);
  await f.owner.command('world.configure', { rules: { ...structuredClone(DEFAULT_RULES), energy: { maximum: 10, perRound: 3, recoveryMode: 'hour', recovery: 1 }, costs: { move: 0.25, action: 1, narrative: 0.1, proposal: 1 } } });
  await f.owner.command('world.start');
  const actor = (await player.state()).state.actors.find(a => a.id === actorId)!;
  const destination = { x: actor.position.x + 1, y: actor.position.y };
  await player.command('intent.save', { intent: { actorId, type: 'move', payload: { path: [destination] } } });
  assert.equal((await player.state()).state.actors[0].resources.find(r => r.id === 'ap')!.current, 10);
  await player.command('turn.end');
  const settled = await f.owner.command('round.settle');
  assert.deepEqual((await player.state()).state.actors[0].position, destination);
  assert.equal((await player.state()).state.actors[0].resources.find(r => r.id === 'ap')!.current, 9.75);
  const replay = await f.owner.api('/api/command', settled.command); assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
  await f.restart();
  assert.equal((await player.state()).state.actors[0].resources.find(r => r.id === 'ap')!.current, 9.75);
  f.advance(3_600_000);
  assert.equal((await player.state()).state.actors[0].resources.find(r => r.id === 'ap')!.current, 10);
});

test('image references cannot launder private assets and database-backed pictures survive a complete export and restore', async t => {
  const f = await setup(t); await f.create(); const p1 = await f.joinPlayer('甲'), p2 = await f.joinPlayer('乙'); const a = await f.register(p1), b = await f.register(p2);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  const secret = await f.owner.api('/api/assets', { dataUrl: png }); assert.equal(secret.status, 201);
  assert.equal((await p2.api(secret.body.url)).status, 404);
  await p2.command('profile.update', { actorId: b, portrait: secret.body.url }, undefined, 403);
  const own = await p1.api('/api/assets', { dataUrl: png }); assert.equal(own.status, 201);
  await p1.command('profile.update', { actorId: a, portrait: own.body.url }); assert.equal((await p2.api(own.body.url)).status, 200);
  const backup = (await f.owner.api('/api/export')).body; assert.equal(backup.assets.length, 2);
  assert.equal((await f.owner.api('/api/restore', { backup })).status, 200);
  assert.equal((await p2.api(own.body.url)).status, 200); assert.equal((await p2.api(secret.body.url)).status, 404);
});

test('AI exchange endpoints restrict authority, validate previews and preserve gameplay revisions and idempotent initialization', async t => {
  const f = await setup(t); await f.create('ai'); const player = await f.joinPlayer('旁观玩家');
  assert.equal((await player.api('/api/ai/export', {kind:'initialize'})).status,403);
  const before = await f.owner.state(), exported = await f.owner.api('/api/ai/export', {kind:'initialize'});
  assert.equal(exported.status,200,exported.body.error);
  assert.equal(exported.body.packet.worldRevision,before.world!.gameplayRev);
  assert.equal((await f.owner.state()).world!.gameplayRev,before.world!.gameplayRev);
  assert.equal((await f.owner.state()).state.rev,before.state.rev+1);
  const {packet,schema,prompt}=exported.body; assert.ok(schema&&prompt);
  const reply={protocol:packet.protocol,version:1,packetType:'initialize',campaignId:packet.campaignId,exchangeId:packet.exchangeId,worldRevision:packet.worldRevision,payload:{decisionId:'initial-import-1',lore:'外部AI世界背景',characters:[{id:'external-hero',name:'探索者',profile:'free',manual:{maxHp:23}}]}};
  const preview=await f.owner.api('/api/ai/preview',{packet:reply});assert.equal(preview.body.valid,true,JSON.stringify(preview.body.errors));
  assert.equal((await f.owner.state()).state.actors.length,0,'preview must not mutate data');
  const applied=await f.owner.command('ai.apply',{packet:reply});assert.equal(applied.body.snapshot.state.actors.length,1);
  assert.equal(applied.body.snapshot.state.actors[0].hp.max,23);assert.equal(applied.body.snapshot.state.actors[0].registration,'available');
  assert.equal((await player.state()).state.actors.length,0);assert.equal((await player.state()).offers!.length,1);
  await f.owner.command('ai.apply',{packet:reply});assert.equal((await f.owner.state()).state.actors.length,1);
  await f.restart();await f.owner.command('ai.apply',{packet:reply});assert.equal((await f.owner.state()).state.actors.length,1);
  await player.command('ai.apply',{packet:reply},undefined,403);
  await f.owner.command('round.settle',{},undefined,403);
});

test('free-copy server command preserves original byte-for-byte and creates a distinct unclaimed private card',async t=>{
  const f=await setup(t);await f.create();const player=await f.joinPlayer('玩家');const id=await f.register(player);
  await f.owner.command('character.patch',{actorId:id,patch:{manual:{maxHp:31,proficiency:-2},hp:{current:7,max:31,temp:2},notes:'原卡私人备注'}});
  const source=(await f.owner.state()).state.actors.find(a=>a.id===id)!;
  const copied=await f.owner.command('character.copyFree',{actorId:id});
  const actors=copied.body.snapshot.state.actors;assert.deepEqual(actors.find((a:any)=>a.id===id),source);
  const copy=actors.find((a:any)=>a.id!==id);assert.ok(copy);assert.equal(copy.registration,'available');assert.equal(copy.hidden,true);assert.equal(copy.hp.current,7);assert.equal(copy.manual.proficiency,-2);
  assert.equal(copy.choices.copySourceActorId,id);assert.ok(copy.choices.copySourceHash);
  assert.equal((await player.state()).state.actors.length,1);await player.command('character.copyFree',{actorId:id},undefined,403);
});

test('real AI room completes rounds with the selected dice source and preserves one-time decisions across restarts',async t=>{
  const f=await setup(t);await f.create('ai');const player=await f.joinPlayer('探索者');const actorId=await f.register(player);
  await f.owner.command('world.configure',{rules:{...structuredClone(DEFAULT_RULES),energy:{maximum:10,perRound:3,recoveryMode:'hour',recovery:1},costs:{move:0.5}}});
  await f.owner.command('world.start');
  await f.owner.command('world.configure',{lore:'直接绕过AI'},undefined,400);
  await f.owner.command('knowledge.unlock',{actorId,entryId:'monster:tarrasque'},undefined,403);
  for(const diceSource of ['program','ai'] as const){
    await f.owner.command('ai.configure',{diceSource});
    const position=(await player.state()).state.actors[0].position,destination={x:position.x+1,y:position.y};
    await player.command('intent.save',{intent:{actorId,type:'move',payload:{path:[destination]}}});await player.command('turn.end');
    const exported=await f.owner.api('/api/ai/export',{kind:'turn_context'});assert.equal(exported.status,200,exported.body.error);
    const first=exported.body.packet,intent=first.payload.round.intents.find((i:any)=>i.actorId===actorId&&i.status==='planned');assert.ok(intent);
    const rollReply={protocol:'jigerpg-ai',version:1,packetType:'decision',campaignId:first.campaignId,exchangeId:first.exchangeId,worldRevision:first.worldRevision,payload:{decisionId:'roll-'+diceSource,completeRound:false,steps:[{id:'chance',type:'roll',expression:'1d6',rollId:'chance-result'}],...(diceSource==='ai'?{aiRolls:[{id:'chance-result',expression:'1d6',rolls:[3],total:3}]}:{})}};
    await f.owner.command('ai.apply',{packet:rollReply});
    const results=await f.owner.api('/api/ai/export',{kind:'roll_results',exchangeId:first.exchangeId});assert.equal(results.status,200,results.body.error);
    const packet=results.body.packet;assert.equal(packet.payload.rolls[0].total,diceSource==='program'?1:3);
    const reply={protocol:'jigerpg-ai',version:1,packetType:'decision',campaignId:packet.campaignId,exchangeId:packet.exchangeId,worldRevision:packet.worldRevision,payload:{decisionId:'real-'+diceSource,completeRound:true,steps:[{id:'move',type:'intent',intentId:intent.id,approve:true}]}};
    const preview=await f.owner.api('/api/ai/preview',{packet:reply});assert.equal(preview.body.valid,true,JSON.stringify(preview.body));
    await f.owner.command('ai.apply',{packet:reply});const once=await f.owner.state();assert.equal(once.world!.round.phase,'intermission');
    const hero=once.state.actors.find(a=>a.id===actorId)!;assert.deepEqual(hero.position,destination);assert.equal(hero.resources.find(r=>r.id==='ap')!.current,diceSource==='program'?9.5:9);
    assert.equal(once.world!.ai.exchanges.find(e=>e.id===first.exchangeId)!.rolls!.find(r=>r.id==='chance-result')!.total,diceSource==='program'?1:3);
    await f.restart();await f.owner.command('ai.apply',{packet:reply});const repeated=await f.owner.state();assert.equal(repeated.world!.gameplayRev,once.world!.gameplayRev);assert.equal(repeated.state.actors.find(a=>a.id===actorId)!.resources.find(r=>r.id==='ap')!.current,hero.resources.find(r=>r.id==='ap')!.current);
    await f.owner.command('round.start');
  }
});
