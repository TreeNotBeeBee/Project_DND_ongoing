import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor,createMonster,createGameState,resolveCommand} from '../src/engine/index.ts';
import type {Actor,GameState,Dice} from '../src/shared/model.ts';

const low:Dice=()=>1;
function caster(classId='cleric'){const a=createActor({name:'Audited caster',ownerId:'caster',kind:'hero',draft:false,speciesId:'dwarf',backgroundId:'soldier',classes:[{classId,level:17}],abilities:{str:10,dex:14,con:14,int:18,wis:18,cha:18}});a.inventory=[{id:'holy-symbol',contentId:'equipment:emblem',name:'Holy Symbol',quantity:1,equipped:false}];return a;}
function target(n=0){const a=createActor({name:`Target ${n}`,kind:'monster',ownerId:'gm',draft:false,hp:{max:300,current:1,temp:0},position:{x:n+1,y:1}});a.choices!.creatureType='humanoid';return a;}
function game(...actors:Actor[]){const state=createGameState('Audited spells');state.actors=actors;return state;}
function cast(state:GameState,source:Actor,spell:string,targets:Actor[],rank:number,options:Record<string,unknown>={},origin?:{x:number;y:number},dice=low){return resolveCommand(state,{operationId:'audit-cast',expectedRev:0,type:'action.use',actorId:source.id,targetIds:targets.map(a=>a.id),payload:{actionId:`spell:${spell}`,slotLevel:rank,options,origin}},dice);}

test('Blindness/Deafness rejects Paralyzed before any save, while a selected legal condition alone is applied',()=>{
 const a=caster();a.spells=['spell:blindness-deafness'];const t=target(),state=game(a,t),before=structuredClone(state);let saves=0;assert.throws(()=>cast(state,a,'blindness-deafness',[t],2,{condition:'paralyzed'},undefined,s=>{if(s===20)saves++;return 20;}),/only Blinded or Deafened/);assert.equal(saves,0);assert.deepEqual(state,before);const resolved=cast(state,a,'blindness-deafness',[t],2,{condition:'deafened'});assert.equal(resolved.state.actors[1].effects.some(e=>e.condition==='deafened'),true);assert.equal(resolved.state.actors[1].effects.some(e=>e.condition==='blinded'||e.condition==='paralyzed'),false);
});

test('Hold Person rejects a Beast companion even if it would save, while a Humanoid companion is eligible',()=>{
 const a=caster('wizard');a.spells=['spell:hold-person'];const wolf=createMonster('wolf','owner');wolf.kind='companion';wolf.position={x:1,y:0};const state=game(a,wolf),before=structuredClone(state);let saves=0;assert.throws(()=>cast(state,a,'hold-person',[wolf],2,{},undefined,s=>{if(s===20)saves++;return 20;}),/only Humanoids/);assert.equal(saves,0);assert.deepEqual(state,before);const humanoid=createMonster('bandit','owner');humanoid.kind='companion';humanoid.position={x:1,y:0};const out=cast(game(a,humanoid),a,'hold-person',[humanoid],2);assert.ok(out.state.actors[1].effects.some(e=>e.condition==='paralyzed'));
});

test('Mass Cure Wounds selects at most six in one visible 30-foot sphere and does not heal unselected bystanders',()=>{
 const a=caster();a.spells=['spell:mass-cure-wounds'];const chosen=target(),bystander=target(1);chosen.position={x:18,y:0};bystander.position={x:12,y:1};const state=game(a,chosen,bystander),origin={x:12,y:0};const result=cast(state,a,'mass-cure-wounds',[chosen],5,{},origin);assert.equal(result.state.actors[1].hp.current,10);assert.equal(result.state.actors[2].hp.current,1);const invalid=structuredClone(state);invalid.actors[1].position={x:19,y:0};assert.throws(()=>cast(invalid,a,'mass-cure-wounds',[invalid.actors[1]],5,{},origin),/outside|within/i);assert.throws(()=>cast(state,a,'mass-cure-wounds',[chosen],5,{}, {x:13,y:0}),/within 60|out of range/i);
 const seven=Array.from({length:7},(_,i)=>{const t=target(i);t.position={x:10+i%3,y:Math.floor(i/3)};return t;});assert.throws(()=>cast(game(a,...seven),a,'mass-cure-wounds',seven,5,{},origin),/six|Too many/);
});

