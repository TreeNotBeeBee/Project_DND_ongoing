import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_AVATAR_RADIUS, aiNameInitial, focusAiMap, hitMapCircle, mapFrame, mapImageSource, mapScreenToWorld, mapWorldToScreen, normalizedToWorld, worldToNormalized, zoomMapAt } from '../src/client/ai-map-geometry';

test('avatar initials skip emoji punctuation and digits without changing names', () => {
  assert.equal(aiNameInitial(' 🎲！张三'), '张'); assert.equal(aiNameInitial('007—Alice'), 'A'); assert.equal(aiNameInitial('🐉𠀀旅人'), '𠀀'); assert.equal(aiNameInitial('…123🎲'), '?'); assert.equal(aiNameInitial(' e\u0301lise'), 'é');
});
test('normalized positions and screen transforms round-trip without clamping AI values', () => {
  const frame = { width: 1600, height: 900 }, position = { x: -.25, y: 1.4 }, camera = { x: 42, y: -91, zoom: .35 };
  const world = normalizedToWorld(position, frame), screen = mapWorldToScreen(world, camera);
  assert.deepEqual(world, { x: -400, y: 1260 }); assert.deepEqual(worldToNormalized(world, frame), position); assert.deepEqual(mapScreenToWorld(screen, camera), world);
});
test('zoom preserves its screen anchor while avatar hit areas stay fixed and respect paint order', () => {
  const camera = { x: 50, y: 20, zoom: .5 }, pointer = { x: 190, y: 300 }, world = mapScreenToWorld(pointer, camera);
  const zoomed = zoomMapAt(camera, pointer, 4); assert.deepEqual(mapWorldToScreen(world, zoomed), pointer);
  const items = [{ id: 'other', screen: pointer, radius: AI_AVATAR_RADIUS }, { id: 'own', screen: pointer, radius: AI_AVATAR_RADIUS }];
  assert.equal(hitMapCircle(items, { x: pointer.x + 24, y: pointer.y })?.id, 'own'); assert.equal(hitMapCircle(items, { x: pointer.x + 26, y: pointer.y }), undefined);
});
test('return-to-position changes only the camera and centers the actual own point on the full viewport', () => {
  const frame = { width: 2400, height: 1200 }, viewport = { width: 390, height: 844 }, position = { x: 2000, y: 160 }, frozen = JSON.stringify(position);
  const camera = focusAiMap(frame, viewport, position); assert.deepEqual(mapWorldToScreen(position, camera), { x: 195, y: 422 }); assert.equal(JSON.stringify(position), frozen);
});
test('invalid frames and executable image sources are not rendered as data or implicit zero positions', () => {
  assert.equal(mapFrame({ width: 0, height: 100 }), undefined); assert.equal(mapFrame({ width: Infinity, height: 100 }), undefined);
  assert.equal(mapImageSource('javascript:alert(1)'), undefined); assert.equal(mapImageSource('data:image/svg+xml,<svg/>'), undefined); assert.equal(mapImageSource('/api/assets/private-123'), '/api/assets/private-123');
});
