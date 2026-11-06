import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as engine from '../src/engine';
import {newWorld,DEFAULT_RULES} from '../src/shared/world';
import type {GameState} from '../src/shared/model';
import {validateBackupState} from '../src/server/validation';
import {createApplication} from '../src/server/app';
import {advanceWorldTime} from '../src/world/clock';

function valid():GameState {
 const state=engine.createGameState('Recoverable world');state.world=newWorld('owner','co-create');state.world.phase='running';state.world.round={number:1,phase:'planning',participants:['owner'],ended:[],spent:{},intents:[]};state.world.rules={...structuredClone(DEFAULT_RULES),energy:{maximum:10,perRound:3,recoveryMode:'hour',recovery:1},costs:{action:1,narrative:.1},growth:{kind:'global',tracks:[{id:'main',name:'Main',curve:[10],pointsPerLevel:1,upgrades:[{target:'hp',cost:1,amount:1}]}]}};
 const actor=engine.createActor({profile:'free',id:'hero',name:'Hero',ownerId:'owner',registration:'registered',resources:[{id:'ap',name:'AP',current:5,max:10,recovery:'manual'}],growth:{tracks:{main:{level:1,xp:0,totalXp:0,points:0}},bonuses:{}}});state.actors.push(actor);state.world.energyAt.hero=0;state.world.items=[{id:'ore',name:'Ore',description:''}];state.world.nodes=[{id:'vein',name:'Vein',position:{x:1,y:1},inventory:[{itemId:'ore',quantity:2}]}];return JSON.parse(JSON.stringify(state));
}
function intent(state:GameState){return{id:'intent-valid',actorId:state.actors[0].id,memberId:state.actors[0].ownerId,type:'narrative' as const,payload:{text:'Narrative'},targetIds:[],cost:.1,round:state.world!.round.number,status:'approved' as const};}
const invalidCases:[string,(state:GameState)=>void][]=[
 ['AP current precision',s=>s.actors[0].resources.find(r=>r.id==='ap')!.current=1e-7],
 ['AP maximum precision',s=>s.actors[0].resources.find(r=>r.id==='ap')!.max=9.0000001],
 ['round-spent precision',s=>s.world!.round.spent[s.actors[0].id]=1e-7],
 ['intent-cost precision',s=>{s.world!.round.intents=[intent(s)];s.world!.round.intents[0].cost=1e-7;}],
 ['negative energy clock',s=>s.world!.energyAt[s.actors[0].id]=-1],
 ['fractional energy clock',s=>s.world!.energyAt[s.actors[0].id]=.5],
 ['unsafe energy clock',s=>s.world!.energyAt[s.actors[0].id]=Number.MAX_SAFE_INTEGER+1],
 ['bad item bonuses',s=>s.world!.items[0].bonuses={'ap.recovery':1e-7}],
 ['bad node inventory',s=>(s.world!.nodes[0]as any).inventory={ore:1}],
 ['node missing item',s=>s.world!.nodes[0].inventory[0].itemId='absent'],
 ['NPC missing actor',s=>s.world!.npcBehaviors=[{actorId:'absent',kind:'idle'}]],
 ['NPC invalid target array',s=>s.world!.npcBehaviors=[{actorId:s.actors[0].id,kind:'hostile',targetKinds:'hero' as any}]],
 ['growth bad AP bonus',s=>s.actors[0].growth={tracks:{},bonuses:{'ap.perRound':1e-7}}],
 ['growth malformed track',s=>(s.actors[0]as any).growth={tracks:{main:{level:1,xp:'ten',totalXp:0,points:0}},bonuses:{}}],
 ['growth negative points',s=>s.actors[0].growth={tracks:{main:{level:1,xp:0,totalXp:0,points:-1}},bonuses:{}}],
 ['pending actor reference',s=>{s.world!.round.intents=[intent(s)];s.world!.round.intents[0].actorId='absent';}],
 ['pending ownership reference',s=>{s.world!.round.intents=[intent(s)];s.world!.round.intents[0].memberId='other';}],
 ['duplicate intents',s=>s.world!.round.intents=[intent(s),intent(s)]],
 ['duplicate items',s=>s.world!.items.push(structuredClone(s.world!.items[0]))],
 ['ended nonparticipant',s=>s.world!.round.ended=['absent']],
 ['missing job record',s=>s.world!.jobs=[{id:'job',actorId:s.actors[0].id,ruleId:'old-rule',completesRound:2}]],
 ['missing job actor',s=>s.world!.jobs=[{id:'job',actorId:'absent',ruleId:'old-rule',completesRound:2}]],
 ['malformed action list',s=>(s.actors[0]as any).customActions={id:'bad'}],
 ['malformed AI exchange',s=>s.world!.ai.exchanges=[{id:'exchange',worldRevision:0,round:1,kind:'turn_context',payload:null as any,createdAt:0,appliedDecisionIds:[]}]],
 ['malformed private AI receipt',s=>s.world!.ai.exchanges=[{id:'exchange',worldRevision:0,round:1,kind:'turn_context',payload:{_decisions:7},createdAt:0,appliedDecisionIds:[]}]],
];
for(const [name,mutate]of invalidCases)test(`backup rejects ${name} before snapshot or settlement`,()=>{const state=valid();mutate(state);assert.throws(()=>validateBackupState(state),(error:any)=>error.status===400&&error.code==='backup_invalid');});
test('valid fractional AP, retired history, partial drafts and frozen jobs remain restorable and hourly recovery is safe',()=>{
 const state=valid();state.actors[0].resources.find(r=>r.id==='ap')!.current=5.000001;state.world!.round.spent.hero=.000001;state.world!.drafts=[{id:'half',ownerId:'owner',kind:'rules',title:'',payload:{_editorText:'{"costs":',rules:{}},updatedAt:0}];state.world!.round.intents=[{...intent(state),actorId:'retired-character',status:'executed'}];state.world!.jobs=[{id:'job',actorId:'hero',ruleId:'removed-rule',completesRound:2}];state.actors[0].choices!._worldJobs={job:{outputs:[{itemId:'ore',quantity:1}],experience:[],unlockEntries:[]}};
 const source=structuredClone(state),restored=validateBackupState(state);assert.deepEqual(state,source);assert.equal(restored.world!.drafts[0].payload._editorText,'{"costs":');assert.equal(restored.world!.jobs[0].ruleId,'removed-rule');const result=advanceWorldTime(restored,{now:3600000,onlineMemberIds:[],members:[{id:'owner',name:'Owner',role:'gm'}],dice:()=>1,resolveEngine:engine.resolveCommand});assert.equal(result.state.actors[0].resources.find(r=>r.id==='ap')!.current,6.000001);
 const legacy=engine.createGameState('Old standard data');legacy.actors=[engine.createActor({name:'Old draft',draft:true})];assert.equal(validateBackupState(JSON.parse(JSON.stringify(legacy))).world,undefined);
});
async function apiFixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'jige-restore-validation-')),runtime=await createApplication({dataDir:directory,hostToken:'validation-host',now:()=>1000,dice:()=>1}),base=`http://127.0.0.1:${(await runtime.listen(0)).port}`;let cookie='';
 t.after(async()=>{await runtime.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('jige-restore-validation-'));await rm(directory,{recursive:true,force:true});});
 const request=async(path:string,body?:unknown)=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:base,'Content-Type':'application/json','X-Jige-Request':'1'})},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie')!.split(';')[0];return{status:response.status,data:await response.json() as any};};
 const created=await request('/api/campaigns',{hostToken:'validation-host',name:'Validation API',gmName:'Owner',mode:'co-create'});assert.equal(created.status,201);const command=async(type:string,payload:any)=>{const state=(await request('/api/state')).data;const result=await request('/api/command',{operationId:randomUUID(),expectedRev:state.state.rev,type,payload});assert.equal(result.status,200,JSON.stringify(result.data));return result.data.snapshot;};
 const template=valid().world!;await command('world.configure',{rules:template.rules,items:template.items,nodes:template.nodes});const offered=await command('character.create',{}),actorId=offered.offers[0].id;await command('character.register',{actorId,memberId:created.data.session.member.id,approved:true});await command('world.start',{});return{directory,runtime,request,actorId};
}
test('real SQLite restore rejects malformed worlds atomically, creates no backup side effects and accepts an unfinished draft',async t=>{
 const f=await apiFixture(t),archive=(await f.request('/api/export')).data,before=(await f.request('/api/state')).data.state,count=(f.runtime.db.prepare('SELECT COUNT(*) AS n FROM operations').get()as any).n;
 const httpCases=['AP current precision','round-spent precision','intent-cost precision','fractional energy clock','node missing item','NPC invalid target array','growth malformed track','missing job record','duplicate intents'];
 for(const [name,mutate]of invalidCases.filter(([name])=>httpCases.includes(name))){const backup=structuredClone(archive);mutate(backup.state);const result=await f.request('/api/restore',{backup});assert.equal(result.status,400,name+': '+JSON.stringify(result.data));assert.equal(result.data.code,'backup_invalid',name);assert.deepEqual((await f.request('/api/state')).data.state,before,name);assert.equal((f.runtime.db.prepare('SELECT COUNT(*) AS n FROM operations').get()as any).n,count,name);}
 const backups=await readdir(join(f.directory,'backups')).catch((error:any)=>{if(error.code==='ENOENT')return[];throw error;});assert.deepEqual(backups,[]);
 const valid=structuredClone(archive);valid.state.world.drafts.push({id:'half-saved',ownerId:valid.state.world.ownerId,kind:'rules',title:'Half',payload:{_editorText:'{"energy":'},updatedAt:1000});const restored=await f.request('/api/restore',{backup:valid});assert.equal(restored.status,200,JSON.stringify(restored.data));assert.equal(restored.data.snapshot.world.drafts[0].payload._editorText,'{"energy":');assert.equal(f.runtime.db.pragma('integrity_check',{simple:true}),'ok');
});
