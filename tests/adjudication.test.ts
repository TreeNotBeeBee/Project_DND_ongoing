import test from 'node:test';
import assert from 'node:assert/strict';
import {createActor,createGameState} from '../src/engine/index.ts';
import {queueNarrativeRuling,resolveNarrativeRuling} from '../src/engine/adjudication.ts';
import type {ActionDefinition,Resolution} from '../src/shared/model.ts';
const action:ActionDefinition={id:'spell:augury',name:'Augury',source:'spell',economy:'action',level:2,description:'The GM supplies the omen about the planned course of action.',automation:'adjudication'};
test('narrative casting creates a GM-owned durable choice without inventing world facts',()=>{
  const state=createGameState('Test'),actor=createActor({name:'Cleric',ownerId:'player'}),log:Resolution['events']=[];
  state.actors=[actor];queueNarrativeRuling(state,actor,action,{intent:'是否应当现在穿过石桥？'},[],log);
  assert.equal(state.choices[0].ownerId,'__gm__');assert.equal(state.choices[0].kind,'gm-adjudication');
  assert.equal(state.choices[0].payload.intent,'是否应当现在穿过石桥？');assert.equal(log[0].type,'adjudication-request');
  resolveNarrativeRuling(state,state.choices[0],'resolve','吉兆：桥上的守卫愿意帮助你。',log);
  assert.equal(state.choices.length,0);assert.match(log[1].message,/吉兆/);assert.equal(actor.effects.length,0);
});
test('empty narrative request rejects before creating pending state',()=>{
  const state=createGameState('Test'),actor=createActor(),log:Resolution['events']=[];
  assert.throws(()=>queueNarrativeRuling(state,actor,action,{intent:''},[],log),/意图/);assert.equal(state.choices.length,0);
});
