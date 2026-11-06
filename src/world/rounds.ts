import type { Actor, Command, GameState, Member, Resolution } from '../shared/model';
import type { PlannedIntent, WorldContext, WorldDraft, WorldState } from '../shared/world';
import { assert, uid } from '../engine/dice';
import { pathCost } from '../engine/map';
import { hasEffect } from '../engine/actors';
import { decimal, finite, micro } from './fixed';
import { apResource, energyLimits, isActiveActor, reconcileEnergy, recoverRound, spendEnergy } from './energy';
import { migrateGrowth, reconcileWorldBonuses } from './growth';
import { executeEngine } from './engine';
import { equipWorldItem, finishJobs, gatherAmounts, grantItems, itemQuantity, performGather, performRecipe, removeItems } from './inventory';
import { hasCapability, note, openProposal, registeredMembers, requireCapability, requireOwner, requireWorld } from './governance';
import { draftPayload, id, object, text, validateBehaviors, validateItems, validateNodes, validateRules } from './validation';
import { runNpcPolicies } from './npc';
import { assertWorldIdentities } from './identity';

type Log = Resolution['events'];
const pending = (intent: PlannedIntent) => intent.status === 'planned' || intent.status === 'approved';
function findActor(state: GameState, actorId: unknown): Actor { const actor = state.actors.find(actor => actor.id === actorId); assert(actor && isActiveActor(actor), 'WORLD_ACTOR', '请选择已注册且仍可行动的角色'); return actor; }
export function validateCatalog(state: GameState): void {
  const world = requireWorld(state), known = new Set(world.items.map(item => item.id));
  for (const recipe of world.rules.recipes) for (const entry of [...recipe.inputs, ...recipe.outputs]) assert(known.has(entry.itemId), 'WORLD_ITEM', '配方引用的世界物品必须存在');
  for (const node of world.nodes) for (const entry of node.inventory) assert(known.has(entry.itemId), 'WORLD_ITEM', '节点引用的世界物品必须存在');
  for (const actor of state.actors) for (const item of actor.inventory) if (item.contentId.startsWith('world:')) assert(known.has(item.contentId.slice(6)), 'WORLD_ITEM', '不能删除角色仍持有的物品定义');
  for (const behavior of world.npcBehaviors) {
    if (behavior.ruleId) assert(world.rules.recipes.some(rule => rule.id === behavior.ruleId), 'WORLD_RECIPE', 'NPC行为引用的制作或交易规则不存在');
    if (behavior.kind === 'trade') assert(behavior.ruleId, 'WORLD_TRADE', '交易NPC必须选择一个已定义的交易规则');
    if (behavior.kind === 'patrol') assert(behavior.waypoints?.length && behavior.waypoints.every(position => position.x < state.scene.width && position.y < state.scene.height), 'WORLD_PATROL', '巡逻行为需要场景内的路线点');
  }
  for (const job of world.jobs) {
    const actor = state.actors.find(actor => actor.id === job.actorId), snapshot = (actor?.choices?._worldJobs as Record<string, any> | undefined)?.[job.id];
    assert(snapshot && snapshot.outputs.every((entry: any) => known.has(entry.itemId)), 'WORLD_JOB', '不能删除进行中制作任务的产出定义');
    assert(snapshot.experience.every((entry: any) => world.rules.growth.kind === 'global' ? world.rules.growth.tracks.length : world.rules.growth.tracks.some(track => track.id === entry.trackId)), 'WORLD_JOB', '不能删除进行中制作任务的成长轨道');
  }
}
export function configureWorld(state: GameState, p: Record<string, any>, ctx: WorldContext): void {
  const world = requireWorld(state);
  assert(Object.keys(p).every(key => ['rules', 'lore', 'secretLore', 'items', 'nodes', 'npcBehaviors'].includes(key)), 'WORLD_CONFIG', '不能通过世界配置更改模式、房主、治理或内部状态');
  if (p.rules !== undefined) { const before = structuredClone(world.rules); world.rules = validateRules(p.rules); for (const actor of state.actors) migrateGrowth(actor, before, world.rules); for (const actor of state.actors) world.energyAt[actor.id] = ctx.now; }
  if (p.lore !== undefined) world.lore = text(p.lore, '公开世界背景', 100_000, true);
  if (p.secretLore !== undefined) world.secretLore = text(p.secretLore, '秘密世界背景', 100_000, true);
  if (p.items !== undefined) world.items = validateItems(p.items);
  if (p.nodes !== undefined) world.nodes = validateNodes(p.nodes, world.items);
  if (p.npcBehaviors !== undefined) world.npcBehaviors = validateBehaviors(p.npcBehaviors, state.actors);
  validateCatalog(state); reconcileWorldBonuses(state);
}
function actionPayload(payload: Record<string, any>, manualRuling: boolean): void {
  assert(payload.commandType === undefined || payload.commandType === 'inventory.equip', 'WORLD_ACTION', '行动意图只允许动作或装备切换');
  if (payload.commandType === 'inventory.equip') { id(payload.itemId); assert(typeof payload.equipped === 'boolean', 'WORLD_ACTION', '请明确装备或卸下'); }
  else id(payload.actionId);
  if (!manualRuling) {
    const options = payload.options === undefined ? {} : object(payload.options, '动作选项');
    assert([payload.advantage, payload.saveAdvantage, options.advantage, options.saveAdvantage].every(value => value === undefined || value === null || value === 0), 'WORLD_RULING', '优势和劣势由规则自动计算；特殊情况请由真人主持人裁定');
    assert(payload.saveAbility === undefined && options.saveAbility === undefined, 'WORLD_RULING', '不能替目标选择防御属性');
  }
}
export function intentCost(state: GameState, actor: Actor, type: PlannedIntent['type'], payload: Record<string, any>): number {
  const world = requireWorld(state), costs = world.rules.costs;
  let value: number | undefined;
  if (type === 'move') {
    const working = structuredClone(actor);
    const earlier = world.round.intents.filter(intent => intent.actorId === actor.id && pending(intent) && intent.type === 'move');
    if (earlier.length) working.position = structuredClone((earlier.at(-1)!.payload.path as Actor['position'][]).at(-1)!);
    const equivalent = pathCost(state.scene, working, payload.path, state.actors.filter(isActiveActor), { crawling: hasEffect(actor, 'prone') }) / state.scene.gridFeet;
    if (costs.move !== undefined) { const result = BigInt(micro(costs.move)) * BigInt(equivalent); assert(result <= BigInt(Number.MAX_SAFE_INTEGER), 'WORLD_AP', '移动成本超出安全范围'); value = decimal(Number(result)); }
  } else if (type === 'recipe') { const recipe = world.rules.recipes.find(recipe => recipe.id === payload.ruleId); assert(recipe, 'WORLD_RECIPE', '配方不存在'); value = recipe.cost; }
  else if (type === 'action') {
    const action = actor.customActions?.find(action => action.id === payload.actionId), explicit = action?.costs?.filter(cost => cost.resourceId === 'ap');
    value = explicit?.length ? decimal(explicit.reduce((sum, cost) => sum + micro(cost.amount), 0)) : costs.action;
  } else value = type === 'gather' ? costs.action : type === 'proposal' ? costs.proposal : costs.narrative;
  if (world.mode === 'co-create') assert(world.rules.energy && value !== undefined, 'WORLD_RULES_REQUIRED', '请先由房主配置行动力与此类行动成本，未配置的玩法不能执行');
  if (!world.rules.energy) return 0;
  return decimal(micro(value ?? 0, '意图成本'));
}
interface Claim { key: string; quantity: number; available: number }
export function resourceClaims(state: GameState, intent: PlannedIntent): Claim[] {
  const world = requireWorld(state), actor = findActor(state, intent.actorId), payload = intent.payload, claims: Claim[] = [];
  if (intent.type === 'gather') {
    const node = world.nodes.find(node => node.id === payload.nodeId); assert(node, 'WORLD_NODE', '采集节点不存在');
    for (const amount of gatherAmounts(state, payload)) claims.push({ key: `node:${node.id}:${amount.itemId}`, quantity: amount.quantity, available: node.inventory.find(entry => entry.itemId === amount.itemId)?.quantity || 0 });
  }
  if (intent.type === 'recipe') {
    const recipe = world.rules.recipes.find(recipe => recipe.id === payload.ruleId); assert(recipe, 'WORLD_RECIPE', '配方不存在');
    for (const amount of recipe.inputs) claims.push({ key: `actor:${actor.id}:item:${amount.itemId}`, quantity: amount.quantity, available: itemQuantity(actor, amount.itemId) });
    for (const amount of recipe.resourceCosts || []) claims.push({ key: `actor:${actor.id}:resource:${amount.resourceId}`, quantity: amount.amount, available: actor.resources.find(resource => resource.id === amount.resourceId)?.current || 0 });
    if (payload.npcId) { const merchant = state.actors.find(actor => actor.id === payload.npcId); assert(merchant, 'WORLD_TRADE', '交易商人不存在'); for (const amount of recipe.outputs) claims.push({ key: `actor:${merchant.id}:item:${amount.itemId}`, quantity: amount.quantity, available: itemQuantity(merchant, amount.itemId) }); }
  }
  if (intent.type === 'action') for (const amount of actor.customActions?.find(action => action.id === payload.actionId)?.costs || []) if (amount.resourceId !== 'ap') claims.push({ key: `actor:${actor.id}:resource:${amount.resourceId}`, quantity: amount.amount, available: actor.resources.find(resource => resource.id === amount.resourceId)?.current || 0 });
  return claims;
}
function reserve(state: GameState, candidate: PlannedIntent): void {
  const world = requireWorld(state), actor = findActor(state, candidate.actorId), intents = world.round.intents.filter(intent => intent.actorId === actor.id && pending(intent));
  const previous = intents.findIndex(intent => intent.id === candidate.id); if (previous >= 0) intents[previous] = candidate; else intents.push(candidate);
  const reserved = intents.reduce((sum, intent) => sum + micro(intent.cost), 0), resource = apResource(actor), spent = micro(world.round.spent[actor.id] || 0);
  assert(reserved <= micro(resource?.current || 0), 'WORLD_AP_RESERVED', '本轮计划保留的行动力超过可用余额');
  if (world.rules.energy) assert(reserved + spent <= micro(energyLimits(actor, world).perRound), 'WORLD_ROUND_LIMIT', '本轮计划超过每回合行动力支出额度');
  const forecast = structuredClone(state), future = findActor(forecast, actor.id);
  for (const intent of intents) {
    for (const claim of resourceClaims(forecast, intent)) assert(claim.quantity <= claim.available, 'WORLD_RESOURCE_RESERVED', '本轮计划重复保留了不足的法力、体力、材料或节点资源');
    if (intent.type === 'move') future.position = structuredClone((intent.payload.path as Actor['position'][]).at(-1)!);
    if (intent.type === 'gather') { const amounts = gatherAmounts(forecast, intent.payload), node = requireWorld(forecast).nodes.find(node => node.id === intent.payload.nodeId)!; for (const amount of amounts) node.inventory.find(entry => entry.itemId === amount.itemId)!.quantity -= amount.quantity; grantItems(forecast, future, amounts, `forecast:${intent.id}`); }
    if (intent.type === 'recipe') { const recipe = world.rules.recipes.find(recipe => recipe.id === intent.payload.ruleId)!; removeItems(future, recipe.inputs); if (intent.payload.npcId) { const merchant = forecast.actors.find(actor => actor.id === intent.payload.npcId)!; removeItems(merchant, recipe.outputs); grantItems(forecast, merchant, recipe.inputs, `forecast-trade:${intent.id}`); } if (!recipe.durationRounds) grantItems(forecast, future, recipe.outputs, `forecast:${intent.id}`); }
    for (const claim of resourceClaims(state, intent)) if (claim.key.startsWith(`actor:${actor.id}:resource:`)) { const resource = future.resources.find(resource => claim.key === `actor:${actor.id}:resource:${resource.id}`)!; resource.current -= claim.quantity; }
  }
}
function npcPayload(actor: Record<string, any>, ownerId: string, actorId: string): Record<string, any> {
  assert(actor.kind === undefined || ['monster', 'companion'].includes(actor.kind), 'WORLD_NPC', '世界提案只能创建NPC、怪物或随从，不能生成主角席位');
  const npc: Record<string, any> = { ...actor, id: actorId, ownerId, kind: actor.kind || 'monster', profile: actor.profile || 'free', draft: false, choices: typeof actor.choices?.team === 'string' ? { team: actor.choices.team } : {} };
  for (const key of ['registration', 'requestedBy', 'publicGroups', 'knownEntries', 'growth', 'world', 'mode', 'owner', 'governance', 'grants', 'behavior']) delete npc[key];
  return npc;
}
function validateSubmission(state: GameState, draft: WorldDraft, ctx: WorldContext): WorldDraft {
  const published = { ...structuredClone(draft), payload: draftPayload(draft.kind, draft.payload) }, world = requireWorld(state), candidate = structuredClone(state);
  if (draft.kind === 'actor' || draft.kind === 'scene') {
    const result = executeEngine(candidate, { operationId: `preview:${draft.id}`, expectedRev: state.rev, type: draft.kind === 'actor' ? 'actor.create' : 'scene.update', payload: draft.kind === 'actor' ? npcPayload(object(published.payload.actor), world.ownerId, `preview:${draft.id}`) : published.payload }, ctx);
    if (draft.kind === 'actor') bindProposedBehavior(result.state, candidate, published.payload);
  }
  else if (draft.kind !== 'story') configureWorld(candidate, published.payload, ctx);
  return published;
}
function bindProposedBehavior(state: GameState, before: GameState, payload: Record<string, any>): void {
  const behavior = payload.behavior ?? payload.actor?.behavior;
  if (behavior === undefined) return;
  const added = state.actors.filter(actor => !before.actors.some(previous => previous.id === actor.id)); assert(added.length === 1, 'WORLD_NPC', 'NPC提案必须恰好创建一个角色');
  const world = requireWorld(state); world.npcBehaviors = validateBehaviors([...world.npcBehaviors, { ...object(behavior, 'NPC行为'), actorId: added[0].id }], state.actors); validateCatalog(state);
}
export function saveIntent(state: GameState, command: Command, member: Member, ctx: WorldContext, forced?: Record<string, any>): void {
  const world = requireWorld(state); assert(world.phase === 'running' && world.round.phase === 'planning', 'WORLD_PHASE', '当前不在回合计划阶段');
  const input = object(forced || object(command.payload || {}).intent, '行动意图'), existing = input.id === undefined ? undefined : world.round.intents.find(intent => intent.id === input.id);
  if (input.id !== undefined) assert(existing && existing.memberId === member.id && pending(existing), 'WORLD_INTENT_OWNER', '只能编辑自己尚未结算的意图');
  const actor = findActor(state, input.actorId), manual = world.mode === 'gm' && member.id === world.ownerId;
  assert(actor.ownerId === member.id || manual, 'WORLD_PERMISSION', '只能为自己的角色提交意图');
  assert(world.round.participants.includes(actor.ownerId) || actor.kind !== 'hero' && manual, 'WORLD_PARTICIPANT', '此角色未参加本回合，请在下一回合开始后规划');
  assert(!world.round.ended.includes(actor.ownerId), 'WORLD_TURN_ENDED', '请先撤回结束回合，再编辑计划');
  const type = input.type as PlannedIntent['type']; assert(['move', 'action', 'recipe', 'gather', 'proposal', 'narrative'].includes(type), 'WORLD_INTENT', '未知意图类型');
  const payload = structuredClone(object(input.payload || {}, '意图内容'));
  if (type === 'action') actionPayload(payload, manual);
  if (type === 'recipe') id(payload.ruleId);
  if (type === 'gather') { id(payload.nodeId); gatherAmounts(state, payload); }
  if (type === 'narrative') text(payload.text, '行动描述', 4000);
  if (type === 'proposal') {
    assert(world.mode === 'co-create' || member.id === world.ownerId, 'WORLD_PERMISSION', '此模式由主持人负责世界内容');
    const draft = world.drafts.find(draft => draft.id === payload.draftId && draft.ownerId === member.id); assert(draft, 'WORLD_DRAFT_OWNER', '请选择自己的现有草稿');
    assert(!world.round.intents.some(intent => intent.id !== existing?.id && intent.type === 'proposal' && pending(intent) && intent.payload.draftId === draft.id), 'WORLD_DUPLICATE', '此草稿已保留本轮提案费用');
    payload.draft = validateSubmission(state, draft, ctx);
  }
  const originalIntents = world.round.intents;
  if (existing) world.round.intents = originalIntents.slice(0, originalIntents.indexOf(existing));
  let cost: number; try { cost = intentCost(state, actor, type, payload); } finally { world.round.intents = originalIntents; }
  const intent: PlannedIntent = { id: existing?.id || `intent:${uid()}`, actorId: actor.id, memberId: actor.ownerId, type, payload, targetIds: Array.isArray(input.targetIds) ? input.targetIds.map(id) : [], cost, round: world.round.number, status: world.mode === 'co-create' ? 'approved' : 'planned' };
  assert(intent.targetIds.length <= 500 && world.round.intents.length < 2000, 'WORLD_LIMIT', '回合意图或目标数量过多'); reserve(state, intent);
  if (existing) world.round.intents[world.round.intents.indexOf(existing)] = intent; else world.round.intents.push(intent);
}
export function executeIntent(input: GameState, intentId: string, ctx: WorldContext): Resolution {
  assertWorldIdentities(input);
  const state = structuredClone(input), world = requireWorld(state), intent = world.round.intents.find(intent => intent.id === intentId); assert(intent && intent.status === 'approved', 'WORLD_INTENT', '此意图未获批准或已经执行');
  const actor = findActor(state, intent.actorId), spent = micro(world.round.spent[actor.id] || 0);
  const original = world.round.intents; let actual: number;
  try { world.round.intents = original.filter(entry => entry.actorId !== actor.id); actual = intentCost(state, actor, intent.type, intent.payload); } finally { world.round.intents = original; }
  assert(micro(actual) <= micro(intent.cost), 'WORLD_AP_REPRICE', '实际行动费用已超过原保留额度，请在下一轮检查并重新提交；本次未扣费'); intent.cost = actual;
  if (world.rules.energy) assert(spent + micro(intent.cost) <= micro(energyLimits(actor, world).perRound), 'WORLD_ROUND_LIMIT', '本回合支出额度不足');
  spendEnergy(actor, intent.cost); const events: Log = []; let output = state;
  const command: Command = { operationId: intent.id, expectedRev: state.rev, actorId: actor.id, targetIds: intent.targetIds, type: 'action.use', payload: intent.payload };
  if (intent.type === 'move') { command.type = 'actor.move'; const result = executeEngine(state, command, ctx); output = result.state; events.push(...result.events); }
  else if (intent.type === 'action') {
    if (intent.payload.commandType === 'inventory.equip') {
      const item = actor.inventory.find(item => item.id === intent.payload.itemId); assert(item, 'WORLD_ITEM', '角色没有这件物品');
      if (item.contentId.startsWith('world:')) equipWorldItem(state, actor, intent.payload);
      else { command.type = 'inventory.equip'; const result = executeEngine(state, command, ctx); output = result.state; events.push(...result.events); }
    } else { const result = executeEngine(state, command, ctx); output = result.state; events.push(...result.events); }
  } else if (intent.type === 'recipe') performRecipe(state, actor, intent.payload, intent.id, events);
  else if (intent.type === 'gather') performGather(state, actor, intent.payload, intent.id, events);
  else if (intent.type === 'proposal') openProposal(state, intent.payload.draft as WorldDraft, command, ctx, events);
  else note(events, 'world-narrative', `${actor.name}：${String(intent.payload.text)}`, actor.id);
  const current = requireWorld(output), completed = current.round.intents.find(entry => entry.id === intent.id)!; completed.status = 'executed'; completed.result = '已执行'; current.round.spent[actor.id] = decimal(spent + micro(intent.cost)); reconcileWorldBonuses(output);
  return { state: output, events };
}
function fail(state: GameState, intentId: string, reason: unknown, log: Log): void { const intent = requireWorld(state).round.intents.find(intent => intent.id === intentId)!; intent.status = 'failed'; intent.result = reason instanceof Error ? reason.message : String(reason); note(log, 'world-intent-failed', `意图未执行，未扣行动力：${intent.result}`, intent.actorId); }
function conflictOrder(state: GameState, wave: PlannedIntent[], ctx: WorldContext, log: Log): PlannedIntent[] {
  const world = requireWorld(state), claims = new Map<string, { total: number; available: number; ids: string[] }>();
  for (const intent of wave) try { for (const claim of resourceClaims(state, intent)) { const previous = claims.get(claim.key); claims.set(claim.key, { total: (previous?.total || 0) + claim.quantity, available: claim.available, ids: [...(previous?.ids || []), intent.id] }); } } catch (error) { fail(state, intent.id, error, log); }
  const contested = new Set([...claims.values()].filter(claim => claim.total > claim.available && claim.ids.length > 1).flatMap(claim => claim.ids));
  if (world.rules.conflict.kind === 'cancel-refund') for (const intentId of contested) fail(state, intentId, '资源竞争：本轮争抢者全部取消并释放保留额度', log);
  const eligible = wave.filter(intent => requireWorld(state).round.intents.find(entry => entry.id === intent.id)?.status === 'approved'), rolls: {expression:string;rolls:number[];total:number}[] = [];
  for (let index = eligible.length - 1; index > 0; index--) { const roll = ctx.dice(index + 1); assert(Number.isInteger(roll) && roll >= 1 && roll <= index + 1, 'WORLD_DICE', '随机顺序超出骰面'); rolls.push({ expression: `1d${index + 1}`, rolls: [roll], total: roll }); [eligible[index], eligible[roll - 1]] = [eligible[roll - 1], eligible[index]]; }
  const chosen = eligible.filter(intent => contested.has(intent.id));
  if (world.rules.conflict.kind === 'attribute') {
    const key = world.rules.conflict.attribute!, score = (intent: PlannedIntent) => { const actor = findActor(state, intent.actorId); return key === 'level' ? Math.max(1, ...Object.values(actor.growth?.tracks || {}).map(track => track.level)) : key in actor.abilities ? actor.abilities[key as keyof Actor['abilities']] : Number(actor.choices?.[key] ?? 0); };
    chosen.sort((a, b) => finite(score(b), '冲突属性', true) - finite(score(a), '冲突属性', true));
  }
  const untouched = eligible.filter(intent => !contested.has(intent.id)), order = [...untouched, ...chosen];
  if (order.length > 1) log.push({ type: 'world-action-order', message: `同批次行动顺序：${order.map(intent => findActor(state, intent.actorId).name).join(' → ')}；同属性竞争按已记录随机结果打破平手`, rolls });
  return order;
}
export function settleRound(input: GameState, member: Member, ctx: WorldContext): Resolution {
  assertWorldIdentities(input);
  let state = structuredClone(input); const world = requireWorld(state); requireCapability(world, member, 'manage.rounds');
  assert(world.phase === 'running' && ['planning', 'settling'].includes(world.round.phase), 'WORLD_PHASE', '此回合已经结算');
  assert(!state.choices.length, 'WORLD_REACTION', '请先完成待决规则反应，再继续统一结算');
  if (world.round.phase === 'planning') assert(world.round.participants.every(memberId => !ctx.onlineMemberIds.includes(memberId) || world.round.ended.includes(memberId)), 'WORLD_TURN_OPEN', '仍有在线参与者尚未确认结束回合');
  if (world.mode !== 'co-create') assert(!world.round.intents.some(intent => intent.status === 'planned' && world.round.ended.includes(intent.memberId)), 'WORLD_REVIEW', '仍有已确认的意图等待真人主持人或AI审批');
  world.round.phase = 'settling'; const events: Log = [], eligible = new Set(world.round.ended);
  for (const intent of world.round.intents) if (pending(intent) && !eligible.has(intent.memberId)) { intent.status = 'planned'; intent.result = '离线且未确认结束，本轮保留为未扣费草稿'; }
  while (true) {
    const current = requireWorld(state), first = new Map<string, PlannedIntent>();
    for (const intent of current.round.intents) if (intent.status === 'approved' && eligible.has(intent.memberId) && !first.has(intent.actorId)) first.set(intent.actorId, intent);
    if (!first.size) break;
    const wave = conflictOrder(state, [...first.values()], ctx, events);
    for (const intent of wave) {
      try { const result = executeIntent(state, intent.id, ctx); state = result.state; events.push(...result.events); }
      catch (error) { fail(state, intent.id, error, events); }
      if (state.choices.length) { note(events, 'world-round-paused', '统一结算等待规则选择；处理后继续结算，不会再次扣费'); return { state, events }; }
    }
  }
  const npc = runNpcPolicies(state, ctx, { cost: intentCost, execute: executeIntent }); state = npc.state; events.push(...npc.events);
  if (state.choices.length) { note(events, 'world-round-paused', 'NPC行动等待规则选择，处理后继续结算'); return { state, events }; }
  requireWorld(state).round.phase = 'intermission'; note(events, 'world-round-settled', `第${requireWorld(state).round.number}回合已结算`); return { state, events };
}
export function applyApprovedProposals(input: GameState, round: number, ctx: WorldContext): Resolution {
  let state = input; const events: Log = [];
  for (const proposalId of requireWorld(state).proposals.filter(proposal => proposal.status === 'approved' && (proposal.effectiveRound || Infinity) <= round).map(proposal => proposal.id)) {
    const previousState = state, eventCount = events.length, candidate = structuredClone(state), world = requireWorld(candidate), proposal = world.proposals.find(proposal => proposal.id === proposalId)!;
    try {
      const payload = draftPayload(proposal.kind, proposal.payload);
      if (proposal.kind === 'scene' || proposal.kind === 'actor') {
        const actor = proposal.kind === 'actor' ? object(payload.actor) : undefined;
        let npc: Record<string, any> | undefined;
        if (actor) {
          npc = npcPayload(actor, world.ownerId, `npc:${proposal.id}`);
        }
        const command: Command = { operationId: `adopt:${proposal.id}`, expectedRev: state.rev, type: proposal.kind === 'scene' ? 'scene.update' : 'actor.create', payload: npc || payload };
        const result = executeEngine(candidate, command, ctx); state = result.state; events.push(...result.events);
        if (actor) bindProposedBehavior(state, candidate, payload);
        if (actor) { const previous = new Set(candidate.actors.map(actor => actor.id)); for (const created of state.actors.filter(actor => !previous.has(actor.id))) { reconcileEnergy(created, requireWorld(state), true); requireWorld(state).energyAt[created.id] = ctx.now; } }
      } else { configureWorld(candidate, proposal.kind === 'story' ? { lore: [world.lore, payload.text].filter(Boolean).join('\n\n') } : payload, ctx); state = candidate; }
      const adopted = requireWorld(state).proposals.find(proposal => proposal.id === proposalId)!; adopted.status = 'applied'; adopted.result = `已于第${round}回合生效`; note(events, 'proposal-applied', `提案「${adopted.title}」已在新回合生效`);
    } catch (error) { state = previousState; events.length = eventCount; const failed = requireWorld(state).proposals.find(proposal => proposal.id === proposalId)!; failed.status = 'conflict'; failed.result = error instanceof Error ? error.message : String(error); note(events, 'proposal-conflict', `提案「${failed.title}」因世界变化未能采用：${failed.result}`); }
  }
  return { state, events };
}
export function startRound(input: GameState, ctx: WorldContext, first = false): Resolution {
  const world = requireWorld(input); assert(world.round.phase === 'intermission', 'WORLD_PHASE', '请先完成当前回合结算'); assert(!input.choices.length, 'WORLD_REACTION', '请先完成待决规则选择');
  const number = world.round.number + 1, applied = applyApprovedProposals(input, number, ctx), state = applied.state, current = requireWorld(state), events = applied.events;
  finishJobs(state, number, events); if (!first) recoverRound(state, ctx.onlineMemberIds);
  const carry = current.round.intents.filter(intent => intent.status === 'planned' && !current.round.ended.includes(intent.memberId));
  current.round = { number, phase: 'planning', participants: registeredMembers(state, ctx), ended: [], spent: {}, intents: carry.map(intent => ({ ...intent, round: number, result: '离线保留草稿，请检查后确认本轮', status: 'planned' })) };
  note(events, 'world-round-started', `第${number}回合开始，参与者名单已固定`); return { state, events };
}
