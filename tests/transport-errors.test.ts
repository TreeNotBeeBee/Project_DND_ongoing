import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {build} from 'vite';
import {chromium,expect,type Browser,type Page,type BrowserContext} from '@playwright/test';
import {createApplication} from '../src/server/app.ts';
import type {GameClient} from '../src/client/transport.ts';

type ProbeWindow=Window&{probe:GameClient};
const project=resolve(fileURLToPath(new URL('..',import.meta.url)));
let browser:Browser,directory:string,dist:string;
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'jige-transport-build-'));dist=join(directory,'dist');
 await build({configFile:false,root:project,logLevel:'silent',plugins:[{name:'actual-transport-probe',resolveId(id){if(id==='virtual:transport-probe')return'\0transport-probe';},load(id){if(id==='\0transport-probe')return`import React from 'react';import {createRoot} from 'react-dom/client';import {useGame} from '/src/client/transport.ts';function Probe(){const game=useGame();window.probe=game;return React.createElement('main',null,React.createElement('output',{id:'error'},game.error),React.createElement('output',{id:'pending'},JSON.stringify(game.pending)));}createRoot(document.getElementById('root')).render(React.createElement(Probe));`;}}],build:{outDir:dist,emptyOutDir:true,target:'es2022',rollupOptions:{input:'virtual:transport-probe',output:{entryFileNames:'assets/probe.js'}}}});
 await writeFile(join(dist,'index.html'),'<!doctype html><div id="root"></div><script type="module" src="/assets/probe.js"></script>');
 browser=await chromium.launch({headless:true});
});
async function clean(directory:string,prefix:string){assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith(prefix));await rm(directory,{recursive:true,force:true});}
after(async()=>{await browser?.close();if(directory)await clean(directory,'jige-transport-build-');});
const snapshot=(page:Page)=>page.evaluate(()=>(window as unknown as ProbeWindow).probe.snapshot!);
const pending=(page:Page)=>page.evaluate(()=>(window as unknown as ProbeWindow).probe.pending);
const command=(page:Page,type:string,actorId?:string,payload:Record<string,unknown>={})=>page.evaluate(async args=>(window as unknown as ProbeWindow).probe.command(args.type,args.actorId,args.payload),{type,actorId,payload});
const retry=(page:Page,id:string,rebase=false)=>page.evaluate(async args=>(window as unknown as ProbeWindow).probe.retry(args.id,args.rebase),{id,rebase});
async function fixture(t:any){
 const dataDir=await mkdtemp(join(tmpdir(),'jige-transport-data-')),runtime=await createApplication({dataDir,distDir:dist,hostToken:'transport-browser-only'}),address=await runtime.listen(0),base=`http://127.0.0.1:${address.port}`,contexts:BrowserContext[]=[];
 t.after(async()=>{for(const context of contexts)await context.close();await runtime.close();await clean(dataDir,'jige-transport-data-');});
 const open=async(host=false)=>{const context=await browser.newContext();contexts.push(context);context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(20000);const page=await context.newPage();await page.goto(base+(host?'/#hostToken=transport-browser-only':'/'));await page.waitForFunction(()=>Boolean((window as unknown as ProbeWindow).probe)&&!(window as unknown as ProbeWindow).probe.loading);return page;};
 const page=await open(true);assert.equal(await page.evaluate(()=>(window as unknown as ProbeWindow).probe.authenticate('create',{name:'Transport test',gmName:'GM'})),true);await expect.poll(async()=>(await snapshot(page))?.session.member.role).toBe('gm');await expect.poll(()=>page.evaluate(()=>(window as unknown as ProbeWindow).probe.connection)).toBe('online');
 const count=()=>(runtime.db.prepare('SELECT COUNT(*) AS n FROM operations').get()as{n:number}).n;
 return{runtime,page,open,count};
}

