import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor,createGameState,resolveCommand} from '../src/engine/index.ts';
import {getEntry,corrections} from '../src/content/index.ts';
import upstream from '../src/content/raw/srd-2024.json' with {type:'json'};

test('Heal uses its fixed source HP amount and ends exactly its three listed conditions',()=>{
  const source=createActor({name:'Cleric',draft:false,classes:[{classId:'cleric',level:13}],spells:['spell:heal'],abilities:{str:10,dex:10,con:14,int:10,wis:20,cha:10}});
  const target=createActor({name:'Target',kind:'monster',draft:false,hp:{current:1,max:200,temp:0},position:{x:1,y:0}});
  target.effects=['blinded','deafened','poisoned','stunned'].map(condition=>({id:condition,name:condition,condition}));
  const state=createGameState('Source spell');state.actors=[source,target];
  const out=resolveCommand(state,{operationId:'heal-source',expectedRev:0,type:'action.use',actorId:source.id,targetIds:[target.id],payload:{actionId:'spell:heal',slotLevel:7}},()=>1);
  assert.equal(out.state.actors[1].hp.current,81);assert.deepEqual(out.state.actors[1].effects.map(effect=>effect.condition),['stunned']);
  assert.ok(out.events.some(event=>event.type==='spell-effect'&&event.message.includes('Poisoned')));
});

test('Power Word Heal and Kill use official Verbal components and cannot bypass Silence through a source omission',()=>{
  for(const [id,classId] of [['power-word-heal','cleric'],['power-word-kill','wizard']]){
    assert.deepEqual(upstream.spells.find(spell=>spell.index===id)!.components,[]);
    assert.deepEqual(getEntry('spell:'+id)!.data.components,['V']);
    assert.ok(corrections.some(entry=>entry.id===id+'-verbal-component'&&entry.sourcePage===154));
    const source=createActor({name:'Caster',draft:false,classes:[{classId,level:17}],spells:['spell:'+id],effects:[{id:'silence',name:'Silence',sourceId:'silenced'}]});
    const target=createActor({name:'Target',kind:'monster',draft:false,hp:{current:100,max:200,temp:0},position:{x:1,y:0}});
    const state=createGameState('Verbal source');state.actors=[source,target];const original=structuredClone(state);
    assert.throws(()=>resolveCommand(state,{operationId:'verbal-check',expectedRev:0,type:'action.use',actorId:source.id,targetIds:[target.id],payload:{actionId:'spell:'+id}},()=>1),{code:'SILENCED'});
    assert.deepEqual(state,original);
  }
});
