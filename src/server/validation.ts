import { z } from 'zod';
import { ApiError } from './security.js';
import type { GameState } from '../shared/model.js';
import { GROWTH_TARGETS, validateRules, validateItems, validateNodes, validateBehaviors } from '../world/validation';
import { micro } from '../world/fixed';
import { energyLimits } from '../world/energy';
import { validateCatalog } from '../world/rounds';
import { assertWorldIdentities } from '../world/identity';

const id=z.string().min(1).max(512);
const finite=z.number().finite();
const position=z.object({x:finite,y:finite});
const text=z.string().max(100_000);
const strings=z.array(z.string().max(256)).max(2000);
const ability=z.enum(['str','dex','con','int','wis','cha']);
const arbitrary=z.record(z.string(),z.unknown());
const safeInteger=finite.int().min(0).max(Number.MAX_SAFE_INTEGER);
const ap=finite.min(0).superRefine((value,ctx)=>{try{micro(value);}catch(error){ctx.addIssue({code:'custom',message:error instanceof Error?error.message:'行动力最多6位小数'});}});
const growthBonus=z.record(z.string(),finite).superRefine((values,ctx)=>{for(const [key,value]of Object.entries(values)){if(!GROWTH_TARGETS.includes(key as any))ctx.addIssue({code:'custom',path:[key],message:'未知成长目标'});if(key.startsWith('ap.'))try{micro(value,'行动力加成',true);}catch(error){ctx.addIssue({code:'custom',path:[key],message:error instanceof Error?error.message:'行动力加成无效'});}}});
const growth=z.object({tracks:z.record(z.string(),z.object({level:safeInteger.min(1),xp:safeInteger,totalXp:safeInteger,points:safeInteger})),bonuses:growthBonus});
const itemAmount=z.object({itemId:id,quantity:safeInteger.min(1).max(1_000_000)});
const experience=z.object({trackId:id,amount:safeInteger.max(1_000_000_000)});
const action=z.object({id,name:z.string(),source:z.enum(['weapon','spell','feature','monster','custom']),economy:z.enum(['action','bonus','reaction','free']),description:z.string(),automation:z.enum(['automatic','choice','adjudication','unsupported']),attack:z.object({ability:ability.optional(),bonus:finite.optional(),proficient:z.boolean().optional(),ranged:z.boolean().optional()}).optional(),save:z.object({ability,dc:finite.optional(),success:z.enum(['half','none','other'])}).optional(),damage:z.array(z.object({formula:z.string(),type:z.string(),addAbility:ability.optional()}).passthrough()).max(100).optional(),healing:z.string().optional(),conditions:strings.optional(),costs:z.array(z.object({resourceId:id,amount:finite.min(0)})).max(1000).optional(),duration:finite.optional()}).passthrough();
const effect=z.object({id,name:z.string(),condition:z.string().optional(),sourceActorId:z.string().optional(),sourceId:z.string().optional(),modifiers:z.record(z.string(),finite).optional(),conditionImmunities:strings.optional(),resistance:strings.optional(),immunity:strings.optional(),vulnerability:strings.optional(),duration:finite.optional(),gmOnly:z.boolean().optional()}).passthrough();
const actor=z.object({
  id,name:z.string().max(256),kind:z.enum(['hero','companion','monster']),ownerId:z.string().max(128),
  profile:z.enum(['free','srd2024']).optional(), story:text.optional(),
  manual:z.object({maxHp:finite.positive(),proficiency:finite,ac:finite,speed:finite.min(0)}).optional(),
  abilities:z.object({str:finite,dex:finite,con:finite,int:finite,wis:finite,cha:finite}),
  classes:z.array(z.object({classId:id,level:z.number().int().min(1).max(20),subclassId:z.string().optional()})).max(20),speciesId:z.string(),backgroundId:z.string(),
  hp:z.object({current:finite.min(0),max:finite.min(1),temp:finite.min(0)}),deathSaves:z.object({successes:z.number().int().min(0).max(3),failures:z.number().int().min(0).max(3)}),
  skills:strings,expertise:strings,saveProficiencies:z.array(ability).max(6),languages:strings,
  resources:z.array(z.object({id,name:z.string(),current:finite,max:finite.min(0),recovery:z.enum(['short','long','turn','manual'])})).max(1000),
  inventory:z.array(z.object({id,contentId:z.string(),name:z.string(),quantity:finite.min(0),equipped:z.boolean(),baseContentId:z.string().optional(),charges:z.object({current:finite.min(0),max:finite.min(0),recharge:z.enum(['dawn','short','long','manual']).optional(),rechargeFormula:z.string().optional()}).optional(),storedSpells:z.array(z.object({spellId:id,rank:z.number().int().min(1).max(5),saveDC:finite,attackBonus:finite,casterAbility:ability,casterModifier:finite})).max(5).optional()}).passthrough()).max(5000),
  spells:strings,features:strings,effects:z.array(effect).max(1000),
  position,hidden:z.boolean(),notes:text,choices:arbitrary.optional(),growth:growth.optional(),customActions:z.array(action).max(1000).optional(),monsterActions:z.array(action).max(1000).optional(),knownEntries:strings.optional(),publicGroups:z.array(z.enum(['story','stats','skills','equipment'])).max(4).optional(),registration:z.enum(['available','requested','registered','archived']).optional(),requestedBy:id.optional(),size:finite.optional(),
}).passthrough().superRefine((a,ctx)=>{
  if(a.profile!=='free') for(const key of ['str','dex','con','int','wis','cha'] as const) if(!Number.isInteger(a.abilities[key])||a.abilities[key]<1||a.abilities[key]>30)ctx.addIssue({code:'custom',path:['abilities',key],message:'标准角色属性应为1至30整数'});
  if(a.profile==='free'&&!a.manual)ctx.addIssue({code:'custom',path:['manual'],message:'自由卡缺少手动数值'});
  if(a.hp.current>a.hp.max)ctx.addIssue({code:'custom',path:['hp','current'],message:'当前生命超过上限'});
  const ids=new Set();for(let i=0;i<a.resources.length;i++){const r=a.resources[i];if(ids.has(r.id)||r.current<0||r.current>r.max||r.id==='ap'&&r.max>100)ctx.addIssue({code:'custom',path:['resources',i],message:'资源重复或余额超界'});if(r.id==='ap')for(const key of ['current','max']as const)try{micro(r[key]);}catch(error){ctx.addIssue({code:'custom',path:['resources',i,key],message:error instanceof Error?error.message:'行动力无效'});}ids.add(r.id);}
});
const vote=z.enum(['approve','reject','abstain']);
const kind=z.enum(['scene','rules','actor','story','items','nodes']);
const draft=z.object({id,ownerId:id,kind,title:text,payload:arbitrary,updatedAt:safeInteger});
const npc=z.object({actorId:id,kind:z.enum(['idle','patrol','hostile','trade','event']),waypoints:z.array(position).max(1000).optional(),targetKinds:z.array(z.enum(['hero','companion','monster'])).max(3).optional(),actionId:id.optional(),ruleId:id.optional(),trigger:z.string().optional()});
const exchange=z.object({id,worldRevision:safeInteger,round:safeInteger,kind:z.enum(['initialize','player_selection','turn_context','roll_results']),payload:arbitrary,createdAt:safeInteger,appliedDecisionIds:strings,rolls:z.array(z.object({id,expression:z.string(),rolls:z.array(finite).max(2000),total:finite})).max(20000).optional()});
const world=z.object({
  version:z.literal(1),ownerId:id,mode:z.enum(['gm','ai','co-create']),phase:z.enum(['setup','running']),gameplayRev:safeInteger,
  governance:z.object({system:z.enum(['democracy','dictatorship']),ownerVeto:z.boolean(),delegations:z.record(z.string(),z.array(z.enum(['review.map','review.rules','review.creatures','review.story','manage.characters','manage.members','manage.knowledge','manage.rounds'])))}),
  lore:text,secretLore:text,rules:z.unknown().superRefine((value,ctx)=>{try{validateRules(value);}catch(error){ctx.addIssue({code:'custom',message:error instanceof Error?error.message:'世界规则无效'});}}),
  round:z.object({number:safeInteger,phase:z.enum(['planning','intermission','settling']),participants:strings,ended:strings,spent:z.record(z.string(),ap),intents:z.array(z.object({id,actorId:id,memberId:id,type:z.enum(['move','action','recipe','gather','proposal','narrative']),payload:arbitrary,targetIds:strings,cost:ap,round:safeInteger,status:z.enum(['planned','approved','rejected','executed','failed'])}).passthrough()).max(10000)}),
  drafts:z.array(draft).max(10000),
  proposals:z.array(z.object({id,draftId:id,authorId:id,title:text,kind,payload:arbitrary,electorate:strings,ballots:z.record(z.string(),z.object({vote,source:z.enum(['manual','timeout'])})),opensAt:safeInteger,closesAt:safeInteger,status:z.enum(['open','owner-review','approved','rejected','applied','conflict']),ownerDecision:z.boolean().optional(),effectiveRound:safeInteger.optional()}).passthrough()).max(10000),
  timeoutVotes:z.record(z.string(),vote),items:z.array(z.object({id,name:z.string(),description:z.string(),bonuses:growthBonus.optional()})).max(2000),nodes:z.array(z.object({id,name:z.string(),position,inventory:z.array(z.object({itemId:id,quantity:safeInteger.max(1_000_000)})).max(1000),hidden:z.boolean().optional()})).max(1000),npcBehaviors:z.array(npc).max(500),energyAt:z.record(z.string(),safeInteger),jobs:z.array(z.object({id,actorId:id,ruleId:id,completesRound:safeInteger})).max(10000),
  ai:z.object({diceSource:z.enum(['program','ai']),exchanges:z.array(exchange).max(10000),narratives:z.array(z.object({id,text,actorIds:strings.optional()})).max(10000)})
});
const choice=z.object({id,actorId:id,ownerId:id,kind:z.string(),prompt:text,options:z.array(z.object({id,label:text})).max(2000),payload:arbitrary});
const state=z.object({
  id,name:z.string().max(256),rev:z.number().int().min(0),actors:z.array(actor).max(500),
  scene:z.object({width:finite.positive(),height:finite.positive(),gridFeet:finite.positive(),walls:z.array(z.object({id,a:position,b:position}).passthrough()).max(10_000),terrain:z.array(z.object({id,x:finite,y:finite,width:finite,height:finite,type:z.enum(['difficult','half-cover','three-quarter-cover'])})).max(10_000),fog:z.boolean()}).passthrough(),
  combat:z.object({active:z.boolean(),round:z.number().int().min(0),turn:z.number().int().min(0),order:strings,budgets:z.record(z.string(),z.object({action:finite,bonus:finite,reaction:finite,movement:finite,attacks:finite.optional()}))}),
  choices:z.array(choice).max(2000),paused:z.boolean(),events:z.array(z.object({id,sequence:z.number().int().min(0),operationId:id,type:z.string(),message:text,timestamp:z.string()}).passthrough()).max(2000),world:world.optional()
});

