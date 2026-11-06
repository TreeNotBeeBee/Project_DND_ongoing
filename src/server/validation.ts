import { z } from 'zod';
import { ApiError } from './security.js';
import type { GameState } from '../shared/model.js';
import { validateRules } from '../world/validation';

const id=z.string().min(1).max(512);
const finite=z.number().finite();
const position=z.object({x:finite,y:finite});
const text=z.string().max(100_000);
const strings=z.array(z.string().max(256)).max(2000);
const ability=z.enum(['str','dex','con','int','wis','cha']);
const arbitrary=z.record(z.string(),z.unknown());
const actor=z.object({
  id,name:z.string().max(256),kind:z.enum(['hero','companion','monster']),ownerId:z.string().max(128),
  profile:z.enum(['free','srd2024']).optional(), story:text.optional(),
  manual:z.object({maxHp:finite.positive(),proficiency:finite,ac:finite,speed:finite.min(0)}).optional(),
  abilities:z.object({str:finite,dex:finite,con:finite,int:finite,wis:finite,cha:finite}),
  classes:z.array(z.object({classId:id,level:z.number().int().min(1).max(20),subclassId:z.string().optional()})).max(20),speciesId:z.string(),backgroundId:z.string(),
  hp:z.object({current:finite.min(0),max:finite.min(1),temp:finite.min(0)}),deathSaves:z.object({successes:z.number().int().min(0).max(3),failures:z.number().int().min(0).max(3)}),
  skills:strings,expertise:strings,saveProficiencies:z.array(ability).max(6),languages:strings,
  resources:z.array(z.object({id,name:z.string(),current:finite,max:finite.min(0),recovery:z.enum(['short','long','turn','manual'])})).max(1000),
  inventory:z.array(z.object({id,contentId:z.string(),name:z.string(),quantity:finite.min(0),equipped:z.boolean(),baseContentId:z.string().optional(),charges:z.object({current:finite.min(0),max:finite.min(0),recharge:z.enum(['dawn','short','long','manual']),rechargeFormula:z.string().optional()}).optional(),storedSpells:z.array(z.object({spellId:id,rank:z.number().int().min(1).max(5),saveDC:finite,attackBonus:finite,casterAbility:ability,casterModifier:finite})).max(5).optional()}).passthrough()).max(5000),
  spells:strings,features:strings,effects:z.array(z.object({id,name:z.string()}).passthrough()).max(1000),
  position,hidden:z.boolean(),notes:text,choices:arbitrary.optional(),
}).passthrough().superRefine((a,ctx)=>{
  if(a.profile!=='free') for(const key of ['str','dex','con','int','wis','cha'] as const) if(!Number.isInteger(a.abilities[key])||a.abilities[key]<1||a.abilities[key]>30)ctx.addIssue({code:'custom',path:['abilities',key],message:'标准角色属性应为1至30整数'});
  if(a.profile==='free'&&!a.manual)ctx.addIssue({code:'custom',path:['manual'],message:'自由卡缺少手动数值'});
  if(a.hp.current>a.hp.max)ctx.addIssue({code:'custom',path:['hp','current'],message:'当前生命超过上限'});
  const ids=new Set();for(let i=0;i<a.resources.length;i++){const r=a.resources[i];if(ids.has(r.id)||r.current<0||r.current>r.max||r.id==='ap'&&r.max>100)ctx.addIssue({code:'custom',path:['resources',i],message:'资源重复或余额超界'});ids.add(r.id);}
});
const vote=z.enum(['approve','reject','abstain']);
const world=z.object({
  version:z.literal(1),ownerId:id,mode:z.enum(['gm','ai','co-create']),phase:z.enum(['setup','running']),gameplayRev:finite.int().min(0),
  governance:z.object({system:z.enum(['democracy','dictatorship']),ownerVeto:z.boolean(),delegations:z.record(z.string(),z.array(z.enum(['review.map','review.rules','review.creatures','review.story','manage.characters','manage.members','manage.knowledge','manage.rounds'])))}),
  lore:text,secretLore:text,rules:z.unknown().superRefine((value,ctx)=>{try{validateRules(value);}catch(error){ctx.addIssue({code:'custom',message:error instanceof Error?error.message:'世界规则无效'});}}),
  round:z.object({number:finite.int().min(0),phase:z.enum(['planning','intermission','settling']),participants:strings,ended:strings,spent:z.record(z.string(),finite.min(0)),intents:z.array(z.object({id,actorId:id,memberId:id,type:z.enum(['move','action','recipe','gather','proposal','narrative']),payload:arbitrary,targetIds:strings,cost:finite.min(0),round:finite.int().min(0),status:z.enum(['planned','approved','rejected','executed','failed'])}).passthrough()).max(10000)}),
  drafts:z.array(z.object({id,ownerId:id,kind:z.enum(['scene','rules','actor','story','items','nodes']),title:text,payload:arbitrary,updatedAt:finite})).max(10000),
  proposals:z.array(z.object({id,draftId:id,authorId:id,title:text,kind:z.enum(['scene','rules','actor','story','items','nodes']),payload:arbitrary,electorate:strings,ballots:z.record(z.string(),z.object({vote,source:z.enum(['manual','timeout'])})),opensAt:finite,closesAt:finite,status:z.enum(['open','owner-review','approved','rejected','applied','conflict'])}).passthrough()).max(10000),
  timeoutVotes:z.record(z.string(),vote),items:z.array(arbitrary).max(2000),nodes:z.array(arbitrary).max(1000),npcBehaviors:z.array(arbitrary).max(500),energyAt:z.record(z.string(),finite),jobs:z.array(arbitrary).max(10000),
  ai:z.object({diceSource:z.enum(['program','ai']),exchanges:z.array(arbitrary).max(10000),narratives:z.array(z.object({id,text,actorIds:strings.optional()})).max(10000)})
});
const choice=z.object({id,actorId:id,ownerId:id,kind:z.string(),prompt:text,options:z.array(z.object({id,label:text})).max(2000),payload:arbitrary});
const state=z.object({
  id,name:z.string().max(256),rev:z.number().int().min(0),actors:z.array(actor).max(500),
  scene:z.object({width:finite.positive(),height:finite.positive(),gridFeet:finite.positive(),walls:z.array(z.object({id,a:position,b:position}).passthrough()).max(10_000),terrain:z.array(z.object({id,x:finite,y:finite,width:finite,height:finite,type:z.enum(['difficult','half-cover','three-quarter-cover'])})).max(10_000),fog:z.boolean()}).passthrough(),
  combat:z.object({active:z.boolean(),round:z.number().int().min(0),turn:z.number().int().min(0),order:strings,budgets:z.record(z.string(),z.object({action:finite,bonus:finite,reaction:finite,movement:finite,attacks:finite.optional()}))}),
  choices:z.array(choice).max(2000),paused:z.boolean(),events:z.array(z.object({id,sequence:z.number().int().min(0),operationId:id,type:z.string(),message:text,timestamp:z.string()}).passthrough()).max(2000),world:world.optional()
});

export function validateBackupState(value:unknown):GameState{
  const result=state.safeParse(value);
  if(!result.success)throw new ApiError(400,'backup_invalid',`备份状态无效：${result.error.issues.slice(0,3).map(i=>`${i.path.join('.')}: ${i.message}`).join('；')}`);
  return result.data as GameState;
}
