import data from './raw/srd-2024.json' with {type:'json'};
import {DAMAGE_TYPES,type Ability,type DamageType,type ContentEntry} from '../shared/model.ts';

export interface ItemPassive {ac?:number;save?:number;check?:number;spellAttack?:number;spellDC?:number;minimum?:Partial<Record<Ability,number>>;resistance?:DamageType[];immunity?:DamageType[];darkvision?:number;criticalImmunity?:boolean;ignoreHalfCover?:boolean;spellImmunities?:string[];speedMinimum?:number;swimSpeed?:number;climbSpeed?:number;waterBreathing?:boolean;magicSaveAdvantage?:boolean;freeAction?:boolean;weaponWarning?:boolean;coldReduction?:string}
export interface ItemSpell {spellId:string;rank:number;cost:number;dc?:number;attackBonus?:number;maxRank?:number;chargePerRank?:boolean}
export interface ItemAdapter {id:string;sourcePage:number;automation:ContentEntry['automation'];reason?:string;capabilities:string[];passive?:ItemPassive;kind?:'weapon'|'armor'|'shield';baseContentId?:string;weaponBonus?:number;extraDamage?:{formula:string;type?:DamageType;creatureTypes?:string[]}[];charges?:{max:number;recharge:'dawn'|'short'|'long'|'manual';formula?:string;last?:'destroy-on-1'|'power'|'mundane-on-1'};spells?:ItemSpell[];use?:string;variants?:string[];attunementClasses?:string[];spellcasterAttunement?:boolean;requiresAttunement?:boolean}
export const itemCorrections=[
  {id:'potion-of-heroism',sourcePage:236,reason:'Structured upstream incorrectly repeats Gaseous Form. Official Heroism gives 10 Temporary HP and Bless for 1 hour without Concentration.'},
  {id:'vicious-weapon',sourcePage:250,reason:'2024 Vicious Weapon adds 2d6 on every hit, rather than the 2014 critical-only flat bonus.'},
  {id:'ring-of-warmth',sourcePage:239,reason:'2024 Ring of Warmth reduces each instance of Cold damage by 2d8; it does not grant Cold Resistance.'},
];
export const resistanceVariants:DamageType[]=['acid','cold','fire','force','lightning','necrotic','poison','psychic','radiant','thunder'];
export const giantStrength:Record<string,number>={hill:21,frost:23,stone:23,fire:25,cloud:27,storm:29};
export const itemAdapters:Record<string,ItemAdapter>={};
const add=(id:string,page:number,patch:Omit<Partial<ItemAdapter>,'id'|'sourcePage'>)=>itemAdapters[id]={id,sourcePage:page,automation:'automatic',capabilities:[],...patch};
for(const n of[1,2,3]){
  add(`weapon-${n}`,253,{kind:'weapon',weaponBonus:n,capabilities:['attack bonus','damage bonus','base weapon selection']});
  add(`armor-${n}`,210,{kind:'armor',passive:{ac:n},capabilities:['Armor Class bonus','base armor selection']});
  add(`shield-${n}`,243,{kind:'shield',baseContentId:'equipment:shield',passive:{ac:n},capabilities:['shield Armor Class bonus']});
  add(`wand-of-the-war-mage-${n}`,251,{passive:{spellAttack:n,ignoreHalfCover:true},spellcasterAttunement:true,capabilities:['spell attack bonus','ignore Half Cover on spell attacks']});
}
add('amulet-of-health',209,{passive:{minimum:{con:19}},capabilities:['effective Constitution minimum 19']});
add('gauntlets-of-ogre-power',223,{passive:{minimum:{str:19}},capabilities:['effective Strength minimum 19']});
add('headband-of-intellect',225,{passive:{minimum:{int:19}},capabilities:['effective Intelligence minimum 19']});
add('belt-of-giant-strength',213,{variants:Object.keys(giantStrength),capabilities:['effective Strength from fixed item variant']});
for(const[id,page]of[['cloak-of-protection',216],['ring-of-protection',238]]as const)add(id,page,{passive:{ac:1,save:1},capabilities:['Armor Class +1','saving throws +1']});
add('stone-of-good-luck-(luckstone)',248,{passive:{save:1,check:1},capabilities:['ability checks +1','saving throws +1']});
add('bracers-of-defense',214,{passive:{ac:2},capabilities:['Armor Class +2 without armor or shield']});
add('brooch-of-shielding',214,{passive:{resistance:['force'],spellImmunities:['magic-missile']},capabilities:['Force Resistance','Magic Missile immunity']});
add('boots-of-the-winterlands',214,{passive:{resistance:['cold']},capabilities:['Cold Resistance'],automation:'choice',reason:'Cold Resistance is automatic; snow/ice terrain and temperature survival require the scene environment.'});
add('goggles-of-night',224,{passive:{darkvision:60},capabilities:['Darkvision 60 feet or +60 feet']});
add('periapt-of-proof-against-poison',234,{passive:{immunity:['poison']},capabilities:['Poison damage immunity','Poisoned immunity']});
add('periapt-of-health',234,{capabilities:['disease prevention'],automation:'adjudication',reason:'Disease identity and exceptions are world facts resolved by the GM; no combat statistic is fabricated.'});
add('mantle-of-spell-resistance',229,{passive:{magicSaveAdvantage:true},capabilities:['advantage on saves against spells']});
add('spellguard-shield',244,{kind:'shield',baseContentId:'equipment:shield',passive:{magicSaveAdvantage:true},capabilities:['shield AC','spell save advantage'],automation:'choice',reason:'Spell save advantage is automatic; spell attack disadvantage also needs the incoming attack context.'});
add('robe-of-the-archmagi',240,{passive:{spellAttack:2,spellDC:2,magicSaveAdvantage:true},attunementClasses:['sorcerer','warlock','wizard'],capabilities:['unarmored AC 15 + Dexterity','spell attack and save DC +2','spell save advantage']});
add('adamantine-armor',209,{kind:'armor',passive:{criticalImmunity:true},capabilities:['convert incoming critical hits to normal hits','base medium/heavy armor selection']});
add('mithral-armor',230,{kind:'armor',capabilities:['base armor','ignore armor Strength minimum and Stealth disadvantage']});
add('dwarven-plate',219,{kind:'armor',baseContentId:'equipment:plate-armor',passive:{ac:2},capabilities:['Plate Armor +2'],automation:'choice',reason:'AC is automatic; reducing forced movement requires a recorded Reaction choice.'});
add('elven-chain',220,{kind:'armor',baseContentId:'equipment:chain-shirt',passive:{ac:1},capabilities:['Chain Shirt +1','armor training override']});
add('glamoured-studded-leather',223,{kind:'armor',baseContentId:'equipment:studded-leather-armor',passive:{ac:1},capabilities:['Studded Leather Armor +1'],automation:'adjudication',reason:'Armor Class is automatic; illusory appearance is chosen and described by the GM/player.'});
add('armor-of-resistance',210,{kind:'armor',variants:resistanceVariants,capabilities:['fixed damage Resistance','base armor selection']});
add('ring-of-resistance',238,{variants:resistanceVariants,capabilities:['fixed damage Resistance']});
add('armor-of-invulnerability',210,{kind:'armor',baseContentId:'equipment:plate-armor',passive:{resistance:['bludgeoning','piercing','slashing']},charges:{max:1,recharge:'dawn'},use:'invulnerability',capabilities:['physical Resistance','10-minute physical immunity once per dawn']});
add('ring-of-warmth',239,{passive:{coldReduction:'2d8'},capabilities:['reduce incoming Cold damage by 2d8'],automation:'choice',reason:'Cold damage reduction is automatic; environmental protection remains a scene fact.'});
add('ring-of-free-action',238,{passive:{freeAction:true},capabilities:['ignore Difficult Terrain','prevent magical speed reduction, Paralyzed and Restrained']});
add('cloak-of-the-manta-ray',216,{passive:{swimSpeed:60,waterBreathing:true},capabilities:['Swim Speed 60 feet','breathe underwater'],automation:'choice',reason:'Modes are derived; aquatic movement requires the scene to identify swimming.'});
add('ring-of-swimming',239,{passive:{swimSpeed:40},capabilities:['Swim Speed 40 feet'],automation:'choice',reason:'The Swim Speed is derived; aquatic movement requires a swimming scene mode.'});
add('slippers-of-spider-climbing',244,{passive:{climbSpeed:-1},capabilities:['Climb Speed equal to Speed','climb walls and ceilings'],automation:'choice',reason:'Climb Speed is derived; ceiling, slippery surface and three-dimensional placement require scene choices.'});
add('boots-of-striding-and-springing',214,{passive:{speedMinimum:30},capabilities:['Speed minimum 30 feet','jump distance ×3'],automation:'choice',reason:'Speed is automatic; vertical jump geometry and encumbrance need the scene/equipment context.'});
add('boots-of-speed',214,{charges:{max:100,recharge:'long'},use:'speed-boots',capabilities:['Bonus Action toggle','double Speed','10-minute shared use budget','opportunity attack disadvantage']});
add('weapon-of-warning',253,{kind:'weapon',passive:{weaponWarning:true},capabilities:['initiative advantage','warning aura'],automation:'choice',reason:'Initiative advantage is automatic; waking allies and surprise require scene participant awareness.'});
add('flame-tongue',223,{kind:'weapon',extraDamage:[{formula:'2d6',type:'fire'}],use:'flame-toggle',capabilities:['Bonus Action ignite/extinguish','2d6 Fire on every active hit']});
add('frost-brand',223,{kind:'weapon',extraDamage:[{formula:'1d6',type:'cold'}],passive:{resistance:['fire']},capabilities:['1d6 Cold on hit','Fire Resistance'],automation:'choice',reason:'Combat damage and Resistance are automatic; extinguishing nonmagical flames requires scene objects.'});
add('vicious-weapon',250,{kind:'weapon',extraDamage:[{formula:'2d6'}],capabilities:['2024 extra 2d6 on every hit']});
add('dragon-slayer',219,{kind:'weapon',weaponBonus:1,extraDamage:[{formula:'3d6',creatureTypes:['dragon']}],capabilities:['weapon +1','extra 3d6 against Dragons']});
add('giant-slayer',223,{kind:'weapon',weaponBonus:1,extraDamage:[{formula:'2d6',creatureTypes:['giant']}],capabilities:['weapon +1','extra 2d6 against Giants','Strength DC15 or Prone']});
add('sun-blade',248,{kind:'weapon',baseContentId:'equipment:longsword',weaponBonus:2,extraDamage:[{formula:'1d8',type:'radiant',creatureTypes:['undead']}],capabilities:['weapon +2','Radiant damage','extra 1d8 against Undead'],automation:'choice',reason:'Damage is automatic; sunlight radius and activation presentation require the light/scene model.'});
add('staff-of-striking',246,{kind:'weapon',baseContentId:'equipment:quarterstaff',weaponBonus:3,charges:{max:10,recharge:'dawn',formula:'1d6+4',last:'mundane-on-1'},use:'striking',capabilities:['Quarterstaff +3','spend 1–3 charges on hit for 1d6 Force per charge']});
const spell=(spellId:string,rank:number,cost:number,dc?:number):ItemSpell=>({spellId,rank,cost,dc});
for(const[id,page,spellId,rank]of[['wand-of-fireballs',250,'fireball',3],['wand-of-lightning-bolts',251,'lightning-bolt',3],['wand-of-magic-missiles',251,'magic-missile',1]]as const)add(id,page,{charges:{max:7,recharge:'dawn',formula:'1d6+1',last:'destroy-on-1'},spells:[{...spell(spellId,rank,1,id==='wand-of-magic-missiles'?undefined:15),maxRank:rank+2,chargePerRank:true}],use:'cast',spellcasterAttunement:id!=='wand-of-magic-missiles',capabilities:['1–3 charges cast/upcast','dawn recharge','last-charge destruction roll']});
add('wand-of-magic-detection',251,{charges:{max:3,recharge:'dawn',formula:'1d3'},spells:[spell('detect-magic',1,1)],use:'cast',capabilities:['Detect Magic from charges'],automation:'adjudication',reason:'Charge accounting is automatic; the GM identifies magical auras in the scene.'});
add('wand-of-binding',250,{charges:{max:7,recharge:'dawn',formula:'1d6+1',last:'destroy-on-1'},spells:[spell('hold-person',2,2,17),spell('hold-monster',5,5,17)],use:'cast',capabilities:['Hold Person/Monster DC17','charge accounting'],automation:'choice',reason:'Spell casts are automated; the wand also has a defensive Reaction property requiring its own choice adapter.'});
add('circlet-of-blasting',215,{charges:{max:1,recharge:'dawn'},spells:[{...spell('scorching-ray',2,1),attackBonus:5}],use:'cast',capabilities:['Scorching Ray with +5 spell attack once per dawn']});
add('pearl-of-power',234,{charges:{max:1,recharge:'dawn'},spellcasterAttunement:true,use:'pearl',capabilities:['restore one spent spell slot level 1–3 once per dawn']});
add('staff-of-fire',245,{passive:{resistance:['fire']},charges:{max:10,recharge:'dawn',formula:'1d6+4',last:'destroy-on-1'},spells:[spell('burning-hands',1,1),spell('fireball',3,3),spell('wall-of-fire',4,4)],attunementClasses:['druid','sorcerer','warlock','wizard'],use:'cast',capabilities:['Fire Resistance','charged spells'],automation:'choice',reason:'Each selected spell retains its own automation status; unsupported spell effects fail before charges are spent.'});
add('staff-of-frost',245,{passive:{resistance:['cold']},charges:{max:10,recharge:'dawn',formula:'1d6+4',last:'destroy-on-1'},spells:[spell('cone-of-cold',5,5),spell('fog-cloud',1,1),spell('ice-storm',4,4),spell('wall-of-ice',6,4)],attunementClasses:['druid','sorcerer','warlock','wizard'],use:'cast',capabilities:['Cold Resistance','charged spells'],automation:'choice',reason:'Each selected spell retains its own adapter coverage; unavailable effects spend no charges.'});
add('staff-of-healing',245,{charges:{max:10,recharge:'dawn',formula:'1d6+4',last:'destroy-on-1'},spells:[{...spell('cure-wounds',1,1),maxRank:4,chargePerRank:true},spell('lesser-restoration',2,2),spell('mass-cure-wounds',5,5)],attunementClasses:['bard','cleric','druid'],use:'cast',capabilities:['charged Cure Wounds 1–4','Lesser Restoration','Mass Cure Wounds']});
add('staff-of-power',245,{kind:'weapon',baseContentId:'equipment:quarterstaff',weaponBonus:2,passive:{ac:2,save:2,spellAttack:2},charges:{max:20,recharge:'dawn',formula:'2d8+4',last:'power'},spells:[spell('cone-of-cold',5,5),spell('fireball',5,5),spell('globe-of-invulnerability',6,6),spell('hold-monster',5,5),spell('levitate',2,2),spell('lightning-bolt',5,5),spell('magic-missile',1,1),spell('ray-of-enfeeblement',1,1),spell('wall-of-force',5,5)],attunementClasses:['sorcerer','warlock','wizard'],use:'cast',capabilities:['Quarterstaff +2','AC/saves/spell attacks +2','charged spell table'],automation:'choice',reason:'Individual spell adapters govern casts. Retributive Strike planar outcomes require explicit GM adjudication.'});
add('ring-of-spell-storing',239,{use:'spell-storage',capabilities:['store real level 1–5 casts up to five levels','spend stored spell exactly once','preserve original caster DC and attack']});
for(const[id,formula]of[['potion-of-healing','2d4+2'],['potion-of-greater-healing','4d4+4'],['potion-of-superior-healing','8d4+8'],['potion-of-supreme-healing','10d4+20']]as const)add(id,236,{use:`healing:${formula}`,capabilities:['2024 healing dice','Bonus Action to drink or administer','consume one vial']});
for(const[id,page,use,capabilities]of[
  ['potion-of-heroism',236,'heroism',['10 Temporary HP','Bless for 1 hour without Concentration']],
  ['potion-of-resistance',236,'resistance',['fixed Resistance for 1 hour']],
  ['potion-of-giant-strength',235,'giant-strength',['fixed Strength minimum for 1 hour']],
  ['potion-of-invisibility',236,'invisibility',['Invisible 1 hour, ending on attack/damage/cast']],
  ['potion-of-poison',236,'poison-potion',['4d6 Poison','DC13 Constitution or Poisoned 1 hour']],
  ['potion-of-water-breathing',236,'water-breathing',['breathe underwater 1 hour']],
  ['potion-of-climbing',235,'climbing',['Climb Speed equal to Speed for 1 hour','climbing check advantage']],
]as const)add(id,page,{use,capabilities:[...capabilities]});
itemAdapters['potion-of-resistance'].variants=resistanceVariants;itemAdapters['potion-of-giant-strength'].variants=Object.keys(giantStrength);
add('potion-of-growth',235,{capabilities:[],automation:'unsupported',reason:'Requires an audited Enlarge adapter for size, Strength checks/saves, weapon dice and occupied-space limits before the potion can be consumed.'});
add('potion-of-diminution',235,{capabilities:[],automation:'unsupported',reason:'Requires an audited Reduce adapter for size, Strength checks/saves, weapon-damage subtraction and squeezing before consumption.'});
add('poison-basic',99,{use:'coat-basic',capabilities:['Bonus Action weapon coating','1d4 Poison on the next Piercing/Slashing hit within 1 minute']});
add('potion-of-invulnerability',236,{use:'all-resistance',capabilities:['Resistance to all thirteen damage types for 1 minute']});
export const additionalItemEntries:ContentEntry[]=[
 ...(['greater','superior','supreme']as const).map(tier=>{const id=`potion-of-${tier}-healing`,a=itemAdapters[id];return{id:`magic-item:${id}`,name:`Potion of Healing (${tier})`,category:'magic-item',description:`Regains ${a.use!.slice(8)} Hit Points. Drinking or administering a potion is a Bonus Action (SRD p. 204).`,source:'SRD 5.2.1',sourcePage:236,automation:a.automation,data:{index:id,name:`Potion of Healing (${tier})`,attunement:false,desc:[`Regains ${a.use!.slice(8)} Hit Points.`]}};}),
 {id:'magic-item:potion-of-invulnerability',name:'Potion of Invulnerability',category:'magic-item',description:'For 1 minute after you drink this potion, you have Resistance to all damage.',source:'SRD 5.2.1',sourcePage:236,automation:'automatic',data:{index:'potion-of-invulnerability',name:'Potion of Invulnerability',attunement:false,desc:['For 1 minute after you drink this potion, you have Resistance to all damage.']}},
];
export const allItemDamageTypes=[...DAMAGE_TYPES];
for(const id of ['amulet-of-health','gauntlets-of-ogre-power','headband-of-intellect','belt-of-giant-strength','cloak-of-protection','ring-of-protection','stone-of-good-luck-(luckstone)','bracers-of-defense','brooch-of-shielding','boots-of-the-winterlands','periapt-of-proof-against-poison','mantle-of-spell-resistance','spellguard-shield','robe-of-the-archmagi','armor-of-resistance','ring-of-resistance','armor-of-invulnerability','ring-of-warmth','ring-of-free-action','slippers-of-spider-climbing','boots-of-striding-and-springing','boots-of-speed','weapon-of-warning','flame-tongue','frost-brand','sun-blade','staff-of-striking','wand-of-fireballs','wand-of-lightning-bolts','wand-of-binding','pearl-of-power','staff-of-fire','staff-of-frost','staff-of-healing','staff-of-power','ring-of-spell-storing','wand-of-the-war-mage-1','wand-of-the-war-mage-2','wand-of-the-war-mage-3'])itemAdapters[id].requiresAttunement=true;

