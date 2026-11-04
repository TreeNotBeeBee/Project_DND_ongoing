import test from 'node:test';import assert from 'node:assert/strict';
import {createActor} from '../src/engine/actors.ts';import {createGameState} from '../src/engine/combat.ts';
import {rollExpression,modifier} from '../src/engine/dice.ts';
import {itemAdapters,itemCorrections,poisonAdapters,itemCoverage,additionalItemEntries} from '../src/content/item-adapters.ts';
import {initializeItem,itemBonuses,weaponBonus,useItem,applyItemHit,exposePoison,tickItemEffects,maxItemHealableHp,onItemDamage,onItemHeal,neutralizeItemPoison,applyItemColdReduction,rechargeItems,grantItemTemporaryHp,expireItemEffect,handleItemCommand,type ItemContext} from '../src/engine/item-effects.ts';
import {confidentialProjection} from '../src/server/security.ts';
import type {Actor,ItemInstance,Dice,ActionDefinition} from '../src/shared/model.ts';
import {grantSpellMaterials,paySpellMaterials} from '../src/engine/spell-materials.ts';

function fixture(classId='cleric'){
 const source=createActor({name:'Source',ownerId:'source-owner',kind:'hero',draft:false,speciesId:'dwarf',backgroundId:'soldier',classes:[{classId,level:3}],abilities:{str:16,dex:14,con:14,int:18,wis:18,cha:14},spells:['spell:cure-wounds','spell:magic-missile']});
 const target=createActor({name:'Target',ownerId:'target-owner',kind:'monster',draft:false,abilities:{str:10,dex:10,con:10,int:10,wis:10,cha:10},hp:{current:200,max:200,temp:0},position:{x:1,y:0}});const state=createGameState('Items');state.actors=[source,target];let d20=1;const dice:Dice=s=>s===20?d20:1;const economies:ActionDefinition['economy'][]=[];const casts:any[]=[];
 const ctx:ItemContext={state,source,targets:[target],options:{},dice,log:[],
  addEffect(_s,t,e){if(e.condition==='poisoned'&&(t.choices?.conditionImmunities as string[]||[]).includes('poisoned'))return;t.effects.push(e);},
  clearCondition(a,c){a.effects=a.effects.filter(e=>e.condition!==c);},
  heal(t,n){t.hp.current=Math.min(maxItemHealableHp(t),t.hp.current+n);},
  damage(_s,_a,t,parts){let n=parts.reduce((sum,p)=>sum+(t.immunities?.includes(p.type)?0:t.resistances?.includes(p.type)?Math.floor(p.amount/2):p.amount),0);const temp=Math.min(n,t.hp.temp);t.hp.temp-=temp;n-=temp;t.hp.current=Math.max(0,t.hp.current-n);},
  save(a,ability,dc,d,log,label){const roll=d(20),total=roll+modifier(a.abilities[ability]);log.push({type:'save',actorId:a.id,message:label||'save',rolls:[{expression:'1d20',rolls:[roll],total}]});return total>=dc;},
  spend(a,id,n){const r=a.resources.find(r=>r.id===id);assert.ok(r&&r.current>=n);r.current-=n;},
  economy(_s,_a,a){economies.push(a.economy);},castSpell(cast){casts.push(structuredClone(cast));}
 };
 function item(id:string,options:Partial<ItemInstance>={},config:any={}){const i:ItemInstance={id:'instance-'+source.inventory.length,contentId:`magic-item:${id}`,name:id,quantity:1,equipped:true,attuned:true,...options};source.inventory.push(i);initializeItem(source,i,dice,config);return i;}
 return{source,target,state,ctx,item,economies,casts,setSave(n:number){d20=n;}};
}

