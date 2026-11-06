import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/engine/index';
import { newWorld } from '../src/shared/world';
import { projectWorld, resolveCharacterCommand } from '../src/server/world-controller';
import type { Command, GameState, Member } from '../src/shared/model';
const members: Member[] = [{ id: 'owner', name: '房主', role: 'gm' }, { id: 'p1', name: '甲', role: 'player' }, { id: 'p2', name: '乙', role: 'player' }];
function fresh() { const s = engine.createGameState('角色池测试'); s.world = newWorld('owner', 'gm'); return s; }
function apply(state: GameState, who: string, type: string, payload: Record<string, unknown> = {}) { const command: Command = { operationId: 'test-operation-' + state.rev, expectedRev: state.rev, type, payload }; return resolveCharacterCommand(state, command, members.find(m => m.id === who)!, members, engine).state; }
function register(state: GameState, who: string) { state = apply(state, 'owner', 'character.create'); const actorId = state.actors.at(-1)!.id; state = apply(state, who, 'character.claim', { actorId }); return apply(state, 'owner', 'character.register', { actorId, approved: true }); }

test('GM creates a usable empty card; claims and registration are exclusive and do not rewrite identity', () => {
  let state = apply(fresh(), 'owner', 'character.create');
  const actorId = state.actors[0].id;
  assert.equal(state.actors[0].hp.max, 10); assert.equal(state.actors[0].draft, false); assert.equal(state.actors[0].profile, 'free');
  assert.deepEqual(state.actors[0].classes, []); assert.deepEqual(state.actors[0].customActions, []);
  state = apply(state, 'p1', 'character.claim', { actorId });
  assert.throws(() => apply(state, 'p2', 'character.claim', { actorId }), /已被领取/);
  assert.throws(() => apply(state, 'p1', 'character.create'), /当前模式/);
  state = apply(state, 'owner', 'character.register', { actorId, approved: true });
  assert.equal(state.actors[0].ownerId, 'p1'); assert.equal(state.actors[0].registration, 'registered');
  const second = apply(state, 'owner', 'character.create');
  assert.throws(() => apply(second, 'p1', 'character.claim', { actorId: second.actors[1].id }), /已领取/);
  assert.throws(() => apply(state, 'p2', 'profile.update', { actorId, portrait: '' }), /自己角色/);
});

test('player snapshots contain only their own complete card and explicitly shared fields', () => {
  let state = register(register(fresh(), 'p1'), 'p2');
  const other = state.actors.find(a => a.ownerId === 'p2')!;
  other.name = '同伴'; other.notes = 'NEVER-PUBLISH-PRIVATE-NOTES'; other.story = '可公开的故事'; other.abilities.str = 99; other.hp.current = 7;
  state.world!.secretLore = 'NEVER-PUBLISH-SECRET-LORE';
  state.world!.drafts.push({ id: 'private-draft', ownerId: 'p2', title: 'NEVER-PUBLISH-DRAFT', kind: 'story', payload: { secret: 'private' }, updatedAt: 1 });
  const hidden = engine.createActor({ profile: 'free', name: 'NEVER-PUBLISH-HIDDEN-CREATURE', kind: 'monster', ownerId: 'owner', hidden: true }); state.actors.push(hidden);
  const session = { campaignId: state.id, member: members[1] };
  let view = projectWorld(state, session, members, engine);
  assert.equal(view.state!.actors.length, 1); assert.equal(view.tokens!.find(t => t.id === other.id)?.hp, undefined);
  for (const secret of ['NEVER-PUBLISH-PRIVATE-NOTES', 'NEVER-PUBLISH-SECRET-LORE', 'NEVER-PUBLISH-DRAFT', 'NEVER-PUBLISH-HIDDEN-CREATURE']) assert.ok(!JSON.stringify(view).includes(secret));
  assert.equal(view.profiles!.find(a => a.id === other.id)?.stats, undefined);
  other.publicGroups = ['story']; view = projectWorld(state, session, members, engine);
  assert.equal(view.profiles!.find(a => a.id === other.id)?.story, '可公开的故事');
  assert.equal(view.profiles!.find(a => a.id === other.id)?.stats, undefined);
  other.publicGroups = ['stats']; view = projectWorld(state, session, members, engine);
  assert.equal(view.profiles!.find(a => a.id === other.id)?.stats?.abilities.str, 99);
  assert.equal(view.profiles!.find(a => a.id === other.id)?.story, undefined);
});

test('dictator delegated character rights are scoped and immediately revocable; democracy cannot bypass proposals', () => {
  let state = register(fresh(), 'p1'); const actorId = state.actors[0].id;
  state.world!.mode = 'co-create'; state.world!.phase = 'running'; state.world!.governance.system = 'dictatorship';
  state.world!.governance.delegations.p2 = ['manage.characters'];
  state = apply(state, 'p2', 'character.patch', { actorId, patch: { manual: { maxHp: 123 }, abilities: { str: 100, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } } });
  assert.equal(state.actors[0].hp.max, 123); assert.equal(state.actors[0].abilities.str, 100);
  delete state.world!.governance.delegations.p2;
  assert.throws(() => apply(state, 'p2', 'character.patch', { actorId, patch: { name: '绕过' } }), /当前模式/);
  state.world!.governance.system = 'democracy';
  assert.throws(() => apply(state, 'owner', 'character.patch', { actorId, patch: { name: '绕过' } }), /需要GM决策或通过提案/);
});
