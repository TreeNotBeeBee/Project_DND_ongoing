import type { Actor, ActionDefinition, Dice, Effect, GameState, Resolution, DamageType, Ability } from '../shared/model.ts';
import { assert, rollExpression, uid } from './dice.ts';
import { totalLevel, deriveActor, maximumHp } from './actors.ts';
import { distance, lineOfSight, validateTokenPosition } from './map.ts';
import {tokenCentre} from './spatial.ts';
import {ABILITIES} from '../shared/model.ts';

type Log = Resolution['events'];
export interface AdditionalSpellContext {
  state: GameState; source: Actor; target: Actor; action: ActionDefinition; rank: number;
  options: Record<string, any>; failed: boolean; dice: Dice; log: Log;
  spellAbility?: Ability;
  spellModifier?: number;
  spellSaveDC?: number;
  addEffect: (state: GameState, target: Actor, effect: Effect) => void;
  clearCondition: (actor: Actor, condition: string) => void;
  removeConcentration?: (state: GameState, actor: Actor) => void;
  heal?: (target: Actor, amount: number, log: Log, source: Actor) => void;
  damage?: (state: GameState, source: Actor, target: Actor, parts: {amount:number;type:DamageType}[], critical:boolean, dice:Dice, log:Log) => void;
  save?: (actor:Actor,ability:Ability,dc:number,dice:Dice,log:Log,label?:string,advantage?:number)=>boolean;
  spend?: (actor:Actor,resourceId:string,amount:number)=>void;
}
export function applyAdditionalSpellEffect(ctx: AdditionalSpellContext): boolean {
  const {state,source,target,action,rank,dice,log,addEffect,clearCondition}=ctx;
  const id=action.id.split(':').at(-1)!;
  const base:Effect={id:uid(),name:action.name,sourceId:id,sourceActorId:source.id,concentration:action.concentration,duration:action.duration,timing:'end'};
  const note=(message:string)=>log.push({type:'spell-effect',actorId:source.id,message,source:'SRD 5.2.1'});
  if(id==='heal'){
    // The common healing pipeline has already restored 70 + 10 per higher slot.
    for(const condition of ['blinded','deafened','poisoned'])clearCondition(target,condition);
    note(`${target.name}: Heal ends Blinded, Deafened and Poisoned.`);return true;
  }
  if(id==='false-life'){
    assert(target.id===source.id,'SELF_ONLY','False Life targets only the caster');
    const roll=rollExpression(`2d4+${4+5*Math.max(0,rank-1)}`,dice);
    // Existing temporary HP may always be retained; they never add together.
    const previous=target.hp.temp; target.hp.temp=Math.max(previous,roll.total);
    log.push({type:'temporary-hp',actorId:source.id,message:`${source.name}: False Life ${roll.total} Temporary HP; retained ${target.hp.temp} (previous ${previous}, never stacked)`,rolls:[roll],source:'SRD 5.2.1, False Life'});
    return true;
  }
  if(id==='spare-the-dying'){
    assert(target.hp.current===0&&!target.dead,'INVALID_TARGET','Spare the Dying requires a living creature at 0 HP');
    target.deathSaves={successes:3,failures:0}; note(`${target.name} becomes Stable at 0 HP.`);return true;
  }
  if(id==='protection-from-poison'){
    clearCondition(target,'poisoned');
    addEffect(state,target,{...base,resistance:['poison'],saveAdvantages:{conditions:['poisoned']}});
    note(`${target.name}: Poisoned ends; Poison Resistance and advantage against Poisoned for 1 hour.`);return true;
  }
  if(id==='stoneskin'){
    addEffect(state,target,{...base,resistance:['bludgeoning','piercing','slashing']});
    note(`${target.name}: Resistance to Bludgeoning, Piercing and Slashing while concentration lasts.`);return true;
  }
  if(id==='longstrider'){
    addEffect(state,target,{...base,modifiers:{speed:10}});note(`${target.name}: Speed +10 feet for 1 hour.`);return true;
  }
  if(id==='darkvision'){
    addEffect(state,target,{...base,modifiers:{darkvision:150}});note(`${target.name}: Darkvision 150 feet for 8 hours.`);return true;
  }
  if(id==='see-invisibility'){
    assert(target.id===source.id,'SELF_ONLY','See Invisibility targets only the caster');
    addEffect(state,target,base);note(`${target.name} sees Invisible creatures and into the Ethereal Plane for 1 hour.`);return true;
  }
  if(id==='ray-of-sickness'){
    addEffect(state,target,{...base,condition:'poisoned',duration:undefined,expiresOn:{actorId:source.id,timing:'end',round:state.combat.round+(state.combat.active?1:0)}});
    note(`${target.name}: Poisoned until the end of ${source.name}'s next turn.`);return true;
  }
  if(id==='misty-step'){
    assert(target.id===source.id,'SELF_ONLY','Misty Step targets only its caster');
    const destination=ctx.options.destination;validateTokenPosition(state.scene,source,destination,state.actors);
    assert(distance(source.position,destination,state.scene.gridFeet)<=30,'OUT_OF_RANGE','Misty Step teleports at most 30 feet');
    assert(lineOfSight(state.scene,tokenCentre(source,source.position,state.scene.gridFeet),tokenCentre(source,destination,state.scene.gridFeet)),'NO_LINE_OF_SIGHT','Misty Step destination must be visible');
    source.position={x:destination.x,y:destination.y};note(`${source.name} teleports to (${destination.x}, ${destination.y}) without spending movement.`);return true;
  }
  if(id==='barkskin'){
    addEffect(state,target,{...base,modifiers:{acMinimum:17}});note(`${target.name}: AC cannot be lower than 17 for 1 hour.`);return true;
  }
  if(id==='heroism'){
    assert(ctx.spellAbility,'SPELL_SOURCE_REQUIRED','Heroism requires its actual spellcasting source');
    const amount=Math.max(0,ctx.spellModifier??deriveActor(source).modifiers[ctx.spellAbility]);
    addEffect(state,target,{...base,modifiers:{tempHpEachStart:amount},conditionImmunities:['frightened']});
    note(`${target.name}: immune to Frightened; gains ${amount} Temporary HP at each turn start while concentration lasts.`);return true;
  }
  if(id==='greater-restoration'){
    const choice=ctx.options.restorationChoice;
    if(choice==='exhaustion'){target.choices||={};target.choices.exhaustion=Math.max(0,Number(target.choices.exhaustion||0)-1);}
    else if(choice==='charmed'||choice==='petrified')clearCondition(target,choice);
    else if(choice==='ability'||choice==='max-hp'){
      const hinted=ctx.options.effectId?target.effects.find(effect=>effect.id===ctx.options.effectId):undefined;
      if(ctx.options.effectId)assert(hinted,'EFFECT_REQUIRED','Choose the effect being ended');
      const reduced=ABILITIES.filter(key=>(hinted?[hinted]:target.effects).some(effect=>(effect.modifiers?.[key]||0)<0));
      const ability=ctx.options.restorationAbility??(reduced.length===1?reduced[0]:undefined);
      if(choice==='ability')assert(ABILITIES.includes(ability)&&target.effects.some(effect=>(effect.modifiers?.[ability]||0)<0),'CHOICE_REQUIRED','Choose exactly one ability score whose reductions end');
      const key=choice==='ability'?ability:'maxHp';
      assert(target.effects.some(effect=>(effect.modifiers?.[key]||0)<0),'INVALID_EFFECT','The target has no reduction of this kind');
      target.effects=target.effects.filter(effect=>{
        if((effect.modifiers?.[key]||0)>=0)return true;
        const modifiers={...effect.modifiers};delete modifiers[key];effect.modifiers=modifiers;
        // Preserve other reductions, conditions and protections from the same
        // source rather than treating an effect record as one indivisible stat.
        return Object.keys(modifiers).length>0||!!effect.condition||!!effect.resistance?.length||!!effect.immunity?.length||!!effect.vulnerability?.length||!!effect.conditionImmunities?.length||!!effect.saveAdvantages;
      });
      if(choice==='max-hp'){target.hp.max=maximumHp(target);target.hp.current=Math.min(target.hp.current,target.hp.max);}
    }
    else if(choice==='curse'){
      const effect=target.effects.find(value=>value.id===ctx.options.effectId);
      assert(effect,'EFFECT_REQUIRED','Choose the effect being ended');
      const matches=/curse/i.test(effect.sourceId||'')||/curse/i.test(effect.notes||'');
      assert(matches,'INVALID_EFFECT','The selected effect is not this kind of reduction or curse');
      target.effects=target.effects.filter(value=>value.id!==effect.id);
    }else assert(false,'CHOICE_REQUIRED','Choose one Greater Restoration effect');
    note(`${target.name}: Greater Restoration ends ${choice}.`);return true;
  }
  if(id==='power-word-kill'){
    assert(!target.dead,'DEAD_TARGET','Choose a living creature');
    if(target.hp.current<=100){
      const ward=target.effects.find(effect=>effect.sourceId==='death-ward');
      if(ward){target.effects=target.effects.filter(effect=>effect.id!==ward.id);note(`${target.name}: Death Ward prevents instant death and ends.`);}
      else {target.dead=true;target.hp.current=0;target.deathSaves={successes:0,failures:3};ctx.removeConcentration?.(state,target);note(`${target.name} dies from Power Word Kill (100 HP or fewer).`);}
    }else{
      assert(ctx.damage,'DAMAGE_HANDLER_REQUIRED','Damage handler is unavailable');const roll=rollExpression('12d12',dice);
      log.push({type:'damage-roll',actorId:source.id,targetIds:[target.id],message:'Power Word Kill: target above 100 HP takes 12d12 Psychic damage.',rolls:[roll]});
      ctx.damage(state,source,target,[{amount:roll.total,type:'psychic'}],false,dice,log);
    }return true;
  }
  if(id==='power-word-stun'){
    assert(!target.dead,'DEAD_TARGET','Choose a living creature');
    if(target.hp.current<=150){
      assert(ctx.spellAbility,'SPELL_SOURCE_REQUIRED','The spellcasting source is required');const derived=deriveActor(source),dc=ctx.spellSaveDC??8+derived.proficiency+(ctx.spellModifier??derived.modifiers[ctx.spellAbility]);
      addEffect(state,target,{...base,condition:'stunned',duration:undefined,notes:`repeat:con:${dc}`});note(`${target.name}: Stunned; repeat Constitution save DC ${dc} at each turn end.`);
    }else{addEffect(state,target,{...base,duration:undefined,modifiers:{speedMaximum:0},expiresOn:{actorId:source.id,timing:'start',round:state.combat.round+(state.combat.active?1:0)}});note(`${target.name}: above 150 HP, Speed 0 until the caster's next turn.`);}
    return true;
  }
  if(id==='power-word-heal'){
    assert(ctx.heal,'HEAL_HANDLER_REQUIRED','Healing handler is unavailable');ctx.heal(target,target.hp.max,log,source);
    for(const condition of ['charmed','frightened','paralyzed','poisoned','stunned'])clearCondition(target,condition);
    if(target.effects.some(effect=>effect.condition==='prone')&&(!state.combat.active||(state.combat.budgets[target.id]?.reaction||0)>0))state.choices.push({id:uid(),actorId:target.id,ownerId:target.ownerId,kind:'power-word-heal-stand',prompt:`${target.name}：使用反应从倒地站起？`,options:[{id:'stand',label:'使用反应站起'},{id:'remain',label:'保持倒地'}],payload:{}});
    note(`${target.name}: all HP restored; Charmed, Frightened, Paralyzed, Poisoned and Stunned end.`);return true;
  }
  if(id==='mass-heal'){
    const allocation=ctx.options.allocations;
    assert(allocation&&typeof allocation==='object'&&!Array.isArray(allocation),'CHOICE_REQUIRED','Specify the HP allocation for each target');
    const amounts=Object.values(allocation) as unknown[];
    assert(amounts.every(value=>Number.isInteger(value)&&Number(value)>=0)&&amounts.reduce<number>((sum,value)=>sum+Number(value),0)<=700,'INVALID_ALLOCATION','Mass Heal distributes at most 700 HP');
    const amount=Number(allocation[target.id]);assert(Number.isInteger(amount)&&amount>0,'INVALID_ALLOCATION','Each chosen target needs a positive HP allocation');
    assert(ctx.heal,'HEAL_HANDLER_REQUIRED','Healing handler is unavailable');ctx.heal(target,amount,log,source);
    for(const condition of ['blinded','deafened','poisoned'])clearCondition(target,condition);
    note(`${target.name}: Mass Heal ${amount} HP allocation; Blinded, Deafened and Poisoned end.`);return true;
  }
  return false;
}

