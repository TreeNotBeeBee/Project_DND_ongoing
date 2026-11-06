import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../src/engine';
import {newWorld,type WorldContext} from '../src/shared/world';
import {resolveWorldCommand} from '../src/world';
import {executeIntent} from '../src/world/rounds';
import type {GameState,Member} from '../src/shared/model';
function fixture(){
 let state=engine.createGameState('Entity identity');state.world=newWorld('owner','co-create');const members:Member[]=[{id:'owner',name:'Owner',role:'gm'},{id:'a',name:'A',role:'player'},{id:'b',name:'B',role:'player'}];for(const [index,member]of members.slice(1).entries())state.actors.push(engine.createActor({id:member.id,profile:'free',name:member.name,ownerId:member.id,registration:'registered',position:{x:index,y:0}}));
 const ctx:WorldContext={now:1000,members,onlineMemberIds:['a','b'],dice:()=>1,resolveEngine:(s,c,d)=>engine.resolveCommand(s,c,d,{economy:'world',skipResources:['ap']})};let sequence=0;
 const run=(type:string,payload:any,who=members[0],operationId=`operation-${++sequence}`)=>{state=resolveWorldCommand(state,{operationId,expectedRev:state.rev,type,payload},who,ctx).state;};run('world.configure',{rules:{...structuredClone(state.world.rules),energy:{maximum:10,perRound:10,recoveryMode:'round',recovery:1},costs:{narrative:1,proposal:1}}});run('world.start',{});return{get state(){return state;},members,ctx,run};
}
test('two members can reuse a database-scoped operation ID without sharing intent, draft or proposal identities',()=>{
 const f=fixture();for(const member of f.members.slice(1))f.run('intent.save',{intent:{actorId:member.id,type:'narrative',payload:{text:member.name}}},member,'same-public-operation-id');assert.equal(new Set(f.state.world!.round.intents.map(i=>i.id)).size,2);
 for(const member of f.members.slice(1))f.run('draft.save',{draft:{kind:'story',title:member.name,payload:{text:`Story ${member.name}`}}},member,'same-draft-operation-id');assert.equal(new Set(f.state.world!.drafts.map(d=>d.id)).size,2);
 for(const member of f.members.slice(1))f.run('proposal.submit',{draftId:f.state.world!.drafts.find(d=>d.ownerId===member.id)!.id},member,'same-proposal-operation-id');assert.equal(new Set(f.state.world!.round.intents.map(i=>i.id)).size,4);
 for(const member of f.members.slice(1))f.run('turn.end',{},member);f.run('round.settle',{});assert.equal(f.state.world!.round.phase,'intermission');assert.equal(f.state.world!.round.intents.filter(i=>i.status==='executed').length,4);assert.equal(new Set(f.state.world!.proposals.map(p=>p.id)).size,2);for(const actor of f.state.actors)assert.equal(actor.resources.find(r=>r.id==='ap')!.current,8);
});
test('a preexisting duplicate intent is rejected before a settlement loop or direct AI execution can mutate state',()=>{
 const f=fixture();f.run('intent.save',{intent:{actorId:'a',type:'narrative',payload:{text:'Original'}}},f.members[1]);const intent=f.state.world!.round.intents[0];f.state.world!.round.intents.push({...structuredClone(intent),actorId:'b',memberId:'b'});const before=structuredClone(f.state);
 assert.throws(()=>f.run('round.settle',{}),/编号重复/);assert.deepEqual(f.state,before);assert.throws(()=>executeIntent(f.state,intent.id,f.ctx),/编号重复/);assert.deepEqual(f.state,before);
});
