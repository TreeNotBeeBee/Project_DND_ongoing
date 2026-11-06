import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_REPLY_JSON_SCHEMA, parseAiReply } from '../src/ai/schema.ts';
const envelope = { protocol: 'jigerpg-ai', version: 1, campaignId: 'campaign', exchangeId: 'exchange', worldRevision: 0 };
test('AI replies have a fixed bounded envelope and stable decision IDs, never arbitrary state imports', () => {
  assert.equal(parseAiReply({ ...envelope, packetType: 'initialize', payload: { decisionId: 'init-1', characters: [{ name: 'Free card', profile: 'free' }] } }).packetType, 'initialize');
  for (const input of [{ ...envelope, packetType: 'decision', payload: {} }, { ...envelope, version: 2, packetType: 'decision', payload: { decisionId: 'v2' } }, { ...envelope, packetType: 'initialize', payload: { decisionId: 'owner', ownerId: 'attacker' } }, { ...envelope, packetType: 'initialize', payload: { decisionId: 'actor-owner', characters: [{ name: 'X', ownerId: 'attacker' }] } }, { ...envelope, packetType: 'decision', payload: { decisionId: 'restore', steps: [{ id: 'x', type: 'command', command: { type: 'restore', payload: {} } }] } }]) assert.throws(() => parseAiReply(input));
  assert.ok(JSON.stringify(AI_REPLY_JSON_SCHEMA).includes('jigerpg-ai'));
});
test('intent, external ruling and die requests are explicit separate step shapes', () => {
  const packet = parseAiReply({ ...envelope, packetType: 'decision', payload: { decisionId: 'turn-1', steps: [{ id: 'intent', type: 'intent', intentId: 'planned', approve: true }, { id: 'ruling', type: 'ruling', command: { type: 'gm.adjust', actorId: 'hero', payload: { hp: 7 } } }, { id: 'die', type: 'roll', expression: '1d20+3', rollId: 'r1' }] } });
  assert.equal(packet.payload.decisionId, 'turn-1');
  assert.throws(() => parseAiReply({ ...envelope, packetType: 'decision', payload: { decisionId: 'typo', steps: [{ id: 'bad', type: 'roll', expression: '1d20', force: 20 }] } }));
});
