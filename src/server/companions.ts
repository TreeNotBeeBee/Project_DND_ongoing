import type {Actor,Command,GameState,Member} from '../shared/model.js';
import {ApiError} from './security.js';

type Roles=ReadonlyMap<string,Member['role']>;
function parentFor(state:GameState,parentId:unknown,roles:Roles):Actor{
  if(typeof parentId!=='string'||!parentId)throw new ApiError(400,'companion_parent','请选择随从的主人角色');
  const parent=state.actors.find(actor=>actor.id===parentId);
  if(!parent||parent.kind!=='hero'||parent.draft||!roles.has(parent.ownerId))throw new ApiError(400,'companion_parent','随从主人必须是本战役已完成建卡的主角');
  return parent;
}

/** The GM authorizes a source statblock; the owning PC determines control and allegiance. */
export function prepareActorCommand(state:GameState,command:Command,member:Member,roles:Roles){
  if(command.type==='actor.create'){
    const input:any=command.payload?.actor||command.payload||{};
    if(!input||typeof input!=='object'||Array.isArray(input))throw new ApiError(400,'invalid_body','角色资料必须为对象');
    command.payload=input;
    if(input.kind==='companion'&&input.monsterId!==undefined)assign(input);
    else{
      if(!input.ownerId)input.ownerId=member.id;
      if(!roles.has(input.ownerId))throw new ApiError(403,'ownership','角色只能分配给本战役成员');
      if((input.monsterId!==undefined||input.kind==='monster')&&roles.get(input.ownerId)!=='gm')throw new ApiError(403,'monster_owner','玩家操控的怪物数据必须由主持人通过主角随从路径授予');
    }
  }else if(command.type==='actor.update'&&Object.hasOwn(command.payload?.patch||{},'monsterId')){
    const target=state.actors.find(actor=>actor.id===command.actorId);
    if(!target||target.kind!=='companion')throw new ApiError(400,'companion_target','只能为随从重新匹配怪物数据');
    if(state.combat.active)throw new ApiError(409,'companion_combat','请结束战斗后再重新匹配随从数据');
    const patch:any=command.payload!.patch;
    assign(patch,target);
  }
  function assign(input:any,previous?:Actor){
    if(member.role!=='gm')throw new ApiError(403,'gm_only','只有主持人可以授予或重新匹配随从怪物数据');
    if(typeof input.monsterId!=='string'||!input.monsterId.trim())throw new ApiError(400,'companion_statblock','请选择官方怪物数据');
    const parent=parentFor(state,input.choices?.parentActorId??previous?.choices?.parentActorId,roles);
    if(input.ownerId!==undefined&&input.ownerId!==parent.ownerId)throw new ApiError(400,'companion_owner','随从控制者必须与主人角色相同');
    input.kind='companion';input.ownerId=parent.ownerId;input.draft=false;
    input.choices={parentActorId:parent.id,team:parent.choices?.team??'party'};
  }
}

/** Also run for backup restores so ownership cannot bypass the command boundary. */
export function validateActorOwnership(state:GameState,roles:Roles){
  for(const actor of state.actors){
    if(!roles.has(actor.ownerId))throw new ApiError(403,'ownership','角色控制者必须是本战役成员');
    if(actor.kind==='monster'&&roles.get(actor.ownerId)!=='gm')throw new ApiError(403,'monster_owner','普通怪物只能由主持人控制；玩家随从须绑定主角');
    if(actor.kind==='companion'&&actor.choices?.monsterId&&!actor.draft){
      const parent=parentFor(state,actor.choices.parentActorId,roles);
      if(actor.ownerId!==parent.ownerId||(actor.choices.team??'party')!==(parent.choices?.team??'party'))throw new ApiError(400,'companion_owner','随从必须与主人保持相同控制者和阵营');
    }
  }
}
