import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createGameState } from '../src/engine/index.ts';
import { newWorld } from '../src/shared/world.ts';
import { AI_DISPLAY_REPLY_JSON_SCHEMA, newAiDisplay, parseAiDisplayReply, previewAiDisplay, exportAiDisplay, applyAiDisplayPacket, validateAiDisplayState, type AiFreedom, type AiDisplayContext } from '../src/ai/display.ts';
const examples = new URL('../examples/ai-v2/', import.meta.url), load = (name: string) => JSON.parse(readFileSync(new URL(name, examples), 'utf8'));
const member = { id: 'owner', name: 'Owner', role: 'gm' as const }, ctx: AiDisplayContext = { member, members: [member], now: 1000 };
test('published v2 JSON schema matches runtime and all sample replies parse without silently changing freedom or game values', () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL('../reference/ai-display-reply-v2.schema.json', import.meta.url), 'utf8')), AI_DISPLAY_REPLY_JSON_SCHEMA);
  const files = readdirSync(examples).filter(file => file.endsWith('.json')); assert.equal(files.length, 4);
  for (const file of files) { const raw = load(file), parsed = parseAiDisplayReply(raw); assert.deepEqual(parsed, raw, file); }
  const a = load('initialize-A.json'); assert.equal(a.payload.initialization.freedom, 'A'); assert.deepEqual(a.payload.initialization.pcs[0].fields.hp.value, { current: -3, max: 10 }); assert.deepEqual(a.payload.initialization.pcs[0].fields.resources.value, { mp: { current: 50, max: 5 } });
});
for (const freedom of ['A', 'B', 'C'] as AiFreedom[]) test(`published ${freedom} module initializes without Actor construction and stable update is display-only`, () => {
  const state = createGameState('Actual v2 example'); state.world = newWorld(member.id, 'ai'); state.world.ai.display = newAiDisplay(freedom);
  const exported = exportAiDisplay(state, 'initialize', ctx), packet = load(`initialize-${freedom}.json`); Object.assign(packet, { campaignId: state.id, exchangeId: exported.packet.exchangeId, displayRevision: exported.packet.displayRevision });
  const before = structuredClone(exported.state), preview = previewAiDisplay(exported.state, packet, ctx); assert.equal(preview.valid, true, preview.errors.join('\n')); assert.deepEqual(exported.state, before);
  const initialized = applyAiDisplayPacket(exported.state, packet, ctx).state, d = initialized.world!.ai.display!; assert.deepEqual(initialized.actors, []); assert.equal(d.freedom, freedom);
  if (freedom === 'A') { assert.equal(d.entities[0].fields.hp.value, null); assert.ok(d.pendingConfirmations.some(p => JSON.stringify(p.value) === JSON.stringify({ current: -3, max: 10 }))); } else { assert.equal(d.pendingConfirmations.length, 0); assert.deepEqual(d.entities[0].fields.hp.value, { current: -3, max: 10 }); }
  assert.doesNotThrow(() => validateAiDisplayState(d));
  const next = exportAiDisplay(initialized, 'turn_context', ctx), update = load('update.json'); Object.assign(update, { campaignId: initialized.id, exchangeId: next.packet.exchangeId, displayRevision: next.packet.displayRevision });
  const result = applyAiDisplayPacket(next.state, update, ctx); assert.ok(result.state.world!.ai.display!.entities.some(e => e.id === 'enemy-1')); assert.ok(!result.state.world!.ai.display!.narratives.some(n => n.id === 'opening-1')); assert.deepEqual(result.state.actors, []); assert.deepEqual(applyAiDisplayPacket(result.state, update, ctx).events, []);
});