test('a real rule 400 returns false, clears pending/persisted work and allows a corrected command',async t=>{
 const f=await fixture(t);assert.equal(await command(f.page,'actor.create',undefined,{name:'Draft',draft:true}),true);let state=(await snapshot(f.page)).state;const actor=state.actors[0],before=structuredClone(state),count=f.count();
 assert.equal(await command(f.page,'actor.update',actor.id,{patch:{hp:{current:999}}}),false);await expect(f.page.locator('#error')).toContainText('cannot be edited');assert.equal((await pending(f.page)).length,0);assert.equal(f.count(),count);assert.deepEqual((await snapshot(f.page)).state,before);
 assert.equal(await f.page.evaluate(()=>{const g=(window as unknown as ProbeWindow).probe,s=g.snapshot!;return localStorage.getItem(`jigerpg_v1_pending:${s.session.campaignId}:${s.session.member.id}`);}),null);
 assert.equal(await command(f.page,'actor.update',actor.id,{patch:{name:'Corrected'}}),true);await expect.poll(async()=>(await snapshot(f.page)).state.actors[0].name).toBe('Corrected');assert.equal(await f.page.locator('#error').textContent(),'');assert.equal(f.count(),count+1);
});
test('a real permission 403 is reported without preventing a subsequent legal player operation',async t=>{
 const f=await fixture(t),invite=(await snapshot(f.page)).inviteCode!,player=await f.open();assert.equal(await player.evaluate(invite=>(window as unknown as ProbeWindow).probe.authenticate('join',{inviteCode:invite,name:'Player'}),invite),true);await expect.poll(async()=>(await snapshot(player))?.session.member.role).toBe('player');const count=f.count();
 assert.equal(await command(player,'gm.pause',undefined,{paused:true}),false);await expect(player.locator('#error')).toContainText('只有主持人');assert.equal((await pending(player)).length,0);assert.equal(f.count(),count);assert.equal(await command(player,'actor.create',undefined,{name:'Own draft',draft:true}),true);assert.equal((await snapshot(player)).state.actors[0].name,'Own draft');
});
test('a real revision 409 retains explicit conflict review and rebases only after user confirmation',async t=>{
 const f=await fixture(t);await command(f.page,'actor.create',undefined,{name:'Conflict draft',draft:true});const before=await snapshot(f.page),actor=before.state.actors[0];
 await f.page.route('**/api/command',async route=>{const old=JSON.parse(route.request().postData()!);await f.page.request.post(new URL('/api/command',f.page.url()).href,{headers:{Origin:new URL(f.page.url()).origin,'X-Jige-Request':'1'},data:{operationId:randomUUID(),expectedRev:old.expectedRev,type:'gm.pause',payload:{paused:false}}});await route.continue();},{times:1});
 assert.equal(await command(f.page,'actor.update',actor.id,{patch:{name:'Rebased'}}),false);await expect.poll(async()=>(await pending(f.page))[0]?.status).toBe('conflict');const original=(await pending(f.page))[0];assert.equal(original.outcomeUnknown,false);assert.equal((await snapshot(f.page)).state.actors[0].name,'Conflict draft');assert.equal(await retry(f.page,original.command.operationId,true),true);assert.equal((await pending(f.page)).length,0);assert.equal((await snapshot(f.page)).state.actors[0].name,'Rebased');
});
for(const mode of ['missing-ack','server-error']as const)test(`a committed command with ${mode} retains its operation ID until one duplicate ACK confirms it`,async t=>{
 const f=await fixture(t),count=f.count();await f.page.route('**/api/command',async route=>{const actual=await route.fetch({timeout:15000});assert.equal(actual.status(),200);await route.fulfill(mode==='missing-ack'?{status:200,json:{ok:true}}:{status:500,json:{error:'ACK unavailable',code:'server_error'}});},{times:1});
 assert.equal(await command(f.page,'actor.create',undefined,{name:'Exactly once',draft:true}),false);const row=(await pending(f.page))[0];assert.equal(row.status,'queued');assert.equal(row.outcomeUnknown,true);assert.equal(f.count(),count+1);assert.equal(await retry(f.page,row.command.operationId,true),true);assert.equal(f.count(),count+1);assert.equal((await pending(f.page)).length,0);assert.equal((await snapshot(f.page)).state.actors.filter(a=>a.name==='Exactly once').length,1);
});

