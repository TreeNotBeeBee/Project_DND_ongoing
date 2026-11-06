import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Scene } from '../src/shared/model';
import type { TokenView } from '../src/shared/world';
import { lineOfSight, pathBetween, tokenCells, tokenCentre } from '../src/client/world-map-geometry';
import { equipmentPackageOptions } from '../src/shared/starting-equipment-options';
import { remainingActionPoints } from '../src/client/world-ui-budget';
const scene: Scene = { width: 8, height: 8, gridFeet: 5, walls: [], terrain: [], fog: false };
const token: TokenView = { id: 'unit', name: '虚构主角', kind: 'hero', ownerId: 'member', position: { x: 0, y: 0 }, size: 1, hidden: false, conditions: [] };
test('public token geometry needs no private actor or content and respects large footprints', () => {
  const large = { ...token, size: 2 }; assert.equal(tokenCells(large).length, 4); assert.deepEqual(tokenCentre(large), { x: .5, y: .5 });
  assert.deepEqual(pathBetween(large.position, { x: 7, y: 7 }, scene, [], { actor: large, actors: [large] }), []);
  const occupied = { ...token, id: 'other', position: { x: 2, y: 1 } };
  assert.deepEqual(pathBetween(large.position, { x: 1, y: 1 }, scene, [], { actor: large, actors: [large, occupied] }), []);
});
test('preview routes around walls and closed doors but opens the matching passage', () => {
  const divided = { ...scene, walls: [{ id: 'wall', a: { x: 1, y: 0 }, b: { x: 1, y: 8 }, door: true, open: false }] };
  assert.equal(lineOfSight(divided, token.position, { x: 2, y: 0 }), false);
  assert.deepEqual(pathBetween(token.position, { x: 2, y: 0 }, divided, [], { actor: token, actors: [token] }), []);
  const open = { ...divided, walls: [{ ...divided.walls[0], open: true }] };
  assert.deepEqual(pathBetween(token.position, { x: 2, y: 0 }, open, [], { actor: token, actors: [token] }).at(-1), { x: 2, y: 0 });
});
test('route preview prefers the cheaper path and bounds malformed positions', () => {
  const rough = { ...scene, terrain: [{ id: 'rough', x: 1, y: 0, width: 3, height: 1, type: 'difficult' as const }] };
  const route = pathBetween(token.position, { x: 4, y: 0 }, rough, [], { actor: token, actors: [token] });
  assert.ok(route.some(point => point.y > 0)); assert.equal(route[0].x, 0); assert.equal(route.at(-1)!.x, 4);
  assert.deepEqual(pathBetween(token.position, { x: Infinity, y: 0 }, scene, [], { actor: token, actors: [token] }), []);
});
test('published starting packages use injected source records without mutating Bard option A', () => {
  const record = { index: 'bard', starting_equipment_options: [{ desc: 'Choose', from: { options: [{ option_type: 'multiple', items: [] }] } }] };
  const result = equipmentPackageOptions(record, 'class'); assert.equal(result.values[0].items.length, 1); assert.equal(record.starting_equipment_options[0].from.options[0].items.length, 0); assert.deepEqual(equipmentPackageOptions(undefined, 'background').values, []);
});
test('AP previews use authoritative growth and equipment limits and reserve each actor separately', () => {
  const snapshot = { state: { actors: [{ id: 'hero', resources: [{ id: 'ap', current: 9 }] }] }, actorViews: { hero: { energyLimits: { perRound: 8 } } }, world: { mode: 'co-create', rules: { energy: { perRound: 3 } }, round: { spent: { hero: 1 }, intents: [{ actorId: 'hero', status: 'approved', cost: .5 }, { actorId: 'other', status: 'planned', cost: 7 }, { actorId: 'hero', status: 'executed', cost: 1 }] } } } as any;
  assert.equal(remainingActionPoints(snapshot, 'hero'), 6.5); delete snapshot.world.rules.energy; snapshot.world.mode = 'gm'; assert.equal(remainingActionPoints(snapshot, 'hero'), Infinity);
});
