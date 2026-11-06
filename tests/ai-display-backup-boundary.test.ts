import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGameState } from '../src/engine/index.ts';
import { newWorld } from '../src/shared/world.ts';
import { newAiDisplay, applyAiDisplayPacket, exportAiDisplay, projectAiDisplay, validateAiDisplayState } from '../src/ai/display.ts';
const owner = { id: 'owner', role: 'gm' as const, name: 'Owner' }, player = { id: 'player', role: 'player' as const, name: 'Player' };
function state() {
  const s = createGameState('Backup boundary'); s.world = newWorld(owner.id, 'ai'); s.world.ai.display = newAiDisplay('B');
  const ctx = { member: owner, members: [owner, player], now: 1000 }, e = exportAiDisplay(s, 'initialize', ctx), packet = JSON.parse(readFileSync(new URL('../examples/ai-v2/initialize-B.json', import.meta.url), 'utf8'));
  Object.assign(packet, { campaignId: s.id, exchangeId: e.packet.exchangeId, displayRevision: e.packet.displayRevision }); return applyAiDisplayPacket(e.state, packet, ctx).state;
}
test('backup validation strictly rejects unknown setting/opening properties instead of skipping them during canonical reconstruction', () => {
  for (const group of ['setting', 'opening'] as const) {
    const s = state(); (s.world!.ai.display!.initialization![group] as any).privateRaw = { visibility: 'gm', text: 'RESTORE_SECRET_SENTINEL' };
    assert.throws(() => validateAiDisplayState(s.world!.ai.display), /privateRaw/, group);
  }
});
test('projection whitelists module sections and never forwards unknown private raw source properties', () => {
  const s = state(); (s.world!.ai.display!.initialization!.setting as any).privateRaw = { visibility: 'gm', text: 'SETTING_PRIVATE_RAW_SENTINEL' }; (s.world!.ai.display!.initialization!.opening as any).privateRaw = 'OPENING_PRIVATE_RAW_SENTINEL';
  const shown = JSON.stringify(projectAiDisplay(s, player)); assert.ok(!shown.includes('SETTING_PRIVATE_RAW_SENTINEL')); assert.ok(!shown.includes('OPENING_PRIVATE_RAW_SENTINEL'));
});
test('only server field.pending is a typed flag while nested gameplay JSON keys named pending are preserved verbatim', () => {
  const s = state(), d = s.world!.ai.display!; d.initialization!.background.fields.data = { source: 'module', value: { pending: { description: 'A legitimate JSON property', count: -50 } }, pending: true };
  assert.deepEqual(validateAiDisplayState(d).initialization!.background.fields.data, d.initialization!.background.fields.data);
  (d.initialization!.background.fields.data as any).pending = 'not-a-boolean'; assert.throws(() => validateAiDisplayState(d));
});
