import type {Actor,ActionDefinition,GameState,Resolution} from '../shared/model.ts';
import {lookup,unprefix} from '../content/index.ts';
import {equipmentData,equipmentInstance} from './equipment.ts';
import {effectModifier} from './actors.ts';
import {itemBonuses,itemBaseEquipment} from './item-effects.ts';
import {assert} from './dice.ts';
type Options=Record<string,any>;
type Log=Resolution['events'];
export interface WeaponPlan {itemId:string;ammunitionId?:string;loadingKey?:string;actionSerial:number;thrown:boolean}
const property=(data:any,id:string)=>data?.properties?.some((p:any)=>p.index===id);
const shield=(actor:Actor)=>actor.inventory.some(i=>i.equipped&&i.quantity>0&&unprefix(itemBaseEquipment(i)||i.contentId)==='shield');
export function weaponHandsAvailable(actor:Actor,action:ActionDefinition){const d=equipmentData(actor,action.id);return !shield(actor)||!property(d,'two-handed')&&!property(d,'ammunition');}
/** Establish range/mode and reserve ammunition before costs. Commit only after normal action-economy validation. */
export function prepareWeaponAttack(state:GameState,actor:Actor,action:ActionDefinition,options:Options):WeaponPlan|undefined{
 if(action.source!=='weapon')return;const item=equipmentInstance(actor,action.id,options.itemId),d=equipmentData(actor,action.id);if(!item||!d?.damage)return;
 assert(weaponHandsAvailable(actor,action),'HANDS_REQUIRED','This weapon requires a second hand; stow the shield before attacking');
 const selectedAbility=options.weaponAbility??(property(d,'finesse')?options.ability:undefined);if(selectedAbility!==undefined){assert(property(d,'finesse')&&['str','dex'].includes(selectedAbility),'INVALID_WEAPON_ABILITY','Only a Finesse weapon can choose Strength or Dexterity');action.attack!.ability=selectedAbility;for(const part of action.damage||[])if(part.addAbility)part.addAbility=selectedAbility;}
 const thrown=options.thrown===true;if(thrown){assert(property(d,'thrown'),'NOT_THROWN','This weapon has no Thrown property');assert(!options.twoHanded,'INVALID_WEAPON_MODE','Thrown attacks do not use Versatile two-handed damage');action.attack!.ranged=true;action.range=d.throw_range?.long||d.throw_range?.normal;options._weaponNormalRange=d.throw_range?.normal;}else if(action.attack?.ranged){action.range=d.range?.long||d.range?.normal;options._weaponNormalRange=d.range?.normal;}
 const serial=Number(actor.choices?._attackActionSerial||0)+(state.combat.active&&!options.newAttackAction&&action.economy==='action'&&(state.combat.budgets[actor.id]?.attacks||0)>0?0:1);const turn=state.combat.active?state.combat.round+':'+state.combat.turn:'outside';
 const key=property(d,'loading')?turn+':'+action.economy+':'+serial+':'+item.id:undefined;
 assert(!key||!(actor.choices?._loadedActions as string[]||[]).includes(key),'LOADING_LIMIT','A Loading weapon fires only once per action, Bonus Action, or Reaction');
 let ammunitionId:string|undefined;if(property(d,'ammunition')){const ammo=actor.inventory.find(i=>i.quantity>0&&unprefix(i.contentId)===d.ammunition?.index&&(options.ammunitionId===undefined||i.id===options.ammunitionId));assert(ammo,'AMMUNITION_REQUIRED','This attack requires '+(d.ammunition?.name||'matching ammunition'));ammunitionId=ammo.id;}
 return {itemId:item.id,ammunitionId,loadingKey:key,actionSerial:serial,thrown};
}
export function commitWeaponAttack(actor:Actor,plan:WeaponPlan|undefined,options:Options,log:Log){if(!plan)return;actor.choices||={};actor.choices._attackActionSerial=plan.actionSerial;if(plan.loadingKey){const used=(actor.choices._loadedActions||=[]) as string[];used.push(plan.loadingKey);if(used.length>100)used.splice(0,used.length-100);}if(plan.ammunitionId){const ammo=actor.inventory.find(i=>i.id===plan.ammunitionId)!;ammo.quantity--;const used=(actor.choices._spentAmmunition||={}) as Record<string,number>;used[ammo.contentId]=(used[ammo.contentId]||0)+1;log.push({type:'ammunition',actorId:actor.id,message:actor.name+' expends one '+ammo.name});}if(plan.thrown)options._thrownItemId=plan.itemId;}
/** Finish after the hit/miss or a nested Shield decision, so poison and magic bonuses use the thrown instance. */
export function finishWeaponAttack(actor:Actor,options:Options,log:Log){if(!options._thrownItemId)return;const item=actor.inventory.find(i=>i.id===options._thrownItemId);assert(item&&item.quantity>0,'THROWN_ITEM_MISSING','The thrown weapon instance is unavailable');item.quantity--;if(!item.quantity)item.equipped=false;actor.choices||={};const thrown=(actor.choices._thrownWeapons||=[]) as unknown[];thrown.push({itemId:item.id,contentId:item.contentId,quantity:1,position:options._thrownDestination});log.push({type:'weapon-thrown',actorId:actor.id,message:actor.name+' throws '+item.name+'; recovery requires returning to its location'});delete options._thrownItemId;}
export function weaponPropertyDisadvantage(actor:Actor,action:ActionDefinition,distance:number,options:Options){const d=equipmentData(actor,action.id);if(action.source!=='weapon'||!d)return false;const ability=d.equipment_categories.some((c:any)=>c.index==='ranged-weapons')?'dex':'str',score=Math.max(itemBonuses(actor).abilityMinimums[ability]||0,actor.abilities[ability]+effectModifier(actor,ability));return !!(property(d,'heavy')&&score<13||action.attack?.ranged&&options._weaponNormalRange!==undefined&&distance>options._weaponNormalRange);}
