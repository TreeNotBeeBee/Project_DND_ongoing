import type {Actor, Resolution} from '../shared/model.ts';
import {getEntry,lookup,unprefix} from '../content/index.ts';
import {assert,integer,uid} from './dice.ts';

/** A packet is an explicit GM assertion that the complete published material
 * requirement has been obtained. It is never an arbitrary gold substitution. */
export function spellMaterialRequirement(spellId:string):{spellId:string;description:string;consumed:boolean}|undefined{
  const spell=lookup('spells',spellId);
  if(!spell?.components?.includes('M')||!spell.material)return;
  const description=String(spell.material);
  if(!/\b(?:GP|SP|CP)\b|Copper Pieces|consumes/i.test(description))return;
  return {spellId:'spell:'+spell.index,description,consumed:/consumes/i.test(description)};
}

export function grantSpellMaterials(actor:Actor,spellId:string,quantity:number,log:Resolution['events']):void{
  const requirement=spellMaterialRequirement(spellId);
  assert(requirement,'NO_SPECIAL_MATERIAL','This spell has no priced or consumed material requirement');
  integer(quantity,1,999,'Material packets');
  const existing=actor.inventory.find(item=>item.componentFor===requirement.spellId);
  if(existing){assert(existing.quantity+quantity<=999,'MATERIAL_LIMIT','At most 999 packets per material lot');existing.quantity+=quantity;}
  else actor.inventory.push({id:uid(),contentId:requirement.spellId,name:getEntry(requirement.spellId)!.name+' · 施法材料',componentFor:requirement.spellId,notes:requirement.description,quantity,equipped:false});
  log.push({type:'inventory',actorId:actor.id,message:`GM confirms ${quantity} complete material packet(s) for ${getEntry(requirement.spellId)!.name}: ${requirement.description}`,source:'SRD 5.2.1, Material Components'});
}

export function paySpellMaterials(actor:Actor,spellId:string,options:Record<string,unknown>,log:Resolution['events']):void{
  const requirement=spellMaterialRequirement(spellId);if(!requirement)return;
  // Bless specifically accepts the published, reusable 5 GP holy symbols.
  const candidates=actor.inventory.filter(item=>{
    if(item.quantity<1)return false;
    if(item.componentFor===requirement.spellId)return true;
    if(unprefix(spellId)!=='bless'||item.componentFor)return false;
    const equipment=lookup('equipment',item.contentId),cost=equipment?.cost;
    const gp=cost?.quantity*({gp:1,sp:0.1,cp:0.01,ep:0.5,pp:10} as Record<string,number>)[cost?.unit];
    return gp>=5&&equipment?.equipment_categories?.some((category:{index:string})=>category.index==='holy-symbols');
  });
  const selected=options.componentItemId===undefined?candidates[0]:candidates.find(item=>item.id===options.componentItemId);
  assert(selected,'MATERIAL_REQUIRED',`Required material: ${requirement.description}. Select an existing qualifying item or ask the GM to record the actual materials obtained.`);
  if(requirement.consumed){
    // Mixed reusable/consumed requirements need separate durable components;
    // fail closed rather than destroy Legend Lore's reusable ivory each cast.
    assert(!/consumes[\s\S]*\band\b[\s\S]*\bworth\b/i.test(requirement.description),'MATERIAL_WORKFLOW_REQUIRED','This mixed consumed/reusable material requirement needs a dedicated component workflow');
    selected.quantity--;
  }
  log.push({type:'spell-material',actorId:actor.id,message:`${getEntry(requirement.spellId)!.name}: ${requirement.consumed?'consumed':'used (retained)'} ${selected.name}`,source:'SRD 5.2.1, Material Components'});
}
