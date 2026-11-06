// Deliberately manual: this opens real temporary Cloudflare tunnels against
// isolated QA data, then closes both tunnels and the local server.
import {register} from 'tsx/esm/api';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
register();
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {createApplication}=await import('../src/server/app.ts');
const dataDir=resolve(root,'work/public-recovery-'+randomUUID());
const binary=process.env.JIGE_CLOUDFLARED||resolve(root,'.tools/cloudflared.exe');
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
let runtime,child;
async function stopTunnel(){const owned=child;child=undefined;if(!owned||owned.exitCode!==null)return;await new Promise(ok=>{const timeout=setTimeout(ok,5000);timeout.unref();owned.once('exit',()=>{clearTimeout(timeout);ok();});owned.kill();});}
async function startTunnel(port){
  assert(!child,'Previous tunnel must be closed first');
  child=spawn(binary,['tunnel','--url',`http://127.0.0.1:${port}`],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const owned=child;let diagnostics='',lastFailure='';
  const origin=await new Promise((ok,no)=>{
    const timeout=setTimeout(()=>no(new Error('Quick Tunnel URL timed out')),60_000);
    const read=data=>{diagnostics=(diagnostics+String(data)).slice(-16000);const url=diagnostics.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0];if(url){clearTimeout(timeout);ok(url);}};
    owned.stdout.on('data',read);owned.stderr.on('data',read);
    owned.once('error',error=>{clearTimeout(timeout);no(error);});
    owned.once('exit',code=>{clearTimeout(timeout);no(new Error('Quick Tunnel stopped: '+code));});
  });
  runtime.setPublicOrigin(origin);
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline){
    try{const response=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(10_000)});if(response.ok)return origin;lastFailure='HTTP '+response.status;}catch(error){lastFailure=error.message+' ('+(error.cause?.code||error.name)+')';}
    if(owned.exitCode!==null)throw new Error('Quick Tunnel exited during readiness');
    await delay(1000);
  }
  throw new Error('Quick Tunnel HTTPS did not become reachable at '+origin+': '+lastFailure+'\n'+diagnostics.slice(-1800));
}
async function post(origin,path,body,cookie=''){
  const response=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Jige-Request':'1',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
  const payload=await response.json();assert.ok(response.ok,JSON.stringify({status:response.status,payload}));
  return{payload,cookie:response.headers.get('set-cookie')?.split(';')[0],setCookie:response.headers.get('set-cookie')};
}
async function socketSnapshot(origin,cookie){
  const ws=new WebSocket(origin.replace('https:','wss:')+'/ws',{headers:{Origin:origin,Cookie:cookie},handshakeTimeout:30_000});
  try{return await new Promise((ok,no)=>{
    const timer=setTimeout(()=>no(new Error('WSS snapshot timed out')),30_000);
    ws.on('error',error=>{clearTimeout(timer);no(error);});
    ws.on('message',data=>{const message=JSON.parse(String(data));if(message.type==='ping')ws.send(JSON.stringify({type:'pong'}));if(message.type==='snapshot'){clearTimeout(timer);ok(message.snapshot);}});
  });}finally{ws.close();}
}
try{
  runtime=await createApplication({dataDir,distDir:resolve(root,'dist')});
  let address=await runtime.listen(0),local='http://localhost:'+address.port;
  const gm=await post(local,'/api/campaigns',{name:'Real public recovery QA',gmName:'QA GM',hostToken:runtime.hostToken,mode:'co-create',governance:{system:'democracy',ownerVeto:true}});
  const first=await startTunnel(address.port);
  const joined=await post(first,'/api/join',{inviteCode:gm.payload.inviteCode,name:'QA mobile player'});
  assert.match(joined.setCookie,/Secure/);
  const command={operationId:randomUUID(),expectedRev:gm.payload.state.rev,type:'character.create',payload:{actor:{name:'Persistent public actor'}}};
  const committed=await post(local,'/api/command',command,gm.cookie);
  const actorId=committed.payload.snapshot.offers[0].id;
  const requested=await post(first,'/api/command',{operationId:randomUUID(),expectedRev:committed.payload.snapshot.state.rev,type:'character.claim',payload:{actorId}},joined.cookie);
  const registered=await post(local,'/api/command',{operationId:randomUUID(),expectedRev:requested.payload.snapshot.state.rev,type:'character.register',payload:{actorId,approved:true}},gm.cookie);
  const privateNpc=await post(local,'/api/command',{operationId:randomUUID(),expectedRev:registered.payload.snapshot.state.rev,type:'character.create',payload:{actor:{name:'Private QA creature',kind:'monster',hidden:true}}},gm.cookie);
  const confirmed=privateNpc.payload.snapshot,observed=await socketSnapshot(first,joined.cookie);
  assert.equal(observed.state.rev,confirmed.state.rev);assert.equal(observed.state.actors.length,1);assert.equal(observed.state.actors[0].id,actorId);
  assert.ok(!JSON.stringify(observed).includes('Private QA creature'));assert.equal(observed.world.governance.ownerVeto,true);
  const page=await fetch(first+'/');assert.equal(page.status,200);assert.match(await page.text(),/assets\/app-/);
  for(const path of ['/.git/config','/data/game.sqlite','/src/server/app.ts','/node_modules/koa/package.json'])assert.equal((await fetch(first+path)).status,404);
  console.log(JSON.stringify({firstTunnel:true,https:true,secureCookie:true,wss:true,privateFilesBlocked:true}));
  await stopTunnel();runtime.setPublicOrigin(null,'QA tunnel intentionally stopped');
  assert.equal((await fetch(local+'/api/health')).status,200);
  const serverId=runtime.serverId;
  await runtime.close();runtime=await createApplication({dataDir,distDir:resolve(root,'dist')});
  address=await runtime.listen(0);local='http://localhost:'+address.port;
  const second=await startTunnel(address.port);assert.notEqual(second,first);assert.equal(runtime.serverId,serverId);
  const recovered=await post(second,'/api/recover',{recoveryCode:joined.payload.recoveryCode});
  assert.equal(recovered.payload.session.member.id,joined.payload.session.member.id);
  const reconnected=await socketSnapshot(second,recovered.cookie);assert.equal(reconnected.state.rev,confirmed.state.rev);assert.equal(reconnected.state.actors[0].id,actorId);assert.ok(!JSON.stringify(reconnected).includes('Private QA creature'));
  const gmRecovered=await post(second,'/api/recover',{recoveryCode:gm.payload.recoveryCode});
  const duplicate=await post(second,'/api/command',command,gmRecovered.cookie);
  assert.equal(duplicate.payload.snapshot.state.rev,confirmed.state.rev);assert.equal(duplicate.payload.duplicate,true);
  assert.equal(duplicate.payload.snapshot.state.actors.filter(a=>a.name==='Persistent public actor').length,1);
  console.log(JSON.stringify({secondTunnel:true,urlChanged:true,localSurvivedTunnelLoss:true,serverRestart:true,identityRecovered:true,originalOperationDeduplicated:true,wssReconnected:true,worldGovernancePreserved:true,privateNpcFiltered:true,registeredHeroPreserved:true,dataIsolated:true}));
}finally{await stopTunnel();if(runtime)await runtime.close();}
