import type { Actor, ActionDefinition, ChoiceRequest, GameState, Resolution } from '../shared/model.ts';
import { assert, uid } from './dice.ts';
type Log=Resolution['events'];
export function queueNarrativeRuling(state:GameState,source:Actor,action:ActionDefinition,options:Record<string,unknown>,targetIds:string[],log:Log):void{
  assert(action.automation==='adjudication','NOT_NARRATIVE','This action does not require narrative adjudication');
  const intent=typeof options.intent==='string'?options.intent.trim():'';
  assert(intent.length>=1&&intent.length<=2000,'INTENT_REQUIRED','请说明法术的意图、问题或想创造的叙事效果（最多2000字）。');
  const choice:ChoiceRequest={id:uid(),actorId:source.id,ownerId:'__gm__',kind:'gm-adjudication',
    prompt:`${source.name} · ${action.name}：${intent}`,
    options:[{id:'resolve',label:'记录裁定并完成'},{id:'no-effect',label:'已施放，未产生预期效果'}],
    payload:{actionId:action.id,targetIds,intent,rule:action.description,sourcePage:action.sourcePage}};
  state.choices.push(choice);
  log.push({type:'adjudication-request',actorId:source.id,message:`${source.name} casts ${action.name}; awaiting the GM's narrative ruling. Casting resources were recorded.`,source:'SRD 5.2.1'});
}
export function resolveNarrativeRuling(state:GameState,choice:ChoiceRequest,optionId:string,ruling:unknown,log:Log):void{
  assert(choice.kind==='gm-adjudication','WRONG_CHOICE','This choice is not a narrative ruling');
  assert(['resolve','no-effect'].includes(optionId),'INVALID_CHOICE','Unknown narrative ruling');
  const text=typeof ruling==='string'?ruling.trim():'';
  assert(text.length<=4000,'RULING_TOO_LONG','裁定说明最多4000字。');
  state.choices=state.choices.filter(item=>item.id!==choice.id);
  log.push({type:'gm-ruling',actorId:choice.actorId,message:optionId==='resolve'?`GM ruling: ${text||'Narrative outcome confirmed by the GM.'}`:`GM ruling: spell cast, no intended effect. ${text}`,source:`${String(choice.payload.actionId)} / SRD 5.2.1`});
}
