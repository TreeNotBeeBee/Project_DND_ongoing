import test from 'node:test';
import assert from 'node:assert/strict';
import {entries,coverage,raw,source,getEntry,corrections} from '../src/content/index.ts';
import {additionalItemEntries} from '../src/content/item-adapters.ts';
test('pinned catalog contains 2024 data only and unique public ids',()=>{
  assert.equal(source.ruleset,'srd-5.2.1');assert.equal(source.commit,'67d8c6aad9a273862fc5ff5f633fcdc06130b94c');assert.equal(Object.values(raw).reduce((n,a)=>n+a.length,0),2013);assert.equal(entries.length,2013+additionalItemEntries.length);assert.equal(new Set(entries.map(e=>e.id)).size,entries.length);
  for(const e of entries)if(e.data.url)assert.match(e.data.url,/^\/api\/2024\//);
  assert.equal(raw.classes.length,12);assert.equal(raw.spells.length,339);assert.equal(raw['damage-types'].length,13);assert.equal(coverage.entries.length,entries.length);assert.equal(coverage.complete,false);
});
test('official Wizard prepared-spells correction overlays but does not falsify pinned source hashes',()=>{
  const text=raw.classes.find(x=>x.index==='wizard').spellcasting.info.find((x:any)=>x.name==='Prepared Spells of Level 1+').desc.join(' ');
  assert.match(text,/choose four spells/);assert.doesNotMatch(text,/two level four/);assert.equal(corrections[0].sourcePage,78);assert.equal(Object.keys(source.hashes).length,25);
});
test('2024 differences are preserved: Inflict Wounds is a save and Cure Wounds starts at 2d8',()=>{
  assert.equal(getEntry('spell:inflict-wounds')?.action?.attack,undefined);assert.equal(getEntry('spell:inflict-wounds')?.action?.save?.ability,'con');assert.equal(getEntry('spell:cure-wounds')?.action?.healing,'2d8');
  assert.deepEqual(getEntry('spell:mass-cure-wounds')?.action?.area,{shape:'sphere',size:30});
});
test('complex deterministic content is blocked and narrative adjudication distinguished',()=>{
  assert.equal(getEntry('spell:wish')?.automation,'adjudication');assert.equal(getEntry('spell:polymorph')?.automation,'unsupported');assert.equal(getEntry('spell:fireball')?.automation,'automatic');assert.ok(getEntry('spell:polymorph')?.reason);
  assert.equal(getEntry('spell:legend-lore')?.automation,'unsupported');
  assert.match(getEntry('spell:legend-lore')?.reason||'',/reusable ivory/);
});
