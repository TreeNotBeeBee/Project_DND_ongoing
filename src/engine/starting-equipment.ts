import database from '../content/raw/srd-2024.json' with {type:'json'};
import type {Actor,ItemInstance} from '../shared/model.ts';
import {assert,uid} from './dice.ts';

const raw=database as Record<string,any[]>;
const key=(value:string)=>String(value||'').split(':').at(-1)!;
export interface StartingEquipmentSelection {classOption?:string|number;backgroundOption?:string|number;selections?:Record<string,string>}
export const startingEquipmentCorrections=[{id:'bard-musical-instrument',sourcePage:31,reason:'The official Bard option A includes a Musical Instrument of your choice; the pinned structured package omits that reference.'}];
function entry(category:string,id:string){return raw[category]?.find(x=>x.index===key(id));}
function packageOptions(actor:Actor,source:'class'|'background'){
  const record=source==='class'?entry('classes',actor.classes[0]?.classId):entry('backgrounds',actor.backgroundId);
  const choices=source==='class'?record?.starting_equipment_options:record?.equipment_options;
  assert(Array.isArray(choices)&&choices[0]?.from?.options?.length,'STARTING_EQUIPMENT_SOURCE',`No published ${source} equipment packages`);
  const values=structuredClone(choices[0].from.options);
  if(source==='class'&&key(actor.classes[0].classId)==='bard'&&values[0]?.items&&!values[0].items.some((x:any)=>x.choice?.from?.equipment_category?.index==='musical-instruments'))values[0].items.push({option_type:'choice',choice:{choose:1,from:{option_set_type:'equipment_category',equipment_category:{index:'musical-instruments'}}}});
  return{description:choices[0].desc,values};
}
export function startingEquipmentOptions(actor:Actor){return(['class','background'] as const).map(source=>{const {description,values}=packageOptions(actor,source);return{source,description,options:values.map((value:any,index:number)=>({id:String.fromCharCode(65+index),value}))};});}

/** Grant only source-defined packages once; clients supply a package selector, never item quantities. */
export function grantStartingEquipment(actor:Actor):boolean{
  if(actor.kind==='monster'||actor.kind==='companion'&&actor.choices?.monsterId||actor.draft||actor.choices?._startingEquipmentGranted)return false;
  const selection=(actor.choices?.startingEquipment||{}) as StartingEquipmentSelection;
  assert(selection&&typeof selection==='object'&&!Array.isArray(selection),'INVALID_STARTING_EQUIPMENT','Starting equipment choices must be an object');
  const selected=selection.selections||{};
  assert(selected&&typeof selected==='object'&&!Array.isArray(selected),'INVALID_STARTING_EQUIPMENT','Nested equipment selections must be an object');
  const additions=new Map<string,{quantity:number;notes?:string}>();let gold=0;
  const add=(contentId:string,quantity:number,notes?:string)=>{const previous=additions.get(contentId);additions.set(contentId,{quantity:(previous?.quantity||0)+quantity,notes:previous?.notes||notes});};
  function categoryItems(category:string):any[]{
    const refs=entry('equipment-categories',category)?.equipment||[];
    const ids=new Set(refs.map((x:any)=>x.index));
    return raw.equipment.filter(x=>ids.has(x.index)||x.equipment_categories?.some((c:any)=>c.index===category)).sort((a,b)=>a.name.localeCompare(b.name));
  }
  function chooseFrom(candidates:any[],path:string){
    assert(candidates.length>0,'STARTING_EQUIPMENT_SOURCE',`No legal equipment choices at ${path}`);
    const desired=selected[path];
    if(!desired)return candidates[0];
    const item=candidates.find(x=>x.index===key(desired));assert(item,'INVALID_STARTING_EQUIPMENT',`Equipment selection is outside its published category: ${path}`);return item;
  }
  function expand(option:any,path:string):void{
    assert(option&&typeof option==='object','STARTING_EQUIPMENT_SOURCE','Malformed source equipment option');
    if(option.option_type==='multiple'){option.items.forEach((value:any,index:number)=>expand(value,`${path}.${index}`));return;}
    if(option.option_type==='money'){assert(option.unit==='gp'&&Number.isFinite(option.count)&&option.count>=0,'STARTING_EQUIPMENT_SOURCE','Unrecognized starting currency');gold+=option.count;return;}
    if(option.option_type==='counted_reference'||option.option_type==='reference'){
      const reference=option.of||option.item;const quantity=option.count??1;assert(Number.isInteger(quantity)&&quantity>0&&quantity<=999,'STARTING_EQUIPMENT_SOURCE','Invalid source item quantity');
      let item=entry('equipment',reference.index);
      if(!item)item=chooseFrom(categoryItems(reference.index),path);
      add(`equipment:${item.index}`,quantity,reference.note);return;
    }
    if(option.option_type==='choice'){
      const choice=option.choice;assert(choice?.choose===1,'STARTING_EQUIPMENT_SOURCE','Only source single-item choices are supported');
      if(choice.from?.equipment_category){const item=chooseFrom(categoryItems(choice.from.equipment_category.index),path);add(`equipment:${item.index}`,1);return;}
      const options=choice.from?.options||[];const candidates=options.flatMap((value:any)=>value.choice?.from?.equipment_category?categoryItems(value.choice.from.equipment_category.index):value.item?[entry('equipment',value.item.index)].filter(Boolean):[]);
      const item=chooseFrom(candidates,path);add(`equipment:${item.index}`,1);return;
    }
    assert(false,'STARTING_EQUIPMENT_SOURCE',`Unhandled published equipment shape: ${option.option_type}`);
  }
  for(const source of ['class','background'] as const){
    const {values}=packageOptions(actor,source);const requested=source==='class'?selection.classOption:selection.backgroundOption;
    const index=typeof requested==='number'?requested:requested===undefined?0:String(requested).toUpperCase().charCodeAt(0)-65;
    assert(Number.isInteger(index)&&index>=0&&index<values.length,'INVALID_STARTING_EQUIPMENT',`Choose a published ${source} equipment package`);
    expand(values[index],`${source}:${index}`);
  }
  // Nothing touches actor state until every nested choice has passed validation.
  const inventory:ItemInstance[]=actor.inventory.map(item=>({...item}));
  for(const[contentId,value]of additions){const existing=inventory.find(i=>i.contentId===contentId&&!i.equipped);if(existing)existing.quantity+=value.quantity;else inventory.push({id:uid(),contentId,name:entry('equipment',contentId).name,quantity:value.quantity,equipped:false,notes:value.notes});}
  actor.inventory=inventory;
  const gp=actor.resources.find(r=>r.id==='gp');if(gp){gp.current+=gold;gp.max=Math.max(gp.max,gp.current);}else actor.resources.push({id:'gp',name:'Gold Pieces (GP)',current:gold,max:1_000_000_000,recovery:'manual'});
  actor.choices||={};actor.choices._startingEquipmentGranted=true;actor.choices._startingEquipmentGold=gold;
  return true;
}
