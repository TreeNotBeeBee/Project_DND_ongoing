import { validateStandardActor } from '../shared/standard-actor';
import { ABILITIES, DAMAGE_TYPES } from '../shared/model.ts';
import type {Actor,Ability,DerivedActor,Resource,ActionDefinition} from '../shared/model.ts';
import {lookup,getEntry,unprefix,weaponAction,raw} from '../content/index.ts';
import {validateBuild as checkBuild} from '../shared/build-validation.ts';
import {assert,integer,modifier,rollExpression,uid} from './dice.ts';
import {itemBonuses,itemBaseEquipment,weaponBonus,itemActionAvailable,itemCoverage,itemBlocksCondition} from './item-effects.ts';
import {featureActions,featureResources,extraArmor,extraSpeed,hasFeat} from './feature-rules.ts';
export const isFreeActor=(a:Actor)=>a.profile==='free';
export const FREE_NUMBER_LIMIT=1_000_000;
const finiteFree=(value:unknown,min=-FREE_NUMBER_LIMIT,max=FREE_NUMBER_LIMIT)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const freeResources:Resource[]=[{id:'mp',name:'MP',current:0,max:0,recovery:'manual'},{id:'stamina',name:'Stamina',current:0,max:0,recovery:'manual'},{id:'shield',name:'Shield',current:0,max:0,recovery:'manual'},{id:'ap',name:'AP',current:0,max:0,recovery:'manual'}];
export const levelOf=(a:Actor,id:string)=>a.classes.find(c=>unprefix(c.classId)===id)?.level||0;
export const isStatblock=(a:Actor)=>a.kind==='monster'||a.kind==='companion'&&!!lookup('monsters',String(a.choices?.monsterId||''));
export const totalLevel=(a:Actor)=>a.classes.reduce((n,c)=>n+c.level,0);
export function validateBuild(a:Actor){return isFreeActor(a)?validateActor(a):isStatblock(a)?[]:checkBuild(a,raw);}
export function applyBuildChoices(a:Actor){
  if(isFreeActor(a))return;
  const build=a.choices?.characterBuild as any;if(!build)return;
  const featIds=[build.originFeat,...(build.fightingStyles||[]),...(build.feats||[]).map((f:any)=>f.featId)].filter(Boolean);
  a.features=[...new Set([...a.features,...featIds.map((x:string)=>`feat:${unprefix(x)}`)])];
  if(build.baseAbilities)for(const k of ABILITIES)a.abilities[k]=Number(build.baseAbilities[k]||0)+Number(build.backgroundBonuses?.[k]||0)+(build.feats||[]).reduce((n:number,f:any)=>n+Number(f.abilityBonuses?.[k]||0),0);
  const initiate=a.choices?.magicInitiate as any;if(initiate?.spells)a.spells=[...new Set([...a.spells,...initiate.spells.map((x:string)=>`spell:${unprefix(x)}`)])];
}
export const hasEffect=(a:Actor,c:string)=>!(c==='poisoned'&&a.effects.some(e=>e.condition==='petrified'))&&!a.effects.some(e=>e.conditionImmunities?.includes(c))&&a.effects.some(e=>(e.condition===c||e.sourceId===c)&&!itemBlocksCondition(a,e));
export function effectModifier(a:Actor,key:string){const group=new Map<string,number>();for(const e of a.effects){const value=e.modifiers?.[key]||0,id=e.sourceId||e.id;if(!group.has(id)||Math.abs(value)>=Math.abs(group.get(id)!))group.set(id,value);}return [...group.values()].reduce((n,v)=>n+v,0);}
export const incapacitated=(a:Actor)=>a.dead||['incapacitated','paralyzed','petrified','stunned','unconscious'].some(c=>hasEffect(a,c));
const classData=(a:Actor)=>a.classes.map(c=>({c,d:lookup('classes',c.classId),l:lookup('levels',`${unprefix(c.classId)}-${c.level}`)}));
export function maximumHp(a:Actor):number {
  if(isFreeActor(a))return Math.max(1,(a.manual?.maxHp??10)+effectModifier(a,'maxHp'));
  if(isStatblock(a))return Number(a.choices?.baseMaxHp??a.hp.max)+effectModifier(a,'maxHp');
  let hp=0,first=true;const con=modifier(Math.max(itemBonuses(a).abilityMinimums.con||0,Math.max(0,Math.min(30,a.abilities.con+effectModifier(a,'con')))));
  for(const {c,d} of classData(a)){if(!d)continue;for(let i=1;i<=c.level;i++){const rolls=(a.choices?.hpRolls as Record<string,number[]>|undefined)?.[unprefix(c.classId)];const gain=first?d.hit_die:rolls?.[i-1]??(d.hit_die/2+1);hp+=Math.max(1,gain+con);first=false;}}
  if(a.features.some(f=>unprefix(f)==='tough'))hp+=2*totalLevel(a);
  if(unprefix(a.speciesId)==='dwarf')hp+=totalLevel(a);
  hp+=effectModifier(a,'maxHp');return Math.max(1,hp);
}
export function buildResources(a:Actor):Resource[] {if(isFreeActor(a)){const resources=structuredClone(a.resources||[]);for(const r of freeResources)if(!resources.some(value=>value.id===r.id))resources.push({...r});return resources;}if(isStatblock(a))return [];
  const out:Resource[]=[];const push=(id:string,name:string,max:number,recovery:Resource['recovery'])=>{if(max>0)out.push({id,name,max,current:max,recovery});};
  const parts=classData(a);const spellcasters=parts.filter(x=>x.d?.spellcasting&&unprefix(x.c.classId)!=='warlock');
  let spelltable:any;
  if(spellcasters.length===1)spelltable=spellcasters[0].l?.spellcasting;
  else if(spellcasters.length>1){const casterLevel=spellcasters.reduce((n,{c})=>n+(['paladin','ranger'].includes(unprefix(c.classId))?Math.ceil(c.level/2):c.level),0);spelltable=lookup('levels',`wizard-${Math.min(20,casterLevel)}`)?.spellcasting;}
  for(let i=1;i<=9;i++)push(`slot-${i}`,`Spell slot ${i}`,spelltable?.[`spell_slots_level_${i}`]||0,'long');
  for(const {c,d,l} of parts){const id=unprefix(c.classId);push(`hit-dice-${id}`,`${d?.name||id} hit dice (d${d?.hit_die||8})`,c.level,'long');const s=l?.class_specific||{};
    if(id==='warlock')for(let i=1;i<=5;i++)push(`pact-${i}`,`Pact Magic ${i}`,l?.spellcasting?.[`spell_slots_level_${i}`]||0,'short');
    if(id==='fighter'){push('second-wind','Second Wind',s.second_wind_uses||2,'long');if(c.level>=2)push('action-surge','Action Surge',c.level>=17?2:1,'short');if(c.level>=9)push('indomitable','Indomitable',c.level>=17?3:c.level>=13?2:1,'long');}
    if(id==='barbarian')push('rage','Rage',s.rage_count||2,'long');
    if(id==='monk')push('focus','Focus Points',s.focus_points||0,'short');
    if(id==='sorcerer')push('sorcery','Sorcery Points',s.sorcery_points||0,'long');
    if(id==='paladin')push('lay-on-hands','Lay On Hands',5*c.level,'long');
    if(id==='bard')push('bardic-inspiration','Bardic Inspiration',Math.max(1,modifier(a.abilities.cha)),c.level>=5?'short':'long');
    if(s.channel_divinity_charges)push(`channel-divinity-${id}`,'Channel Divinity',s.channel_divinity_charges,'long');
    if(id==='ranger')push('favored-enemy',"Hunter's Mark free uses",s.favored_enemies||2,'long');
    if(id==='druid')push('wild-shape','Wild Shape',s.wild_shape_uses||2,'long');
  }if(a.features.some(f=>unprefix(f)==='magic-initiate'))push('magic-initiate','Magic Initiate free casting',1,'long');
  for(const r of featureResources(a)){push(r.id,r.name,r.max,r.recovery);if(r.id==='heroic-inspiration')out.at(-1)!.current=unprefix(a.speciesId)==='human'?1:0;}
  return out;
}
export function syncResources(a:Actor,refill=false){if(isFreeActor(a)){a.resources=buildResources(a);return;}const prev=new Map(a.resources.map(r=>[r.id,r]));a.resources=buildResources(a).map(r=>({...r,current:refill?r.current:prev.has(r.id)?Math.max(0,r.max-(prev.get(r.id)!.max-prev.get(r.id)!.current)):r.current}));for(const r of prev.values())if(r.id==='gp'||r.id.startsWith('item-')||r.id.startsWith('item:'))a.resources.push(r);}
export function applyLevelFeatures(a:Actor){if(isFreeActor(a))return;const features=new Set(a.features);for(const {c} of classData(a))for(let n=1;n<=c.level;n++){for(const f of lookup('levels',`${unprefix(c.classId)}-${n}`)?.features||[])features.add(`feature:${f.index}`);if(c.subclassId)for(const f of lookup('levels',`${unprefix(c.subclassId)}-${n}`)?.features||[])features.add(`feature:${f.index}`);}a.features=[...features];}
export function createActor(input:Partial<Actor> & Record<string,any> = {}):Actor {
  const abilities=Object.fromEntries(ABILITIES.map(k=>[k,input.abilities?.[k]??10])) as Record<Ability,number>;
  const a:Actor={id:input.id||uid(),name:String(input.name||'New adventurer').slice(0,100),kind:input.kind||'hero',ownerId:input.ownerId||'',abilities,classes:structuredClone(input.classes||[]),speciesId:input.speciesId||'',backgroundId:input.backgroundId||'',hp:{current:1,max:1,temp:0},deathSaves:{successes:0,failures:0},skills:[...(input.skills||[])],expertise:[...(input.expertise||[])],saveProficiencies:[...(input.saveProficiencies||[])],languages:[...(input.languages||[])],resources:[],inventory:structuredClone(input.inventory||[]),spells:[...(input.spells||[])],features:[...(input.features||[])],effects:structuredClone(input.effects||[]),position:input.position||{x:0,y:0},hidden:!!input.hidden,portrait:input.portrait,notes:String(input.notes||''),draft:input.draft??true,choices:structuredClone(input.choices||{}),size:input.size??1};
  Object.assign(a,{profile:input.profile,manual:input.manual?structuredClone(input.manual):undefined,customActions:structuredClone(input.customActions||[]),registration:input.registration,requestedBy:input.requestedBy,publicGroups:structuredClone(input.publicGroups||[]),knownEntries:[...(input.knownEntries||[])],growth:input.growth?structuredClone(input.growth):undefined,story:input.story});
  if(isFreeActor(a)){a.manual={maxHp:10,proficiency:0,ac:10,speed:30,...input.manual};a.draft=input.draft??false;a.resources=structuredClone(input.resources||[]);a.resistances=structuredClone(input.resistances||[]);a.immunities=structuredClone(input.immunities||[]);a.vulnerabilities=structuredClone(input.vulnerabilities||[]);}
  if(input.kind==='monster'&&!isFreeActor(a)){Object.assign(a,{baseAc:input.baseAc,baseSpeed:input.baseSpeed,monsterActions:input.monsterActions,resistances:input.resistances,immunities:input.immunities,vulnerabilities:input.vulnerabilities});a.choices!.baseMaxHp=input.hp?.max||1;}
  if(a.classes.length&&!isFreeActor(a)){const first=lookup('classes',a.classes[0].classId);a.saveProficiencies=(first?.saving_throws||[]).map((x:any)=>x.index);applyLevelFeatures(a);}
  const bg=lookup('backgrounds',a.backgroundId);if(bg&&!isFreeActor(a)){a.skills=[...new Set([...a.skills,...(bg.proficiencies||[]).filter((x:any)=>x.index.startsWith('skill-')).map((x:any)=>x.index.slice(6))])];if(bg.feat)a.features=[...new Set([...a.features,`feat:${bg.feat.index}`])];}
  applyBuildChoices(a);
  a.hp={max:input.kind==='monster'&&!isFreeActor(a)?input.hp?.max||1:maximumHp(a),current:1,temp:input.hp?.temp||0};a.hp.current=Math.min(a.hp.max,input.hp?.current??a.hp.max);a.resources=buildResources(a);
  return a;
}
export function validateActor(a:Actor):string[] {
  const errors:string[]=[];if(!a.name?.trim())errors.push('Name is required');if(a.profile!==undefined&&!['free','srd2024'].includes(a.profile))errors.push('Unknown character profile');
  if(isFreeActor(a)){
    for(const k of ABILITIES)if(!finiteFree(a.abilities?.[k]))errors.push('Invalid '+k+': expected a finite number within the technical range');
    if(!a.manual||!finiteFree(a.manual.maxHp,1)||!finiteFree(a.manual.proficiency)||!finiteFree(a.manual.ac)||!finiteFree(a.manual.speed,0))errors.push('Free cards require finite manual maxHp (>=1), proficiency, ac and speed (>=0)');
    if(!finiteFree(a.hp?.current,0)||!finiteFree(a.hp?.temp,0)||!finiteFree(a.hp?.max,1))errors.push('Invalid free HP values');
    const resourceIds=new Set<string>();for(const r of a.resources||[]){if(!r.id||resourceIds.has(r.id)||!finiteFree(r.max,0)||!finiteFree(r.current,0)||r.current>r.max||!['manual','short','long','turn'].includes(r.recovery))errors.push('Invalid or duplicate free resource '+r.id);resourceIds.add(r.id);}
    const actionIds=new Set<string>();if((a.customActions||[]).length>1000)errors.push('Too many custom actions');
    const reserved=new Set(['dash','dodge','disengage','stand','drop-prone','grapple','shove','escape-grapple','help','roll-dice','check','ability-check']);
    for(const action of a.customActions||[]){
      if(!action.id||actionIds.has(action.id)||reserved.has(action.id)||!action.name?.trim()||action.source!=='custom'||!['action','bonus','reaction','free'].includes(action.economy))errors.push('Invalid custom action identity or economy');actionIds.add(action.id);
      for(const value of [action.castingAbility,action.attack?.ability,action.healingAbility,...(action.damage||[]).map(part=>part.addAbility)])if(value!==undefined&&!ABILITIES.includes(value))errors.push('Invalid custom action ability');
      if(action.attack?.bonus!==undefined&&!finiteFree(action.attack.bonus))errors.push('Invalid custom attack bonus');
      if(action.save&&(!ABILITIES.includes(action.save.ability)||!['half','none','other'].includes(action.save.success)||action.save.dc!==undefined&&!finiteFree(action.save.dc)||action.save.dc===undefined&&!action.castingAbility&&!action.attack?.ability))errors.push('Custom save needs a valid target ability and explicit dc or castingAbility');
      for(const value of [action.range,action.reach,action.duration,action.level,action.area?.size])if(value!==undefined&&!finiteFree(value,0))errors.push('Invalid custom action range, level, duration or area');
      if(action.targets!==undefined&&(!Number.isInteger(action.targets)||action.targets<1||action.targets>500))errors.push('Invalid custom action target count');
      if(action.area&&!['sphere','cone','cube','line','cylinder'].includes(action.area.shape))errors.push('Invalid custom action area shape');
      for(const cost of action.costs||[])if(!resourceIds.has(cost.resourceId)||!finiteFree(cost.amount,0))errors.push('Custom action cost needs an existing resource and finite nonnegative amount');
      for(const condition of action.conditions||[])if(!lookup('conditions',condition))errors.push('Unknown custom action condition '+condition);
      try{for(const part of action.damage||[]){if(!DAMAGE_TYPES.includes(part.type))errors.push('Custom damage must use a supported damage type');rollExpression(part.formula,()=>1);}if(action.healing)rollExpression(action.healing,()=>1);}catch{errors.push('Invalid custom action dice formula');}
      if(!['automatic','choice','adjudication','unsupported'].includes(action.automation))errors.push('Invalid custom action automation');
    }
    return [...new Set(errors)];
  }
  return [...errors,...validateStandardActor(a,raw)];
}
export function deriveActor(a:Actor):DerivedActor {
  const items=itemBonuses(a);const modifiers=Object.fromEntries(ABILITIES.map(k=>[k,modifier(isFreeActor(a)?Math.max(items.abilityMinimums[k]??-Infinity,a.abilities[k]+effectModifier(a,k)):Math.max(items.abilityMinimums[k]||0,Math.max(0,Math.min(30,a.abilities[k]+effectModifier(a,k)))))])) as Record<Ability,number>;const level=totalLevel(a),proficiency=isFreeActor(a)?a.manual?.proficiency??0:isStatblock(a)?Number(a.choices?.proficiency||2):2+Math.floor((Math.max(1,level)-1)/4);const parts=classData(a),explanation:string[]=[];
  const worn=a.inventory.filter(i=>i.equipped).map(i=>{const d=lookup('equipment',itemBaseEquipment(i)||i.contentId);return d?{...d,mithral:unprefix(i.contentId)==='mithral-armor'}:undefined;}).filter(Boolean);const shield=worn.some(x=>x.index==='shield');const armor=worn.filter(x=>x.armor_class&&x.index!=='shield');let ac=isFreeActor(a)?a.manual?.ac??10:a.baseAc??10+modifiers.dex;
  if(armor.length){const x=armor[0];ac=isFreeActor(a)?ac+Math.max(0,x.armor_class.base-10):x.armor_class.base+(x.armor_class.dex_bonus?Math.min(modifiers.dex,x.armor_class.max_bonus??Infinity):0);explanation.push(`Armor ${x.name}: AC ${ac}`);}else{if(items.unarmoredAcBase)ac=Math.max(ac,items.unarmoredAcBase+modifiers.dex);if(levelOf(a,'barbarian'))ac=Math.max(ac,10+modifiers.dex+modifiers.con);if(levelOf(a,'monk')&&!shield)ac=Math.max(ac,10+modifiers.dex+modifiers.wis);if(hasEffect(a,'mage-armor'))ac=Math.max(ac,13+modifiers.dex);}
  if(shield)ac+=2;ac+=extraArmor(a,armor.length>0);if(a.acOverride!==undefined)ac=a.acOverride;ac+=effectModifier(a,'ac')+items.ac;ac=Math.max(ac,...a.effects.map(e=>e.modifiers?.acMinimum||0));
  let speed=a.speedOverride??(isFreeActor(a)?a.manual?.speed??30:a.baseSpeed??lookup('species',a.speciesId)?.speed??30);
  if(!isFreeActor(a)&&!armor.length&&!shield&&levelOf(a,'monk'))speed+=lookup('levels',`monk-${levelOf(a,'monk')}`)?.class_specific?.unarmored_movement_bonus||0;
  speed=Math.max(speed,items.speedMinimum);if(armor.some(x=>!x.mithral&&a.abilities.str<(x.str_minimum||0))&&!items.speedMinimum)speed-=10;
  speed+=isFreeActor(a)?0:extraSpeed(a,armor.some(x=>x.equipment_categories?.some((c:any)=>c.index==='heavy-armor')));
  speed+=effectModifier(a,'speed')+items.speed;speed*=items.speedMultiplier;
  const exhaustion=Number(a.choices?.exhaustion||0);speed=Math.max(0,speed-5*exhaustion);if(['grappled','restrained','paralyzed','petrified','stunned','unconscious'].some(c=>hasEffect(a,c)))speed=0;
  speed=Math.min(speed,...a.effects.filter(e=>e.modifiers?.speedMaximum!==undefined).map(e=>e.modifiers!.speedMaximum));
  const spellAbility=(parts.find(x=>x.d?.spellcasting)?.d.spellcasting.spellcasting_ability.index||'int') as Ability;
  const profs=new Set(parts.flatMap(x=>(x.d?.proficiencies||[]).map((p:any)=>p.index)));const attacks:ActionDefinition[]=[];
  for(const it of a.inventory.filter(i=>i.equipped&&i.quantity>0)){const d=lookup('equipment',itemBaseEquipment(it)||it.contentId);if(!d?.damage)continue;const ranged=d.equipment_categories.some((x:any)=>x.index==='ranged-weapons');const finesse=d.properties?.some((p:any)=>p.index==='finesse');const ability:Ability=ranged||finesse&&modifiers.dex>modifiers.str?'dex':'str';const proficient=d.equipment_categories.some((x:any)=>profs.has(x.index))||profs.has(d.index);const action=weaponAction(d,ability,proficient);if(it.contentId.startsWith('magic-item:')){action.id='item:'+it.id+':attack';action.name=it.name;const b=weaponBonus(a,it.id);if(b.damageType)action.damage![0].type=b.damageType;}attacks.push(action);}
  const martial=levelOf(a,'monk')&&!armor.length&&!shield;const die=lookup('levels',`monk-${levelOf(a,'monk')}`)?.class_specific?.martial_arts_die;const unarmedAbility:Ability=martial&&modifiers.dex>modifiers.str?'dex':'str';attacks.push({id:'unarmed-strike',name:'Unarmed Strike',source:'weapon',economy:'action',reach:5,range:5,attack:{ability:unarmedAbility,proficient:true},damage:[{formula:martial?`1d${die||6}`:'1',type:'bludgeoning',addAbility:unarmedAbility}],description:'Damage, grapple, or shove. Select grapple/shove as a basic action.',automation:'automatic'});
  for(const id of a.spells){const entry=getEntry(id.includes(':')?id:`spell:${id}`);if(entry?.action)attacks.push(structuredClone(entry.action));}
  if(a.monsterActions)attacks.push(...a.monsterActions);
  attacks.push(...structuredClone(a.customActions||[]));if(!isFreeActor(a))attacks.push(...featureActions(a));for(const it of a.inventory)if(itemActionAvailable(a,it.id)){const cov=itemCoverage(it.contentId);attacks.push({id:'item:'+it.id,name:it.name,source:'feature',economy:'action',description:getEntry(it.contentId)?.description||'',automation:cov.automation,reason:cov.reason});}
  explanation.push(`Level ${level}, proficiency +${proficiency}; ability modifiers use floor((score−10)/2).`,`Rules baseline SRD 5.2.1. See content coverage for feature automation limits.`);
  return {level,proficiency,modifiers,ac,speed,initiative:modifiers.dex+(hasFeat(a,'alert')?proficiency:0),spellAbility,spellAttack:proficiency+modifiers[spellAbility]+items.spellAttackBonus,spellDC:8+proficiency+modifiers[spellAbility]+items.spellDCBonus+(unprefix(parts.find(x=>x.d?.spellcasting)?.c.classId||'')==='sorcerer'?effectModifier(a,'spellDC'):0),maxHp:maximumHp(a),attacks,explanation};
}
export function createMonster(contentId:string,ownerId:string):Actor {
  const d=lookup('monsters',contentId);assert(d,'UNKNOWN_CONTENT','Unknown SRD monster');
  const abilities=Object.fromEntries(ABILITIES.map((k,i)=>[k,d[['strength','dexterity','constitution','intelligence','wisdom','charisma'][i]]])) as Record<Ability,number>;
  const monsterActions:ActionDefinition[]=(d.actions||[]).map((s:any,n:number)=>{
    const extra=/saving throw|condition|grapple|swallow|if |unless|plus .*if|recharge|hit points|and the target|on a failed|each creature/i.test(s.desc||'');
    const simple=!!s.attack_bonus&&s.damage?.length>0&&!extra;
    return {id:`monster:${d.index}:${n}`,name:s.name,source:'monster',economy:'action',range:Number(s.desc?.match(/range (\d+)/i)?.[1]??s.desc?.match(/reach (\d+)/i)?.[1]??5),reach:Number(s.desc?.match(/reach (\d+)/i)?.[1]??5),attack:s.attack_bonus!==undefined?{bonus:s.attack_bonus,ranged:/Ranged Attack/i.test(s.desc)}:undefined,damage:s.damage?.filter((p:any)=>p.damage_dice&&p.damage_type).map((p:any)=>({formula:p.damage_dice,type:p.damage_type.index})),description:s.desc,automation:simple?'automatic':'unsupported',reason:simple?undefined:'This monster action has conditional/special mechanics requiring a dedicated adapter.'};
  });
  const a=createActor({name:d.name,kind:'monster',ownerId,abilities,hp:{max:d.hit_points,current:d.hit_points,temp:0},baseAc:d.armor_class[0].value,baseSpeed:parseInt(d.speed.walk)||0,monsterActions,resistances:d.damage_resistances?.filter((x:string)=>DAMAGE_TYPES.includes(x as any)),immunities:d.damage_immunities?.filter((x:string)=>DAMAGE_TYPES.includes(x as any)),vulnerabilities:d.damage_vulnerabilities?.filter((x:string)=>DAMAGE_TYPES.includes(x as any)),draft:false});a.size=({Tiny:0.25,Small:0.5,Medium:1,Large:2,Huge:3,Gargantuan:4} as Record<string,number>)[d.size]||1;a.saveProficiencies=(d.proficiencies||[]).filter((p:any)=>p.proficiency?.index?.startsWith('saving-throw-')).map((p:any)=>p.proficiency.index.slice(13));a.skills=(d.proficiencies||[]).filter((p:any)=>p.proficiency?.index?.startsWith('skill-')).map((p:any)=>p.proficiency.index.slice(6));a.choices={baseMaxHp:d.hit_points,monsterId:d.index,creatureType:d.type,proficiency:d.proficiency_bonus,conditionImmunities:d.condition_immunities?.map((x:any)=>x.index)};return a;
}