test('a lost committed ACK remains uncertain through real 403, 400 and expired-session 401 responses',async t=>{
 const f=await fixture(t),count=f.count(),recoveryCode=await f.page.evaluate(()=>(window as unknown as ProbeWindow).probe.recoveryCode),attempts:string[]=[];
 await f.page.route('**/api/command',async route=>{attempts.push(JSON.parse(route.request().postData()!).operationId);const actual=await route.fetch();assert.equal(actual.status(),200);await route.abort('connectionreset');},{times:1});
 assert.equal(await command(f.page,'actor.create',undefined,{name:'Lost ACK once',draft:true}),false);const original=(await pending(f.page))[0];assert.equal(original.outcomeUnknown,true);assert.equal(f.count(),count+1);
 for(const status of [403,400]){
  await f.page.route('**/api/command',async route=>{attempts.push(JSON.parse(route.request().postData()!).operationId);const actual=await route.fetch(status===403?{headers:{...route.request().headers(),'x-jige-request':'0'}}:{postData:'{invalid JSON'});assert.equal(actual.status(),status);await route.fulfill({response:actual});},{times:1});
  assert.equal(await retry(f.page,original.command.operationId,true),false);const row=(await pending(f.page))[0];assert.equal(row.command.operationId,original.command.operationId);assert.equal(row.status,'queued');assert.equal(row.outcomeUnknown,true);assert.match(row.error!,/结果尚未确认/);assert.equal(f.count(),count+1);
 }
 assert.equal(await f.page.evaluate(async()=>{const response=await fetch('/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Jige-Request':'1'},body:'{}'});return response.status;}),200);
 await f.page.route('**/api/command',async route=>{attempts.push(JSON.parse(route.request().postData()!).operationId);const actual=await route.fetch();assert.equal(actual.status(),401);await route.fulfill({response:actual});},{times:1});
 assert.equal(await retry(f.page,original.command.operationId,true),false);assert.equal((await pending(f.page))[0].outcomeUnknown,true);assert.equal(f.count(),count+1);
 assert.equal(await f.page.evaluate(code=>(window as unknown as ProbeWindow).probe.authenticate('recover',{recoveryCode:code}),recoveryCode),true);
 await f.page.route('**/api/command',async route=>{attempts.push(JSON.parse(route.request().postData()!).operationId);const actual=await route.fetch();assert.equal(actual.status(),200);assert.equal((await actual.json()).duplicate,true);await route.fulfill({response:actual});},{times:1});
 assert.equal(await retry(f.page,original.command.operationId,true),true);assert.deepEqual(attempts,Array(5).fill(original.command.operationId));assert.equal(f.count(),count+1);assert.equal((await pending(f.page)).length,0);assert.equal((await snapshot(f.page)).state.actors.filter(a=>a.name==='Lost ACK once').length,1);
});

for(const committed of [true,false])test(`a persisted legacy rejected row recovers conservatively when its original command ${committed?'committed':'was rejected'}`,async t=>{
 const f=await fixture(t);if(!committed)await command(f.page,'actor.create',undefined,{name:'Legacy draft',draft:true});const before=await snapshot(f.page),count=f.count(),original={operationId:randomUUID(),expectedRev:before.state.rev,type:committed?'actor.create':'actor.update',...(committed?{}:{actorId:before.state.actors[0].id}),payload:committed?{name:'Legacy committed',draft:true}:{patch:{hp:{current:999}}},targetIds:[]};
 assert.equal(await f.page.evaluate(async input=>{const response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-Jige-Request':'1'},body:JSON.stringify(input)});return response.status;},original),committed?200:400);
 await f.page.evaluate(input=>{const s=(window as unknown as ProbeWindow).probe.snapshot!;localStorage.setItem(`jigerpg_v1_pending:${s.session.campaignId}:${s.session.member.id}`,JSON.stringify([{command:input,label:'Old saved request',status:'rejected',error:'Old client did not distinguish ACK failures'}]));},original);
 await f.page.reload();await expect.poll(async()=>(await pending(f.page))[0]?.outcomeUnknown).toBe(true);const restored=(await pending(f.page))[0];assert.equal(restored.command.operationId,original.operationId);assert.equal(restored.status,'queued');assert.match(restored.error!,/结果需核验/);
 assert.equal(await retry(f.page,original.operationId,true),committed);assert.equal(f.count(),count+Number(committed));
 if(committed){assert.equal((await pending(f.page)).length,0);assert.equal((await snapshot(f.page)).state.actors.filter(a=>a.name==='Legacy committed').length,1);}
 else{assert.equal((await pending(f.page))[0].command.operationId,original.operationId);assert.equal((await pending(f.page))[0].outcomeUnknown,true);await f.page.evaluate(id=>(window as unknown as ProbeWindow).probe.discard(id),original.operationId);assert.equal(await command(f.page,'actor.update',before.state.actors[0].id,{patch:{name:'Legacy corrected'}}),true);assert.equal((await snapshot(f.page)).state.actors[0].name,'Legacy corrected');}
});

test('an in-flight request cannot be rebased, discarded or replaced before its acknowledgement',async t=>{
 const f=await fixture(t),count=f.count();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());await f.page.route('**/api/command',async route=>{await gate;await route.continue();},{times:1});
 const active=command(f.page,'actor.create',undefined,{name:'In flight once',draft:true});await expect.poll(async()=>(await pending(f.page))[0]?.status).toBe('sending');const original=(await pending(f.page))[0];
 try{assert.equal(await retry(f.page,original.command.operationId,true),false);assert.equal(await command(f.page,'actor.create',undefined,{name:'Blocked second',draft:true}),false);await f.page.evaluate(id=>(window as unknown as ProbeWindow).probe.discard(id),original.command.operationId);assert.equal((await pending(f.page))[0].command.operationId,original.command.operationId);}finally{release();}
 assert.equal(await active,true);assert.equal((await pending(f.page)).length,0);assert.equal(f.count(),count+1);assert.deepEqual((await snapshot(f.page)).state.actors.map(a=>a.name),['In flight once']);
});
