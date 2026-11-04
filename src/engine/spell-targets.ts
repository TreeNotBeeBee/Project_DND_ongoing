import type {Actor,ActionDefinition,GameState} from '../shared/model.ts';
import {assert} from './dice.ts';
import {distance,lineOfSight,validatePosition} from './map.ts';
import {areaContains,resolveSpellArea} from '../shared/spell-geometry.ts';
import {tokenCells} from './spatial.ts';

const id=(action:ActionDefinition)=>action.id.split(':').at(-1)!;
const targetScaling:Record<string,{base:number;level:number}>={
  bless:{base:3,level:1},bane:{base:3,level:1},
  'blindness-deafness':{base:1,level:2},'hold-person':{base:1,level:2},'hold-monster':{base:1,level:5},
};

/** Published target counts are computed once from the actual expended slot. */
export function prepareAuditedSpell(action:ActionDefinition,rank:number):void{
  if(action.source!=='spell')return;
  const scaling=targetScaling[id(action)];
  if(scaling)action.targets=scaling.base+Math.max(0,rank-scaling.level);
  if(id(action)==='mass-cure-wounds'){action.targets=6;action.area={shape:'sphere',size:30};}
}

/** Validate before saves or effects so a successful save never legitimizes an invalid target. */
export function validateAuditedTargets(state:GameState,source:Actor,action:ActionDefinition,targets:Actor[],payload:Record<string,any>):void{
  if(action.source!=='spell')return;
  const spell=id(action),options=payload.options||{};
  if(targetScaling[spell])assert(targets.length<=(action.targets||1),'TOO_MANY_TARGETS','Too many targets for this spell slot');
  if(spell==='blindness-deafness')assert(['blinded','deafened'].includes(options.condition??'blinded'),'INVALID_CONDITION','Blindness/Deafness can impose only Blinded or Deafened');
  if(spell==='hold-person')for(const target of targets){
    const pc=target.kind==='hero'||target.kind==='companion'&&!target.choices?.monsterId;
    const creatureType=String(target.choices?.creatureType??(pc?'humanoid':'')).toLowerCase();
    assert(creatureType==='humanoid','INVALID_TARGET','Hold Person targets only Humanoids, including statblock companions');
  }
  if(spell==='mass-cure-wounds'){
    assert(targets.length>0&&targets.length<=6,'TOO_MANY_TARGETS','Mass Cure Wounds selects one to six creatures');
    assert(payload.origin,'AREA_ORIGIN_REQUIRED','Choose the center of the Mass Cure Wounds sphere');
    validatePosition(state.scene,payload.origin);
    const area=resolveSpellArea(action,source.position,{origin:payload.origin},state.scene.gridFeet);
    const castingCells=tokenCells(source,source.position,state.scene.gridFeet).filter(cell=>distance(cell,area.origin,state.scene.gridFeet)<=60);
    assert(castingCells.length>0,'OUT_OF_RANGE','Mass Cure Wounds sphere center must be within 60 feet');
    assert(castingCells.some(cell=>lineOfSight(state.scene,cell,area.origin)),'NO_LINE_OF_SIGHT','Mass Cure Wounds sphere center must be visible');
    for(const target of targets)assert(tokenCells(target,target.position,state.scene.gridFeet).some(cell=>areaContains(area,cell)&&lineOfSight(state.scene,area.origin,cell)),'OUTSIDE_AREA','Every selected creature must be within the same 30-foot-radius sphere and outside total cover');
  }
}
