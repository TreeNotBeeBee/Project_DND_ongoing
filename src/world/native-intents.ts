import type { Actor, Command, GameState } from '../shared/model';
import type { PlannedIntent, WorldContext } from '../shared/world';
import { assert } from '../engine/dice';
import { itemActionAvailable } from '../engine/item-effects';
import { executeEngine } from './engine';
import { id, object } from './validation';

const nativeTypes = new Set(['actor.rest', 'inventory.consume', 'actor.deathSave']);
export function nativeActionCommand(payload: Record<string, any>): Pick<Command, 'type' | 'payload'> | undefined {
  if (!nativeTypes.has(payload.commandType)) return;
  const { commandType, ...rest } = payload; return { type: commandType, payload: rest };
}
/** Strict structure first; authoritative rule/ownership/resource checks still run on the engine clone. */
export function validateNativeActionPayload(payload: Record<string, any>): boolean {
  const command = nativeActionCommand(payload); if (!command) return false;
  const keys = command.type === 'actor.rest' ? ['commandType', 'kind', 'hitDice'] : command.type === 'inventory.consume' ? ['commandType', 'itemId', 'options'] : ['commandType'];
  assert(Object.keys(payload).every(key => keys.includes(key)), 'WORLD_ACTION', '此常规行动含未知字段');
  if (command.type === 'actor.rest') {
    assert(['short', 'long'].includes(payload.kind), 'WORLD_REST', '请选择短休或长休');
    if (payload.hitDice !== undefined) {
      const hitDice = object(payload.hitDice, '生命骰'); assert(Object.keys(hitDice).length <= 20, 'WORLD_REST', '生命骰职业种类过多');
      for (const [classId, count] of Object.entries(hitDice)) { id(classId); assert(Number.isInteger(count) && count >= 0 && count <= 20, 'WORLD_REST', '生命骰数量须为0到20的整数'); }
      assert(payload.kind === 'short' || !Object.keys(hitDice).length, 'WORLD_REST', '长休不能额外消费生命骰');
    }
  } else if (command.type === 'inventory.consume') {
    id(payload.itemId);
    if (payload.options !== undefined) {
      const options = object(payload.options, '物品选项');
      assert(Object.keys(options).every(key => !key.startsWith('_') && !['dice', 'rolls', 'damageTotal', 'skipResources', 'economy'].includes(key)), 'WORLD_ACTION', '物品选项不能注入引擎内部权限或骰子');
    }
  }
  return true;
}
/** A planning forecast uses fixed dice only to verify native payment/eligibility; it never consumes real dice. */
export function forecastNativeAction(state: GameState, intent: PlannedIntent, ctx: WorldContext): Actor | undefined {
  const command = nativeActionCommand(intent.payload); if (!command) return;
  validateNativeActionPayload(intent.payload);
  const actor = state.actors.find(actor => actor.id === intent.actorId); assert(actor, 'WORLD_ACTOR', '角色不存在');
  if (command.type !== 'inventory.consume') assert(!intent.targetIds.length, 'WORLD_ACTION', '休息和死亡豁免没有额外目标');
  if (command.type === 'inventory.consume') assert(itemActionAvailable(actor, String(intent.payload.itemId)), 'WORLD_ITEM', '此角色没有可使用且剩余数量有效的物品');
  if (command.type === 'actor.deathSave') assert(!state.world!.round.intents.some(other => other.id !== intent.id && other.actorId === intent.actorId && other.type === 'action' && other.payload.commandType === 'actor.deathSave' && ['approved', 'planned', 'executed'].includes(other.status)), 'WORLD_DEATH_SAVE', '每名角色每回合只能提交一次死亡豁免');
  const result = executeEngine(state, { ...command, actorId: actor.id, targetIds: intent.targetIds, operationId: `forecast:${intent.id}`, expectedRev: state.rev }, { ...ctx, dice: () => 1 });
  return result.state.actors.find(other => other.id === actor.id);
}
