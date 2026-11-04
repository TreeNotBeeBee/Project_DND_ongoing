import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor} from '../src/engine/actors.ts';
import {grantSpellMaterials,paySpellMaterials,spellMaterialRequirement} from '../src/engine/spell-materials.ts';
import type {Resolution} from '../src/shared/model.ts';

test('priced or consumed materials use source requirements; ordinary materials do not become a gold tax',()=>{
  assert.equal(spellMaterialRequirement('spell:fireball'),undefined);
  assert.equal(spellMaterialRequirement('spell:stoneskin')?.consumed,true);
  assert.equal(spellMaterialRequirement('spell:augury')?.consumed,false);
  assert.equal(spellMaterialRequirement('spell:bless')?.consumed,false);
});
test('a paid material lot is bound to the exact spell and each casting consumes one packet',()=>{
  const actor=createActor({name:'Caster'}),log:Resolution['events']=[];
  assert.throws(()=>paySpellMaterials(actor,'stoneskin',{},log),/Required material/);
  grantSpellMaterials(actor,'stoneskin',2,log);
  assert.throws(()=>paySpellMaterials(actor,'greater-restoration',{},log),/Required material/);
  paySpellMaterials(actor,'stoneskin',{},log);assert.equal(actor.inventory[0].quantity,1);
  paySpellMaterials(actor,'stoneskin',{},log);assert.equal(actor.inventory[0].quantity,0);
  assert.throws(()=>paySpellMaterials(actor,'stoneskin',{},log),/Required material/);
});
test('Bless accepts a real 5 GP Holy Symbol without consuming it, rather than an arbitrary item name',()=>{
  const actor=createActor({name:'Cleric'}),log:Resolution['events']=[];
  actor.inventory=[{id:'fake',contentId:'equipment:club',name:'Holy Symbol',quantity:1,equipped:true}];
  assert.throws(()=>paySpellMaterials(actor,'bless',{},log),/Required material/);
  actor.inventory.push({id:'real',contentId:'equipment:emblem',name:'Emblem',quantity:1,equipped:false});
  paySpellMaterials(actor,'bless',{},log);paySpellMaterials(actor,'bless',{},log);
  assert.equal(actor.inventory[1].quantity,1);
  assert.throws(()=>paySpellMaterials(actor,'bless',{componentItemId:'fake'},log),/Required material/);
});
test('reusable divinatory tokens persist while mixed material requirements fail closed',()=>{
  const actor=createActor({name:'Diviner'}),log:Resolution['events']=[];
  grantSpellMaterials(actor,'augury',1,log);paySpellMaterials(actor,'augury',{},log);assert.equal(actor.inventory[0].quantity,1);
  grantSpellMaterials(actor,'legend-lore',1,log);
  assert.throws(()=>paySpellMaterials(actor,'legend-lore',{},log),/dedicated component workflow/);
  assert.equal(actor.inventory[1].quantity,1);
  assert.throws(()=>grantSpellMaterials(actor,'fireball',1,log),/no priced/);
});