test('the four healing dice spells add ability once and scale by the published dice; Heal adds no ability',()=>{
 for(const [spell,rank,amount] of [['cure-wounds',2,8],['healing-word',3,10],['mass-cure-wounds',6,10],['mass-healing-word',5,8],['heal',7,80]] as const){const a=caster();a.spells=['spell:'+spell];const t=target();t.position={x:1,y:0};const out=cast(game(a,t),a,spell,[t],rank,{},spell==='mass-cure-wounds'?{x:1,y:0}:undefined);assert.equal(out.state.actors[1].hp.current,1+amount,spell);}
});

test('Lesser Restoration ends the single chosen condition and an invalid multi-condition selection rolls back',()=>{
 const a=caster();a.spells=['spell:lesser-restoration'];const t=target();t.position={x:1,y:0};t.effects=['blinded','deafened','paralyzed','poisoned'].map(c=>({id:c,name:c,condition:c}));const state=game(a,t),before=structuredClone(state);const out=cast(state,a,'lesser-restoration',[t],2,{condition:'poisoned'});assert.deepEqual(out.state.actors[1].effects.map(e=>e.condition).sort(),['blinded','deafened','paralyzed']);assert.throws(()=>cast(state,a,'lesser-restoration',[t],2,{condition:['poisoned','blinded']}),/Choose a condition/);assert.deepEqual(state,before);
});

test('repeated Aid cannot stack maxima or heal again; a stronger cast adds only the increase and a weaker cast stays suppressed',()=>{
 const a=caster(),b=caster('druid');b.id='second-caster';b.ownerId='second';a.spells=b.spells=['spell:aid'];const t=target();t.position={x:1,y:0};t.hp.current=20;let out=cast(game(a,b,t),a,'aid',[t],2);assert.equal(out.state.actors[2].hp.max,305);assert.equal(out.state.actors[2].hp.current,25);out.state.actors[2].hp.current=10;out=cast(out.state,a,'aid',[t],2);assert.equal(out.state.actors[2].hp.max,305);assert.equal(out.state.actors[2].hp.current,10);out=cast(out.state,a,'aid',[t],4);assert.equal(out.state.actors[2].hp.max,315);assert.equal(out.state.actors[2].hp.current,20);out=cast(out.state,b,'aid',[t],3);assert.equal(out.state.actors[2].hp.max,315);assert.equal(out.state.actors[2].hp.current,20);const stronger=out.state.actors[2].effects.find(e=>e.modifiers?.maxHp===15)!;out=resolveCommand(out.state,{operationId:'remove-aid',expectedRev:0,type:'effect.remove',actorId:t.id,payload:{effectId:stronger.id}},low);assert.equal(out.state.actors[2].hp.max,310);assert.equal(out.state.actors[2].hp.current,20);
});
test('restoration of Poisoned does not erase an unrelated latent poison; Protection from Poison instead resists its later damage',()=>{
 const a=caster();a.spells=['spell:lesser-restoration','spell:protection-from-poison'];a.inventory.push({id:'midnight-dose',name:'Midnight Tears',contentId:'poison:midnight-tears',quantity:1,equipped:false});const t=target();t.position={x:1,y:0};t.hp.current=200;let out=resolveCommand(game(a,t),{operationId:'latent-poison',expectedRev:0,type:'gm.poisonExposure',actorId:a.id,targetIds:[t.id],payload:{itemId:'midnight-dose'}},low);out=cast(out.state,a,'lesser-restoration',[t],2,{condition:'poisoned'});assert.ok(out.state.actors[1].effects.some(e=>e.sourceId==='poison:midnight-tears'&&e.gmOnly));out=cast(out.state,a,'protection-from-poison',[t],2);assert.ok(out.state.actors[1].effects.some(e=>e.sourceId==='poison:midnight-tears'&&e.gmOnly));out=resolveCommand(out.state,{operationId:'midnight',expectedRev:0,type:'gm.itemTiming',payload:{occasion:'midnight'}},low);assert.equal(out.state.actors[1].hp.current,196);assert.equal(out.state.actors[1].effects.some(e=>e.sourceId==='poison:midnight-tears'),false);
});