export interface PoisonAdapter {id:string;sourcePage:number;dc:number;formula?:string;half?:boolean;duration?:number;conditions?:string[];repeat?:'start'|'end'|'day'|'midnight';successes?:number;followupFormula?:string;wake?:boolean;special?:string}
export const poisonAdapters:Record<string,PoisonAdapter>={
 'assassins-blood':{id:'assassins-blood',sourcePage:197,dc:10,formula:'1d12',half:true,duration:14400,conditions:['poisoned']},
 'burnt-othur-fumes':{id:'burnt-othur-fumes',sourcePage:197,dc:13,formula:'3d6',followupFormula:'1d6',repeat:'start',successes:3},
 'crawler-mucus':{id:'crawler-mucus',sourcePage:197,dc:13,duration:10,conditions:['poisoned','paralyzed'],repeat:'end',successes:1},
 'essence-of-ether':{id:'essence-of-ether',sourcePage:197,dc:15,duration:4800,conditions:['poisoned','unconscious'],wake:true},
 malice:{id:'malice',sourcePage:197,dc:15,duration:600,conditions:['poisoned','blinded']},
 'midnight-tears':{id:'midnight-tears',sourcePage:197,dc:17,formula:'9d6',half:true,repeat:'midnight'},
 'oil-of-taggit':{id:'oil-of-taggit',sourcePage:198,dc:13,duration:14400,conditions:['poisoned','unconscious'],wake:true},
 'pale-tincture':{id:'pale-tincture',sourcePage:198,dc:16,formula:'1d6',conditions:['poisoned'],repeat:'day',successes:7,special:'unhealable'},
 'purple-worm-poison':{id:'purple-worm-poison',sourcePage:198,dc:21,formula:'10d6',half:true},
 'serpent-venom':{id:'serpent-venom',sourcePage:198,dc:11,formula:'3d6',half:true},
 'spiders-sting':{id:'spiders-sting',sourcePage:198,dc:13,duration:600,conditions:['poisoned'],wake:true,special:'fail-by-five'},
 torpor:{id:'torpor',sourcePage:198,dc:15,conditions:['poisoned'],special:'4d6-hours-half-speed'},
 'truth-serum':{id:'truth-serum',sourcePage:198,dc:11,duration:600,conditions:['poisoned'],special:'truth'},
 'wyvern-poison':{id:'wyvern-poison',sourcePage:198,dc:14,formula:'7d6',half:true},
};
export function getItemAdapter(id:string){return itemAdapters[String(id).split(':').at(-1)!];}
export function itemCoverage(id:string):{automation:ContentEntry['automation'];reason?:string;sourcePage?:number;capabilities:string[]}{
 const simple=String(id).split(':').at(-1)!;const adapter=itemAdapters[simple];if(adapter)return adapter;
 const poison=poisonAdapters[simple];if(poison)return{automation:['midnight-tears','pale-tincture','truth-serum'].includes(simple)?'choice':'automatic',sourcePage:poison.sourcePage,capabilities:['save and damage','linked conditions','repeat saves when the campaign timing hook runs'],reason:['midnight-tears','pale-tincture'].includes(simple)?'Daily/midnight progression requires the GM to advance campaign time; exposure is a GM-confirmed world fact.':simple==='truth-serum'?'Poisoned is automatic; knowingly communicating a lie is narrative adjudication.':undefined};
 const row=(data['magic-items']as any[]).find(x=>x.index===simple);const description=(row?.desc||[]).join(' ');
 if(/roll.*table|random|d100/i.test(description))return{automation:'unsupported',capabilities:[],reason:'The published random table needs an audited outcome adapter, entity spawning and scene placement before this item can execute.'};
 if(/Wish|plane of existence|location.*GM|illusion|appearance|thoughts|charm|creature.*choice/i.test(description))return{automation:'adjudication',capabilities:[],reason:'The item requires a destination, perception, allegiance or narrative outcome chosen by the GM; its text is available without inventing deterministic success.'};
 if(/summon|transform|creature|stat block/i.test(description))return{automation:'unsupported',capabilities:[],reason:'This item needs a dedicated summoned-creature or transformation state adapter with control, duration and dismissal rules.'};
 return{automation:'unsupported',capabilities:[],reason:'This specific item still needs its own trigger, target and resource adapter. No generic bonus or spell effect is guessed from prose.'};
}