/** Called before range/target validation; derived ranges are never supplied by clients. */
export function prepareAdditionalSpell(action: ActionDefinition, actor: Actor, rank:number):void {
  const id=action.id.split(':').at(-1)!;
  if(id==='spare-the-dying')action.range=totalLevel(actor)>=17?120:totalLevel(actor)>=11?60:totalLevel(actor)>=5?30:15;
  if(id==='longstrider')action.targets=1+Math.max(0,rank-1);
  if(id==='heroism')action.targets=rank;
}

export function resolveAdditionalSpellChoice(state:GameState,choice:import('../shared/model.ts').ChoiceRequest,optionId:string,log:Log):boolean{
  if(choice.kind!=='power-word-heal-stand')return false;
  assert(['stand','remain'].includes(optionId),'INVALID_CHOICE','Choose stand or remain prone');
  const target=state.actors.find(actor=>actor.id===choice.actorId);assert(target,'ACTOR_NOT_FOUND','Choice actor no longer exists');
  if(optionId==='stand'){
    if(state.combat.active){const budget=state.combat.budgets[target.id];assert(budget?.reaction>0,'NO_REACTION','No reaction remains');budget.reaction--;}
    target.effects=target.effects.filter(effect=>effect.condition!=='prone');
  }
  log.push({type:'reaction',actorId:target.id,message:optionId==='stand'?`${target.name} uses a reaction to stand after Power Word Heal.`:`${target.name} remains Prone.`});return true;
}
