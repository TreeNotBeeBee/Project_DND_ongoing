import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as engine from '../src/engine/index.ts';
import { newWorld } from '../src/shared/world.ts';
import { resolveWorldCommand } from '../src/world/index.ts';
import { AI_REPLY_JSON_SCHEMA, parseAiReply, createAiExchange, applyAiPacket, previewAiPacket, type AiContext } from '../src/ai/protocol.ts';
import type { GameState } from '../src/shared/model.ts';
const owner = { id: 'owner', role: 'gm' as const, name: 'Owner' };
const examples = new URL('../examples/ai/', import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(name, examples), 'utf8'));
function fixture(source: 'program' | 'ai' = 'program') {
  const state = engine.createGameState('Executable documentation'); state.world = newWorld(owner.id, 'ai'); state.world.ai.diceSource = source;
  const ctx: AiContext = { now: 1000, member: owner, members: [owner], onlineMemberIds: [owner.id], dice: side => side === 20 ? 12 : 4, engine, resolveWorldCommand, resolveEngine: (s, c, d) => engine.resolveCommand(s, c, d, { economy: 'world', skipResources: ['ap'] }) };
  const exported = createAiExchange(state, 'initialize', ctx), packet = { ...load('initialize.json'), campaignId: state.id, exchangeId: exported.packet.exchangeId, worldRevision: exported.packet.worldRevision };
  const initialized = applyAiPacket(exported.state, packet, ctx).state;
  return { state: initialized, ctx };
}
test('published AI schema exactly matches runtime and every downloadable example parses with its real strict schema', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../reference/ai-reply.schema.json', import.meta.url), 'utf8')), AI_REPLY_JSON_SCHEMA);
  const files = readdirSync(examples).filter(file => file.endsWith('.json')); assert.ok(files.length >= 6);
  for (const file of files) assert.doesNotThrow(() => parseAiReply(load(file)), file);
  const wrong = load('runtime-rulings.json'); wrong.payload.steps[0].command.payload.ownerId = 'stolen'; assert.throws(() => parseAiReply(wrong));
});
test('published initialization actually creates a free offer, current rule catalog and mapped NPC without random fallback', () => {
  const f = fixture(), hero = f.state.actors.find(actor => actor.kind === 'hero')!, guide = f.state.actors.find(actor => actor.name === '向导')!;
  assert.equal(hero.profile, 'free'); assert.equal(hero.ownerId, owner.id); assert.equal(hero.registration, 'available'); assert.equal(hero.hidden, true); assert.equal(hero.manual!.maxHp, 20); assert.equal(hero.classes.length, 0); assert.equal(hero.skills.length, 0);
  assert.equal(hero.customActions![0].damage![0].addAbility, 'int'); assert.equal(f.state.world!.npcBehaviors[0].actorId, guide.id); assert.equal(f.state.world!.nodes[0].inventory[0].itemId, 'crystal');
});
for (const source of ['program', 'ai'] as const) test(`published ${source} turn decision executes its intent against actual initialized custom action`, () => {
  const f = fixture(source), hero = f.state.actors.find(actor => actor.kind === 'hero')!; hero.registration = 'registered'; hero.hidden = false;
  const target = engine.createActor({ name: 'Target', ownerId: owner.id, profile: 'free', kind: 'monster', registration: 'registered', manual: { maxHp: 30, ac: 10, speed: 30, proficiency: 0 }, position: { x: 1, y: 0 } }); f.state.actors.push(target);
  let index = 0; const call = (state: GameState, type: string, payload: Record<string, unknown>) => resolveWorldCommand(state, { type, payload, expectedRev: 0, operationId: 'docs:' + ++index }, owner, f.ctx).state;
  let state = call(f.state, 'world.start', {});
  state = call(state, 'intent.save', { intent: { actorId: hero.id, type: 'action', targetIds: [target.id], payload: { actionId: 'custom:ember' } } }); state = call(state, 'turn.end', {});
  const exported = createAiExchange(state, 'turn_context', f.ctx), packet = load(source === 'ai' ? 'ai-decision.json' : 'program-decision.json');
  Object.assign(packet, { campaignId: state.id, exchangeId: exported.packet.exchangeId, worldRevision: exported.packet.worldRevision }); packet.payload.steps[0].intentId = state.world!.round.intents[0].id; packet.payload.narratives[0].actorIds = [hero.id];
  const preview = previewAiPacket(exported.state, packet, f.ctx); assert.equal(preview.valid, true, preview.errors.join('\n'));
  const out = applyAiPacket(exported.state, packet, f.ctx); assert.equal(out.state.world!.round.phase, 'intermission'); assert.equal(out.state.actors.find(actor => actor.id === target.id)!.hp.current, 23);
  const after = out.state.actors.find(actor => actor.id === hero.id)!; assert.equal(after.resources.find(resource => resource.id === 'mp')!.current, 8); assert.equal(after.resources.find(resource => resource.id === 'ap')!.current, 8);
});
test('published runtime rulings grant actual catalog rewards, growth and manual stats to a registered free hero', () => {
  const f = fixture(), hero = f.state.actors.find(actor => actor.kind === 'hero')!; hero.registration = 'registered'; f.state.world!.phase = 'running';
  const exported = createAiExchange(f.state, 'turn_context', f.ctx), packet = load('runtime-rulings.json');
  Object.assign(packet, { campaignId: f.state.id, exchangeId: exported.packet.exchangeId, worldRevision: exported.packet.worldRevision });
  for (const step of packet.payload.steps) if (step.command.actorId === 'hero-id') step.command.actorId = hero.id; packet.payload.narratives[0].actorIds[0] = hero.id;
  const out = applyAiPacket(exported.state, packet, f.ctx), after = out.state.actors.find(actor => actor.id === hero.id)!;
  assert.equal(after.hp.max, 22); assert.equal(after.hp.current, 20); assert.equal(after.growth!.tracks.adventure.level, 2); assert.equal(after.growth!.tracks.adventure.points, 2); assert.equal(after.inventory[0].contentId, 'world:crystal'); assert.ok(after.knownEntries!.includes('world:crystal'));
});