const jobSnapshot=z.object({outputs:z.array(itemAmount).max(100),experience:z.array(experience).max(100),unlockEntries:strings.optional()});
const decisionReceipt=z.object({canonical:z.string(),status:z.enum(['pending','applied','failed']),next:safeInteger,used:strings,narratives:z.boolean(),reaction:id.optional(),error:z.string().optional(),ids:z.record(z.string(),z.string()).optional()}).passthrough();
const reactionPool=z.object({id,expression:z.string(),rolls:z.array(finite).max(2000),sides:z.array(safeInteger.min(2)).max(2000),total:finite,offset:safeInteger}).passthrough();
const reactionRecord=z.object({pool:reactionPool.optional(),decisionId:id,stepId:id,requested:z.object({choiceId:id,optionId:id,side:safeInteger.min(2)}).optional(),done:z.boolean().optional()}).passthrough();
function invalid(condition: unknown,message: string): asserts condition {if(!condition)throw new Error(message);}
function unique(values: string[],label: string){invalid(new Set(values).size===values.length,`${label}不能重复`);}
function validateWorldReferences(value: GameState): void {
  assertWorldIdentities(value);
  const world=value.world;if(!world)return;
  validateItems(world.items);validateNodes(world.nodes,world.items);validateBehaviors(world.npcBehaviors,value.actors);validateCatalog(value);
  unique(world.round.participants,'回合参与者');unique(world.round.ended,'结束确认');invalid(world.round.ended.every(memberId=>world.round.participants.includes(memberId)),'结束确认引用了未参加该回合的成员');
  const actors=new Map(value.actors.map(actor=>[actor.id,actor]));
  for(const actor of value.actors){
    energyLimits(actor,world);
    const applied=actor.choices?._worldAppliedBonuses;
    if(applied!==undefined)growthBonus.parse(applied);
    if(actor.choices?._worldJobs!==undefined)z.record(z.string(),jobSnapshot).parse(actor.choices._worldJobs);
    for(const [trackId,progress]of Object.entries(actor.growth?.tracks||{})){
      const rule=world.rules.growth.tracks.find(track=>track.id===trackId);
      if(rule)invalid(progress.xp<rule.curve[Math.min(progress.level-1,rule.curve.length-1)],'本级经验超过升级门槛，成长记录损坏');
    }
  }
  for(const intent of world.round.intents){
    if(!['planned','approved'].includes(intent.status))continue;
    const actor=actors.get(intent.actorId);invalid(actor,'待结算意图引用不存在的角色');invalid(actor.ownerId===intent.memberId,'待结算意图的角色控制者与提交成员不一致');invalid(intent.round===world.round.number,'待结算意图引用了其他回合');
    const payload=intent.payload;
    if(intent.type==='move')z.array(z.object({x:safeInteger.max(199),y:safeInteger.max(199)})).min(1).max(500).parse(payload.path);
    if(intent.type==='narrative')z.string().min(1).max(4000).parse(payload.text);
    if(intent.type==='proposal')draft.parse(payload.draft);
    if(intent.type==='recipe')id.parse(payload.ruleId);
    if(intent.type==='gather'){id.parse(payload.nodeId);if(payload.ruleId!==undefined)id.parse(payload.ruleId);else{id.parse(payload.itemId);safeInteger.min(1).max(1_000_000).parse(payload.quantity??1);}}
    if(intent.type==='action'){
      if(payload.commandType!==undefined){invalid(['inventory.equip','inventory.consume','actor.rest','actor.deathSave'].includes(String(payload.commandType)),'行动意图引用了未知或非行动命令');if(['inventory.equip','inventory.consume'].includes(String(payload.commandType)))id.parse(payload.itemId);if(payload.commandType==='inventory.equip')z.boolean().parse(payload.equipped);}
      else id.parse(payload.actionId);
      if(payload.options!==undefined)arbitrary.parse(payload.options);
    }
  }
  for(const proposal of world.proposals){
    unique(proposal.electorate,'投票名单');invalid(proposal.closesAt>=proposal.opensAt,'投票截止时间早于开票时间');invalid(Object.keys(proposal.ballots).every(memberId=>proposal.electorate.includes(memberId)),'投票记录引用了名单外成员');
    if(proposal.status==='approved')invalid(proposal.effectiveRound!==undefined,'已通过提案缺少生效回合');
  }
  for(const job of world.jobs){invalid(actors.has(job.actorId),'制作任务引用不存在的角色');const snapshot=(actors.get(job.actorId)!.choices?._worldJobs as Record<string,unknown>|undefined)?.[job.id];jobSnapshot.parse(snapshot);}
  for(const choice of value.choices){
    invalid(actors.has(choice.actorId),'待决选择引用不存在的角色');
    if(choice.kind==='opportunity-reaction')z.object({actorId:id,path:z.array(position).max(500),reactedIds:strings}).parse(choice.payload.movementContinuation);
  }
  for(const exchange of world.ai.exchanges){
    unique(exchange.appliedDecisionIds,'AI已应用决策编号');
    if(exchange.payload._decisions!==undefined)z.record(z.string(),decisionReceipt).parse(exchange.payload._decisions);
    if(exchange.payload._reactions!==undefined){const records=z.record(z.string(),reactionRecord).parse(exchange.payload._reactions);for(const record of Object.values(records)){if(record.pool)invalid(record.pool.rolls.length===record.pool.sides.length&&record.pool.offset<=record.pool.rolls.length,'AI反应骰池的长度或消费位置无效');}}
  }
}

export function validateBackupState(value:unknown):GameState{
  const result=state.safeParse(value);
  if(!result.success)throw new ApiError(400,'backup_invalid',`备份状态无效：${result.error.issues.slice(0,3).map(i=>`${i.path.join('.')}: ${i.message}`).join('；')}`);
  try{validateWorldReferences(result.data as GameState);}catch(error){throw new ApiError(400,'backup_invalid',`备份状态无效：${error instanceof z.ZodError?error.issues.slice(0,3).map(issue=>`${issue.path.join('.')}: ${issue.message}`).join('；'):error instanceof Error?error.message:'世界结构或引用无效'}`);}
  return result.data as GameState;
}
