import database from './raw/srd-2024.json' with { type: 'json' };
import manifest from './raw/manifest.json' with { type: 'json' };
import officialSpellIndex from './official-spell-index.json' with {type:'json'};
import type { ActionDefinition, ContentEntry, Ability, DamageType } from '../shared/model.ts';
import {itemCoverage,additionalItemEntries,itemCorrections,getItemAdapter} from './item-adapters.ts';
import {additionalSpellPatches} from './spell-adapters.ts';
import {automatedFeatures,automatedTraits,automatedFeats,partialFeatureReasons} from './feature-adapters.ts';

export const raw = structuredClone(database) as Record<string, any[]>;
// Official PDF p78 supersedes a known community transcription error. Preserve raw hashes.
export const corrections = [{id:'wizard-prepared-spells',sourcePage:78,officialSha256:'8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87',reason:'Upstream prose incorrectly says choose two level four spells; official text says choose four spells.'}];
for(const id of ['power-word-heal','power-word-kill']){
  raw.spells.find(spell=>spell.index===id)!.components=['V'];
  corrections.push({id:id+'-verbal-component',sourcePage:154,officialSha256:'8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87',reason:'The official spell requires its Verbal component; the upstream components array was empty.'});
}
const itemTextCorrections:Record<string,string>={'potion-of-heroism':'For 1 hour, you gain 10 Temporary Hit Points and the effects of Bless without Concentration. Drinking or administering this potion uses a Bonus Action.','vicious-weapon':'When you hit a creature with this magic weapon, the weapon deals an extra 2d6 damage of its damage type.','ring-of-warmth':'While attuned and wearing this ring, reduce each instance of Cold damage by 2d8. The ring also protects you and your equipment from the cold down to −50 degrees Fahrenheit.'};
for(const correction of itemCorrections){const item=raw['magic-items'].find(x=>x.index===correction.id);if(item&&itemTextCorrections[correction.id])item.desc=[itemTextCorrections[correction.id]];}
const wizard=raw.classes.find(c=>c.index==='wizard');
for(const info of wizard?.spellcasting?.info||[])if(info.name==='Prepared Spells of Level 1+')info.desc=info.desc.map((s:string)=>s.replace('choose two level four spells','choose four spells'));
export const source = manifest;
const officialSpellPages=new Map(officialSpellIndex.spells.map(s=>[s.id,s.sourcePage]));
export const attribution = 'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';
const categories: Record<string,string> = { 'ability-scores':'ability','alignments':'alignment','backgrounds':'background','classes':'class','conditions':'condition','damage-types':'damage-type','equipment-categories':'equipment-category','equipment':'equipment','feats':'feat','features':'feature','languages':'language','levels':'level','magic-items':'magic-item','magic-schools':'school','monsters':'monster','poisons':'poison','proficiencies':'proficiency','skills':'skill','species':'species','spells':'spell','subclasses':'subclass','subspecies':'subspecies','traits':'trait','weapon-mastery-properties':'mastery','weapon-properties':'weapon-property' };
export const unprefix = (id: string) => String(id || '').split(':').at(-1)!;
export function lookup(category: string, id: string) { return raw[category]?.find(x=>x.index===unprefix(id)); }
const spells: Record<string,Partial<ActionDefinition>> = {...additionalSpellPatches,
  'acid-splash': {save:{ability:'dex',success:'none'},area:{shape:'sphere',size:5}},
  'fire-bolt': {attack:{ranged:true},scaling:{5:'2d10',11:'3d10',17:'4d10'}},
  'ray-of-frost': {attack:{ranged:true},scaling:{5:'2d8',11:'3d8',17:'4d8'},duration:1},
  'shocking-grasp': {attack:{ranged:false},scaling:{5:'2d8',11:'3d8',17:'4d8'},duration:1},
  'chill-touch': {attack:{ranged:false},scaling:{5:'2d10',11:'3d10',17:'4d10'},duration:1},
  'poison-spray': {attack:{ranged:true},scaling:{5:'2d12',11:'3d12',17:'4d12'}},
  'sacred-flame': {save:{ability:'dex',success:'none'},scaling:{5:'2d8',11:'3d8',17:'4d8'}},
  'word-of-radiance': {save:{ability:'con',success:'none'},area:{shape:'sphere',size:5},scaling:{5:'2d6',11:'3d6',17:'4d6'}},
  'thunderclap': {save:{ability:'con',success:'none'},area:{shape:'sphere',size:5},scaling:{5:'2d6',11:'3d6',17:'4d6'}},
  'eldritch-blast': {attack:{ranged:true}},
  'burning-hands': {save:{ability:'dex',success:'half'},area:{shape:'cone',size:15}},
  'thunderwave': {save:{ability:'con',success:'half'},area:{shape:'cube',size:15}},
  'fireball': {save:{ability:'dex',success:'half'},area:{shape:'sphere',size:20}},
  'lightning-bolt': {save:{ability:'dex',success:'half'},area:{shape:'line',size:100}},
  'cone-of-cold': {save:{ability:'con',success:'half'},area:{shape:'cone',size:60}},
  'shatter': {save:{ability:'con',success:'half'},area:{shape:'sphere',size:10}},
  'ice-storm': {save:{ability:'dex',success:'half'},area:{shape:'cylinder',size:20},damage:[{formula:'2d10',type:'bludgeoning'},{formula:'4d6',type:'cold'}]},
  'magic-missile': {damage:[{formula:'1d4+1',type:'force'}]},
  'guiding-bolt': {attack:{ranged:true},duration:1},
  'inflict-wounds': {save:{ability:'con',success:'half'}},
  'scorching-ray': {attack:{ranged:true}},
  'blight': {save:{ability:'con',success:'half'}},
  'flame-strike': {save:{ability:'dex',success:'half'},area:{shape:'cylinder',size:10},damage:[{formula:'5d6',type:'fire'},{formula:'5d6',type:'radiant'}]},
  'finger-of-death': {save:{ability:'con',success:'half'}},
  'disintegrate': {save:{ability:'dex',success:'none'}},
  'sunburst': {save:{ability:'con',success:'half'},area:{shape:'sphere',size:60},conditions:['blinded'],duration:10},
  'meteor-swarm': {save:{ability:'dex',success:'half'},area:{shape:'sphere',size:40},damage:[{formula:'20d6',type:'bludgeoning'},{formula:'20d6',type:'fire'}]},
  'cure-wounds': {healing:'2d8'},'healing-word':{healing:'2d4'},
  'mass-healing-word': {healing:'2d4',targets:6},'mass-cure-wounds':{healing:'5d8',targets:6,area:{shape:'sphere',size:30}},
  'heal': {healing:'70'},'power-word-heal':{healing:'0'},
  'bless': {targets:3,duration:10},'bane':{save:{ability:'cha',success:'none'},targets:3,duration:10},
  'shield': {economy:'reaction',duration:1},'mage-armor': {duration:4800},
  'shield-of-faith': {economy:'bonus',duration:100},
  'protection-from-energy': {duration:600},
  'lesser-restoration': {},'greater-restoration':{},
  'hold-person': {save:{ability:'wis',success:'none'},conditions:['paralyzed'],duration:10},
  'hold-monster': {save:{ability:'wis',success:'none'},conditions:['paralyzed'],duration:10},
  'blindness-deafness': {save:{ability:'con',success:'none'},duration:10},
  'sleep': {save:{ability:'wis',success:'none'},duration:10},
  'counterspell': {economy:'reaction',save:{ability:'con',success:'none'}},
  'dispel-magic': {},'revivify':{},'raise-dead':{},'resurrection':{},
  'death-ward': {duration:4800},'aid':{targets:3,duration:4800},
  'heroism':{duration:10},'false-life':{},
};
// Do not conflate a data adapter with an implementation. These need their bespoke rules first.
for (const id of ['ice-storm','blight','finger-of-death','disintegrate','sunburst','meteor-swarm','sleep','counterspell','dispel-magic','revivify','raise-dead','resurrection','greater-restoration','power-word-heal','heroism','false-life']) if(!additionalSpellPatches[id])delete spells[id];
const safeFeatures = new Set(['fighter-second-wind','fighter-action-surge','fighter-extra-attack','fighter-two-extra-attacks','fighter-three-extra-attacks','barbarian-rage','barbarian-unarmored-defense','barbarian-extra-attack','monk-unarmored-defense','monk-unarmored-movement','paladin-lay-on-hands','rogue-sneak-attack','rogue-expertise']);
const safeTraits = new Set(['dwarven-resilience','draconic-resistance','hellish-resistance','resourceful']);
const mundaneCategories = new Set(['ability','alignment','background','class','condition','damage-type','equipment-category','language','level','school','proficiency','skill','species','subclass','subspecies','weapon-property']);
function durationRounds(s:string) { const m=s.match(/(\d+) (minute|hour|round)/i); return m ? +m[1]*(m[2].toLowerCase()==='hour'?600:m[2].toLowerCase()==='minute'?10:1):undefined; }
function spellAction(d:any): ActionDefinition|undefined {
  const patch=spells[d.index]; if(!patch) return;
  const formula=d.damage?.damage_at_slot_level?.[d.level] ?? d.damage?.damage_at_character_level?.[1];
  return {id:`spell:${d.index}`,name:d.name,source:'spell',economy:/bonus/i.test(d.casting_time)?'bonus':/reaction/i.test(d.casting_time)?'reaction':'action',level:d.level,range:/self/i.test(d.range)?0:/touch/i.test(d.range)?5:parseInt(d.range)||undefined,damage:formula?[{formula,type:d.damage.damage_type.index}]:undefined,concentration:d.concentration,ritual:d.ritual,duration:durationRounds(d.duration),description:d.description,automation:'automatic',sourcePage:officialSpellPages.get(`spell:${d.index}`),...patch};
}
export const entries: ContentEntry[] = Object.entries(raw).flatMap(([category,values]) => values.map(d=>{
  const cat=categories[category];
  const action=cat==='spell'?spellAction(d):undefined;
  const description=String(d.description ?? d.desc?.join?.('\n') ?? d.desc ?? d.text ?? '');
  let automation:ContentEntry['automation']='unsupported';
  let reason:string|undefined='Structured source available; deterministic mechanics require an audited rule adapter before use.';
  if(mundaneCategories.has(cat)){automation=['class','background','species','subclass','subspecies'].includes(cat)?'choice':'automatic';reason=undefined;}
  if(cat==='equipment'){automation=d.damage||d.armor_class?'automatic':'choice';reason=undefined;}
  if(action || cat==='feature'&&(safeFeatures.has(d.index)||automatedFeatures.has(d.index)||/-ability-score-improvement$|-epic-boon$/.test(d.index)) || cat==='trait'&&(safeTraits.has(d.index)||automatedTraits.has(d.index)) || cat==='feat'&&automatedFeats.has(d.index)){automation='automatic';reason=undefined;}
  if(cat==='spell' && ['wish','augury','divination','commune','contact-other-plane','legend-lore','speak-with-dead','dream','minor-illusion','silent-image','major-image','hallucinatory-terrain','mirage-arcane','prestidigitation','thaumaturgy','druidcraft'].includes(d.index)) {automation='adjudication';reason='GM decides open-ended narrative effects; resource use still requires a recorded ruling.';}
  if(cat==='monster'){automation='choice';reason='Stat block and individual audited attacks available; special abilities retain their own coverage status.';}
  if(cat==='mastery'&&['sap','slow','topple','vex','push','cleave','nick','graze'].includes(d.index)){automation='automatic';reason=undefined;}
  if(action){automation=action.automation;reason=action.reason;}if(cat==='magic-item'||cat==='poison'||cat==='equipment'&&getItemAdapter(d.index)){const c=itemCoverage(d.index);automation=c.automation;reason=c.reason;}
  if(partialFeatureReasons[d.index]){automation='unsupported';reason=partialFeatureReasons[d.index];}
  return {id:`${cat}:${d.index}`,name:d.name,category:cat,description,source:'SRD 5.2.1 / 5e-bits 2024',sourcePage:action?.sourcePage??(cat==='spell'?officialSpellPages.get(`spell:${d.index}`):['magic-item','poison'].includes(cat)?itemCoverage(d.index).sourcePage:undefined),automation,reason,data:d,action};
}));
for(const e of additionalItemEntries)if(!entries.some(x=>x.id===e.id))entries.push(e);
const byId=new Map(entries.map(e=>[e.id,e]));
export function getEntry(id:string):ContentEntry|undefined { if(byId.has(id))return byId.get(id); const hits=entries.filter(e=>unprefix(e.id)===id); return hits.length===1?hits[0]:undefined; }
export const coverage = {
  ruleset:'srd-5.2.1',commit:manifest.commit,total:entries.length,
  counts:Object.fromEntries(['automatic','choice','adjudication','unsupported'].map(s=>[s,entries.filter(e=>e.automation===s).length])),
  categories:Object.fromEntries([...new Set(entries.map(e=>e.category))].map(c=>[c,{total:entries.filter(e=>e.category===c).length,automatic:entries.filter(e=>e.category===c&&e.automation==='automatic').length}])),
  entries:entries.map(e=>({id:e.id,status:e.automation,reason:e.reason})),
  complete:false,
  note:'Coverage distinguishes local reference data from tested executable rules. Unsupported deterministic entries are blocked, never approximated.'
};

export function weaponAction(d:any,ability:Ability,proficient:boolean,twoHanded=false):ActionDefinition {
  const damage=twoHanded&&d.two_handed_damage?d.two_handed_damage:d.damage;
  const ranged=d.equipment_categories?.some((x:any)=>x.index==='ranged-weapons');
  return {id:`equipment:${d.index}`,name:d.name,source:'weapon',economy:'action',range:ranged?(d.range?.normal||5):(d.properties?.some((p:any)=>p.index==='reach')?10:5),reach:d.properties?.some((p:any)=>p.index==='reach')?10:5,attack:{ability,proficient,ranged},damage:[{formula:damage.damage_dice,type:damage.damage_type.index as DamageType,addAbility:ability}],description:d.description||'',automation:'automatic'};
}
