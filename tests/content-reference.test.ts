import test from 'node:test';
import assert from 'node:assert/strict';
import reference from '../src/content/official-spell-index.json' with {type:'json'};
import { entries } from '../src/content/index.ts';
test('every local spell has an exact heading and page in the verified official 5.2.1 reference',()=>{
  const spells=entries.filter(entry=>entry.category==='spell');
  assert.equal(reference.spellCount,339);assert.equal(reference.spells.length,spells.length);
  assert.deepEqual(reference.spells.map(entry=>entry.id).sort(),spells.map(entry=>entry.id).sort());
  assert.ok(reference.spells.every(entry=>entry.sourcePage>=107&&entry.sourcePage<=175));
  assert.equal(reference.spells.find(entry=>entry.id==='spell:acid-splash')?.sourcePage,107);
  assert.equal(reference.spells.find(entry=>entry.id==='spell:power-word-kill')?.sourcePage,154);
});
