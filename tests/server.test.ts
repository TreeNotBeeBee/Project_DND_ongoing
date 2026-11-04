import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { createApplication,DEFAULT_BODY_LIMITS } from '../src/server/app.js';
import { onlineBackup } from '../src/server/database.js';
import type { Actor,GameState,Command } from '../src/shared/model.js';

function actor(input:any={}):Actor{return{id:input.id||randomUUID(),name:input.name||'Hero',kind:'hero',ownerId:input.ownerId||'',abilities:{str:10,dex:10,con:10,int:10,wis:10,cha:10},classes:[],speciesId:'human',backgroundId:'',hp:{current:10,max:10,temp:0},deathSaves:{successes:0,failures:0},skills:[],expertise:[],saveProficiencies:[],languages:[],resources:[],inventory:[],spells:[],features:[],effects:[],position:{x:0,y:0},hidden:false,notes:'',...input};}
const fixtureEngine={
  createGameState(name:string):GameState{return{id:randomUUID(),name,rev:0,actors:[],scene:{width:30,height:20,gridFeet:5,walls:[],terrain:[],fog:false},combat:{active:false,round:1,turn:0,order:[],budgets:{}},choices:[],paused:false,events:[]};},
  resolveCommand(state:GameState,c:Command){const next=structuredClone(state);const p:any=c.payload||{};if(c.type==='actor.create')next.actors.push(actor(p.actor||p));else if(c.type==='gm.pause')next.paused=!!p.paused;else if(c.type==='gm.adjust'){const a=next.actors.find(a=>a.id===c.actorId)!;a.hp.current=Number(p.hp);if(a.hp.current<0)throw new Error('HP cannot be negative');}else if(c.type==='choice.resolve')next.choices=next.choices.filter(v=>v.id!==p.choiceId);else if(c.type==='actor.update')Object.assign(next.actors.find(a=>a.id===c.actorId)!,p.patch||p);else if(c.type==='action.use')next.actors.find(a=>a.id===c.actorId)!.hp.current--;return{state:next,events:[{type:c.type,actorId:c.actorId,message:'committed'}]};},
  projectState(state:GameState){return state;},validateActor(){return[];},
  migrateLegacy(payload:any,fingerprint:string){const id=`migrated-${fingerprint.slice(0,8)}`;return{actors:[actor({id,name:payload.name||'Old',draft:true})],report:{id:randomUUID(),fingerprint,version:1,importedAt:new Date().toISOString(),actors:[{oldId:'old',newId:id,issues:['review']}],issues:[],original:payload}};}
};
async function setup(t:any,bodyLimits?:Partial<typeof DEFAULT_BODY_LIMITS>){
  const dir=await mkdtemp(join(tmpdir(),'jige-server-'));const dist=join(dir,'dist');await mkdir(join(dist,'assets'),{recursive:true});await writeFile(join(dist,'index.html'),'<h1>new app</h1>');await writeFile(join(dist,'assets','app.js'),'export{};');
  const runtime=await createApplication({dataDir:join(dir,'data'),distDir:dist,engine:fixtureEngine,content:{entries:[],coverage:{automatic:0}},hostToken:'local-host-secret',bodyLimits});const address=await runtime.listen(0);const base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
  const client=()=>{let cookie='';return{get cookie(){return cookie;},async request(path:string,body?:any,headers:Record<string,string>={}){const res=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json','origin':base,'x-jige-request':'1'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];let data:any;try{data=await res.json();}catch{data=null;}return{status:res.status,data,headers:res.headers};}};};
  const gm=client();const created=await gm.request('/api/campaigns',{name:'test campaign',gmName:'GM',hostToken:runtime.hostToken});assert.equal(created.status,201);const inviteCode=created.data.inviteCode;
  const player=client();const joined=await player.request('/api/join',{inviteCode,name:'Player'});assert.equal(joined.status,200);
  const command=(who:any,type:string,payload:any={},actorId?:string,rev?:number,operationId=randomUUID())=>who.request('/api/command',{operationId,expectedRev:rev??0,type,...(actorId?{actorId}:{}),payload});
  return{dir,dist,runtime,base,gm,player,client,created,joined,inviteCode,command};
}

test('cookie auth, origin and host bootstrap boundaries',async t=>{
  const f=await setup(t);assert.equal((await f.client().request('/api/state')).status,401);
  assert.equal((await f.client().request('/api/campaigns',{name:'bad',hostToken:'wrong'})).status,403);
  assert.equal((await f.gm.request('/api/logout',{}, {'origin':'https://evil.example'})).status,403);
  assert.equal((await f.gm.request('/api/logout',{}, {'x-jige-request':'0'})).status,403);
  assert.equal((await f.gm.request('/api/host')).status,403);
  f.runtime.setPublicOrigin('https://exact-name.trycloudflare.com');
  const host=await f.gm.request('/api/host',undefined,{'x-jige-host-token':f.runtime.hostToken});assert.equal(host.status,200);assert.equal(host.data.url,'https://exact-name.trycloudflare.com');assert.equal(host.data.localUrl,f.base.replace('127.0.0.1','localhost'));assert.match(host.data.qrDataUrl,/^data:image\/png/);
  assert.equal((await f.gm.request('/api/logout',{}, {'origin':'http://localhost:8080'})).status,403);
  assert.throws(()=>f.runtime.setPublicOrigin('https://evil.example'));
});
test('owned commands, hidden projection, stale revisions and atomic failure',async t=>{
  const f=await setup(t);const made=await f.command(f.player,'actor.create',{name:'Player Hero',ownerId:'forged'});assert.equal(made.status,200);const a=made.data.snapshot.state.actors[0];assert.equal(a.ownerId,f.joined.data.session.member.id);
  const stale=await f.command(f.player,'actor.update',{patch:{notes:'stale'}},a.id,0);assert.equal(stale.status,409);assert.equal(stale.data.snapshot.state.rev,1);
  const no=await f.command(f.player,'gm.adjust',{hp:1},a.id,1);assert.equal(no.status,403);
  const protectedWrite=await f.command(f.player,'actor.update',{patch:{hp:{current:999}}},a.id,1);assert.equal(protectedWrite.status,403);
  const bad=await f.command(f.gm,'gm.adjust',{hp:-20},a.id,1);assert.equal(bad.status,400);assert.equal((await f.gm.request('/api/state')).data.state.rev,1);
  const monster=await f.command(f.gm,'actor.create',{name:'Hidden dragon',hidden:true,notes:'secret'},undefined,1);assert.equal(monster.status,200);
  const playerState=(await f.player.request('/api/state')).data;assert.equal(playerState.state.actors.length,1);assert.equal(playerState.inviteCode,undefined);
});
test('idempotency survives retries and rejects reused operation identifiers',async t=>{
  const f=await setup(t);const op=randomUUID();const first=await f.command(f.player,'actor.create',{name:'Hero'},undefined,0,op);const again=await f.command(f.player,'actor.create',{name:'Hero'},undefined,0,op);assert.equal(first.status,200);assert.equal(again.status,200);assert.equal(again.data.duplicate,true);assert.equal(again.data.snapshot.state.actors.length,1);assert.deepEqual(again.data.events,first.data.events);
  const collision=await f.command(f.player,'actor.create',{name:'Different'},undefined,0,op);assert.equal(collision.status,409);assert.equal(collision.data.code,'operation_reused');
});
test('simultaneous clients cannot overwrite newer authoritative state',async t=>{
  const f=await setup(t);const results=await Promise.all([f.command(f.player,'actor.create',{name:'A'}),f.command(f.player,'actor.create',{name:'B'})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await f.player.request('/api/state')).data.state.actors.length,1);
});
test('GM undo is persistent, monotonic and idempotent',async t=>{
  const f=await setup(t);const created=await f.command(f.player,'actor.create',{name:'Undo me'});const id=created.data.snapshot.state.actors[0].id;await f.command(f.gm,'gm.adjust',{hp:2},id,1);const op=randomUUID();const undone=await f.command(f.gm,'gm.undo',{},undefined,2,op);assert.equal(undone.status,200);assert.equal(undone.data.snapshot.state.actors[0].hp.current,10);assert.equal(undone.data.snapshot.state.rev,3);const retry=await f.command(f.gm,'gm.undo',{},undefined,2,op);assert.equal(retry.data.duplicate,true);assert.equal(retry.data.snapshot.state.rev,3);
});
test('copy migration is transactional, deduplicated and preserves original',async t=>{
  const f=await setup(t);const payload={name:'Original legacy',physicalResist:80};const a=await f.player.request('/api/migrate',{payload});const b=await f.player.request('/api/migrate',{payload});assert.equal(a.status,200);assert.equal(b.data.snapshot.state.actors.length,1);assert.deepEqual(a.data.report.original,payload);assert.equal(a.data.snapshot.state.actors[0].ownerId,f.joined.data.session.member.id);
});
test('draft privilege changes and inventory grants require GM approval',async t=>{
  const f=await setup(t);const created=await f.command(f.player,'actor.create',{name:'Draft',hp:{current:999,max:999,temp:0},kind:'monster',draft:false,choices:{characterBuild:{method:'standard'},hpRolls:{fighter:[999]},monsterId:'tarrasque',conditionImmunities:['unconscious']}});const a=created.data.snapshot.state.actors[0];assert.equal(a.kind,'hero');assert.equal(a.hp.max,10);assert.equal(a.draft,true);assert.equal(a.choices.hpRolls,undefined);assert.equal(a.choices.monsterId,undefined);assert.equal(a.choices.conditionImmunities,undefined);assert.equal(a.choices.characterBuild.method,'standard');
  const kind=await f.command(f.player,'actor.update',{patch:{kind:'monster'}},a.id,1);assert.equal(kind.status,403);
  const activate=await f.command(f.player,'actor.update',{patch:{draft:false}},a.id,1);assert.equal(activate.status,409);
  const grant=await f.command(f.player,'inventory.add',{contentId:'unlimited'},a.id,1);assert.equal(grant.status,403);
  assert.equal((await f.command(f.player,'gm.poisonExposure',{itemId:'fake'},a.id,1)).status,403);
});
test('backup restore validates ownership, malformed state, migration undo and monotonic revision',async t=>{
  const f=await setup(t);await f.player.request('/api/migrate',{payload:{name:'Archived'}});const exported=await f.gm.request('/api/export');assert.equal(exported.data.format,'jigerpg-campaign');assert.equal((await f.player.request('/api/restore',{backup:exported.data})).status,403);
  const malformed=structuredClone(exported.data);malformed.state.actors[0].hp='broken';assert.equal((await f.gm.request('/api/restore',{backup:malformed})).status,400);
  const undone=await f.command(f.gm,'gm.undo',{},undefined,1);assert.equal(undone.status,200);assert.equal(undone.data.snapshot.state.actors.length,0);
  const remigrate=await f.player.request('/api/migrate',{payload:{name:'Archived'}});assert.equal(remigrate.data.snapshot.state.actors.length,1);
  const restored=await f.gm.request('/api/restore',{backup:exported.data});assert.equal(restored.status,200);assert.equal(restored.data.snapshot.state.rev,4);assert.equal(restored.data.snapshot.state.actors.length,1);
  assert.equal((await f.player.request('/api/export')).data.migrations,undefined);
});
test('twelve member seats include offline members and GM',async t=>{
  const f=await setup(t);for(let i=0;i<10;i++)assert.equal((await f.client().request('/api/join',{inviteCode:f.inviteCode,name:'P'+i})).status,200);assert.equal((await f.client().request('/api/join',{inviteCode:f.inviteCode,name:'overflow'})).status,409);const recovered=await f.client().request('/api/recover',{recoveryCode:f.joined.data.recoveryCode});assert.equal(recovered.status,200);assert.equal(recovered.data.session.member.id,f.joined.data.session.member.id);
});
test('pending choices are private, persisted, and only resolvable by owner or GM',async t=>{
  const f=await setup(t);const created=await f.command(f.player,'actor.create',{name:'Chooser'});const actorId=created.data.snapshot.state.actors[0].id;const campaignId=created.data.snapshot.state.id;
  const row:any=f.runtime.db.prepare('SELECT state FROM campaigns WHERE id=?').get(campaignId);const state=JSON.parse(row.state);state.choices.push({id:'pending-choice',actorId,ownerId:f.joined.data.session.member.id,kind:'reaction',prompt:'Spend a reaction?',options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],payload:{trigger:'attack'}});f.runtime.db.prepare('UPDATE campaigns SET state=? WHERE id=?').run(JSON.stringify(state),campaignId);
  const other=f.client();await other.request('/api/join',{inviteCode:f.inviteCode,name:'Other'});assert.equal((await other.request('/api/state')).data.state.choices.length,0);assert.equal((await f.player.request('/api/state')).data.state.choices.length,1);
  const denied=await f.command(other,'choice.resolve',{choiceId:'pending-choice',optionId:'yes'},undefined,1);assert.equal(denied.status,403);const resolved=await f.command(f.player,'choice.resolve',{choiceId:'pending-choice',optionId:'no'},undefined,1);assert.equal(resolved.status,200);assert.equal(resolved.data.snapshot.state.choices.length,0);
});
test('unrevealed effects are absent from player state and own actor export while retained in GM backups',async t=>{
  const f=await setup(t);const made=await f.command(f.player,'actor.create',{name:'Secret target'});const campaignId=made.data.snapshot.state.id;const row:any=f.runtime.db.prepare('SELECT state FROM campaigns WHERE id=?').get(campaignId);const state=JSON.parse(row.state);state.actors[0].effects.push({id:'secret-midnight-controller',name:'Unrevealed Midnight Tears',gmOnly:true});f.runtime.db.prepare('UPDATE campaigns SET state=? WHERE id=?').run(JSON.stringify(state),campaignId);
  assert.equal(JSON.stringify((await f.player.request('/api/state')).data).includes('Unrevealed Midnight Tears'),false);assert.equal(JSON.stringify((await f.player.request('/api/export')).data).includes('Unrevealed Midnight Tears'),false);assert.equal(JSON.stringify((await f.gm.request('/api/export')).data).includes('Unrevealed Midnight Tears'),true);
});
test('private inventory receipt events reach only the owner and GM, not unrelated players',async t=>{
  const f=await setup(t);const made=await f.command(f.player,'actor.create',{name:'Carrier'});const campaignId=made.data.snapshot.state.id;const row:any=f.runtime.db.prepare('SELECT state FROM campaigns WHERE id=?').get(campaignId);const state=JSON.parse(row.state);state.events.push({id:'private-grant',sequence:99,operationId:'private-grant-operation',type:'inventory',actorId:state.actors[0].id,message:'Carrier receives Midnight Tears',timestamp:new Date().toISOString()});f.runtime.db.prepare('UPDATE campaigns SET state=? WHERE id=?').run(JSON.stringify(state),campaignId);
  const viewer=f.client();await viewer.request('/api/join',{inviteCode:f.inviteCode,name:'Other player'});assert.equal(JSON.stringify((await viewer.request('/api/state')).data).includes('Midnight Tears'),false);assert.equal(JSON.stringify((await f.player.request('/api/state')).data).includes('Midnight Tears'),true);assert.equal(JSON.stringify((await f.gm.request('/api/state')).data).includes('Midnight Tears'),true);
});
test('recovery code and committed state survive server restart and new tunnel URL',async t=>{
  const f=await setup(t);await f.command(f.player,'actor.create',{name:'Persistent'});const serverId=f.runtime.serverId;await f.runtime.close();
  const resumed=await createApplication({dataDir:join(f.dir,'data'),engine:fixtureEngine,content:{entries:[],coverage:{}},hostToken:'new-host-secret'});const address=await resumed.listen(0);resumed.setPublicOrigin('https://new-address.trycloudflare.com');const base=`http://127.0.0.1:${address.port}`;
  try{const res=await fetch(base+'/api/recover',{method:'POST',headers:{'content-type':'application/json','origin':'https://new-address.trycloudflare.com','x-jige-request':'1'},body:JSON.stringify({recoveryCode:f.joined.data.recoveryCode})});const data:any=await res.json();assert.equal(res.status,200);assert.equal(data.session.member.id,f.joined.data.session.member.id);assert.equal(data.state.actors[0].name,'Persistent');assert.equal(resumed.serverId,serverId);}finally{await resumed.close();}
});
test('online WAL backup contains committed campaign and credentials',async t=>{
  const f=await setup(t);await f.command(f.player,'actor.create',{name:'Backed up'});const path=await onlineBackup(f.runtime.db,join(f.dir,'backups'));const db=new Database(path,{readonly:true});try{assert.equal(db.pragma('integrity_check',{simple:true}),'ok');const row:any=db.prepare('SELECT state FROM campaigns').get();assert.equal(JSON.parse(row.state).actors[0].name,'Backed up');assert.equal((db.prepare('SELECT COUNT(*) AS n FROM members').get() as any).n,2);}finally{db.close();}
});
test('only production assets and documented APIs are public',async t=>{
  const f=await setup(t);for(const path of ['/.git/config','/node_modules/koa/package.json','/src/server/app.ts','/data/game.sqlite','/room_server.mjs','/scripts/host.mjs','/package.json','/assets/%2e%2e/package.json'])assert.equal((await fetch(f.base+path)).status,404,path);assert.equal((await fetch(f.base+'/')).status,200);assert.equal((await fetch(f.base+'/assets/app.js')).status,200);
});
test('authenticated WebSocket receives committed snapshots and rejects outsider origins',async t=>{
  const f=await setup(t);const ws=new WebSocket(f.base.replace('http:','ws:')+'/ws',{headers:{origin:f.base,cookie:f.player.cookie}});const first=once(ws,'message');await once(ws,'open');const [raw]=await first;assert.equal(JSON.parse(String(raw)).type,'snapshot');const push=once(ws,'message');await f.command(f.gm,'gm.pause',{paused:true});const[next]=await push;assert.equal(JSON.parse(String(next)).snapshot.state.paused,true);ws.close();await once(ws,'close');
  const outsider=new WebSocket(f.base.replace('http:','ws:')+'/ws',{headers:{origin:'https://evil.example',cookie:f.player.cookie}});await new Promise<void>(ok=>{outsider.on('unexpected-response',(_req,res)=>{assert.equal(res.statusCode,403);res.resume();outsider.terminate();ok();});outsider.on('error',()=>{});});
});
test('migration/restore use a 64 MiB default, with route-specific UTF8 byte limits and small public auth bodies',async t=>{
  assert.equal(DEFAULT_BODY_LIMITS.large,64*1024*1024);assert.equal(DEFAULT_BODY_LIMITS.command,12*1024*1024);assert.equal(DEFAULT_BODY_LIMITS.small,16*1024);
  const f=await setup(t,{large:512,command:2048,small:256});
  const oversized=await f.player.request('/api/migrate',{payload:{name:'x'.repeat(700)}});assert.equal(oversized.status,413);assert.equal(oversized.data.code,'body_too_large');assert.equal(oversized.data.limitBytes,512);
  const utf8=await f.player.request('/api/migrate',{payload:{name:'龙'.repeat(180)}});assert.equal(utf8.status,413);
  const small=await f.client().request('/api/join',{inviteCode:f.inviteCode,name:'x'.repeat(300)});assert.equal(small.status,413);assert.equal(small.data.limitBytes,256);
  const trailing=await f.client().request('/api/join/',{inviteCode:f.inviteCode,name:'x'.repeat(300)});assert.equal(trailing.status,413);assert.equal(trailing.data.limitBytes,256);
  assert.equal((await f.command(f.gm,'gm.pause',{paused:true,note:'x'.repeat(700)})).status,200);
  const legal=await f.player.request('/api/migrate',{payload:{name:'合法旧角色'}});assert.equal(legal.status,200);
});
test('large-body routes verify cookie, restore role and Origin before JSON parsing or size rejection',async t=>{
  const f=await setup(t,{large:512});const bad='{'+ 'x'.repeat(2000);
  const request=async(path:string,cookie?:string,origin=f.base)=>{const response=await fetch(f.base+path,{method:'POST',headers:{'content-type':'application/json','origin':origin,'x-jige-request':'1',...(cookie?{cookie}:{})},body:bad});return{status:response.status,data:await response.json()as any};};
  assert.equal((await request('/api/migrate')).status,401);assert.equal((await request('/api/restore',f.player.cookie)).status,403);assert.equal((await request('/api/migrate',f.player.cookie,'https://evil.example')).status,403);const authed=await request('/api/restore',f.gm.cookie);assert.equal(authed.status,413);assert.equal(authed.data.limitBytes,512);
  assert.equal((await request('/api/migrate/')).status,401);assert.equal((await request('/api/restore/',f.player.cookie)).status,403);const trailing=await request('/api/restore/',f.gm.cookie);assert.equal(trailing.status,413);assert.equal(trailing.data.limitBytes,512);
});
test('authenticated large-body rate limit runs before reading a subsequent malformed upload',async t=>{
  const f=await setup(t,{large:512});for(let i=0;i<10;i++)assert.equal((await f.player.request('/api/migrate',{})).status,400);
  const response=await fetch(f.base+'/api/migrate/',{method:'POST',headers:{cookie:f.player.cookie,'content-type':'application/json',origin:f.base,'x-jige-request':'1'},body:'{'+ 'x'.repeat(2000)});assert.equal(response.status,429);assert.equal((await response.json()as any).code,'rate_limit');
});
