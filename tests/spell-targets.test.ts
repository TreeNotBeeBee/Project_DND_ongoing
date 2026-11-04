import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor,createMonster,createGameState} from '../src/engine/index.ts';
import {getEntry} from '../src/content/index.ts';
import {prepareAuditedSpell,validateAuditedTargets} from '../src/engine/spell-targets.ts';

test('published higher slots add exactly one target for Bless, Bane, Blindness and both Hold spells',()=>{
 const actor=createActor({name:'Caster'}),state=createGameState('Target audit');state.actors=[actor];
 for(const [spell,base,rank] of [['bless',3,1],['bane',3,1],['blindness-deafness',1,2],['hold-person',1,2],['hold-monster',1,5]] as const){const action=structuredClone(getEntry('spell:'+spell)!.action!);prepareAuditedSpell(action,rank+1);assert.equal(action.targets,base+1);const targets=Array.from({length:base+2},()=>createActor({name:'Humanoid'}));assert.doesNotThrow(()=>validateAuditedTargets(state,actor,action,targets.slice(0,base+1),{options:{condition:'blinded'}}));assert.throws(()=>validateAuditedTargets(state,actor,action,targets,{options:{condition:'blinded'}}),/Too many/);}
});
test('Hold Person uses statblock creature type, while Blindness cannot select Paralyzed',()=>{
 const source=createActor({name:'Caster'}),state=createGameState('Types'),wolf=createMonster('wolf','owner'),bandit=createMonster('bandit','owner');wolf.kind=bandit.kind='companion';const hold=structuredClone(getEntry('spell:hold-person')!.action!);prepareAuditedSpell(hold,2);assert.throws(()=>validateAuditedTargets(state,source,hold,[wolf],{}),/only Humanoids/);assert.doesNotThrow(()=>validateAuditedTargets(state,source,hold,[bandit],{}));const blind=structuredClone(getEntry('spell:blindness-deafness')!.action!);prepareAuditedSpell(blind,2);assert.throws(()=>validateAuditedTargets(state,source,blind,[bandit],{options:{condition:'paralyzed'}}),/only Blinded or Deafened/);assert.doesNotThrow(()=>validateAuditedTargets(state,source,blind,[bandit],{options:{condition:'deafened'}}));
});
test('Mass Cure Wounds validates its center and the common radius, rather than caster-to-each-target range',()=>{
 const source=createActor({name:'Caster'}),target=createActor({name:'Target',position:{x:18,y:0}}),state=createGameState('Sphere'),action=structuredClone(getEntry('spell:mass-cure-wounds')!.action!);prepareAuditedSpell(action,5);assert.equal(action.targets,6);assert.deepEqual(action.area,{shape:'sphere',size:30});assert.doesNotThrow(()=>validateAuditedTargets(state,source,action,[target],{origin:{x:12,y:0}}));target.position.x=19;assert.throws(()=>validateAuditedTargets(state,source,action,[target],{origin:{x:12,y:0}}),/same 30-foot-radius/);assert.throws(()=>validateAuditedTargets(state,source,action,[target],{origin:{x:13,y:0}}),/within 60 feet/);assert.throws(()=>validateAuditedTargets(state,source,action,[target],{}),/center/);
});
test('Mass Cure Wounds checks occupied cells for Large creatures whose anchor lies outside its area',()=>{
 const source=createActor({name:'Caster'}),large=createMonster('brown-bear','owner'),state=createGameState('Large target'),action=structuredClone(getEntry('spell:mass-cure-wounds')!.action!);large.position={x:5,y:0};prepareAuditedSpell(action,5);assert.doesNotThrow(()=>validateAuditedTargets(state,source,action,[large],{origin:{x:12,y:0}}));large.position.x=4;assert.throws(()=>validateAuditedTargets(state,source,action,[large],{origin:{x:12,y:0}}),/same 30-foot-radius/);source.effects=[{id:'grow',name:'Enlarge',modifiers:{sizeDelta:1}}];large.position={x:13,y:0};assert.doesNotThrow(()=>validateAuditedTargets(state,source,action,[large],{origin:{x:13,y:0}}));
});
