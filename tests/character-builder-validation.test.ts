import test from 'node:test';
import assert from 'node:assert/strict';
import { builderIssues, builderRulesData, builderSubclasses } from '../src/client/builder-validation';
import { entries } from '../src/content/index';

const rules = builderRulesData(entries);
const issues = (input: Parameters<typeof builderIssues>[0]) => builderIssues(input, rules);
const fighter = () => ({ name: '验收角色', ownerId: 'test', classes: [{ classId: 'class:fighter', level: 1 }], speciesId: 'species:dwarf', backgroundId: 'background:soldier', abilities: { str: 17, dex: 14, con: 14, int: 12, wis: 10, cha: 8 }, skills: ['athletics', 'intimidation', 'perception', 'survival'], choices: { characterBuild: { method: 'standard', baseAbilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, backgroundBonuses: { str: 2, con: 1 } } } });
test('builder checklist accepts the same legal source-based fighter as the server', () => {
  assert.deepEqual(issues(fighter()), []);
  assert.ok(issues({ ...fighter(), name: '' }).some(issue => issue.field === 'name'));
});
test('shared validation routes background, skill, feat and Magic Initiate deficiencies to editable steps', () => {
  const input = fighter(); input.choices.characterBuild.backgroundBonuses = { str: 0, con: 0 };
  assert.ok(issues(input).some(issue => issue.tab === 'abilities' && issue.field === 'background-bonuses'));
  assert.ok(issues({ ...fighter(), skills: [] }).some(issue => issue.field === 'skills'));
  assert.ok(issues({ ...fighter(), classes: [{ classId: 'class:fighter', level: 4 }] }).some(issue => issue.tab === 'equipment' && issue.source.includes('升级专长')));
  assert.ok(issues({ ...fighter(), backgroundId: 'background:acolyte' }).some(issue => issue.tab === 'spells' && issue.source.includes('魔法学徒')));
});
test('subclass choices come only from a selected class at an eligible level', () => {
  assert.deepEqual(builderSubclasses(entries, '', 3), []);
  assert.deepEqual(builderSubclasses(entries, 'class:wizard', 2), []);
  assert.deepEqual(builderSubclasses(entries, 'class:wizard', 3).map(entry => entry.id), ['subclass:evoker']);
  assert.ok(!builderSubclasses(entries, 'class:fighter', 3).some(entry => entry.id === 'subclass:evoker'));
  assert.ok(issues({ ...fighter(), classes: [{ classId: 'class:fighter', level: 3 }] }).some(issue => issue.field === 'subclass-0'));
});
