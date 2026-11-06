import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/engine/index.ts';
import type { Actor, Dice, GameState, Member } from '../src/shared/model.ts';
import { newWorld, type WorldMode } from '../src/shared/world.ts';
import { resolveWorldCommand } from '../src/world/index.ts';
import { createAiExchange, applyAiPacket, resolveAiReaction, resumeAiDecisions, resolveAiGameCommand, type AiContext } from '../src/ai/protocol.ts';
const owner: Member = { id: 'owner', name: 'Owner', role: 'gm' }, player: Member = { id: 'player', name: 'Player', role: 'player' };
function fixture(mode: WorldMode = 'co-create', card?: Actor) {
  let state = engine.createGameState('Native world intents'); state.world = newWorld(owner.id, mode); let sequence = 0, diceCalls = 0;
  const a = card || engine.createActor({ name: 'Free hero', profile: 'free', ownerId: player.id, registration: 'registered', manual: { maxHp: 20, ac: 10, speed: 30, proficiency: 0 }, resources: [{ id: 'mp', name: 'MP', current: 3, max: 10, recovery: 'long' }, { id: 'stamina', name: 'Stamina', current: 2, max: 10, recovery: 'short' }] }); state.actors = [a]; a.hp.current = 1;
  const raw: AiContext['resolveEngine'] = (s, c, d) => engine.resolveCommand(s, c, d, { economy: 'world', skipResources: ['ap'] });
  const ctx: AiContext = { now: 1000, member: owner, members: [owner, player], onlineMemberIds: [player.id], engine, resolveWorldCommand, dice: () => { diceCalls++; return 2; }, resolveEngine: (s, c, d) => resolveAiReaction(s, c, d, raw) };
  const run = (type: string, payload: Record<string, unknown> = {}, member = owner) => { const before = structuredClone(state), out = resolveWorldCommand(state, { type, payload, operationId: 'native:' + ++sequence, expectedRev: state.rev }, member, ctx); assert.deepEqual(state, before); state = out.state; return out; };
  run('world.configure', { rules: { ...state.world!.rules, energy: { maximum: 10, initial: 10, perRound: 10, recoveryMode: 'round', recovery: 0 }, costs: { action: 2 } } }); run('world.start');
  return { get state() { return state; }, set state(value: GameState) { state = value; }, get actor() { return state.actors.find(actor => actor.id === a.id)!; }, get diceCalls() { return diceCalls; }, ctx, raw, run,
    plan(payload: Record<string, unknown>, targetIds: string[] = []) { return run('intent.save', { intent: { actorId: a.id, type: 'action', payload, targetIds } }, player); }, end() { return run('turn.end', {}, player); } };
}
function decision(state: GameState, ctx: AiContext, roll?: { expression: string; rolls: number[]; total: number }) {
  const exported = createAiExchange(state, 'turn_context', ctx), packet = { ...exported.packet, packetType: 'decision', payload: { decisionId: 'native-ai-turn', completeRound: true, steps: [{ id: 'perform-native', type: 'intent', intentId: state.world!.round.intents[0].id, approve: true, ...(roll ? { rollId: 'native-dice' } : {}) }], ...(roll ? { aiRolls: [{ id: 'native-dice', ...roll }] } : {}) } };
  return { ...exported, packet };
}
test('short and long rests use native recovery once and preserve manual maxima and manually governed AP', () => {
  const f = fixture(); f.plan({ commandType: 'actor.rest', kind: 'short' }); assert.equal(f.diceCalls, 0); f.end(); f.run('round.settle');
  assert.equal(f.actor.resources.find(r => r.id === 'stamina')!.current, 10); assert.equal(f.actor.resources.find(r => r.id === 'mp')!.current, 3); assert.equal(f.actor.resources.find(r => r.id === 'ap')!.current, 8); assert.equal(f.actor.hp.current, 1);
  const settled = structuredClone(f.state); assert.throws(() => f.run('round.settle')); assert.deepEqual(f.state, settled);
  f.run('round.start'); f.plan({ commandType: 'actor.rest', kind: 'long' }); f.end(); f.run('round.settle');
  assert.equal(f.actor.resources.find(r => r.id === 'mp')!.current, 10); assert.equal(f.actor.resources.find(r => r.id === 'ap')!.current, 6); assert.equal(f.actor.hp.current, 20); assert.equal(f.actor.manual!.maxHp, 20);
});
test('native hit dice are verified and reserved before planning without spending real dice or admitting duplicate use', () => {
  const card = engine.createActor({ name: 'Fighter', ownerId: player.id, registration: 'registered', draft: false, speciesId: 'human', backgroundId: 'soldier', classes: [{ classId: 'fighter', level: 1 }], abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 10 } });
  const f = fixture('co-create', card); f.plan({ commandType: 'actor.rest', kind: 'short', hitDice: { fighter: 1 } }); assert.equal(f.diceCalls, 0);
  const before = structuredClone(f.state); assert.throws(() => f.plan({ commandType: 'actor.rest', kind: 'short', hitDice: { fighter: 1 } }), /Not enough/); assert.deepEqual(f.state, before);
  for (const payload of [{ commandType: 'actor.rest', kind: 'long', hitDice: { fighter: 1 } }, { commandType: 'actor.rest', kind: 'short', hitDice: { fighter: -1 } }, { commandType: 'actor.rest', kind: 'short', ownerId: owner.id }]) assert.throws(() => f.plan(payload));
  f.end(); f.run('round.settle'); assert.equal(f.diceCalls, 1); assert.equal(f.actor.hp.current, 5); assert.equal(f.actor.resources.find(r => r.id === 'hit-dice-fighter')!.current, 0); assert.equal(f.actor.resources.find(r => r.id === 'ap')!.current, 8);
});
test('one potion is reserved and consumed once with native healing, while invalid ownership/options and repeat use stay atomic', () => {
  const f = fixture(); f.actor.inventory.push({ id: 'potion', name: 'Potion', contentId: 'equipment:potion-of-healing', quantity: 1, equipped: false });
  const before = structuredClone(f.state);
  for (const payload of [{ commandType: 'inventory.consume', itemId: 'not-owned' }, { commandType: 'inventory.consume', itemId: 'potion', quantity: 100 }, { commandType: 'inventory.consume', itemId: 'potion', options: { _itemCast: true } }]) { assert.throws(() => f.plan(payload)); assert.deepEqual(f.state, before); }
  f.plan({ commandType: 'inventory.consume', itemId: 'potion' }); assert.equal(f.diceCalls, 0); const reserved = structuredClone(f.state); assert.throws(() => f.plan({ commandType: 'inventory.consume', itemId: 'potion' })); assert.deepEqual(f.state, reserved);
  f.end(); f.run('round.settle'); assert.equal(f.actor.hp.current, 7); assert.equal(f.actor.inventory[0].quantity, 0); assert.equal(f.actor.resources.find(r => r.id === 'ap')!.current, 8); assert.equal(f.diceCalls, 2);
  const settled = structuredClone(f.state); assert.throws(() => f.run('round.settle')); assert.deepEqual(f.state, settled);
});
test('AI native consumption and death-save intents use their actual AI dice and deduplicate without a program fallback', () => {
  const rest = fixture('ai'); rest.state.world!.ai.diceSource = 'ai'; rest.plan({ commandType: 'actor.rest', kind: 'short', hitDice: {} }); rest.end();
  const context = createAiExchange(rest.state, 'turn_context', rest.ctx); assert.equal((context.packet.payload.round as any).intents[0].payload.kind, 'short'); assert.deepEqual((context.packet.payload.round as any).intents[0].payload.hitDice, {});
  const r = decision(context.state, rest.ctx); const recovered = applyAiPacket(r.state, r.packet, rest.ctx); assert.equal(recovered.state.actors[0].resources.find(resource => resource.id === 'stamina')!.current, 10); assert.equal(recovered.state.actors[0].resources.find(resource => resource.id === 'ap')!.current, 8); assert.equal(rest.diceCalls, 0);
  const potion = fixture('ai'); potion.state.world!.ai.diceSource = 'ai'; potion.actor.inventory.push({ id: 'potion', name: 'Potion', contentId: 'equipment:potion-of-healing', quantity: 1, equipped: false }); potion.plan({ commandType: 'inventory.consume', itemId: 'potion' }); potion.end();
  const e = decision(potion.state, potion.ctx, { expression: '2d4', rolls: [2, 3], total: 5 }); assert.equal((e.packet.payload as any).steps[0].rollId, 'native-dice');
  let out = applyAiPacket(e.state, e.packet, potion.ctx); assert.equal(out.state.actors[0].hp.current, 8); assert.equal(out.state.actors[0].inventory[0].quantity, 0); assert.equal(out.state.actors[0].resources.find(r => r.id === 'ap')!.current, 8); assert.deepEqual(applyAiPacket(out.state, e.packet, potion.ctx).events, []); assert.equal(potion.diceCalls, 0);
  const dying = fixture('ai'); dying.state.world!.ai.diceSource = 'ai'; dying.actor.hp.current = 0; dying.plan({ commandType: 'actor.deathSave' }); const reserved = structuredClone(dying.state); assert.throws(() => dying.plan({ commandType: 'actor.deathSave' }), /一次死亡豁免/); assert.deepEqual(dying.state, reserved); dying.end();
  const d = decision(dying.state, dying.ctx, { expression: '1d20', rolls: [20], total: 20 }); out = applyAiPacket(d.state, d.packet, dying.ctx); assert.equal(out.state.actors[0].hp.current, 1); assert.equal(out.state.actors[0].resources.find(r => r.id === 'ap')!.current, 8); assert.equal(out.state.world!.round.phase, 'intermission'); assert.equal(dying.diceCalls, 0);
});
test('item-casting native intent preserves Shield pause through JSON restart without repeating AP or wand charges', () => {
  const f = fixture('ai'); f.state.world!.ai.diceSource = 'ai'; f.actor.inventory.push({ id: 'wand', contentId: 'magic-item:wand-of-magic-missiles', name: 'Wand', quantity: 1, equipped: true, charges: { current: 7, max: 7, recharge: 'dawn' } });
  const wizard = engine.createActor({ name: 'Wizard', ownerId: owner.id, registration: 'registered', draft: false, speciesId: 'human', backgroundId: 'soldier', classes: [{ classId: 'wizard', level: 1 }], abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 10, cha: 10 }, spells: ['spell:shield'], position: { x: 1, y: 0 } }); f.state.actors.push(wizard);
  f.plan({ commandType: 'inventory.consume', itemId: 'wand', options: { spellId: 'spell:magic-missile', rank: 1 } }, [wizard.id]); assert.equal(f.diceCalls, 0); f.end();
  const e = decision(f.state, f.ctx, { expression: '1d4', rolls: [2], total: 2 }); let out = applyAiPacket(e.state, e.packet, f.ctx); assert.equal(out.state.choices[0].kind, 'shield-reaction'); assert.equal(out.state.actors[0].inventory[0].charges!.current, 6); assert.equal(out.state.actors[0].resources.find(r => r.id === 'ap')!.current, 8);
  const choice = out.state.choices[0]; out = resolveAiReaction(JSON.parse(JSON.stringify(out.state)), { type: 'choice.resolve', payload: { choiceId: choice.id, optionId: 'cast' }, operationId: 'native-shield', expectedRev: 0 }, f.ctx.dice, f.raw); out = resumeAiDecisions(out.state, f.ctx);
  assert.equal(out.state.choices.length, 0); assert.equal(out.state.world!.round.phase, 'intermission'); assert.equal(out.state.actors[0].inventory[0].charges!.current, 6); assert.equal(out.state.actors[0].resources.find(r => r.id === 'ap')!.current, 8); assert.equal(out.state.actors[1].hp.current, wizard.hp.current); assert.equal(out.state.actors[1].resources.find(r => r.id === 'slot-1')!.current, 1); assert.equal(f.diceCalls, 0);
});
test('AI free manual max-HP ruling retains active effect bonuses without refilling current HP or mana', () => {
  const f = fixture('ai'); f.actor.effects.push({ id: 'aid', name: 'Aid', modifiers: { maxHp: 5 } }); f.actor.hp.max = engine.deriveActor(f.actor).maxHp;
  const out = resolveAiGameCommand(f.state, { type: 'character.patch', actorId: f.actor.id, payload: { patch: { manual: { maxHp: 30 } } }, expectedRev: 0, operationId: 'manual-hp' }, f.ctx);
  assert.equal(out.state.actors[0].manual!.maxHp, 30); assert.equal(out.state.actors[0].hp.max, 35); assert.equal(out.state.actors[0].hp.current, 1); assert.equal(out.state.actors[0].resources.find(r => r.id === 'mp')!.current, 3);
});
