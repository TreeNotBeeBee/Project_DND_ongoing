import test from 'node:test';
import assert from 'node:assert/strict';
import { areaContains, resolveSpellArea, type AreaGeometry } from '../src/shared/spell-geometry.ts';
import type { ActionDefinition } from '../src/shared/model.ts';
const base:AreaGeometry={shape:'sphere',size:20,origin:{x:0,y:0},direction:{x:1,y:0},gridFeet:5};
test('sphere/cylinder use a circle, not an axis-aligned square',()=>{
  assert.equal(areaContains(base,{x:4,y:0}),true);assert.equal(areaContains(base,{x:4,y:4}),false);
  assert.equal(areaContains({...base,shape:'cylinder'},{x:2,y:2}),true);
});
test('cone width grows with distance and excludes its origin unless selected',()=>{
  const cone={...base,shape:'cone' as const,size:15};
  assert.equal(areaContains(cone,{x:2,y:1}),true);assert.equal(areaContains(cone,{x:2,y:2}),false);
  assert.equal(areaContains(cone,{x:-1,y:0}),false);assert.equal(areaContains(cone,{x:0,y:0}),false);
  assert.equal(areaContains({...cone,includeOrigin:true},{x:0,y:0}),true);
});
test('line has five-foot width, respects length and rotates independently',()=>{
  const line={...base,shape:'line' as const,size:100};
  assert.equal(areaContains(line,{x:20,y:0}),true);assert.equal(areaContains(line,{x:10,y:1}),false);
  assert.equal(areaContains(line,{x:21,y:0}),false);
  assert.equal(areaContains({...line,direction:{x:0,y:1}},{x:0,y:10}),true);
  assert.equal(areaContains({...line,direction:{x:0,y:1}},{x:10,y:0}),false);
});
test('cube begins on an origin face and does not extend behind it',()=>{
  const cube={...base,shape:'cube' as const,size:15};
  assert.equal(areaContains(cube,{x:2,y:1}),true);assert.equal(areaContains(cube,{x:-1,y:0}),false);
  assert.equal(areaContains(cube,{x:2,y:2}),false);
});
test('self cone/line origin is the caster and map aim supplies direction',()=>{
  const action:ActionDefinition={id:'spell:burning-hands',name:'Burning Hands',source:'spell',economy:'action',range:0,area:{shape:'cone',size:15},description:'',automation:'automatic'};
  const area=resolveSpellArea(action,{x:5,y:5},{origin:{x:5,y:8}});
  assert.deepEqual(area.origin,{x:5,y:5});assert.equal(areaContains(area,{x:5,y:7}),true);assert.equal(areaContains(area,{x:7,y:5}),false);
});
test('ranged spheres require a point of origin and do not mutate caller coordinates',()=>{
  const action:ActionDefinition={id:'spell:fireball',name:'Fireball',source:'spell',economy:'action',range:150,area:{shape:'sphere',size:20},description:'',automation:'automatic'};
  assert.throws(()=>resolveSpellArea(action,{x:0,y:0},{}));const point={x:8,y:8};const area=resolveSpellArea(action,{x:0,y:0},{origin:point});area.origin.x=1;assert.equal(point.x,8);
});
