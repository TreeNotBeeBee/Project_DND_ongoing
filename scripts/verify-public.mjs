// Uses an isolated test campaign. Supply a test host's URL/token through environment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
const local = process.env.JIGE_TEST_LOCAL_ORIGIN || 'http://localhost:18080';
const publicOrigin = new URL(process.env.JIGE_TEST_PUBLIC_ORIGIN).origin;
const hostToken = process.env.JIGE_TEST_HOST_TOKEN;
if (!hostToken || !publicOrigin.endsWith('.trycloudflare.com')) throw new Error('A temporary test host and its token are required.');
async function post(origin,path,body,cookie='') {
  const response=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Jige-Request':'1',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
  const payload=await response.json(); return {response,payload,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const created=await post(local,'/api/campaigns',{name:'公网验收 · '+new Date().toISOString(),gmName:'QA GM',hostToken});
assert.equal(created.response.status,201);assert.ok(created.cookie);
const page=await fetch(publicOrigin+'/',{signal:AbortSignal.timeout(30_000)});
assert.equal(page.status,200);assert.match(await page.text(),/assets\/app-/);
const joined=await post(publicOrigin,'/api/join',{inviteCode:created.payload.inviteCode,name:'公网测试玩家'});
assert.equal(joined.response.status,200);assert.match(joined.response.headers.get('set-cookie'),/Secure/);
const ws=new WebSocket(publicOrigin.replace('https:','wss:')+'/ws',{headers:{Origin:publicOrigin,Cookie:joined.cookie},handshakeTimeout:30_000});
try {
  let initialResolve;let changedResolve;let rejectWait;
  const initial=new Promise((resolve,reject)=>{initialResolve=resolve;rejectWait=reject;});
  const changed=new Promise(resolve=>{changedResolve=resolve;});
  ws.on('error',error=>rejectWait(error));
  ws.on('message',data=>{const packet=JSON.parse(String(data));if(packet.type==='ping')ws.send(JSON.stringify({type:'pong'}));if(packet.type==='snapshot'){initialResolve(packet.snapshot);if(packet.snapshot.state.actors.some(a=>a.name==='Public QA Actor'))changedResolve(packet.snapshot);}});
  await Promise.race([initial,new Promise((_,reject)=>setTimeout(()=>reject(new Error('WSS initial snapshot timed out')),30_000).unref())]);
  const command=await post(local,'/api/command',{operationId:randomUUID(),expectedRev:created.payload.state.rev,type:'actor.create',payload:{name:'Public QA Actor',draft:true}},created.cookie);
  assert.equal(command.response.status,200);
  const observed=await Promise.race([changed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('WSS update timed out')),30_000).unref())]);
  assert.equal(observed.state.rev,command.payload.snapshot.state.rev);
  const recovered=await post(publicOrigin,'/api/recover',{recoveryCode:joined.payload.recoveryCode});
  assert.equal(recovered.response.status,200);assert.equal(recovered.payload.session.member.id,joined.payload.session.member.id);
  for(const path of ['/.git/config','/data/game.sqlite','/src/server/app.ts','/node_modules/koa/package.json'])assert.equal((await fetch(publicOrigin+path,{signal:AbortSignal.timeout(30_000)})).status,404);
  console.log(JSON.stringify({https:true,secureCookie:true,wss:true,authoritativeBroadcast:true,recovery:true,privateFilesBlocked:true,publicOrigin}));
}finally{ws.close();}
