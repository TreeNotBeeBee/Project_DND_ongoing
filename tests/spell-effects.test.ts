import test from 'node:test';
import assert from 'node:assert/strict';
import { createActor, createGameState, deriveActor } from '../src/engine/index.ts';
import { applyAdditionalSpellEffect, prepareAdditionalSpell, resolveAdditionalSpellChoice, type AdditionalSpellContext } from '../src/engine/spell-effects.ts';
import type { ActionDefinition } from '../src/shared/model.ts';
function context(id:string):AdditionalSpellContext {
  const source=createActor({id:'source',name:'Caster',classes:[{classId:'wizard',level:5}]});
  const target=createActor({id:'target',name:'Target',draft:false,classes:[{classId:'fighter',level:1}]});
  const state=createGameState('Test');state.actors=[source,target];
  return {state,source,target,action:{id:'spell:'+id,name:id,source:'spell',economy:'action',description:'',automation:'automatic',duration:10},rank:1,options:{},failed:true,dice:()=>1,log:[],
    addEffect:(_state,actor,effect)=>{actor.effects.push(effect);},clearCondition:(actor,condition)=>{actor.effects=actor.effects.filter(effect=>effect.condition!==condition);}};
}
test('False Life uses 2024 2d4+4, increases by 5 per slot and does not stack Temporary HP',()=>{
  const c=context('false-life');c.target=c.source;c.rank=3;c.source.hp.temp=20;
  assert.equal(applyAdditionalSpellEffect(c),true);assert.equal(c.source.hp.temp,20);assert.equal(c.log[0].rolls?.[0].total,16);
  c.source.hp.temp=0;applyAdditionalSpellEffect(c);assert.equal(c.source.hp.temp,16);
});
test('self-only spells fail before rolling against another target',()=>{
  const c=context('false-life');let rolls=0;c.dice=()=>{rolls++;return 1;};assert.throws(()=>applyAdditionalSpellEffect(c));assert.equal(rolls,0);
});
test('Spare the Dying stabilizes without healing or reviving; cantrip range scales',()=>{
  const c=context('spare-the-dying');c.target.hp.current=0;c.target.deathSaves={successes:1,failures:2};
  applyAdditionalSpellEffect(c);assert.equal(c.target.hp.current,0);assert.deepEqual(c.target.deathSaves,{successes:3,failures:0});
  prepareAdditionalSpell(c.action,c.source,0);assert.equal(c.action.range,30);c.target.dead=true;assert.throws(()=>applyAdditionalSpellEffect(c));
});
test('Longstrider contributes to the real derived speed and slot target limit',()=>{
  const c=context('longstrider'),before=deriveActor(c.target).speed;applyAdditionalSpellEffect(c);
  assert.equal(deriveActor(c.target).speed,before+10);prepareAdditionalSpell(c.action,c.source,3);assert.equal(c.action.targets,3);
});
test('Protection from Poison ends Poisoned and preserves save and damage protections',()=>{
  const c=context('protection-from-poison');c.target.effects=[{id:'poison',name:'Poison',condition:'poisoned'}];applyAdditionalSpellEffect(c);
  assert.equal(c.target.effects.some(e=>e.condition==='poisoned'),false);assert.deepEqual(c.target.effects[0].resistance,['poison']);assert.deepEqual(c.target.effects[0].saveAdvantages?.conditions,['poisoned']);
});
test('Stoneskin covers all three 2024 damage types; Ray of Sickness expires at caster next end',()=>{
  const c=context('stoneskin');c.action.concentration=true;applyAdditionalSpellEffect(c);
  assert.deepEqual(c.target.effects[0].resistance,['bludgeoning','piercing','slashing']);assert.equal(c.target.effects[0].concentration,true);
  const ray=context('ray-of-sickness');ray.state.combat.active=true;ray.state.combat.round=2;applyAdditionalSpellEffect(ray);
  assert.deepEqual(ray.target.effects[0].expiresOn,{actorId:'source',timing:'end',round:3});
});
test('Misty Step teleports only to a visible unoccupied cell within 30 feet',()=>{
  const c=context('misty-step');c.target=c.source;c.options.destination={x:4,y:0};c.source.position={x:0,y:0};c.state.actors[1].position={x:8,y:0};
  applyAdditionalSpellEffect(c);assert.deepEqual(c.source.position,{x:4,y:0});
  c.options.destination={x:20,y:0};assert.throws(()=>applyAdditionalSpellEffect(c),/30 feet/);
  c.options.destination={x:8,y:0};assert.throws(()=>applyAdditionalSpellEffect(c),{code:'OCCUPIED'});
});

