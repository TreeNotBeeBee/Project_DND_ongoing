import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/engine/index.ts';
import { newWorld } from '../src/shared/world.ts';
import { resolveWorldCommand } from '../src/world/index.ts';
import { createAiExchange, previewAiPacket, applyAiPacket, resolveAiReaction, resumeAiDecisions, resolveAiGameCommand, type AiContext, type AiPacket } from '../src/ai/protocol.ts';
import type { Actor, ActionDefinition, GameState, Dice, Member } from '../src/shared/model.ts';
const owner = { id: 'owner', role: 'gm' as const, name: 'Owner' }, player = { id: 'player', role: 'player' as const, name: 'Player' };
function fixture(source: 'program' | 'ai' = 'program') {
  const state = engine.createGameState('AI protocol proof'); state.world = newWorld(owner.id, 'ai'); state.world.ai.diceSource = source;
  let rolled = 0; const program: Dice = side => { rolled++; return side === 20 ? 10 : 1; };
  const raw: AiContext['resolveEngine'] = (s, c, d) => engine.resolveCommand(s, c, d, { economy: 'world', skipResources: ['ap'] });
  const ctx: AiContext = { now: 1000, member: owner, members: [owner, player], onlineMemberIds: [owner.id, player.id], dice: program, engine, resolveWorldCommand, resolveEngine: (s, c, d) => resolveAiReaction(s, c, d, raw) };
  return { state, ctx, raw, get rolled() { return rolled; } };
}
const action = (patch: Partial<ActionDefinition> = {}): ActionDefinition => ({ id: 'custom:attack', name: 'Explicit action', source: 'custom', economy: 'action', range: 5, attack: { bonus: 3 }, damage: [{ formula: '1d6', type: 'fire' }], costs: [{ resourceId: 'mp', amount: 2 }], description: '', automation: 'automatic', ...patch });
function actors(state: GameState, shield = false) {
  const attacker = engine.createActor({ profile: 'free', name: 'Attacker', ownerId: owner.id, registration: 'registered', resources: [{ id: 'mp', name: 'MP', current: 10, max: 10, recovery: 'manual' }], customActions: [action()], position: { x: 0, y: 0 } });
  const target = shield ? engine.createActor({ name: 'Wizard', ownerId: player.id, registration: 'registered', draft: false, classes: [{ classId: 'wizard', level: 1 }], speciesId: 'human', backgroundId: 'soldier', abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 10, cha: 10 }, spells: ['spell:shield'], position: { x: 1, y: 0 } }) : engine.createActor({ profile: 'free', name: 'Target', ownerId: player.id, registration: 'registered', position: { x: 1, y: 0 } });
  state.actors = [attacker, target]; state.world!.phase = 'running'; return { attacker, target };
}
function reply(packet: AiPacket, payload: Record<string, unknown>, packetType = 'decision') { return { protocol: packet.protocol, version: packet.version, campaignId: packet.campaignId, exchangeId: packet.exchangeId, worldRevision: packet.worldRevision, packetType, payload }; }
const attackStep = (a: Actor, t: Actor, rollId?: string) => ({ id: 'attack', type: 'command', command: { type: 'action.use', actorId: a.id, targetIds: [t.id], payload: { actionId: 'custom:attack' } }, ...(rollId ? { rollId } : {}) });
test('AI export is immutable, owner-only and strips private notes, actor choices and other members drafts', () => {
  const f = fixture(); const { attacker } = actors(f.state); attacker.notes = 'PRIVATE NOTE'; attacker.story = 'Visible story'; attacker.choices = { recoveryCode: 'PRIVATE RECOVERY', migrationOriginal: 'PRIVATE OLD SAVE' };
  f.state.world!.secretLore = 'Host secret lore'; f.state.world!.drafts = [{ id: 'private', ownerId: player.id, kind: 'story', title: 'Private', payload: { text: 'PRIVATE PLAYER DRAFT' }, updatedAt: 1 }];
  const before = structuredClone(f.state), exported = createAiExchange(f.state, 'turn_context', f.ctx), text = JSON.stringify(exported.packet);
  assert.deepEqual(f.state, before); for (const secret of ['PRIVATE NOTE', 'PRIVATE RECOVERY', 'PRIVATE OLD SAVE', 'PRIVATE PLAYER DRAFT']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('Visible story') && text.includes('Host secret lore')); assert.equal(exported.state.world!.gameplayRev, 0); assert.notEqual(exported.packet.exchangeId, '');
  assert.throws(() => createAiExchange(f.state, 'turn_context', { ...f.ctx, member: player }), /Only the world owner/);
});
test('initialization maps external NPC references to program IDs and creates unclaimed free hero offers atomically', () => {
  const f = fixture(), exported = createAiExchange(f.state, 'initialize', f.ctx);
  const packet = reply(exported.packet, { decisionId: 'init-1', lore: 'A world', characters: [{ id: 'outside-hero', name: 'Available Hero', story: 'Public story', notes: 'Private character note' }], npcs: [{ id: 'outside-npc', name: 'Guide', manual: { maxHp: 25 } }], npcBehaviors: [{ actorId: 'outside-npc', kind: 'idle' }] }, 'initialize');
  const before = structuredClone(exported.state), preview = previewAiPacket(exported.state, packet, f.ctx); assert.equal(preview.valid, true, preview.errors.join('\n')); assert.deepEqual(exported.state, before);
  const out = applyAiPacket(exported.state, packet, f.ctx), hero = out.state.actors.find(actor => actor.name === 'Available Hero')!, npc = out.state.actors.find(actor => actor.name === 'Guide')!;
  assert.equal(hero.registration, 'available'); assert.equal(hero.ownerId, owner.id); assert.equal(hero.hidden, true); assert.equal(hero.profile, 'free'); assert.equal(hero.hp.max, 10); assert.equal(npc.ownerId, owner.id); assert.equal(npc.hp.max, 25);
  assert.notEqual(hero.id, 'outside-hero'); assert.equal(out.state.world!.npcBehaviors[0].actorId, npc.id); assert.deepEqual(applyAiPacket(out.state, packet, f.ctx).events, []);
  const bad = reply(exported.packet, { decisionId: 'invalid-init', characters: [{ name: 'Would be created' }], npcBehaviors: [{ actorId: 'missing', kind: 'idle' }] }, 'initialize');
  assert.equal(previewAiPacket(exported.state, bad, f.ctx).valid, false); assert.throws(() => applyAiPacket(exported.state, bad, f.ctx)); assert.deepEqual(exported.state, before);
});
test('foreign, stale and same-ID changed decisions reject while cosmetic revisions and true duplicates remain valid', () => {
  const f = fixture(); actors(f.state); const exported = createAiExchange(f.state, 'turn_context', f.ctx), packet = reply(exported.packet, { decisionId: 'story-1', narratives: [{ text: 'Narration' }] });
  exported.state.rev += 10; assert.equal(previewAiPacket(exported.state, packet, f.ctx).valid, true);
  const applied = applyAiPacket(exported.state, packet, f.ctx); applied.state.world!.gameplayRev++;
  assert.deepEqual(applyAiPacket(applied.state, packet, f.ctx).events, []); assert.equal(applied.state.world!.ai.narratives.length, 1);
  for (const value of [{ ...packet, campaignId: 'foreign' }, { ...packet, exchangeId: 'foreign' }, reply(exported.packet, { decisionId: 'story-1', narratives: [{ text: 'Changed' }] }), reply(exported.packet, { decisionId: 'new' })]) assert.equal(previewAiPacket(applied.state, value, f.ctx).valid, false);
});
test('whole-packet prevalidation and failed engine steps never leave earlier damage, costs or private receipts committed', () => {
  const f = fixture(), { attacker, target } = actors(f.state), exported = createAiExchange(f.state, 'turn_context', f.ctx), before = structuredClone(exported.state);
  const bad = reply(exported.packet, { decisionId: 'atomic', steps: [attackStep(attacker, target), { id: 'invalid', type: 'command', command: { type: 'action.use', actorId: attacker.id, targetIds: [target.id], payload: { actionId: 'not-available' } } }] });
  assert.equal(previewAiPacket(exported.state, bad, f.ctx).valid, false); assert.throws(() => applyAiPacket(exported.state, bad, f.ctx)); assert.equal(f.rolled, 0); assert.deepEqual(exported.state, before);
  const impossible = reply(exported.packet, { decisionId: 'late-runtime', steps: [attackStep(attacker, target), { id: 'outside', type: 'command', command: { type: 'actor.move', actorId: attacker.id, payload: { path: [{ x: 50, y: 0 }] } } }] });
  assert.throws(() => applyAiPacket(exported.state, impossible, f.ctx)); assert.deepEqual(exported.state, before);
  for (const type of ['restore', 'governance.grant', 'vote.cast', 'actor.delete']) assert.equal(previewAiPacket(exported.state, reply(exported.packet, { decisionId: type, steps: [{ id: 'forbidden', type: 'command', command: { type, payload: {} } }] }), f.ctx).valid, false);
});
test('program rolls are recorded once, exported as results and cannot be supplied or rewritten by AI', () => {
  const f = fixture(); actors(f.state); const exported = createAiExchange(f.state, 'turn_context', f.ctx), packet = reply(exported.packet, { decisionId: 'roll-1', steps: [{ id: 'roll', type: 'roll', rollId: 'r1', expression: '1d20+3' }] });
  const out = applyAiPacket(exported.state, packet, f.ctx); assert.equal(f.rolled, 1); assert.equal(out.state.world!.ai.exchanges[0].rolls![0].total, 13); assert.deepEqual(applyAiPacket(out.state, packet, f.ctx).events, []); assert.equal(f.rolled, 1);
  const results = createAiExchange(out.state, 'roll_results', { ...f.ctx, exchangeId: exported.packet.exchangeId }); assert.equal((results.packet.payload.rolls as any[])[0].total, 13);
  const cheating = reply(exported.packet, { decisionId: 'cheat', aiRolls: [{ id: 'r1', expression: '1d20', rolls: [20], total: 20 }] }); assert.equal(previewAiPacket(out.state, cheating, f.ctx).valid, false);
  const reroll = reply(exported.packet, { decisionId: 'reroll', steps: [{ id: 'again', type: 'roll', rollId: 'r1', expression: '1d20+3' }] }); assert.equal(previewAiPacket(out.state, reroll, f.ctx).valid, false);
});
test('AI dice are checked per face, formula, total and actual requested use without random fallback', () => {
  const f = fixture('ai'), { attacker, target } = actors(f.state), exported = createAiExchange(f.state, 'turn_context', f.ctx), valid = reply(exported.packet, { decisionId: 'ai-roll', steps: [attackStep(attacker, target, 'r1')], aiRolls: [{ id: 'r1', expression: '1d20+1d6', rolls: [10, 4], total: 14 }] });
  const out = applyAiPacket(exported.state, valid, f.ctx); assert.equal(out.state.actors[1].hp.current, 6); assert.equal(out.state.actors[0].resources.find(resource => resource.id === 'mp')!.current, 8); assert.equal(f.rolled, 0);
  for (const roll of [{ id: 'r1', expression: '1d20+1d6', rolls: [21, 4], total: 25 }, { id: 'r1', expression: '1d20+1d6', rolls: [10, 4], total: 99 }, { id: 'r1', expression: '1d6', rolls: [4], total: 4 }]) { const packet = reply(exported.packet, { decisionId: 'invalid', steps: [attackStep(attacker, target, 'r1')], aiRolls: [roll] }); assert.throws(() => applyAiPacket(exported.state, packet, f.ctx)); }
  assert.equal(f.rolled, 0);
});
test('program-dice Shield pauses a batch across JSON restart and resumes its remaining owner-confirmed steps once', () => {
  const f = fixture(), { attacker, target } = actors(f.state, true), exported = createAiExchange(f.state, 'turn_context', f.ctx), packet = reply(exported.packet, { decisionId: 'reaction-program', steps: [attackStep(attacker, target), { id: 'after', type: 'ruling', command: { type: 'gm.adjust', actorId: target.id, payload: { hp: 5 } } }] });
  let out = applyAiPacket(exported.state, packet, f.ctx); assert.equal(out.state.choices[0].kind, 'shield-reaction'); assert.equal(out.state.actors[1].hp.current, target.hp.current); assert.equal(out.state.actors[0].resources.find(resource => resource.id === 'mp')!.current, 8);
  const choice = out.state.choices[0]; assert.equal(typeof choice.payload.aiResolutionRef, 'string'); assert.ok(!JSON.stringify(choice.payload).includes('sides'));
  out = resolveAiReaction(JSON.parse(JSON.stringify(out.state)), { operationId: 'react', expectedRev: 0, type: 'choice.resolve', payload: { choiceId: choice.id, optionId: 'cast' } }, f.ctx.dice, f.raw);
  out.state.world!.gameplayRev++; out = resumeAiDecisions(out.state, f.ctx); assert.equal(out.state.actors[1].hp.current, 5); assert.equal(out.state.actors[0].resources.find(resource => resource.id === 'mp')!.current, 8); assert.equal(out.state.actors[1].resources.find(resource => resource.id === 'slot-1')!.current, 1); assert.deepEqual(applyAiPacket(out.state, packet, f.ctx).events, []);
});
test('AI-dice Shield persists private pools, records a real player choice when dice are missing, and accepts only a matching supplement', () => {
  const f = fixture('ai'), { attacker, target } = actors(f.state, true), exported = createAiExchange(f.state, 'turn_context', f.ctx), packet = reply(exported.packet, { decisionId: 'reaction-ai', steps: [attackStep(attacker, target, 'hit')], aiRolls: [{ id: 'hit', expression: '1d20', rolls: [10], total: 10 }] });
  let out = applyAiPacket(exported.state, packet, f.ctx), choice = out.state.choices[0];
  out = resolveAiReaction(JSON.parse(JSON.stringify(out.state)), { operationId: 'player-decline', expectedRev: 0, type: 'choice.resolve', payload: { choiceId: choice.id, optionId: 'decline' } }, () => { throw new Error('Never substitute program dice'); }, f.raw);
  assert.equal(out.state.actors[1].hp.current, target.hp.current); assert.equal(out.state.choices.length, 1); assert.ok(out.events.some(event => event.type === 'ai-dice-needed'));
  const next = createAiExchange(out.state, 'turn_context', f.ctx); assert.equal((next.packet.payload.pendingDice as any[])[0].optionId, 'decline');
  const supplement = reply(next.packet, { decisionId: 'supplement', steps: [{ id: 'resolve', type: 'command', rollId: 'damage', command: { type: 'choice.resolve', payload: { choiceId: choice.id, optionId: 'decline' } } }], aiRolls: [{ id: 'damage', expression: '1d6', rolls: [4], total: 4 }] });
  const changedChoice = structuredClone(supplement); (changedChoice.payload.steps as any[])[0].command.payload.optionId = 'cast'; assert.equal(previewAiPacket(next.state, changedChoice, f.ctx).valid, false);
  out = applyAiPacket(next.state, supplement, f.ctx); assert.equal(out.state.choices.length, 0); assert.equal(out.state.actors[1].hp.current, target.hp.current - 4); out = resumeAiDecisions(out.state, f.ctx); assert.deepEqual(applyAiPacket(out.state, packet, f.ctx).events, []); assert.equal(f.rolled, 0);
});
function planned(source: 'program' | 'ai', shield = false) {
  const f = fixture(source), { attacker, target } = actors(f.state, shield); f.state.world!.phase = 'setup';
  let operation = 0; const call = (state: GameState, type: string, payload: Record<string, unknown>, member: Member = owner) => resolveWorldCommand(state, { operationId: 'proof:' + ++operation, expectedRev: 0, type, payload }, member, f.ctx).state;
  let state = call(f.state, 'world.configure', { rules: { ...f.state.world!.rules, energy: { maximum: 10, initial: 10, perRound: 10, recoveryMode: 'round', recovery: 1 }, costs: { action: 3, move: 1 } } });
  state = call(state, 'world.start', {});
  state = call(state, 'intent.save', { intent: { actorId: attacker.id, type: 'action', targetIds: [target.id], payload: { actionId: 'custom:attack' } } });
  state = call(state, 'intent.save', { intent: { actorId: target.id, type: 'move', payload: { path: [{ x: 2, y: 0 }] } } }, player);
  state = call(state, 'turn.end', {}); state = call(state, 'turn.end', {}, player);
  return { ...f, state, attacker, target, call, attackId: state.world!.round.intents[0].id, moveId: state.world!.round.intents[1].id };
}
for (const source of ['program', 'ai'] as const) test(`${source} intent decisions execute actual attack and movement, spend AP/MP once, finish and start the next round`, () => {
  const f = planned(source), exported = createAiExchange(f.state, 'turn_context', f.ctx);
  const packet = reply(exported.packet, { decisionId: 'intent-round', completeRound: true, steps: [{ id: 'attack-intent', type: 'intent', intentId: f.attackId, approve: true, ...(source === 'ai' ? { rollId: 'attack-dice' } : {}) }, { id: 'move-intent', type: 'intent', intentId: f.moveId, approve: true }], ...(source === 'ai' ? { aiRolls: [{ id: 'attack-dice', expression: '1d20+1d6', rolls: [10, 4], total: 14 }] } : {}) });
  const out = applyAiPacket(exported.state, packet, f.ctx); assert.equal(out.state.world!.round.phase, 'intermission');
  assert.deepEqual(out.state.world!.round.intents.map(intent => intent.status), ['executed', 'executed']);
  assert.equal(out.state.actors[0].resources.find(resource => resource.id === 'ap')!.current, 7); assert.equal(out.state.actors[0].resources.find(resource => resource.id === 'mp')!.current, 8);
  assert.equal(out.state.actors[1].resources.find(resource => resource.id === 'ap')!.current, 9); assert.equal(out.state.actors[1].position.x, 2); assert.equal(out.state.actors[1].hp.current, source === 'ai' ? 6 : 9);
  assert.deepEqual(applyAiPacket(out.state, packet, f.ctx).events, []);
  const next = f.call(out.state, 'round.start', {}); assert.equal(next.world!.round.number, 2); assert.equal(next.world!.round.phase, 'planning'); assert.equal(next.world!.round.intents.length, 0);
  assert.equal(next.actors[0].resources.find(resource => resource.id === 'mp')!.current, 8); assert.equal(next.actors[0].resources.find(resource => resource.id === 'ap')!.current, 8);
});
test('AI intent reaction survives restart and defers all later intents and round completion without repeated resource costs', () => {
  const f = planned('ai', true), exported = createAiExchange(f.state, 'turn_context', f.ctx), packet = reply(exported.packet, { decisionId: 'intent-shield', completeRound: true, steps: [{ id: 'attack-intent', type: 'intent', intentId: f.attackId, approve: true, rollId: 'hit' }, { id: 'move-intent', type: 'intent', intentId: f.moveId, approve: true }], aiRolls: [{ id: 'hit', expression: '1d20', rolls: [10], total: 10 }] });
  let out = applyAiPacket(exported.state, packet, f.ctx); assert.equal(out.state.world!.round.intents[0].status, 'executed'); assert.equal(out.state.world!.round.intents[1].status, 'planned'); assert.equal(out.state.world!.round.phase, 'planning');
  const choice = out.state.choices[0]; out = resolveAiReaction(JSON.parse(JSON.stringify(out.state)), { operationId: 'player-shield', expectedRev: 0, type: 'choice.resolve', payload: { choiceId: choice.id, optionId: 'cast' } }, f.ctx.dice, f.raw);
  out = resumeAiDecisions(out.state, f.ctx); assert.equal(out.state.choices.length, 0); assert.equal(out.state.world!.round.phase, 'intermission'); assert.equal(out.state.actors[1].position.x, 2);
  assert.equal(out.state.actors[0].resources.find(resource => resource.id === 'ap')!.current, 7); assert.equal(out.state.actors[0].resources.find(resource => resource.id === 'mp')!.current, 8); assert.equal(out.state.actors[1].resources.find(resource => resource.id === 'slot-1')!.current, 1);
  assert.deepEqual(applyAiPacket(out.state, packet, f.ctx).events, []);
});
test('turn export waits for online frozen participants; rejected and incomplete decisions cannot silently spend or finish', () => {
  const f = planned('ai'); f.state.world!.round.ended = [owner.id]; assert.throws(() => createAiExchange(f.state, 'turn_context', f.ctx), /online round participants/);
  const exported = createAiExchange(f.state, 'turn_context', { ...f.ctx, onlineMemberIds: [owner.id] }); assert.ok(exported.packet);
  f.state.world!.round.ended.push(player.id); const ready = createAiExchange(f.state, 'turn_context', f.ctx), before = structuredClone(ready.state);
  const incomplete = reply(ready.packet, { decisionId: 'incomplete', completeRound: true, steps: [{ id: 'decline', type: 'intent', intentId: f.attackId, approve: false }] });
  assert.throws(() => applyAiPacket(ready.state, incomplete, f.ctx), /explicit decision/); assert.deepEqual(ready.state, before);
  const reject = reply(ready.packet, { decisionId: 'reject-all', steps: [{ id: 'decline', type: 'intent', intentId: f.attackId, approve: false }, { id: 'decline-move', type: 'intent', intentId: f.moveId, approve: false }] });
  const out = applyAiPacket(ready.state, reject, f.ctx); assert.equal(out.state.world!.round.phase, 'intermission'); assert.equal(out.state.actors[0].resources.find(resource => resource.id === 'ap')!.current, 10); assert.equal(out.state.actors[0].resources.find(resource => resource.id === 'mp')!.current, 10);
});
test('runtime AI increments spawn mapped NPCs, grant existing items and individual knowledge, and apply explicit free stats and experience once', () => {
  const f = fixture(), { target } = actors(f.state); f.state.world!.items = [{ id: 'crystal', name: 'Crystal', description: '' }]; f.state.world!.rules.growth = { kind: 'tracks', tracks: [{ id: 'adventure', name: 'Adventure', curve: [10, 20], pointsPerLevel: 2, upgrades: [{ target: 'str', cost: 1, amount: 1 }] }] };
  const exported = createAiExchange(f.state, 'turn_context', f.ctx), packet = reply(exported.packet, { decisionId: 'increments', steps: [
    { id: 'spawn', type: 'command', command: { type: 'actor.create', payload: { id: 'new-npc', name: 'New NPC', customActions: [action({ costs: [] })], position: { x: 2, y: 0 } } } },
    { id: 'npc-attack', type: 'command', command: { type: 'action.use', actorId: 'new-npc', targetIds: [target.id], payload: { actionId: 'custom:attack' } } },
    { id: 'reward', type: 'command', command: { type: 'inventory.add', actorId: target.id, payload: { contentId: 'world:crystal', quantity: 3 } } },
    { id: 'unlock', type: 'command', command: { type: 'knowledge.unlock', actorId: target.id, payload: { entryId: 'spell:fireball' } } },
    { id: 'stats', type: 'ruling', command: { type: 'character.patch', actorId: target.id, payload: { patch: { abilities: { str: 35 }, manual: { maxHp: 40, ac: 18 }, hp: { current: 25 } } } } },
    { id: 'xp', type: 'ruling', command: { type: 'growth.award', actorId: target.id, payload: { awards: [{ trackId: 'adventure', amount: 15 }] } } },
  ], narratives: [{ text: 'The newcomer arrives.', actorIds: ['new-npc'] }] });
  const preview = previewAiPacket(exported.state, packet, f.ctx); assert.equal(preview.valid, true, preview.errors.join('\n')); assert.ok(preview.summary.some(line => line.includes('maxHp') && line.includes('40')));
  const out = applyAiPacket(exported.state, packet, f.ctx), npc = out.state.actors.find(actor => actor.name === 'New NPC')!, hero = out.state.actors.find(actor => actor.id === target.id)!;
  assert.notEqual(npc.id, 'new-npc'); assert.equal(npc.kind, 'monster'); assert.equal(npc.ownerId, owner.id); assert.equal(npc.registration, 'registered');
  assert.equal(hero.hp.max, 40); assert.equal(hero.hp.current, 25); assert.equal(hero.abilities.str, 35); assert.equal(hero.inventory.find(item => item.contentId === 'world:crystal')!.quantity, 3); assert.ok(hero.knownEntries!.includes('spell:fireball')); assert.deepEqual(hero.growth!.tracks.adventure, { level: 2, xp: 5, totalXp: 15, points: 2 });
  assert.equal(out.state.world!.ai.narratives[0].actorIds![0], npc.id); assert.deepEqual(applyAiPacket(out.state, packet, f.ctx).events, []);
});
test('external game-effect whitelist rejects unknown payloads, AP tampering, seats, bad experience and democratic direct overrides atomically', () => {
  const f = fixture(), { target } = actors(f.state), exported = createAiExchange(f.state, 'turn_context', f.ctx), before = structuredClone(exported.state);
  for (const command of [
    { type: 'gm.adjust', actorId: target.id, payload: { maxHp: 100 } },
    { type: 'actor.create', payload: { name: 'Forbidden', kind: 'hero' } },
    { type: 'actor.create', payload: { name: 'Forbidden', ownerId: player.id } },
    { type: 'character.patch', actorId: target.id, payload: { patch: { ownerId: owner.id } } },
    { type: 'character.patch', actorId: target.id, payload: { patch: { resources: [{ id: 'ap', name: 'AP', current: 100, max: 100, recovery: 'manual' }] } } },
    { type: 'growth.award', actorId: target.id, payload: { awards: [{ trackId: 'missing', amount: 10 }] } },
    { type: 'inventory.add', actorId: target.id, payload: { contentId: 'world:missing', quantity: 1 } },
  ]) { const packet = reply(exported.packet, { decisionId: 'bad', steps: [{ id: 'bad', type: 'command', command }] }); assert.equal(previewAiPacket(exported.state, packet, f.ctx).valid, false); assert.throws(() => applyAiPacket(exported.state, packet, f.ctx)); assert.deepEqual(exported.state, before); }
  const democratic = structuredClone(f.state); democratic.world!.mode = 'co-create';
  assert.throws(() => resolveAiGameCommand(democratic, { operationId: 'forbidden', expectedRev: 0, type: 'character.patch', actorId: target.id, payload: { patch: { manual: { maxHp: 100 } } } }, f.ctx), /Democratic/);
});
test('AI world rulings update strict catalog and rules with current references while ownership and governance stay outside the packet', () => {
  const f = fixture(), { target } = actors(f.state), exported = createAiExchange(f.state, 'turn_context', f.ctx), packet = reply(exported.packet, { decisionId: 'world-update', steps: [
    { id: 'spawn-merchant', type: 'command', command: { type: 'actor.create', payload: { id: 'merchant', name: 'Merchant' } } },
    { id: 'new-chapter', type: 'ruling', command: { type: 'world.configure', payload: { lore: '第二章', secretLore: '秘密路线', items: [{ id: 'map', name: 'Map', description: 'A map', bonuses: { wis: 1 } }], npcBehaviors: [{ actorId: 'merchant', kind: 'idle' }] } } },
    { id: 'give-map', type: 'command', command: { type: 'inventory.add', actorId: target.id, payload: { contentId: 'world:map', quantity: 1 } } },
  ] });
  const preview = previewAiPacket(exported.state, packet, f.ctx); assert.equal(preview.valid, true, preview.errors.join('\n'));
  const out = applyAiPacket(exported.state, packet, f.ctx); assert.equal(out.state.world!.lore, '第二章'); assert.equal(out.state.world!.secretLore, '秘密路线'); assert.equal(out.state.world!.ownerId, owner.id);
  assert.equal(out.state.world!.npcBehaviors[0].actorId, out.state.actors.find(actor => actor.name === 'Merchant')!.id); assert.equal(out.state.actors[1].inventory[0].contentId, 'world:map');
  for (const payload of [{ ownerId: player.id }, { mode: 'co-create' }, { rules: { ...f.state.world!.rules, grants: {} } }, { items: [{ id: 'x', name: 'X', description: '', ownerId: player.id }] }, { rules: { ...f.state.world!.rules, energy: { maximum: 10, perRound: 10, recoveryMode: 'round', recovery: 1, bypass: true } } }]) assert.equal(previewAiPacket(exported.state, reply(exported.packet, { decisionId: 'bad-config', steps: [{ id: 'rule', type: 'ruling', command: { type: 'world.configure', payload } }] }), f.ctx).valid, false);
  const next = createAiExchange(out.state, 'turn_context', f.ctx), replay = reply(next.packet, { decisionId: 'world-update', narratives: [{ text: 'Reusing a decision ID in a new envelope' }] }); assert.equal(previewAiPacket(next.state, replay, f.ctx).valid, false);
});
test('AP worlds require hero intents and run explicit NPC commands through trusted intents with one AP/MP charge and the round cap', () => {
  const f = planned('ai'); f.state.world!.rules.energy!.perRound = 3;
  const exported = createAiExchange(f.state, 'turn_context', f.ctx), forbidden = reply(exported.packet, { decisionId: 'bypass', steps: [attackStep(f.attacker, f.target)] });
  assert.equal(previewAiPacket(exported.state, forbidden, f.ctx).valid, false); assert.throws(() => applyAiPacket(exported.state, forbidden, f.ctx), /submitted intent/);
  const npcAction = action({ range: 30, costs: [{ resourceId: 'ap', amount: 2 }, { resourceId: 'mp', amount: 2 }] });
  const packet = reply(exported.packet, { decisionId: 'npc-turn', completeRound: false, steps: [
    { id: 'new-npc', type: 'command', command: { type: 'actor.create', payload: { id: 'enemy', name: 'Explicit enemy', position: { x: 3, y: 0 }, resources: [{ id: 'mp', name: 'MP', current: 5, max: 5, recovery: 'manual' }], customActions: [npcAction] } } },
    { id: 'npc-act', type: 'command', rollId: 'npc-dice', command: { type: 'action.use', actorId: 'enemy', targetIds: [f.target.id], payload: { actionId: npcAction.id } } },
  ], aiRolls: [{ id: 'npc-dice', expression: '1d20+1d6', rolls: [10, 4], total: 14 }] });
  const out = applyAiPacket(exported.state, packet, f.ctx), npc = out.state.actors.find(actor => actor.name === 'Explicit enemy')!;
  assert.equal(npc.resources.find(resource => resource.id === 'ap')!.current, 8); assert.equal(npc.resources.find(resource => resource.id === 'mp')!.current, 3); assert.equal(out.state.world!.round.spent[npc.id], 2); assert.equal(out.state.actors[1].hp.current, 6);
  assert.equal(out.state.world!.round.intents.at(-1)!.status, 'executed'); assert.deepEqual(applyAiPacket(out.state, packet, f.ctx).events, []);
  const next = createAiExchange(out.state, 'turn_context', f.ctx), before = structuredClone(next.state), second = reply(next.packet, { decisionId: 'npc-over-budget', completeRound: false, steps: [{ ...attackStep(npc, f.target, 'too-many'), id: 'second-act' }], aiRolls: [{ id: 'too-many', expression: '1d20+1d6', rolls: [10, 4], total: 14 }] });
  assert.throws(() => applyAiPacket(next.state, second, f.ctx), /支出额度不足/); assert.deepEqual(next.state, before);
});
