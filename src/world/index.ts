import type { Command, GameState, Member, Resolution } from '../shared/model';
import type { GrowthTarget, WorldContext } from '../shared/world';
import { assert } from '../engine/dice';
import { advanceWorldTime } from './clock';
import { isActiveActor, reconcileEnergy } from './energy';
import { reconcileWorldBonuses, spendGrowth } from './growth';
import { handleGovernance, hasCapability, note, requireCapability, requireOwner, requireWorld } from './governance';
import { equipWorldItem } from './inventory';
import { executeEngine } from './engine';
import { configureWorld, executeIntent, saveIntent, settleRound, startRound } from './rounds';
import { id, object } from './validation';

export { advanceWorldTime } from './clock';
export { reconcileWorldBonuses } from './growth';
export { energyLimits, isActiveActor, reconcileEnergy } from './energy';
const commands = new Set(['world.configure', 'world.start', 'draft.save', 'draft.delete', 'intent.save', 'intent.delete', 'turn.end', 'turn.withdraw', 'round.settle', 'round.start', 'proposal.submit', 'vote.cast', 'vote.preference', 'proposal.decide', 'governance.grant', 'growth.spend', 'intent.review', 'inventory.equip']);
export const isWorldCommand = (type: string): boolean => commands.has(type);

/** Pure command reducer. Persistence, operation receipts, revisions and trusted context belong to the server. */
export function resolveWorldCommand(input: GameState, command: Command, member: Member, ctx: WorldContext): Resolution {
  assert(isWorldCommand(command.type), 'WORLD_COMMAND', '未知世界命令');
  assert(ctx.members.some(entry => entry.id === member.id), 'WORLD_MEMBER', '操作者不属于此房间');
  const advanced = advanceWorldTime(input, ctx); let state = advanced.state; const events = advanced.events, world = requireWorld(state), p = object(command.payload || {});
  if (handleGovernance(state, command, member, ctx, events)) return { state, events };
  switch (command.type) {
    case 'world.configure':
      requireOwner(world, member);
      assert(world.phase === 'setup' || world.mode === 'gm' || world.mode === 'co-create' && world.governance.system === 'dictatorship', 'WORLD_PROPOSAL_REQUIRED', '世界开始后，AI模式须通过决策包、民主共创须通过提案修改内容');
      configureWorld(state, p, ctx); note(events, 'world-configured', '房主已配置世界规则与内容'); break;
    case 'world.start': {
      requireOwner(world, member); assert(world.phase === 'setup', 'WORLD_PHASE', '世界已经开始，不能重复初始化行动力'); assert(!state.combat.active, 'WORLD_COMBAT', '请先结束传统战斗再开始统一世界回合');
      if (world.mode === 'co-create') assert(world.rules.energy, 'WORLD_RULES_REQUIRED', '请先配置共创行动力规则');
      world.phase = 'running'; for (const actor of state.actors.filter(isActiveActor)) { reconcileEnergy(actor, world, true); world.energyAt[actor.id] = ctx.now; }
      const result = startRound(state, ctx, true); state = result.state; events.push(...result.events); break;
    }
    case 'intent.save': saveIntent(state, command, member, ctx); note(events, 'world-intent-saved', '意图已保存并保留行动力，尚未扣费'); break;
    case 'proposal.submit': {
      const actorId = command.actorId || p.actorId || state.actors.find(actor => actor.ownerId === member.id && actor.kind === 'hero' && actor.registration === 'registered')?.id;
      saveIntent(state, command, member, ctx, { actorId, type: 'proposal', payload: { draftId: id(p.draftId) }, targetIds: [] }); note(events, 'proposal-reserved', '提案意图已保留本轮费用；结算成功后才扣费开票'); break;
    }
    case 'intent.delete': {
      assert(world.round.phase === 'planning', 'WORLD_PHASE', '结算阶段不能删除意图'); const intent = world.round.intents.find(intent => intent.id === p.id);
      assert(intent && intent.memberId === member.id && ['planned', 'approved'].includes(intent.status), 'WORLD_INTENT_OWNER', '只能删除自己的待结算意图'); assert(!world.round.ended.includes(member.id), 'WORLD_TURN_ENDED', '请先撤回结束回合');
      world.round.intents = world.round.intents.filter(entry => entry !== intent); note(events, 'world-intent-deleted', '意图已删除，保留额度已释放'); break;
    }
    case 'turn.end': {
      assert(world.phase === 'running' && world.round.phase === 'planning' && world.round.participants.includes(member.id), 'WORLD_PARTICIPANT', '你不在当前规划回合的参与名单中'); assert(!world.round.ended.includes(member.id), 'WORLD_TURN_ENDED', '你已确认结束本回合');
      world.round.ended.push(member.id); if (world.mode === 'co-create') for (const intent of world.round.intents.filter(intent => intent.memberId === member.id && intent.status === 'planned')) intent.status = 'approved';
      note(events, 'world-turn-ended', `${member.name}已确认结束本回合`); break;
    }
    case 'turn.withdraw':
      assert(world.round.phase === 'planning' && world.round.ended.includes(member.id), 'WORLD_PHASE', '此时不能撤回结束确认'); world.round.ended = world.round.ended.filter(memberId => memberId !== member.id); note(events, 'world-turn-withdrawn', `${member.name}撤回结束确认，可继续编辑意图`); break;
    case 'round.settle': { const result = settleRound(state, member, ctx); state = result.state; events.push(...result.events); break; }
    case 'round.start': { requireCapability(world, member, 'manage.rounds'); assert(world.phase === 'running', 'WORLD_PHASE', '请先开始世界'); const result = startRound(state, ctx); state = result.state; events.push(...result.events); break; }
    case 'intent.review': {
      requireOwner(world, member); assert(world.mode === 'gm' || world.mode === 'ai', 'WORLD_REVIEW', '共创行动不能通过主持人审批绕过统一结算');
      const intent = world.round.intents.find(intent => intent.id === p.intentId); assert(intent && ['planned', 'approved'].includes(intent.status), 'WORLD_INTENT', '此意图不再等待审批'); assert(typeof p.approve === 'boolean', 'WORLD_REVIEW', '请明确批准或拒绝');
      intent.status = p.approve ? 'approved' : 'rejected'; intent.result = p.approve ? '已批准' : '主持人拒绝，未扣费';
      if (p.approve && world.mode === 'gm') {
        try { const result = executeIntent(state, intent.id, ctx); state = result.state; events.push(...result.events); }
        catch (error) { intent.status = 'failed'; intent.result = error instanceof Error ? error.message : String(error); note(events, 'world-intent-failed', `审批行动未能执行，未扣费：${intent.result}`, intent.actorId); }
      } else note(events, 'world-intent-reviewed', p.approve ? 'AI意图已批准，等待统一结算' : '意图已拒绝，未扣行动力');
      break;
    }
    case 'growth.spend': {
      const actor = state.actors.find(actor => actor.id === (command.actorId || p.actorId)); assert(actor, 'WORLD_ACTOR', '成长角色不存在');
      const delegated = world.governance.system === 'dictatorship' && hasCapability(world, member.id, 'manage.characters');
      assert(actor.ownerId === member.id || member.id === world.ownerId && (world.mode === 'gm' || world.phase === 'setup') || delegated, 'WORLD_PERMISSION', '只能按合法规则为自己加点；民主运行中房主不能直接替他人修改成长');
      spendGrowth(actor, world.rules, id(p.trackId), p.target as GrowthTarget, p.points, world); reconcileWorldBonuses(state); note(events, 'world-growth', `${actor.name}已按已采用规则消费成长点`, actor.id); break;
    }
    case 'inventory.equip': {
      const actor = state.actors.find(actor => actor.id === command.actorId), item = actor?.inventory.find(item => item.id === p.itemId); assert(actor && item, 'WORLD_ITEM', '角色或装备不存在');
      if (!item.contentId.startsWith('world:') && actor.profile !== 'free') { const result = executeEngine(state, command, ctx); state = result.state; events.push(...result.events); break; }
      requireOwner(world, member); assert(world.mode !== 'co-create' || world.governance.system === 'dictatorship' || world.phase === 'setup', 'WORLD_PROPOSAL_REQUIRED', '此玩法的装备操作请通过行动意图结算');
      if (item.contentId.startsWith('world:')) equipWorldItem(state, actor, p); else { const result = executeEngine(state, command, ctx); state = result.state; events.push(...result.events); }
      note(events, 'world-equipment', '房主管理操作已更新装备', actor.id); break;
    }
  }
  return { state, events };
}