test('Misty Step validates the complete enlarged caster footprint before teleporting',()=>{
  const c=context('misty-step');c.target=c.source;c.source.effects=[{id:'enlarge',name:'Enlarge',modifiers:{sizeDelta:1}}];c.source.position={x:0,y:0};
  c.state.actors[1].position={x:5,y:1};c.options.destination={x:4,y:0};
  assert.throws(()=>applyAdditionalSpellEffect(c),{code:'OCCUPIED'});assert.deepEqual(c.source.position,{x:0,y:0});
  c.options.destination={x:c.state.scene.width-1,y:0};assert.throws(()=>applyAdditionalSpellEffect(c),{code:'TOKEN_BOUNDS'});
});
test('2024 Power Word Kill branches on current HP and respects Death Ward',()=>{
  const c=context('power-word-kill');c.target.hp={current:100,max:150,temp:500};applyAdditionalSpellEffect(c);
  assert.equal(c.target.dead,true);assert.equal(c.target.hp.current,0);
  const ward=context('power-word-kill');ward.target.effects=[{id:'ward',name:'Death Ward',sourceId:'death-ward'}];applyAdditionalSpellEffect(ward);
  assert.equal(ward.target.dead,undefined);assert.equal(ward.target.effects.length,0);
  const above=context('power-word-kill');above.target.hp={current:101,max:150,temp:0};let dealt=0;above.damage=(_s,_a,_t,parts)=>{dealt=parts[0].amount;};applyAdditionalSpellEffect(above);
  assert.equal(dealt,12);assert.equal(above.target.dead,undefined);
});
test('Power Word Stun uses the HP threshold and actual spellcasting source DC',()=>{
  const c=context('power-word-stun');c.spellAbility='int';c.source.abilities.int=18;c.target.hp={current:150,max:200,temp:0};applyAdditionalSpellEffect(c);
  assert.equal(c.target.effects[0].condition,'stunned');assert.equal(c.target.effects[0].notes,'repeat:con:15');
  const above=context('power-word-stun');above.target.hp={current:151,max:200,temp:0};applyAdditionalSpellEffect(above);
  assert.equal(above.target.effects[0].modifiers?.speedMaximum,0);assert.equal(above.target.effects[0].condition,undefined);
});
test('Greater Restoration removes one chosen reduction without healing unrelated missing HP',()=>{
  const c=context('greater-restoration');c.target.effects=[{id:'drain',name:'Drain',modifiers:{maxHp:-5}},{id:'other',name:'Other'}];
  c.options={restorationChoice:'max-hp',effectId:'drain'};c.target.hp.current=1;applyAdditionalSpellEffect(c);
  assert.equal(c.target.hp.current,1);assert.equal(c.target.effects.length,1);assert.equal(c.target.hp.max,maximum(c));
  c.options={restorationChoice:'ability',effectId:'other'};assert.throws(()=>applyAdditionalSpellEffect(c),{code:'CHOICE_REQUIRED'});
});

test('Greater Restoration restores one selected ability across sources and preserves unrelated parts of each effect',()=>{
  const c=context('greater-restoration');c.target.effects=[
    {id:'combined',name:'Combined drain',modifiers:{str:-4,dex:-2,speed:-10},condition:'poisoned'},
    {id:'second',name:'Second drain',modifiers:{str:-2}},
  ];
  c.options={restorationChoice:'ability'};assert.throws(()=>applyAdditionalSpellEffect(c),{code:'CHOICE_REQUIRED'});
  c.options={restorationChoice:'ability',restorationAbility:'str'};applyAdditionalSpellEffect(c);
  assert.equal(c.target.effects.length,1);assert.deepEqual(c.target.effects[0].modifiers,{dex:-2,speed:-10});assert.equal(c.target.effects[0].condition,'poisoned');
});

test('Greater Restoration removes all maximum-HP reductions while retaining other ability penalties and missing HP',()=>{
  const c=context('greater-restoration');c.target.hp.current=1;c.target.effects=[
    {id:'a',name:'Drain A',modifiers:{maxHp:-3,str:-1}},
    {id:'b',name:'Drain B',modifiers:{maxHp:-2}},
  ];c.options={restorationChoice:'max-hp'};applyAdditionalSpellEffect(c);
  assert.equal(c.target.effects.length,1);assert.deepEqual(c.target.effects[0].modifiers,{str:-1});assert.equal(c.target.hp.current,1);
});
function maximum(c:AdditionalSpellContext){return deriveActor(c.target).maxHp;}
test('Mass Heal validates the global 700-HP pool and clears only specified ailments',()=>{
  const c=context('mass-heal');c.options.allocations={[c.target.id]:701};c.heal=()=>{};assert.throws(()=>applyAdditionalSpellEffect(c),/700/);
  let healed=0;c.options.allocations={[c.target.id]:300,other:400};c.heal=(_target,amount)=>{healed=amount;};
  c.target.effects=[{id:'poison',name:'Poison',condition:'poisoned'},{id:'stun',name:'Stun',condition:'stunned'}];applyAdditionalSpellEffect(c);
  assert.equal(healed,300);assert.equal(c.target.effects.length,1);assert.equal(c.target.effects[0].condition,'stunned');
});
test('Power Word Heal asks the target whether to spend a reaction standing',()=>{
  const c=context('power-word-heal');c.heal=()=>{};c.target.effects=[{id:'prone',name:'Prone',condition:'prone'}];c.state.combat.active=true;c.state.combat.budgets[c.target.id]={action:1,bonus:1,reaction:1,movement:30};
  applyAdditionalSpellEffect(c);const choice=c.state.choices[0];assert.equal(choice.ownerId,c.target.ownerId);assert.equal(c.target.effects.length,1);
  resolveAdditionalSpellChoice(c.state,choice,'stand',c.log);assert.equal(c.state.combat.budgets[c.target.id].reaction,0);assert.equal(c.target.effects.length,0);
});
test('stored spells preserve their original caster modifier and save DC',()=>{
  const heroism=context('heroism');heroism.spellAbility='int';heroism.source.abilities.int=8;heroism.spellModifier=5;
  applyAdditionalSpellEffect(heroism);assert.equal(heroism.target.effects[0].modifiers?.tempHpEachStart,5);
  const stun=context('power-word-stun');stun.spellAbility='int';stun.source.abilities.int=8;stun.spellSaveDC=19;
  applyAdditionalSpellEffect(stun);assert.equal(stun.target.effects[0].notes,'repeat:con:19');
});
