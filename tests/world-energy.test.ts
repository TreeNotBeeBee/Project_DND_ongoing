import test from 'node:test';
import assert from 'node:assert/strict';
import { createActor, createGameState } from '../src/engine/index';
import { newWorld } from '../src/shared/world';
import { micro, decimal, scaledRatio, HOUR_MS } from '../src/world/fixed';
import { apResource, energyLimits, reconcileEnergy, recoverHourly, recoverRound, spendEnergy } from '../src/world/energy';
import { grantExperience, migrateGrowth, reconcileWorldBonuses, spendGrowth } from '../src/world/growth';
import { validateRules } from '../src/world/validation';

function fixture() {
  const state = createGameState('World'); state.world = newWorld('owner', 'co-create'); state.world.phase = 'running';
  state.world.rules = validateRules({energy:{maximum:100,perRound:10,recoveryMode:'hour',recovery:0.000001},costs:{action:0.000001},conflict:{kind:'random'},growth:{kind:'global',tracks:[{id:'main',name:'成长',curve:[10,20],pointsPerLevel:2,upgrades:[{target:'hp',cost:2,amount:5,max:20},{target:'ap.maximum',cost:1,amount:10}]}]},recipes:[]});
  const actor = createActor({id:'hero',ownerId:'p',name:'Free',kind:'monster',hp:{max:20,current:10,temp:0},draft:false}); actor.kind='hero';actor.profile='free';actor.registration='registered';actor.manual={maxHp:20,ac:10,speed:30,proficiency:2};state.actors.push(actor);reconcileEnergy(actor,state.world,true);state.world.energyAt[actor.id]=1_000;
  return {state,actor,world:state.world};
}
test('six-decimal AP conversion is exact and rejects precision/overflow/nonfinite values',()=>{
 for(const value of [0,0.1,16.000001,0.000001,100]) assert.equal(decimal(micro(value)),value);
 assert.equal(micro(1e-6),1);for(const value of [1e-7,Infinity,NaN,-1,1e20]) assert.throws(()=>micro(value));assert.equal(scaledRatio(1,3,10),3.333333);
 const {actor}=fixture();for(let i=0;i<1000;i++)spendEnergy(actor,0.000001);assert.equal(apResource(actor)!.current,99.999);
});
test('hourly recovery includes offline actors, retains partial hours and never accrues a clock rollback',()=>{
 const {state,actor,world}=fixture();apResource(actor)!.current=1;recoverHourly(state,1_000+HOUR_MS-1);assert.equal(apResource(actor)!.current,1);recoverHourly(state,1_000+HOUR_MS*3+123);assert.equal(apResource(actor)!.current,1.000003);assert.equal(world.energyAt[actor.id],1_000+HOUR_MS*3);recoverHourly(state,0);assert.equal(apResource(actor)!.current,1.000003);
 actor.registration='available';recoverHourly(state,1_000+HOUR_MS*5);assert.equal(apResource(actor)!.current,1.000003);
});
test('round recovery grants only online registered actors and caps the AP maximum at 100',()=>{
 const {state,actor,world}=fixture();world.rules.energy!.recoveryMode='round';world.rules.energy!.recovery=0.5;actor.growth={tracks:{},bonuses:{'ap.maximum':50,'ap.recovery':0.25,'ap.perRound':3}};assert.deepEqual(energyLimits(actor,world),{maximum:100,recovery:0.75,perRound:13});apResource(actor)!.current=1;recoverRound(state,[]);assert.equal(apResource(actor)!.current,1);recoverRound(state,['p']);assert.equal(apResource(actor)!.current,1.75);
});
test('growth repeats the last curve threshold and edits preserve level, total XP and historical points',()=>{
 const {actor,world}=fixture();grantExperience(actor,world.rules,[{trackId:'main',amount:55}]);assert.deepEqual(actor.growth!.tracks.main,{level:4,xp:5,totalXp:55,points:6});const previous=structuredClone(world.rules);world.rules.growth.tracks[0].curve=[100,200];world.rules.growth.tracks[0].pointsPerLevel=100;migrateGrowth(actor,previous,world.rules);assert.deepEqual(actor.growth!.tracks.main,{level:4,xp:50,totalXp:55,points:6});
});
test('growth and equipment raise pool maxima without free healing or compounding bonuses',()=>{
 const {state,actor,world}=fixture();grantExperience(actor,world.rules,[{trackId:'main',amount:10}]);spendGrowth(actor,world.rules,'main','hp',2);reconcileWorldBonuses(state);assert.equal(actor.hp.max,25);assert.equal(actor.hp.current,10);assert.equal(actor.manual!.maxHp,25);reconcileWorldBonuses(state);assert.equal(actor.hp.max,25);assert.throws(()=>spendGrowth(actor,world.rules,'main','hp',1));
 world.items=[{id:'ring',name:'Ring',description:'',bonuses:{hp:5,'ap.perRound':2}}];actor.inventory.push({id:'ring-instance',contentId:'world:ring',name:'Ring',quantity:1,equipped:true});reconcileWorldBonuses(state);assert.equal(actor.hp.max,30);assert.equal(actor.hp.current,10);assert.equal(energyLimits(actor,world).perRound,12);reconcileWorldBonuses(state);assert.equal(actor.hp.max,30);actor.inventory[0].equipped=false;reconcileWorldBonuses(state);assert.equal(actor.hp.max,25);assert.equal(actor.hp.current,10);
});
test('negative free attributes and zero resource pools remain legal; maximum changes never refill AP or mana',()=>{
 const {state,actor,world}=fixture();actor.abilities.str=-1.1234567;actor.resources.push({id:'mp',name:'Mana',current:0,max:0,recovery:'manual'});apResource(actor)!.current=5;apResource(actor)!.max=10;actor.growth={tracks:{},bonuses:{str:-2,hp:2,mp:5,'ap.maximum':30}};reconcileWorldBonuses(state);assert.equal(actor.abilities.str,-3.1234567);assert.equal(actor.resources.find(r=>r.id==='mp')!.current,0);assert.equal(actor.resources.find(r=>r.id==='mp')!.max,5);assert.equal(apResource(actor)!.current,5);assert.equal(apResource(actor)!.max,100);
});
test('rule validation rejects malformed tracks, AP precision, overflow and resource AP double charges',()=>{
 const {world}=fixture();for(const mutate of [(r:any)=>r.energy.maximum=101,(r:any)=>r.costs.action=1e-7,(r:any)=>r.growth.tracks[0].curve=[],(r:any)=>r.growth.tracks[0].upgrades[0].cost=0]){const rules=structuredClone(world.rules);mutate(rules);assert.throws(()=>validateRules(rules));}
});