test('item adapters retain official pages and explicit coverage, including corrected 2024 rows',()=>{
 assert.ok(Object.keys(itemAdapters).length>=60);assert.equal(Object.keys(poisonAdapters).length,14);for(const a of Object.values(itemAdapters))assert.ok(a.sourcePage>=99&&a.sourcePage<=253,a.id);assert.equal(itemCorrections.find(i=>i.id==='potion-of-heroism')?.sourcePage,236);assert.equal(itemCoverage('vicious-weapon').automation,'automatic');assert.equal(itemCoverage('wand-of-wonder').automation,'unsupported');assert.equal(itemCoverage('ring-of-three-wishes').automation,'adjudication');assert.ok(additionalItemEntries.some(e=>e.id==='magic-item:potion-of-supreme-healing'));
});
test('passive attunement bonuses do not stack duplicate copies or replace a better ability score',()=>{
 const f=fixture();f.item('amulet-of-health');assert.equal(itemBonuses(f.source).abilityMinimums.con,19);f.item('ring-of-protection');f.item('ring-of-protection');assert.equal(itemBonuses(f.source).ac,1);assert.equal(itemBonuses(f.source).saveBonus,1);f.source.inventory[1].attuned=false;assert.equal(itemBonuses(f.source).ac,1);f.source.inventory[2].attuned=false;assert.equal(itemBonuses(f.source).ac,0);
 const g=fixture();const belt=g.item('belt-of-giant-strength',{}, {variant:'storm'});assert.equal((g.source.choices?.itemVariants as any)[belt.id],'storm');assert.equal(itemBonuses(g.source).abilityMinimums.str,29);
});
test('base-item configuration and class attunement cannot fabricate generic armor or weapon bonuses',()=>{
 const f=fixture('fighter');assert.throws(()=>f.item('weapon-3'),/base weapon/);const g=fixture('fighter');const sword=g.item('weapon-3',{}, {baseContentId:'equipment:longsword'});const dagger=g.item('weapon-1',{}, {baseContentId:'equipment:dagger'});assert.equal(weaponBonus(g.source,sword.id).attackBonus,3);assert.equal(weaponBonus(g.source,dagger.id).attackBonus,1);assert.equal(weaponBonus(g.source,sword.id).damageBonus,3);
 assert.throws(()=>fixture('fighter').item('staff-of-healing'),/eligible class/);assert.throws(()=>fixture().item('armor-1',{}, {baseContentId:'equipment:longsword'}),/armor/);
});
test('bracers require no armor/shield; magic resistance and missile-specific immunity remain distinct',()=>{
 const f=fixture();f.item('bracers-of-defense');assert.equal(itemBonuses(f.source).ac,2);f.source.inventory.push({id:'armor',contentId:'equipment:chain-mail',name:'armor',quantity:1,equipped:true});assert.equal(itemBonuses(f.source).ac,0);const g=fixture();g.item('brooch-of-shielding');assert.deepEqual(itemBonuses(g.source).resistance,['force']);assert.deepEqual(itemBonuses(g.source).spellImmunities,['magic-missile']);
});
test('2024 Ring of Warmth rolls 2d8 Cold damage reduction instead of granting Cold Resistance',()=>{
 const f=fixture();f.item('ring-of-warmth');assert.equal(itemBonuses(f.source).resistance.includes('cold'),false);assert.equal(applyItemColdReduction(f.source,20,()=>1),18);assert.equal(applyItemColdReduction(f.source,3,s=>s),0);
});
test('2024 Heroism is 10 non-stacking Temporary HP plus Bless, never Gaseous Form',()=>{
 const f=fixture();const potion=f.item('potion-of-heroism');assert.equal(useItem(f.ctx,potion).consumed,true);assert.equal(potion.quantity,0);assert.equal(f.target.hp.temp,10);const bless=f.target.effects.find(e=>e.sourceId==='bless')!;assert.equal(bless.duration,600);assert.equal(bless.concentration,false);assert.equal(f.target.effects.some(e=>e.sourceId==='gaseous-form'),false);assert.equal(f.economies.at(-1),'bonus');expireItemEffect(f.target,bless);assert.equal(f.target.hp.temp,0);
 const g=fixture();const second=g.item('potion-of-heroism');useItem(g.ctx,second);const effect=g.target.effects[0];grantItemTemporaryHp(g.target,20,'false-life');expireItemEffect(g.target,effect);assert.equal(g.target.hp.temp,20);
});
test('2024 drinking and administering any potion both use a Bonus Action and consume exactly one vial',()=>{
 const f=fixture();f.target.hp.current=100;const potion=f.item('potion-of-greater-healing',{quantity:2});useItem(f.ctx,potion);assert.equal(f.target.hp.current,108);assert.equal(potion.quantity,1);assert.equal(f.economies.at(-1),'bonus');f.ctx.targets=[f.source];f.source.hp.current=1;useItem(f.ctx,potion);assert.equal(f.economies.at(-1),'bonus');assert.equal(potion.quantity,0);assert.throws(()=>useItem(f.ctx,potion),/consumed/);
});
test('potion fixed variants are rolled/selected at grant and cannot be changed by a use request',()=>{
 const f=fixture();const potion=f.item('potion-of-resistance',{}, {variant:'fire'});f.ctx.options={damageType:'cold'};useItem(f.ctx,potion);assert.deepEqual(f.target.effects[0].resistance,['fire']);assert.throws(()=>fixture().item('potion-of-resistance',{}, {variant:'all'}),/fixed/);
});
test('wands limit charges/upcast, do not spend character slots, and preserve charges on rejected spell callbacks',()=>{
 const f=fixture('wizard');const wand=f.item('wand-of-magic-missiles');const slots=f.source.resources.find(r=>r.id==='slot-1')!.current;f.ctx.options={rank:3};useItem(f.ctx,wand);assert.equal(wand.charges?.current,4);assert.equal(f.casts[0].rank,3);assert.equal(f.source.resources.find(r=>r.id==='slot-1')!.current,slots);assert.equal(f.casts[0].casterModifier,4);
 f.ctx.options={rank:4};assert.throws(()=>useItem(f.ctx,wand),/cannot cast/);assert.equal(wand.charges?.current,4);f.ctx.options={rank:1};f.ctx.castSpell=()=>{throw new Error('no line of sight');};assert.throws(()=>useItem(f.ctx,wand),/line of sight/);assert.equal(wand.charges?.current,4);
});
test('dawn charge recharge differs from Long Rest; depletion rolls destroy only on published outcomes',()=>{
 const f=fixture('wizard');const wand=f.item('wand-of-magic-missiles');wand.charges!.current=1;rechargeItems(f.source,()=>1,'long');assert.equal(wand.charges!.current,1);rechargeItems(f.source,()=>1,'dawn');assert.equal(wand.charges!.current,3);wand.charges!.current=1;useItem(f.ctx,wand);assert.equal(wand.quantity,0);assert.equal(wand.equipped,false);
 const g=fixture('wizard');const staff=g.item('staff-of-power');staff.charges!.current=1;g.setSave(20);g.ctx.options={spellId:'magic-missile'};useItem(g.ctx,staff);assert.equal(staff.quantity,1);assert.equal(staff.charges!.current,3);
});
test('ring stores original caster modifier/DC/attack and releases only after successful item casting',()=>{
 const f=fixture('cleric');const ring=f.item('ring-of-spell-storing');const before=f.source.resources.find(r=>r.id==='slot-1')!.current;f.ctx.options={mode:'store',spellId:'cure-wounds',rank:1};useItem(f.ctx,ring);assert.equal(f.source.resources.find(r=>r.id==='slot-1')!.current,before-1);assert.equal(ring.storedSpells?.[0].casterModifier,4);assert.equal(ring.storedSpells?.[0].saveDC,14);assert.equal(ring.storedSpells?.[0].attackBonus,6);
 f.source.abilities.wis=8;f.ctx.options={storedIndex:0};f.ctx.castSpell=()=>{throw new Error('invalid target');};assert.throws(()=>useItem(f.ctx,ring),/invalid target/);assert.equal(ring.storedSpells!.length,1);f.ctx.castSpell=cast=>f.casts.push(cast);useItem(f.ctx,ring);assert.equal(f.casts[0].casterModifier,4);assert.equal(f.casts[0].saveDC,14);assert.equal(f.casts[0].attackBonus,6);assert.equal(ring.storedSpells!.length,0);
});
test('storing a normal spell in a Ring still requires real priced materials and casting permissions',()=>{
 const f=fixture('wizard'),ring=f.item('ring-of-spell-storing');f.source.spells.push('spell:stoneskin','spell:shield');f.source.resources.push({id:'slot-4',name:'Fourth level',current:1,max:1,recovery:'long'});f.ctx.options={mode:'store',spellId:'stoneskin',rank:4};assert.throws(()=>useItem(f.ctx,ring),/material-payment adapter/);f.ctx.paySpellMaterials=paySpellMaterials;const before=structuredClone(f.source);assert.throws(()=>useItem(f.ctx,ring),/Required material/);assert.deepEqual(f.source,before);grantSpellMaterials(f.source,'stoneskin',1,f.ctx.log);useItem(f.ctx,ring);assert.equal(f.source.inventory.find(i=>i.componentFor==='spell:stoneskin')!.quantity,0);assert.equal(ring.storedSpells![0].rank,4);assert.equal(f.source.resources.find(r=>r.id==='slot-4')!.current,0);
 f.ctx.options={mode:'store',spellId:'shield',rank:1};assert.throws(()=>useItem(f.ctx,ring),/live legal trigger/);f.ctx.options={mode:'store',spellId:'cure-wounds',rank:1};f.source.effects.push({id:'rage',name:'Rage',sourceId:'rage'});assert.throws(()=>useItem(f.ctx,ring),/raging/);f.source.effects=[];f.source.effects.push({id:'silenced',name:'Silenced',sourceId:'silenced'});assert.throws(()=>useItem(f.ctx,ring),/Verbal/);
});
test('overfilling Ring of Spell Storing spends the cast slot without silently storing a sixth level',()=>{
 const f=fixture();const ring=f.item('ring-of-spell-storing');ring.storedSpells=[{spellId:'spell:cure-wounds',rank:3,saveDC:14,attackBonus:6,casterAbility:'wis',casterModifier:4},{spellId:'spell:cure-wounds',rank:2,saveDC:14,attackBonus:6,casterAbility:'wis',casterModifier:4}];const before=f.source.resources.find(r=>r.id==='slot-1')!.current;f.ctx.options={mode:'store',spellId:'cure-wounds',rank:1};useItem(f.ctx,ring);assert.equal(ring.storedSpells.reduce((n,s)=>n+s.rank,0),5);assert.equal(f.source.resources.find(r=>r.id==='slot-1')!.current,before-1);
});
test('2024 Vicious Weapon adds 2d6 on every hit and doubles those dice on a critical',()=>{
 const f=fixture('fighter');const sword=f.item('vicious-weapon',{}, {baseContentId:'equipment:longsword'});applyItemHit(f.ctx,sword,false);assert.equal(f.target.hp.current,198);applyItemHit(f.ctx,sword,true);assert.equal(f.target.hp.current,194);
});
test('Flame Tongue toggles with Bonus Action and does not add fire damage while extinguished',()=>{
 const f=fixture('fighter');const sword=f.item('flame-tongue',{}, {baseContentId:'equipment:longsword'});applyItemHit(f.ctx,sword);assert.equal(f.target.hp.current,200);useItem(f.ctx,sword);assert.equal(f.economies.at(-1),'bonus');applyItemHit(f.ctx,sword);assert.equal(f.target.hp.current,198);useItem(f.ctx,sword);applyItemHit(f.ctx,sword);assert.equal(f.target.hp.current,198);
});
test('injury poison is a weapon coating and only exposes the next creature after actual physical damage',()=>{
 const f=fixture('fighter');const dagger:ItemInstance={id:'dagger',contentId:'equipment:dagger',name:'Dagger',quantity:1,equipped:true};f.source.inventory.push(dagger);const poison=f.item('purple-worm-poison',{contentId:'poison:purple-worm-poison'});f.ctx.options={weaponItemId:dagger.id};useItem(f.ctx,poison);assert.equal(poison.quantity,0);assert.equal(f.target.hp.current,200);f.ctx.options={weaponDamageDealt:0};applyItemHit(f.ctx,dagger);assert.equal(f.target.hp.current,200);f.ctx.options={weaponDamageDealt:1};applyItemHit(f.ctx,dagger);assert.equal(f.target.hp.current,190);applyItemHit(f.ctx,dagger);assert.equal(f.target.hp.current,190);
});
test('all fourteen poisons have executable initial save/effect adapters and linked incapacitation ends together',()=>{
 for(const id of Object.keys(poisonAdapters)){const f=fixture();exposePoison(f.ctx,id,f.target);assert.ok(f.ctx.log.length>0,id);}
 const f=fixture();exposePoison(f.ctx,'crawler-mucus',f.target);assert.ok(f.target.effects.some(e=>e.condition==='poisoned'));assert.ok(f.target.effects.some(e=>e.condition==='paralyzed'));f.setSave(20);tickItemEffects(f.ctx,f.target,'end');assert.equal(f.target.effects.length,0);
});
test('Poisoned immunity does not incorrectly prevent independent Poison damage',()=>{const f=fixture();f.target.choices={conditionImmunities:['poisoned']};exposePoison(f.ctx,'assassins-blood',f.target);assert.equal(f.target.hp.current,199);assert.equal(f.target.effects.length,0);});
test('Burnt Othur Fumes repeats 1d6 on failed starts and ends after three accumulated successful saves',()=>{
 const f=fixture();exposePoison(f.ctx,'burnt-othur-fumes',f.target);assert.equal(f.target.hp.current,197);f.setSave(20);tickItemEffects(f.ctx,f.target,'start');f.setSave(1);tickItemEffects(f.ctx,f.target,'start');assert.equal(f.target.hp.current,196);f.setSave(20);tickItemEffects(f.ctx,f.target,'start');tickItemEffects(f.ctx,f.target,'start');assert.equal(f.target.effects.length,0);
});
test('Pale Tincture blocks exactly the HP it dealt until seven daily saves end the poison',()=>{
 const f=fixture();exposePoison(f.ctx,'pale-tincture',f.target);assert.equal(f.target.hp.current,199);assert.equal(maxItemHealableHp(f.target),199);f.ctx.heal(f.target,100,f.ctx.log,f.source);assert.equal(f.target.hp.current,199);f.setSave(20);for(let day=0;day<7;day++)tickItemEffects(f.ctx,f.target,'day');assert.equal(maxItemHealableHp(f.target),200);assert.equal(f.target.effects.length,0);
});
test('Spider Sting uses failure margin; damage wakes Ether/Taggit sleepers without falsely removing Poisoned',()=>{
 const f=fixture();f.setSave(10);exposePoison(f.ctx,'spiders-sting',f.target);assert.equal(f.target.effects.some(e=>e.condition==='unconscious'),false);const g=fixture();exposePoison(g.ctx,'spiders-sting',g.target);assert.equal(g.target.effects.some(e=>e.condition==='unconscious'),true);onItemDamage(g.target);assert.equal(g.target.effects.some(e=>e.condition==='unconscious'),false);assert.equal(g.target.effects.some(e=>e.condition==='poisoned'),true);
});
test('Midnight Tears is secret and dormant until explicit campaign midnight; neutralization removes it',()=>{
 const f=fixture();exposePoison(f.ctx,'midnight-tears',f.target);assert.equal(f.target.hp.current,200);assert.equal(f.target.effects[0].gmOnly,true);const projected=confidentialProjection(f.state,{id:f.target.ownerId,name:'Player',role:'player'});assert.equal(projected.actors.find(a=>a.id===f.target.id)!.effects.length,0);tickItemEffects(f.ctx,f.target,'start');assert.equal(f.target.hp.current,200);tickItemEffects(f.ctx,f.target,'midnight');assert.equal(f.target.hp.current,191);assert.equal(f.target.effects.length,0);
 const g=fixture();exposePoison(g.ctx,'midnight-tears',g.target);neutralizeItemPoison(g.target);tickItemEffects(g.ctx,g.target,'midnight');assert.equal(g.target.hp.current,200);
});
test('GM-confirmed poison exposure consumes one real dose and ordinary ingestion claims are rejected',()=>{
 const f=fixture();const poison=f.item('malice',{contentId:'poison:malice'});f.ctx.options={};assert.throws(()=>useItem(f.ctx,poison),/confirmed by the GM/);assert.equal(poison.quantity,1);f.ctx.options={itemId:poison.id};assert.equal(handleItemCommand(f.ctx,'gm.poisonExposure'),true);assert.equal(poison.quantity,0);assert.ok(f.target.effects.some(e=>e.condition==='blinded'));assert.throws(()=>handleItemCommand(f.ctx,'gm.poisonExposure'),/dose/);
});
test('Robe Armor Class is a competing base formula and Spellcaster attunement includes Magic Initiate',()=>{
 const f=fixture('wizard');f.item('robe-of-the-archmagi');assert.equal(itemBonuses(f.source).ac,0);assert.equal(itemBonuses(f.source).unarmoredAcBase,15);
 const g=fixture('fighter');g.source.features.push('feat:magic-initiate');g.source.choices={magicInitiate:{ability:'wis',classId:'cleric',spells:['spell:cure-wounds']}};g.item('wand-of-the-war-mage-1');assert.equal(itemBonuses(g.source).spellAttackBonus,1);
});
test('multiclass item casts select an eligible real ability and reject a fabricated caster statistic',()=>{
 const f=fixture('wizard');f.source.classes.push({classId:'cleric',level:1});f.source.abilities.int=10;f.source.abilities.wis=18;const wand=f.item('wand-of-magic-missiles');f.ctx.options={classId:'cleric',casterAbility:'wis'};useItem(f.ctx,wand);assert.equal(f.casts[0].casterAbility,'wis');assert.equal(f.casts[0].casterModifier,4);f.ctx.options={casterAbility:'str'};assert.throws(()=>useItem(f.ctx,wand),/actual spellcasting/);
});
test('GM timing is explicit: Long Rest does not mean dawn, day advances poison and midnight resolves latent damage',()=>{
 const f=fixture('wizard');const wand=f.item('wand-of-magic-missiles');wand.charges!.current=0;f.ctx.options={occasion:'dawn'};handleItemCommand(f.ctx,'gm.itemTiming');assert.equal(wand.charges!.current,2);
 exposePoison(f.ctx,'assassins-blood',f.target);assert.ok(f.target.effects.some(e=>e.condition==='poisoned'));f.ctx.options={occasion:'day'};handleItemCommand(f.ctx,'gm.itemTiming');assert.equal(f.target.effects.length,0);
 exposePoison(f.ctx,'midnight-tears',f.target);const before=f.target.hp.current;f.ctx.options={occasion:'midnight'};handleItemCommand(f.ctx,'gm.itemTiming');assert.equal(f.target.hp.current,before-9);assert.ok(f.ctx.log.some(e=>e.type==='item-timing'));
});
test('attack damage dice hooks never alter poison saving throws or item last-charge d20 rolls',()=>{
 const f=fixture('fighter');const staff=f.item('staff-of-striking');staff.charges!.current=1;f.ctx.attackDamageDice=()=>3;f.ctx.options={charges:1};applyItemHit(f.ctx,staff);assert.equal(f.target.hp.current,197);assert.equal(staff.charges!.max,0);assert.equal(weaponBonus(f.source,staff.id).attackBonus,0);
});
test('Heroism owns its new Temporary HP controller even if an older Bless is already present',()=>{
 const f=fixture();const prior={id:'old-bless',name:'Bless',sourceId:'bless',sourceActorId:f.source.id,duration:1,concentration:true};f.target.effects.push(prior);const potion=f.item('potion-of-heroism');useItem(f.ctx,potion);assert.equal(f.target.hp.temp,10);assert.notEqual(f.target.choices?._temporaryHpSource,prior.id);expireItemEffect(f.target,prior);assert.equal(f.target.hp.temp,10);const owner=f.target.effects.find(e=>e.modifiers?.temporaryHpExpires)!;expireItemEffect(f.target,owner);assert.equal(f.target.hp.temp,0);
});
test('Pale Tincture healing restriction is suppressed by Poisoned immunity and records healing allowed during immunity',()=>{
 const f=fixture();exposePoison(f.ctx,'pale-tincture',f.target);f.target.effects.push({id:'immune',name:'Poisoned immunity',conditionImmunities:['poisoned']});assert.equal(maxItemHealableHp(f.target),200);const before=f.target.hp.current;f.ctx.heal(f.target,100,f.ctx.log,f.source);onItemHeal(f.target,f.target.hp.current-before);f.target.effects=f.target.effects.filter(e=>e.id!=='immune');assert.equal(maxItemHealableHp(f.target),200);exposePoison(f.ctx,'pale-tincture',f.target);assert.equal(f.target.effects.filter(e=>e.sourceId==='poison:pale-tincture').length,1);
});
test('ending Poisoned clears linked condition poisons without neutralizing latent Midnight Tears',()=>{
 const f=fixture();exposePoison(f.ctx,'pale-tincture',f.target);exposePoison(f.ctx,'midnight-tears',f.target);assert.ok(f.target.effects.some(e=>e.sourceId==='poison:pale-tincture'));neutralizeItemPoison(f.target,true);assert.equal(f.target.effects.some(e=>e.sourceId==='poison:pale-tincture'),false);assert.equal(f.target.effects.some(e=>e.sourceId==='poison:midnight-tears'&&e.gmOnly),true);const hp=f.target.hp.current;tickItemEffects(f.ctx,f.target,'midnight');assert.equal(f.target.hp.current,hp-9);assert.equal(f.target.effects.some(e=>e.sourceId==='poison:midnight-tears'),false);
});
test('Petrified suppresses existing Poisoned healing restrictions without deleting the poison',()=>{
 const f=fixture();exposePoison(f.ctx,'pale-tincture',f.target);assert.equal(maxItemHealableHp(f.target),199);f.target.effects.push({id:'stone',name:'Petrified',condition:'petrified'});assert.equal(maxItemHealableHp(f.target),200);assert.ok(f.target.effects.some(e=>e.sourceId==='poison:pale-tincture'));const before=f.target.hp.current;f.ctx.heal(f.target,1,f.ctx.log,f.source);onItemHeal(f.target,f.target.hp.current-before);f.target.effects=f.target.effects.filter(e=>e.id!=='stone');assert.equal(maxItemHealableHp(f.target),200);
});
