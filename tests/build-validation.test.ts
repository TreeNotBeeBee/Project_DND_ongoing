import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuild, type RulesData } from '../src/shared/build-validation.ts';
import type { Actor } from '../src/shared/model.ts';

const data:RulesData={
  backgrounds:[{index:'soldier',ability_scores:[{index:'str'},{index:'dex'},{index:'con'}],feat:{index:'savage-attacker'},proficiencies:[{index:'skill-athletics'},{index:'skill-intimidation'}]}],
  classes:[{index:'fighter',proficiency_choices:[{type:'proficiencies',choose:2,from:{options:['acrobatics','athletics','survival','perception'].map(index=>({item:{index:'skill-'+index}}))}}]}, {index:'wizard',spellcasting:{}}],
  levels:[{index:'fighter-1',features:[{index:'fighter-second-wind'}]}, {index:'fighter-4',features:[{index:'fighter-ability-score-improvement'}]}, {index:'wizard-1',spellcasting:{cantrips_known:3,prepared_spells:4,spell_slots_level_1:2}}],
  feats:[{index:'savage-attacker',type:'origin'},{index:'alert',type:'origin'},{index:'ability-score-improvement',type:'general',repeatable:true},{index:'archery',type:'fighting-style'}],
  skills:['acrobatics','athletics','survival','perception','intimidation','arcana'].map(index=>({index})),
  spells:[{index:'fireball',name:'Fireball',level:3,classes:[{index:'wizard'}]},{index:'fire-bolt',name:'Fire Bolt',level:0,classes:[{index:'wizard'}]}]
};
function actor():Actor {return {
  id:'a',ownerId:'member',kind:'hero',name:'Fighter',speciesId:'dwarf',backgroundId:'soldier',classes:[{classId:'fighter',level:1}],
  abilities:{str:17,dex:14,con:14,int:12,wis:10,cha:8},
  choices:{characterBuild:{method:'standard',baseAbilities:{str:15,dex:14,con:13,int:12,wis:10,cha:8},backgroundBonuses:{str:2,con:1}}},
  hp:{current:12,max:12,temp:0},deathSaves:{successes:0,failures:0},skills:['athletics','intimidation','acrobatics','survival'],expertise:[],saveProficiencies:['str','con'],languages:['common','dwarvish','elvish'],resources:[],inventory:[],spells:[],features:['feature:fighter-second-wind','feat:savage-attacker'],effects:[],position:{x:0,y:0},hidden:false,notes:'',draft:false
};}
test('legitimate source-based standard-array fighter activates',()=>assert.deepEqual(validateBuild(actor(),data),[]));
test('point buy uses non-linear 14/15 costs and exactly 27 points',()=>{
  const a=actor();const build=a.choices!.characterBuild as any;build.method='pointBuy';build.baseAbilities={str:15,dex:14,con:13,int:12,wis:10,cha:8};
  assert.deepEqual(validateBuild(a,data),[]);
  build.baseAbilities.cha=9;a.abilities.cha=9;assert.match(validateBuild(a,data).join(),/27/);
});
test('raw 30 attributes and fabricated final totals cannot activate',()=>{
  const a=actor();a.abilities.str=30;assert.match(validateBuild(a,data).join(),/合计/);
  (a.choices!.characterBuild as any).baseAbilities.str=30;assert.match(validateBuild(a,data).join(),/8至15/);
});
test('background only improves its three listed abilities',()=>{
  const a=actor();(a.choices!.characterBuild as any).backgroundBonuses={str:2,int:1};a.abilities.con=13;a.abilities.int=13;
  assert.match(validateBuild(a,data).join(),/INT/);
});
test('future class features, excess skills and expertise are rejected',()=>{
  const a=actor();a.features.push('feature:barbarian-rage');a.skills.push('arcana');a.expertise.push('arcana');
  const errors=validateBuild(a,data).join();assert.match(errors,/合法来源/);assert.match(errors,/技能/);assert.match(errors,/专精/);
});
test('a skill must have class, background or explicit extra source',()=>{
  const a=actor();a.skills[2]='arcana';assert.match(validateBuild(a,data).join(),/职业可选/);
});
test('required ASI selection changes both source record and final attributes',()=>{
  const a=actor();a.classes[0].level=4;a.features.push('feature:fighter-ability-score-improvement');
  assert.match(validateBuild(a,data).join(),/升级专长/);
  const build=a.choices!.characterBuild as any;build.feats=[{classId:'fighter',level:4,featId:'ability-score-improvement',abilityBonuses:{str:2}}];a.abilities.str=19;
  assert.deepEqual(validateBuild(a,data),[]);
  build.feats.push({...build.feats[0]});assert.match(validateBuild(a,data).join(),/没有可用/);
});
test('multiclass shared slots do not unlock higher wizard preparation',()=>{
  const a=actor();a.classes.push({classId:'wizard',level:1});a.spells=['spell:fireball'];
  assert.match(validateBuild(a,data).join(),/当前职业等级/);
});
test('humans must select an origin feat and cannot claim epic feats at first level',()=>{
  const a=actor();a.speciesId='human';assert.match(validateBuild(a,data).join(),/人类/);
  (a.choices!.characterBuild as any).originFeat='alert';a.features.push('feat:alert');assert.deepEqual(validateBuild(a,data),[]);
});
test('mastery lists require class feature and cannot grant arbitrary weapons',()=>{
  const a=actor();a.choices!.weaponMasteries=['equipment:longsword'];
  assert.match(validateBuild(a,data).join(),/武器精通/);
});
test('Scholar expertise cannot be reassigned to a nonacademic skill',()=>{
  const a=actor();a.classes=[{classId:'wizard',level:2}];a.features=[];a.expertise=['athletics'];
  assert.match(validateBuild(a,data).join(),/法师学者/);
});
test('published Grappler prerequisites are enforced even when upstream metadata omits scores',()=>{
  const a=actor();a.classes[0].level=4;
  const local=structuredClone(data);local.feats.push({index:'grappler',name:'Grappler',type:'general',prerequisites:{minimum_level:4}});
  const build=a.choices!.characterBuild as any;build.baseAbilities={str:10,dex:12,con:15,int:14,wis:13,cha:8};build.backgroundBonuses={con:2,dex:1};
  a.abilities={str:10,dex:13,con:17,int:14,wis:13,cha:8};build.feats=[{classId:'fighter',level:4,featId:'grappler',abilityBonuses:{dex:1}}];a.abilities.dex=14;
  assert.equal(validateBuild(a,local).some(error=>error.includes('擒抱者需要')),false);
  build.backgroundBonuses={con:2,str:1};a.abilities.str=11;a.abilities.dex=13;
  assert.match(validateBuild(a,local).join(),/擒抱者需要/);
});
test('reordering feat records cannot use a later ASI to qualify for an earlier feat',()=>{
  const a=actor();a.classes[0].level=8;const local=structuredClone(data);
  local.feats.push({index:'grappler',name:'Grappler',type:'general',prerequisites:{minimum_level:4}});
  local.levels.push({index:'fighter-8',features:[{index:'fighter-ability-score-improvement'}]});
  const build=a.choices!.characterBuild as any;build.baseAbilities={str:10,dex:12,con:15,int:14,wis:13,cha:8};build.backgroundBonuses={con:2,str:1};
  build.feats=[{classId:'fighter',level:8,featId:'ability-score-improvement',abilityBonuses:{str:2}},{classId:'fighter',level:4,featId:'grappler',abilityBonuses:{dex:1}}];
  a.abilities={str:13,dex:13,con:17,int:14,wis:13,cha:8};assert.match(validateBuild(a,local).join(),/擒抱者需要/);
});
