import { ABILITIES, type Ability, type Actor } from './model.ts';

export interface FeatChoice { classId: string; level: number; featId: string; abilityBonuses?: Partial<Record<Ability, number>> }
export interface CharacterBuild {
  method: 'standard' | 'pointBuy'; baseAbilities: Record<Ability, number>;
  backgroundBonuses: Partial<Record<Ability, number>>; feats?: FeatChoice[];
  originFeat?: string; fightingStyles?: string[];
}
export type RulesData = Record<string, any[]>;
const id = (value: unknown) => String(value || '').split(':').at(-1)!;
const find = (raw: RulesData, category: string, value: unknown) => raw[category]?.find(entry => entry.index === id(value));
export const POINT_BUY_COST: Readonly<Record<number,number>> = {8:0,9:1,10:2,11:3,12:4,13:5,14:7,15:9};
const points = (record: Partial<Record<Ability,number>> = {}) => ABILITIES.map(key => Number(record[key] || 0));
const same = (values: number[], expected: number[]) => JSON.stringify([...values].sort((a,b)=>a-b)) === JSON.stringify([...expected].sort((a,b)=>a-b));
const unique = (values: string[]) => new Set(values).size === values.length;

/** Validate source choices, never a client assertion that its final numbers are legal. */
export function validateBuild(actor: Actor, raw: RulesData): string[] {
  if (actor.kind === 'monster') return [];
  const errors: string[] = [];
  const build = actor.choices?.characterBuild as CharacterBuild | undefined;
  if (!build || !['standard','pointBuy'].includes(build.method)) return ['请选择标准数组或27点购点，并记录基础属性与背景提升。'];
  const base = build.baseAbilities;
  if (!base || ABILITIES.some(key => !Number.isInteger(base[key]) || base[key] < 8 || base[key] > 15)) return ['基础属性必须为8至15的整数。'];
  if (build.method === 'standard' && !same(ABILITIES.map(key=>base[key]),[15,14,13,12,10,8])) errors.push('标准数组必须恰好分配15、14、13、12、10、8。');
  if (build.method === 'pointBuy' && ABILITIES.reduce((sum,key)=>sum+POINT_BUY_COST[base[key]],0) !== 27) errors.push('购点必须恰好使用27点，14需7点、15需9点。');
  const background = find(raw,'backgrounds',actor.backgroundId);
  if (!background) errors.push('请选择有效的2024背景。');
  const bonuses = build.backgroundBonuses || {};
  const bonusValues = points(bonuses).filter(Boolean);
  if (!same(bonusValues,[2,1]) && !same(bonusValues,[1,1,1])) errors.push('背景提升需为一项+2另一项+1，或三项各+1。');
  const backgroundAbilities = new Set((background?.ability_scores || []).map((entry:any)=>entry.index));
  for (const key of ABILITIES) if (bonuses[key] && !backgroundAbilities.has(key)) errors.push(`背景不允许提升${key.toUpperCase()}。`);
  if (Object.keys(bonuses).some(key=>!ABILITIES.includes(key as Ability))) errors.push('背景提升包含未知属性。');
  const totalLevel = actor.classes.reduce((sum,row)=>sum+row.level,0);
  const earned = new Set<string>();
  const featSlots: {classId:string;level:number;epic:boolean}[] = [];
  for (const cls of actor.classes) {
    const classId = id(cls.classId);
    for (let level=1; level<=Math.min(20,cls.level); level++) {
      const row = find(raw,'levels',`${classId}-${level}`);
      for (const feature of row?.features || []) {
        earned.add(id(feature.index));
        if (/ability-score-improvement|epic-boon$/.test(feature.index)) featSlots.push({classId,level,epic:/epic-boon$/.test(feature.index)});
      }
      if (cls.subclassId) for (const feature of find(raw,'levels',`${id(cls.subclassId)}-${level}`)?.features || []) earned.add(id(feature.index));
    }
  }
  const featChoices = build.feats || [];
  if (!Array.isArray(featChoices)) return [...errors,'专长选择格式无效。'];
  const usedSlots = new Set<string>(); const selectedFeats: string[] = [];
  const increases = Object.fromEntries(ABILITIES.map(key=>[key,0])) as Record<Ability,number>;
  const working = Object.fromEntries(ABILITIES.map(key=>[key,base[key]+Number(bonuses[key]||0)])) as Record<Ability,number>;
  const classOrder=(classId:string)=>actor.classes.findIndex(cls=>id(cls.classId)===id(classId));
  const orderedChoices=[...featChoices].sort((a,b)=>classOrder(a.classId)-classOrder(b.classId)||a.level-b.level);
  for (const selection of orderedChoices) {
    const slot = featSlots.find(value=>value.classId===id(selection.classId)&&value.level===selection.level);
    const key=`${id(selection.classId)}-${selection.level}`;
    if (!slot || usedSlots.has(key)) { errors.push(`没有可用的专长选择位置：${key}。`); continue; }
    usedSlots.add(key);
    const feat = find(raw,'feats',selection.featId);
    if (!feat) { errors.push(`未知专长：${selection.featId}。`); continue; }
    if (feat.type==='fighting-style' || feat.type==='epic-boon'&&!slot.epic || (feat.prerequisites?.minimum_level||0)>totalLevel) errors.push(`当前不能选择${feat.name}。`);
    if (feat.index==='grappler' && Math.max(working.str,working.dex)<13) errors.push('擒抱者需要先满足力量或敏捷13（官方SRD第87页）。');
    if (feat.prerequisites?.feature_named==='Spellcasting' && ![...earned].some(feature=>feature.endsWith('-spellcasting'))) errors.push(`${feat.name}需要施法职业特性。`);
    if (selectedFeats.includes(feat.index) && !feat.repeatable && feat.index!=='ability-score-improvement') errors.push(`专长不可重复：${feat.name}。`);
    selectedFeats.push(feat.index);
    const ability = selection.abilityBonuses || {};
    const vals = points(ability).filter(Boolean);
    if (feat.index==='ability-score-improvement') {
      if (!same(vals,[2]) && !same(vals,[1,1])) errors.push('属性值提升专长需要一项+2或两项各+1。');
    } else if (feat.index==='grappler') {
      if (!same(vals,[1]) || ABILITIES.some(k=>ability[k]&&!['str','dex'].includes(k))) errors.push('擒抱者提升力量或敏捷1点。');
    } else if (feat.type==='epic-boon') {
      if (!same(vals,[1])) errors.push('史诗恩惠需选择一项属性+1。');
      if (feat.index==='boon-of-irresistible-offense' && ABILITIES.some(k=>ability[k]&&!['str','dex'].includes(k))) errors.push('不可阻挡之攻恩惠提升力量或敏捷。');
      if (feat.index==='boon-of-spell-recall' && ABILITIES.some(k=>ability[k]&&!['int','wis','cha'].includes(k))) errors.push('法术回忆恩惠提升智力、感知或魅力。');
    } else if (vals.length) errors.push(`${feat.name}不提供属性提升。`);
    for (const abilityKey of ABILITIES) {
      const amount = Number(ability[abilityKey]||0);
      if (!Number.isInteger(amount) || amount<0 || amount>2) errors.push('专长属性提升数值无效。');
      working[abilityKey] += amount; increases[abilityKey] += amount;
      if (working[abilityKey]>(feat.type==='epic-boon'?30:20)) errors.push(`${abilityKey.toUpperCase()}超过该专长允许的上限。`);
    }
  }
  if (usedSlots.size!==featSlots.length) errors.push(`请完成全部${featSlots.length}项升级专长选择。`);
  const originFeats = new Set<string>();
  if (background?.feat) originFeats.add(background.feat.index);
  if (id(actor.speciesId)==='human') {
    const feat=find(raw,'feats',build.originFeat);
    if (!feat || feat.type!=='origin') errors.push('人类的多才多艺需选择一项起源专长。');
    else originFeats.add(feat.index);
  } else if (build.originFeat) errors.push('只有人类可通过多才多艺额外选择起源专长。');
  for (const key of ABILITIES) if (actor.abilities[key]!==base[key]+Number(bonuses[key]||0)+increases[key]) errors.push(`${key.toUpperCase()}合计与基础、背景、专长来源不符。`);
  const styles=build.fightingStyles||[];
  const styleSlots=actor.classes.filter(cls=>id(cls.classId)==='fighter'||['paladin','ranger'].includes(id(cls.classId))&&cls.level>=2).length+(earned.has('champion-additional-fighting-style')?1:0);
  if (styles.length>styleSlots || !unique(styles)) errors.push('战斗风格选择数量超出职业提供的次数。');
  for(const style of styles){const feat=find(raw,'feats',style);if(feat?.type!=='fighting-style')errors.push('战斗风格不是有效的风格专长。');else selectedFeats.push(feat.index);}
  const allowedFeatures=new Set([...earned,...selectedFeats,...originFeats]);
  for(const feature of actor.features) if(!allowedFeatures.has(id(feature))) errors.push(`能力没有合法来源：${feature}。`);
  const masteries=actor.choices?.weaponMasteries as unknown;
  if(masteries!==undefined){
    if(!Array.isArray(masteries)||!masteries.every(value=>typeof value==='string')||!unique(masteries.map(id)))errors.push('武器精通选择必须是无重复的武器列表。');
    else {
      const count=actor.classes.reduce((sum,cls)=>{
        const classId=id(cls.classId);if(!earned.has(`${classId}-weapon-mastery`))return sum;
        return sum+Number(find(raw,'levels',`${classId}-${cls.level}`)?.class_specific?.weapon_mastery??({fighter:3,barbarian:2,paladin:2,ranger:2,rogue:2} as Record<string,number>)[classId]??0);
      },0);
      if(masteries.length>count)errors.push(`武器精通超过职业提供的${count}种武器。`);
      for(const weapon of masteries)if(!find(raw,'equipment',weapon)?.damage)errors.push(`精通必须选择有效武器：${weapon}。`);
    }
  }
  if(!unique(actor.skills)||!unique(actor.expertise))errors.push('技能或专精不可重复。');
  const skillIds=new Set((raw.skills||[]).map(entry=>entry.index));
  for(const skill of actor.skills)if(!skillIds.has(id(skill)))errors.push(`未知技能：${skill}。`);
  for(const skill of actor.expertise)if(!actor.skills.some(s=>id(s)===id(skill)))errors.push('专精必须选择已经熟练的技能。');
  const backgroundSkills=(background?.proficiencies||[]).filter((p:any)=>p.index.startsWith('skill-')).map((p:any)=>p.index.slice(6));
  const firstClass=find(raw,'classes',actor.classes[0]?.classId);
  const skillChoice=firstClass?.proficiency_choices?.find((choice:any)=>choice.type==='proficiencies');
  let extraSkills=0;
  if(id(actor.speciesId)==='human'||id(actor.speciesId)==='elf')extraSkills++;
  if(originFeats.has('skilled')||selectedFeats.includes('skilled'))extraSkills+=3;
  for(const cls of actor.classes.slice(1))if(['bard','ranger','rogue'].includes(id(cls.classId)))extraSkills++;
  if(actor.classes.some(c=>id(c.subclassId)==='lore'&&c.level>=3))extraSkills+=3;
  const maxSkills=new Set(backgroundSkills).size+(skillChoice?.choose||0)+extraSkills;
  if(actor.skills.length>maxSkills)errors.push(`技能熟练超过来源允许的${maxSkills}项。`);
  if(actor.skills.length<new Set(backgroundSkills).size+(skillChoice?.choose||0))errors.push('请完成背景与初始职业的技能熟练选择。');
  const options = (choice:any):Set<string> => new Set((choice?.from?.options||[]).map((entry:any)=>id(entry.item?.index||entry.of?.index||'').replace(/^skill-/,'')));
  const initialOptions=options(skillChoice);
  const unassigned=actor.skills.map(id).filter(skill=>!backgroundSkills.includes(skill));
  const outsideClass=unassigned.filter(skill=>!initialOptions.has(skill));
  if(initialOptions.size&&outsideClass.length>extraSkills)errors.push('部分技能不在职业可选列表内，也没有物种、专长或多职业来源。');
  let expertise=0;
  let scholar=0;
  for(const cls of actor.classes){const name=id(cls.classId);if(name==='rogue')expertise+=2+(cls.level>=6?2:0);if(name==='bard')expertise+=(cls.level>=2?2:0)+(cls.level>=9?2:0);if(name==='ranger')expertise+=(cls.level>=2?1:0)+(cls.level>=9?2:0);if(name==='wizard'&&cls.level>=2){expertise++;scholar++;}}
  if(actor.expertise.length>expertise)errors.push('专精数量超过职业来源允许的数量。');
  if(scholar&&actor.expertise.filter(skill=>!['arcana','history','investigation','medicine','nature','religion'].includes(id(skill))).length>expertise-scholar)errors.push('法师学者的专精必须来自奥秘、历史、调查、医药、自然或宗教。');
  const spellSources=actor.classes.map(cls=>{const data=find(raw,'classes',cls.classId),level=find(raw,'levels',`${id(cls.classId)}-${cls.level}`);const table=level?.spellcasting;return{classId:id(cls.classId),maxLevel:Math.max(0,...Array.from({length:9},(_,i)=>(table?.[`spell_slots_level_${i+1}`]||0)>0?i+1:0)),cantrips:table?.cantrips_known||0,prepared:table?.prepared_spells||0,casting:!!data?.spellcasting};});
  const initiate=actor.choices?.magicInitiate as {classId?:string;spells?:string[];ability?:string}|undefined;
  const initiateSpells=new Set((initiate?.spells||[]).map(id));
  if(originFeats.has('magic-initiate')){
    const forced=String(background?.feat?.note||'').toLowerCase();
    if(!initiate||!['cleric','druid','wizard'].includes(id(initiate.classId))||forced&&id(initiate.classId)!==forced)errors.push('请选择魔法学徒的合法职业法术列表。');
    if(initiate?.ability&&!['int','wis','cha'].includes(initiate.ability))errors.push('魔法学徒的施法属性必须为智力、感知或魅力。');
    const selected=[...initiateSpells].map(spell=>find(raw,'spells',spell));
    if(selected.filter(s=>s?.level===0).length!==2||selected.filter(s=>s?.level===1).length!==1||selected.some(s=>!s||!s.classes?.some((c:any)=>c.index===id(initiate?.classId))))errors.push('魔法学徒需从同一列表选择两个戏法和一个1环法术。');
  }
  let selectedCantrips=0,selectedPrepared=0;
  for(const spellId of actor.spells){
    const spell=find(raw,'spells',spellId);if(!spell){errors.push(`未知法术：${spellId}。`);continue;}
    if(initiateSpells.has(spell.index)&&originFeats.has('magic-initiate'))continue;
    if(!spellSources.some(src=>src.casting&&spell.classes?.some((cls:any)=>cls.index===src.classId)&&(spell.level===0?src.cantrips>0:spell.level<=src.maxLevel)))errors.push(`当前职业等级不能准备${spell.name}。`);
    if(spell.level===0)selectedCantrips++;else selectedPrepared++;
  }
  if(selectedCantrips>spellSources.reduce((sum,s)=>sum+s.cantrips,0))errors.push('选择的戏法超过职业允许数量。');
  if(selectedPrepared>spellSources.reduce((sum,s)=>sum+s.prepared,0))errors.push('准备法术超过职业允许数量。');
  if(!unique(actor.spells.map(id)))errors.push('法术选择不可重复。');
  return [...new Set(errors)];
}
