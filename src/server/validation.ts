import { z } from 'zod';
import { ApiError } from './security.js';
import type { GameState } from '../shared/model.js';

const id=z.string().min(1).max(512);
const finite=z.number().finite();
const position=z.object({x:finite,y:finite});
const text=z.string().max(100_000);
const strings=z.array(z.string().max(256)).max(2000);
const ability=z.enum(['str','dex','con','int','wis','cha']);
const arbitrary=z.record(z.string(),z.unknown());
const actor=z.object({
  id,name:z.string().max(256),kind:z.enum(['hero','companion','monster']),ownerId:z.string().max(128),
  abilities:z.object({str:finite.int().min(1).max(30),dex:finite.int().min(1).max(30),con:finite.int().min(1).max(30),int:finite.int().min(1).max(30),wis:finite.int().min(1).max(30),cha:finite.int().min(1).max(30)}),
  classes:z.array(z.object({classId:id,level:z.number().int().min(1).max(20),subclassId:z.string().optional()})).max(20),speciesId:z.string(),backgroundId:z.string(),
  hp:z.object({current:finite.min(0),max:finite.min(1),temp:finite.min(0)}),deathSaves:z.object({successes:z.number().int().min(0).max(3),failures:z.number().int().min(0).max(3)}),
  skills:strings,expertise:strings,saveProficiencies:z.array(ability).max(6),languages:strings,
  resources:z.array(z.object({id,name:z.string(),current:finite,max:finite.min(0),recovery:z.enum(['short','long','turn','manual'])})).max(1000),
  inventory:z.array(z.object({id,contentId:z.string(),name:z.string(),quantity:finite.min(0),equipped:z.boolean(),baseContentId:z.string().optional(),charges:z.object({current:finite.min(0),max:finite.min(0),recharge:z.enum(['dawn','short','long','manual']),rechargeFormula:z.string().optional()}).optional(),storedSpells:z.array(z.object({spellId:id,rank:z.number().int().min(1).max(5),saveDC:finite,attackBonus:finite,casterAbility:ability,casterModifier:finite})).max(5).optional()}).passthrough()).max(5000),
  spells:strings,features:strings,effects:z.array(z.object({id,name:z.string()}).passthrough()).max(1000),
  position,hidden:z.boolean(),notes:text,choices:arbitrary.optional(),
}).passthrough();
const choice=z.object({id,actorId:id,ownerId:id,kind:z.string(),prompt:text,options:z.array(z.object({id,label:text})).max(2000),payload:arbitrary});
const state=z.object({
  id,name:z.string().max(256),rev:z.number().int().min(0),actors:z.array(actor).max(500),
  scene:z.object({width:finite.positive(),height:finite.positive(),gridFeet:finite.positive(),walls:z.array(z.object({id,a:position,b:position}).passthrough()).max(10_000),terrain:z.array(z.object({id,x:finite,y:finite,width:finite,height:finite,type:z.enum(['difficult','half-cover','three-quarter-cover'])})).max(10_000),fog:z.boolean()}).passthrough(),
  combat:z.object({active:z.boolean(),round:z.number().int().min(0),turn:z.number().int().min(0),order:strings,budgets:z.record(z.string(),z.object({action:finite,bonus:finite,reaction:finite,movement:finite,attacks:finite.optional()}))}),
  choices:z.array(choice).max(2000),paused:z.boolean(),events:z.array(z.object({id,sequence:z.number().int().min(0),operationId:id,type:z.string(),message:text,timestamp:z.string()}).passthrough()).max(2000)
});

export function validateBackupState(value:unknown):GameState{
  const result=state.safeParse(value);
  if(!result.success)throw new ApiError(400,'backup_invalid',`备份状态无效：${result.error.issues.slice(0,3).map(i=>`${i.path.join('.')}: ${i.message}`).join('；')}`);
  return result.data as GameState;
}
