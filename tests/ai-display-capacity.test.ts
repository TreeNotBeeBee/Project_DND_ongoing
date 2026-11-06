import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState } from '../src/engine/index.ts';
import { newWorld } from '../src/shared/world.ts';
import { newAiDisplay, applyAiDisplayPacket, createAiModuleTemplate, exportAiDisplay, previewAiDisplay, validateAiDisplayState, dispatchAiDisplayCommand, assertDisplayCapacity } from '../src/ai/display.ts';
const owner = { id: 'owner', role: 'gm' as const, name: 'Owner' }, ctx = { member: owner, members: [owner], now: 1000 };
function initial(length: number) {
  const state = createGameState('Capacity'); state.world = newWorld(owner.id, 'ai'); state.world.ai.display = newAiDisplay();
  const e = exportAiDisplay(state, 'initialize', ctx), initialization = createAiModuleTemplate('B');
  initialization.pcs[0].fields = Object.fromEntries(['one', 'two', 'three'].map(key => [key, { source: 'module' as const, value: 'x'.repeat(length) }]));
  const packet = { protocol: 'jigerpg-ai', version: 2, packetType: 'initialize', campaignId: state.id, exchangeId: e.packet.exchangeId, displayRevision: e.packet.displayRevision, payload: { decisionId: 'init', initialization } };
  return { ...e, packet };
}
test('a legal roughly 3 MB initialization input is rejected when persistent entity/module/receipt expansion exceeds backup capacity', () => {
  const f = initial(999_000), before = structuredClone(f.state); assert.ok(JSON.stringify(f.packet).length < 3_100_000);
  const preview = previewAiDisplay(f.state, f.packet, ctx); assert.equal(preview.valid, false); assert.ok(preview.errors[0].includes('技术容量'));
  assert.throws(() => applyAiDisplayPacket(f.state, f.packet, ctx), /技术容量/); assert.deepEqual(f.state, before);
});
test('accepted normal display states remain backup-valid after exchange and cosmetic mutation, and oversized drafts fail atomically', () => {
  const f = initial(450_000), accepted = applyAiDisplayPacket(f.state, f.packet, ctx).state; assert.doesNotThrow(() => validateAiDisplayState(accepted.world!.ai.display));
  const e = exportAiDisplay(accepted, 'turn_context', ctx); assert.doesNotThrow(() => validateAiDisplayState(e.state.world!.ai.display));
  const before = structuredClone(e.state); assert.throws(() => dispatchAiDisplayCommand(e.state, { type: 'ai.display.draft.save', payload: { raw: 'y'.repeat(4_000_000) }, expectedRev: 0, operationId: 'large-draft' }, ctx), /技术容量/); assert.deepEqual(e.state, before);
  const saved = dispatchAiDisplayCommand(e.state, { type: 'ai.display.draft.save', payload: { raw: 'small incomplete {' }, expectedRev: 0, operationId: 'small-draft' }, ctx).state; assert.doesNotThrow(() => validateAiDisplayState(saved.world!.ai.display));
});
test('capacity checks use the same persistent node/depth budget without clamping game numbers', () => {
  const d = newAiDisplay(); d.draft = { raw: 'ordinary', updatedAt: 1 }; assert.doesNotThrow(() => assertDisplayCapacity(d));
  (d as any).extra = Array.from({ length: 200_001 }, () => null); assert.throws(() => assertDisplayCapacity(d), /技术容量/);
});
test('creating a new exchange cannot push a previously restorable display beyond its persistent JSON budget', () => {
  const f = initial(450_000), accepted = applyAiDisplayPacket(f.state, f.packet, ctx).state, d = accepted.world!.ai.display!;
  d.draft = { raw: '', updatedAt: 1 }; const padding = 7_999_999 - JSON.stringify(d).length; assert.ok(padding > 0 && padding < 4_000_000); d.draft.raw = 'z'.repeat(padding);
  assert.equal(JSON.stringify(d).length, 7_999_999); assert.doesNotThrow(() => validateAiDisplayState(d)); const count = d.exchanges.length;
  assert.throws(() => exportAiDisplay(accepted, 'turn_context', ctx), /技术容量/); assert.equal(d.exchanges.length, count); assert.equal(JSON.stringify(d).length, 7_999_999);
});
