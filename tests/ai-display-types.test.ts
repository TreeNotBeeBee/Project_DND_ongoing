import test from 'node:test';
import assert from 'node:assert/strict';
import { newAiDisplay } from '../src/shared/ai-display.ts';
test('AI display v2 starts independently of any actor, combat or numerical rules', () => {
  const first = newAiDisplay(); assert.equal(first.version, 2); assert.equal(first.freedom, 'B'); assert.equal(first.initialized, false); assert.deepEqual(first.entities, []);
  first.bindings.x = 'pc'; assert.deepEqual(newAiDisplay('A').bindings, {});
});
