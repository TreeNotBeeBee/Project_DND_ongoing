import test from 'node:test';
import assert from 'node:assert/strict';
import { createActor, createGameState, resolveCommand } from '../src/engine';
import { newWorld, type WorldContext } from '../src/shared/world';
import type { Command, Member, Resolution } from '../src/shared/model';
import { advanceWorldTime } from '../src/world/clock';
import { handleGovernance, openProposal, hasCapability } from '../src/world/governance';

function fixture(system:'democracy'|'dictatorship'='democracy',ownerVeto=false){
 const members:Member[]=[{id:'owner',name:'Owner',role:'gm'},{id:'a',name:'A',role:'player'},{id:'b',name:'B',role:'player'}],state=createGameState('Votes');state.world=newWorld('owner','co-create',{system,ownerVeto});state.world.phase='running';state.world.round.number=1;state.world.rules.proposalHours=1;
 const ctx:WorldContext={now:1000,onlineMemberIds:members.map(m=>m.id),members,dice:()=>1,resolveEngine:resolveCommand},log:Resolution['events']=[];
 state.actors=members.map(member=>{const actor=createActor({name:member.name,ownerId:member.id});actor.registration='registered';return actor;});
 const draft={id:'draft',ownerId:'a',kind:'story' as const,title:'Story',payload:{text:'A door opens'},updatedAt:1000};state.world.drafts.push(draft);const proposal=openProposal(state,draft,{operationId:'submission',expectedRev:0,type:'proposal.submit'},ctx,log);
 let n=0;const run=(type:string,payload:any,member=members[0])=>handleGovernance(state,{operationId:`operation-${++n}`,expectedRev:0,type,payload},member,ctx,log);
 return{state,world:state.world,proposal,ctx,log,members,run};
}
test('one approve plus timeout abstentions passes, zero effective votes rejects, electorate remains fixed',()=>{
 const f=fixture();f.run('vote.cast',{proposalId:f.proposal.id,vote:'approve'},f.members[1]);f.ctx.members.push({id:'late',name:'Late',role:'player'});assert.throws(()=>f.run('vote.cast',{proposalId:f.proposal.id,vote:'approve'},f.ctx.members[3]));const original=structuredClone(f.state);const result=advanceWorldTime(f.state,{...f.ctx,now:f.proposal.closesAt});assert.deepEqual(f.state,original);assert.equal(result.state.world!.proposals[0].status,'approved');assert.equal(result.state.world!.proposals[0].effectiveRound,2);assert.equal(result.state.world!.proposals[0].ballots.owner.source,'timeout');assert.equal(result.state.world!.proposals[0].ballots.owner.vote,'abstain');
 const empty=fixture();assert.equal(advanceWorldTime(empty.state,{...empty.ctx,now:empty.proposal.closesAt}).state.world!.proposals[0].status,'rejected');
});
test('individual timeout choices count as recorded votes and a true tie only permits owner adjudication',()=>{
 const f=fixture();f.run('vote.cast',{proposalId:f.proposal.id,vote:'approve'},f.members[1]);f.run('vote.preference',{value:'reject'},f.members[2]);const result=advanceWorldTime(f.state,{...f.ctx,now:f.proposal.closesAt});f.state.world=result.state.world;const proposal=f.state.world!.proposals[0];assert.equal(proposal.status,'owner-review');assert.equal(proposal.ballots.b.vote,'reject');assert.equal(proposal.ballots.b.source,'timeout');assert.throws(()=>f.run('proposal.decide',{proposalId:proposal.id,approve:true},f.members[1]));f.run('proposal.decide',{proposalId:proposal.id,approve:true});assert.equal(proposal.status,'approved');
});
test('democratic owner veto requires a separate explicit approval, rejects without delegation, and cannot revive a lost vote',()=>{
 const f=fixture('democracy',true);for(const m of f.members)f.run('vote.cast',{proposalId:f.proposal.id,vote:'approve'},m);assert.equal(f.proposal.status,'owner-review');assert.throws(()=>f.run('proposal.decide',{proposalId:f.proposal.id,approve:true},f.members[1]));f.run('proposal.decide',{proposalId:f.proposal.id,approve:true});assert.equal(f.proposal.status,'approved');
 const veto=fixture('democracy',true);veto.run('proposal.decide',{proposalId:veto.proposal.id,approve:false});assert.equal(veto.proposal.status,'rejected');assert.throws(()=>veto.run('proposal.decide',{proposalId:veto.proposal.id,approve:true}));
 const loss=fixture('democracy',true);for(const m of loss.members)loss.run('vote.cast',{proposalId:loss.proposal.id,vote:'reject'},m);assert.equal(loss.proposal.status,'rejected');assert.throws(()=>loss.run('proposal.decide',{proposalId:loss.proposal.id,approve:true}));
});
test('dictator grants and revokes only named capabilities and a delegate cannot transfer authority or use another review scope',()=>{
 const f=fixture('dictatorship');f.run('governance.grant',{memberId:'a',capabilities:['review.story']});assert.equal(hasCapability(f.world,'a','review.story'),true);assert.equal(hasCapability(f.world,'a','review.map'),false);assert.throws(()=>f.run('governance.grant',{memberId:'b',capabilities:['review.story']},f.members[1]));assert.throws(()=>f.run('proposal.decide',{proposalId:f.proposal.id,approve:true},f.members[2]));f.run('proposal.decide',{proposalId:f.proposal.id,approve:true},f.members[1]);assert.equal(f.proposal.status,'approved');f.run('governance.grant',{memberId:'a',capabilities:[]});assert.equal(hasCapability(f.world,'a','review.story'),false);
});
test('drafts are owner-scoped, immutable submitted proposal copies and never require AP',()=>{
 const f=fixture(),before=structuredClone(f.state.actors);f.run('draft.save',{draft:{kind:'story',title:'Private',payload:{text:'Original'}}},f.members[1]);const saved=f.world.drafts.at(-1)!;assert.throws(()=>f.run('draft.delete',{id:saved.id},f.members[2]));const proposal=openProposal(f.state,saved,{operationId:'copy-proof',expectedRev:0,type:'proposal.submit'},f.ctx,f.log);f.run('draft.save',{draft:{id:saved.id,kind:'story',title:'Edited',payload:{text:'Changed'}}},f.members[1]);assert.equal(proposal.payload.text,'Original');f.run('draft.delete',{id:saved.id},f.members[1]);assert.equal(proposal.payload.text,'Original');assert.deepEqual(f.state.actors,before);
});
test('voters retain their fixed ballot after releasing a hero; unregistered owners do not get an ordinary vote',()=>{
 const f=fixture();f.state.actors[0].registration='available';const next=openProposal(f.state,f.world.drafts[0],{operationId:'new-electorate',expectedRev:0,type:'proposal.submit'},f.ctx,f.log);assert.deepEqual(next.electorate,['a','b']);f.state.actors[1].registration='available';f.run('vote.cast',{proposalId:next.id,vote:'approve'},f.members[1]);assert.equal(next.ballots.a.vote,'approve');assert.throws(()=>f.run('vote.cast',{proposalId:next.id,vote:'approve'},f.members[0]));
});
