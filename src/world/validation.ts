import { ABILITIES, type Actor, type Scene } from '../shared/model';
import type { GrowthTarget, NpcBehavior, WorldDraft, WorldItem, WorldNode, WorldRules } from '../shared/world';
import { assert } from '../engine/dice';
import { finite, micro, natural } from './fixed';

export const GROWTH_TARGETS: GrowthTarget[] = [...ABILITIES, 'hp', 'mp', 'stamina', 'ap.maximum', 'ap.recovery', 'ap.perRound'];
export function object(value: unknown, label = '数据'): Record<string, any> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'WORLD_FORMAT', `${label}必须为对象`); return value as Record<string, any>;
}
export function text(value: unknown, label: string, max = 4000, empty = false): string {
  assert(typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0), 'WORLD_FORMAT', `${label}必须为${empty ? '0' : '1'}到${max}字的文本`); return value;
}
export function id(value: unknown): string { return text(value, '标识符', 128); }
function array(value: unknown, label: string, max = 1000): any[] { assert(Array.isArray(value) && value.length <= max, 'WORLD_FORMAT', `${label}必须为至多${max}项的数组`); return value; }
function unique(values: string[], label: string): void { assert(new Set(values).size === values.length, 'WORLD_DUPLICATE', `${label}不能重复`); }
export function validateRules(input: unknown): WorldRules {
  const rules = structuredClone(object(input, '世界规则')) as WorldRules;
  const costs = object(rules.costs, '行动成本');
  assert(Object.keys(costs).every(key => ['move', 'action', 'narrative', 'proposal'].includes(key)), 'WORLD_RULES', '未知行动成本');
  for (const value of Object.values(costs)) micro(value, '行动成本');
  if (rules.energy) {
    const energy = object(rules.energy, '行动力规则');
    assert(micro(energy.maximum) <= 100_000_000, 'WORLD_RULES', '基础行动力最大值不能超过100');
    micro(energy.perRound); micro(energy.recovery);
    if (energy.initial !== undefined) assert(micro(energy.initial) <= micro(energy.maximum), 'WORLD_RULES', '初始行动力不能超过基础上限');
    assert(['hour', 'round'].includes(energy.recoveryMode), 'WORLD_RULES', '请选择小时或回合恢复');
  }
  if (rules.proposalHours !== undefined) assert(typeof rules.proposalHours === 'number' && Number.isFinite(rules.proposalHours) && rules.proposalHours > 0 && rules.proposalHours <= 8760, 'WORLD_RULES', '投票期限必须为0到8760小时之间');
  object(rules.conflict, '冲突规则'); assert(['random', 'cancel-refund', 'attribute'].includes(rules.conflict.kind), 'WORLD_RULES', '未知资源冲突策略');
  if (rules.conflict.kind === 'attribute') text(rules.conflict.attribute, '冲突判定属性', 128);
  object(rules.growth, '成长规则'); assert(['global', 'tracks'].includes(rules.growth.kind), 'WORLD_RULES', '未知成长模式');
  for (const track of array(rules.growth.tracks, '成长轨道', 100)) {
    id(track.id); text(track.name, '轨道名称', 128);
    for (const value of array(track.curve, '升级曲线', 1000)) assert(natural(value, '升级经验', 1_000_000_000) > 0, 'WORLD_RULES', '升级经验必须大于0');
    assert(track.curve.length, 'WORLD_RULES', '升级曲线不能为空'); natural(track.pointsPerLevel, '每级成长点', 1_000_000);
    for (const upgrade of array(track.upgrades, '加点规则', 100)) {
      assert(GROWTH_TARGETS.includes(upgrade.target), 'WORLD_RULES', '未知成长目标');
      assert(natural(upgrade.cost, '升级成本', 1_000_000) > 0 && (upgrade.target.startsWith('ap.') ? micro(upgrade.amount, '升级数量') : finite(upgrade.amount, '升级数量')) > 0, 'WORLD_RULES', '加点成本和收益必须大于0');
      if (upgrade.max !== undefined) upgrade.target.startsWith('ap.') ? micro(upgrade.max, '成长上限') : finite(upgrade.max, '成长上限');
    }
    unique(track.upgrades.map((entry: any) => entry.target), '轨道加点目标');
  }
  unique(rules.growth.tracks.map(track => track.id), '成长轨道');
  for (const recipe of array(rules.recipes, '合成采集规则', 1000)) {
    id(recipe.id); text(recipe.name, '行动名称', 128); text(recipe.description, '行动说明', 10_000, true); micro(recipe.cost, '配方行动力');
    for (const amounts of [recipe.inputs, recipe.outputs]) for (const entry of array(amounts, '配方物品', 100)) { id(entry.itemId); assert(natural(entry.quantity, '物品数量', 1_000_000) > 0, 'WORLD_RULES', '物品数量必须大于0'); }
    for (const entry of array(recipe.resourceCosts || [], '配方资源', 100)) { id(entry.resourceId); assert(entry.resourceId !== 'ap', 'WORLD_RULES', '配方行动力请通过cost设置'); micro(entry.amount, '资源成本'); }
    for (const award of array(recipe.experience, '经验奖励', 100)) { assert(rules.growth.tracks.some(track => track.id === award.trackId), 'WORLD_RULES', '经验奖励引用未知成长轨道'); natural(award.amount, '奖励经验', 1_000_000_000); }
    if (recipe.durationRounds !== undefined) assert(natural(recipe.durationRounds, '制作回合数', 1_000_000) >= 1, 'WORLD_RULES', '制作回合数至少为1');
    if (recipe.unlockEntries !== undefined) for (const entry of array(recipe.unlockEntries, '知识解锁', 100)) id(entry);
  }
  unique(rules.recipes.map(recipe => recipe.id), '配方'); return rules;
}
export function validateItems(input: unknown): WorldItem[] {
  const items = structuredClone(array(input, '世界物品', 2000)) as WorldItem[];
  for (const item of items) { id(item.id); text(item.name, '物品名称', 128); text(item.description, '物品说明', 10_000, true); for (const [key, value] of Object.entries(item.bonuses || {})) { assert(GROWTH_TARGETS.includes(key as GrowthTarget), 'WORLD_RULES', '未知物品加成'); key.startsWith('ap.') ? micro(value, '物品加成', true) : finite(value, '物品加成', true); } }
  unique(items.map(item => item.id), '物品'); return items;
}
export function validateNodes(input: unknown, items: WorldItem[]): WorldNode[] {
  const nodes = structuredClone(array(input, '资源节点', 1000)) as WorldNode[];
  for (const node of nodes) { id(node.id); text(node.name, '节点名称', 128); object(node.position, '节点位置'); natural(node.position.x, '坐标x', 199); natural(node.position.y, '坐标y', 199); for (const entry of array(node.inventory, '节点库存', 1000)) { assert(items.some(item => item.id === entry.itemId), 'WORLD_RULES', '资源节点引用未知物品'); natural(entry.quantity, '库存数量', 1_000_000); } unique(node.inventory.map(entry => entry.itemId), '节点库存物品'); }
  unique(nodes.map(node => node.id), '节点'); return nodes;
}
export function validateBehaviors(input: unknown, actors: Actor[]): NpcBehavior[] {
  const behaviors = structuredClone(array(input, 'NPC行为', 500)) as NpcBehavior[];
  for (const behavior of behaviors) { assert(actors.some(actor => actor.id === behavior.actorId && actor.kind !== 'hero'), 'WORLD_RULES', 'NPC行为必须引用现有NPC或怪物'); assert(['idle', 'patrol', 'hostile', 'trade', 'event'].includes(behavior.kind), 'WORLD_RULES', '未知NPC行为'); if (behavior.waypoints) for (const position of array(behavior.waypoints, '巡逻路径', 1000)) { natural(position.x, '坐标x', 199); natural(position.y, '坐标y', 199); } if (behavior.actionId !== undefined) id(behavior.actionId); if (behavior.ruleId !== undefined) id(behavior.ruleId); if (behavior.trigger !== undefined) assert(behavior.trigger === 'round' || behavior.trigger === 'nearby' || /^round:\d+$/.test(behavior.trigger) || /^hp-below:(?:100|\d{1,2})(?:\.\d+)?$/.test(behavior.trigger), 'WORLD_NPC_TRIGGER', '程序事件条件仅支持round、round:N、nearby、hp-below:百分比；其他叙事条件请由主持人或AI裁定'); }
  unique(behaviors.map(behavior => behavior.actorId), 'NPC行为'); return behaviors;
}
export function draftPayload(kind: WorldDraft['kind'], input: unknown): Record<string, unknown> {
  const payload = structuredClone(object(input, '草稿内容'));
  if (kind === 'scene') object(payload.scene, '场景');
  else if (kind === 'rules') payload.rules = validateRules(payload.rules);
  else if (kind === 'actor') object(payload.actor, '角色');
  else if (kind === 'story') text(payload.text, '故事内容', 100_000);
  else if (kind === 'items') payload.items = validateItems(payload.items);
  else if (kind === 'nodes') array(payload.nodes, '资源节点', 1000);
  else assert(false, 'WORLD_DRAFT', '未知草稿种类');
  return payload;
}
