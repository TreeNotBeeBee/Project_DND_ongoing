import type { Actor, GameState, Resolution } from '../shared/model';
import type { ItemAmount, WorldActionRule, WorldContext } from '../shared/world';
import { assert } from '../engine/dice';
import { tokenCells } from '../engine/spatial';
import { grantExperience, reconcileWorldBonuses } from './growth';
import { finite, natural } from './fixed';
import { requireWorld, note } from './governance';
import { id } from './validation';

export function itemQuantity(actor: Actor, itemId: string): number { return actor.inventory.filter(item => item.contentId === `world:${itemId}`).reduce((sum, item) => sum + item.quantity, 0); }
export function removeItems(actor: Actor, amounts: ItemAmount[]): void {
  const totals = new Map<string, number>();
  for (const amount of amounts) totals.set(amount.itemId, (totals.get(amount.itemId) || 0) + amount.quantity);
  for (const [itemId, quantity] of totals) assert(itemQuantity(actor, itemId) >= quantity, 'WORLD_INPUTS', '制作或交易所需物品不足');
  for (const [itemId, quantity] of totals) {
    let remaining = quantity;
    for (const item of actor.inventory.filter(item => item.contentId === `world:${itemId}`)) { const consumed = Math.min(remaining, item.quantity); item.quantity -= consumed; remaining -= consumed; if (!item.quantity) item.equipped = false; }
  }
}
export function grantItems(state: GameState, actor: Actor, amounts: ItemAmount[], operationId: string): void {
  const world = requireWorld(state);
  for (const [index, amount] of amounts.entries()) {
    const definition = world.items.find(item => item.id === amount.itemId); assert(definition, 'WORLD_ITEM', '产出物品定义不存在');
    const previous = actor.inventory.find(item => item.contentId === `world:${amount.itemId}` && !item.equipped);
    if (previous) previous.quantity = natural(previous.quantity + amount.quantity, '物品数量', 1_000_000);
    else { assert(actor.inventory.length < 5000, 'WORLD_LIMIT', '角色物品数量已达上限'); actor.inventory.push({ id: `world-item:${operationId}:${index}`, contentId: `world:${definition.id}`, name: definition.name, quantity: amount.quantity, equipped: false }); }
  }
}
export function equipWorldItem(state: GameState, actor: Actor, payload: Record<string, any>): void {
  const item = actor.inventory.find(item => item.id === payload.itemId), world = requireWorld(state);
  assert(item && item.quantity > 0 && world.items.some(entry => item.contentId === `world:${entry.id}`), 'WORLD_ITEM', '请选择角色拥有的世界物品');
  assert(typeof payload.equipped === 'boolean', 'WORLD_ITEM', '请明确装备或卸下'); item.equipped = payload.equipped; reconcileWorldBonuses(state);
}
export function gatherAmounts(state: GameState, payload: Record<string, any>): ItemAmount[] {
  const world = requireWorld(state);
  if (payload.ruleId !== undefined) { const rule = world.rules.recipes.find(rule => rule.id === payload.ruleId); assert(rule, 'WORLD_RECIPE', '采集规则不存在'); return structuredClone(rule.outputs); }
  const itemId = id(payload.itemId), quantity = natural(payload.quantity ?? 1, '采集数量', 1_000_000); assert(quantity > 0, 'WORLD_INPUTS', '采集数量必须大于0');
  assert(world.items.some(item => item.id === itemId), 'WORLD_ITEM', '采集物品不存在'); return [{ itemId, quantity }];
}
function spendResources(actor: Actor, costs: WorldActionRule['resourceCosts']): void {
  for (const cost of costs || []) {
    const resource = actor.resources.find(resource => resource.id === cost.resourceId); assert(resource && resource.current >= cost.amount, 'WORLD_RESOURCE', '制作所需法力或体力不足');
    resource.current = finite(resource.current - cost.amount, '资源余额');
  }
}
function award(state: GameState, actor: Actor, rule: Pick<WorldActionRule, 'outputs' | 'experience' | 'unlockEntries'>, operationId: string): void {
  grantItems(state, actor, rule.outputs, operationId);
  if (rule.experience.length) grantExperience(actor, requireWorld(state).rules, rule.experience);
  if (rule.unlockEntries?.length) actor.knownEntries = [...new Set([...(actor.knownEntries || []), ...rule.unlockEntries])];
  reconcileWorldBonuses(state);
}
export function performRecipe(state: GameState, actor: Actor, payload: Record<string, any>, operationId: string, log: Resolution['events']): void {
  const world = requireWorld(state), rule = world.rules.recipes.find(rule => rule.id === payload.ruleId); assert(rule, 'WORLD_RECIPE', '制作规则不存在');
  if (payload.npcId !== undefined) {
    const merchant = state.actors.find(candidate => candidate.id === payload.npcId), behavior = world.npcBehaviors.find(behavior => behavior.actorId === merchant?.id && behavior.kind === 'trade' && behavior.ruleId === rule.id);
    assert(merchant && !merchant.dead && behavior && Math.max(Math.abs(merchant.position.x - actor.position.x), Math.abs(merchant.position.y - actor.position.y)) <= 1, 'WORLD_TRADE', '此交易需要在相邻且提供该交易的商人处进行');
  }
  removeItems(actor, rule.inputs); spendResources(actor, rule.resourceCosts);
  if (rule.durationRounds) {
    const jobId = `job:${operationId}`; assert(world.jobs.length < 2000, 'WORLD_LIMIT', '进行中的制作任务已达上限');
    world.jobs.push({ id: jobId, actorId: actor.id, ruleId: rule.id, completesRound: world.round.number + rule.durationRounds }); actor.choices ||= {};
    const jobs = (actor.choices._worldJobs ||= {}) as Record<string, unknown>; jobs[jobId] = structuredClone({ outputs: rule.outputs, experience: rule.experience, unlockEntries: rule.unlockEntries });
    note(log, 'world-job-started', `${actor.name}开始${rule.name}，将在第${world.round.number + rule.durationRounds}回合完成`, actor.id);
  } else { award(state, actor, rule, operationId); note(log, 'world-recipe', `${actor.name}完成${rule.name}`, actor.id); }
}
export function performGather(state: GameState, actor: Actor, payload: Record<string, any>, operationId: string, log: Resolution['events']): void {
  const world = requireWorld(state), node = world.nodes.find(node => node.id === payload.nodeId); assert(node && (!node.hidden || actor.ownerId === world.ownerId), 'WORLD_NODE', '资源节点不存在或尚未被发现');
  assert(tokenCells(actor, actor.position, state.scene.gridFeet).some(cell => Math.max(Math.abs(cell.x - node.position.x), Math.abs(cell.y - node.position.y)) <= 1), 'WORLD_NODE_RANGE', '请先移动到资源节点附近');
  const amounts = gatherAmounts(state, payload);
  for (const amount of amounts) assert((node.inventory.find(entry => entry.itemId === amount.itemId)?.quantity || 0) >= amount.quantity, 'WORLD_NODE_EMPTY', '此节点的资源已经不足');
  for (const amount of amounts) node.inventory.find(entry => entry.itemId === amount.itemId)!.quantity -= amount.quantity;
  const rule = payload.ruleId ? world.rules.recipes.find(rule => rule.id === payload.ruleId)! : undefined;
  award(state, actor, { outputs: amounts, experience: rule?.experience || [], unlockEntries: rule?.unlockEntries }, operationId); note(log, 'world-gather', `${actor.name}从${node.name}采集资源`, actor.id);
}
export function finishJobs(state: GameState, round: number, log: Resolution['events']): void {
  const world = requireWorld(state);
  for (const job of [...world.jobs]) {
    if (job.completesRound > round) continue;
    const actor = state.actors.find(actor => actor.id === job.actorId), records = actor?.choices?._worldJobs as Record<string, any> | undefined, snapshot = records?.[job.id];
    assert(actor && snapshot, 'WORLD_JOB', '制作任务的持久化记录损坏，无法完成');
    award(state, actor, snapshot, job.id); delete records![job.id]; world.jobs = world.jobs.filter(entry => entry.id !== job.id); note(log, 'world-job-complete', `${actor.name}的制作任务已完成`, actor.id);
  }
}
