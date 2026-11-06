import { pathBetween } from '../src/client/legacy-pathfinding';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacyFile, queueKey, readLegacyStorage, safeFilename } from '../src/client/client-utils';
import type { Scene } from '../src/shared/model';
import { pathCost } from '../src/engine/map';
import type { Actor } from '../src/shared/model';
import { createMonster, createActor } from '../src/engine/actors';

const scene: Scene = { width: 5, height: 5, gridFeet: 5, walls: [], terrain: [], fog: false };
test('map route stays in bounds and respects closed walls and open doors', () => {
  assert.equal(pathBetween({ x: 0, y: 0 }, { x: -1, y: 0 }, scene).length, 0);
  const wall = { id: 'wall', a: { x: 1, y: 0 }, b: { x: 1, y: 5 } };
  assert.equal(pathBetween({ x: 0, y: 0 }, { x: 2, y: 0 }, { ...scene, walls: [wall] }).length, 0);
  const path = pathBetween({ x: 0, y: 0 }, { x: 2, y: 0 }, { ...scene, walls: [{ ...wall, door: true, open: true }] });
  assert.deepEqual(path, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
});
test('route follows the server diagonal rules and avoids occupied or expensive terrain cells', () => {
  assert.deepEqual(pathBetween({ x: 0, y: 0 }, { x: 1, y: 1 }, scene), [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  const terrainScene: Scene = { ...scene, terrain: [{ id: 'mud', x: 1, y: 0, width: 1, height: 1, type: 'difficult' }] };
  const actor = { id: 'mover', position: { x: 0, y: 0 } } as Actor;
  const route = pathBetween(actor.position, { x: 2, y: 0 }, terrainScene, [{ x: 1, y: 0 }]);
  assert.ok(!route.some(point => point.x === 1 && point.y === 0));
  assert.equal(pathCost(terrainScene, actor, route.slice(1), []), 10);
  assert.equal(pathBetween(actor.position, { x: 2, y: 0 }, scene, [{ x: 2, y: 0 }]).length, 0);
});
test('legacy export reads original bytes without touching source storage or credentials', () => {
  const values = new Map([['jigerpg_charlist_v04', '[ {"id":"a"} ]'], ['jigerpg_char_a', '{ "name": "旧卡" }'], ['jigerpg_room_v1', 'secret'], ['jigerpg_gm_v1', '{"round":3}']]);
  const before = [...values];
  const result = readLegacyStorage({ length: values.size, key: index => [...values.keys()][index], getItem: key => values.get(key) ?? null });
  assert.deepEqual(result.raw, { jigerpg_charlist_v04: '[ {"id":"a"} ]', jigerpg_char_a: '{ "name": "旧卡" }', jigerpg_gm_v1: '{"round":3}' });
  assert.deepEqual([...values], before);
});
test('crawl routing uses additive terrain costs and chooses the cheaper server path', () => {
  const crawlingScene: Scene = { ...scene, width: 7, terrain: [[1, 1], [3, 1], [1, 2], [3, 2], [3, 3]].map(([x, y]) => ({ id: `${x},${y}`, x, y, width: 1, height: 1, type: 'difficult' })) };
  const actor = { id: 'crawler', position: { x: 0, y: 2 } } as Actor;
  const occupied = [{ x: 5, y: 2 }, { x: 5, y: 3 }];
  const standingRoute = pathBetween(actor.position, { x: 6, y: 2 }, crawlingScene, occupied);
  const crawlRoute = pathBetween(actor.position, { x: 6, y: 2 }, crawlingScene, occupied, { crawling: true });
  assert.equal(pathCost(crawlingScene, actor, standingRoute.slice(1), [], { crawling: true }), 70);
  assert.equal(pathCost(crawlingScene, actor, crawlRoute.slice(1), [], { crawling: true }), 65);
});
test('large-token routes validate every occupied cell against the real movement rules', () => {
  const ogre = createMonster('monster:ogre', 'gm'); ogre.position = { x: 0, y: 0 };
  const corridor: Scene = { ...scene, height: 2 };
  const options = { actor: ogre, actors: [ogre] };
  assert.equal(pathCost(corridor, ogre, pathBetween(ogre.position, { x: 3, y: 0 }, corridor, [], options).slice(1), [ogre]), 15);
  assert.deepEqual(pathBetween(ogre.position, { x: 4, y: 0 }, corridor, [], options), []);
  const blocker = createActor({ id: 'blocker', position: { x: 2, y: 1 } });
  blocker.draft = false;
  assert.deepEqual(pathBetween(ogre.position, { x: 3, y: 0 }, corridor, [], { actor: ogre, actors: [ogre, blocker] }), []);
  const wallScene = { ...corridor, walls: [{ id: 'wall', a: { x: 2, y: 1 }, b: { x: 2, y: 2 } }] };
  assert.deepEqual(pathBetween(ogre.position, { x: 1, y: 0 }, wallScene, [], options), []);
  const mud: Scene = { ...scene, terrain: [{ id: 'mud', x: 2, y: 1, width: 1, height: 1, type: 'difficult' }] };
  assert.equal(pathCost(mud, ogre, pathBetween(ogre.position, { x: 1, y: 0 }, mud, [], options).slice(1), [ogre]), 10);
});
test('legacy file validation and pending keys isolate members and campaigns', () => {
  assert.throws(() => parseLegacyFile('null'));
  assert.throws(() => parseLegacyFile('[]'));
  assert.deepEqual(parseLegacyFile('{"name":"旧卡"}'), { name: '旧卡' });
  assert.notEqual(queueKey('a', 'x'), queueKey('a', 'y'));
  assert.notEqual(queueKey('a', 'x'), queueKey('b', 'x'));
  assert.equal(safeFilename('a/b:存档.json'), 'a_b_存档.json');
});
