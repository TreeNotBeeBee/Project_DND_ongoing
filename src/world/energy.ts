import type { Actor, GameState, Resource } from '../shared/model';
import type { GrowthTarget, WorldState } from '../shared/world';
import { assert } from '../engine/dice';
import { AP_SCALE, HOUR_MS, decimal, finite, micro } from './fixed';

export function isActiveActor(actor: Actor): boolean {
  return !actor.draft && !actor.dead && (actor.kind !== 'hero' || actor.registration === undefined || actor.registration === 'registered');
}
export function worldItemBonuses(actor: Actor, world: WorldState): Partial<Record<GrowthTarget, number>> {
  const result: Partial<Record<GrowthTarget, number>> = {};
  for (const item of actor.inventory.filter(item => item.equipped && item.quantity > 0)) {
    const definition = world.items.find(entry => item.contentId === `world:${entry.id}`);
    for (const [key, value] of Object.entries(definition?.bonuses || {})) {
      const target = key as GrowthTarget;
      result[target] = target.startsWith('ap.') ? decimal(micro(result[target] || 0, target, true) + micro(value, target, true)) : finite((result[target] || 0) + finite(value, target, true), target, true);
    }
  }
  return result;
}
export function energyLimits(actor: Actor, world: WorldState) {
  const rule = world.rules.energy, equipment = worldItemBonuses(actor, world);
  const bonus = (key: GrowthTarget) => micro(actor.growth?.bonuses[key] || 0, key, true) + micro(equipment[key] || 0, key, true);
  const bounded = (base: number, key: GrowthTarget, cap = Number.MAX_SAFE_INTEGER) => decimal(Math.max(0, Math.min(cap, micro(base, key) + bonus(key))));
  return {
    maximum: rule ? bounded(rule.maximum, 'ap.maximum', 100 * AP_SCALE) : 0,
    recovery: rule ? bounded(rule.recovery, 'ap.recovery') : 0,
    perRound: rule ? bounded(rule.perRound, 'ap.perRound') : 0,
  };
}
export function apResource(actor: Actor): Resource | undefined { return actor.resources.find(resource => resource.id === 'ap'); }
export function reconcileEnergy(actor: Actor, world: WorldState, initial = false): void {
  const { maximum } = energyLimits(actor, world), previous = apResource(actor);
  const current = initial ? Math.min(maximum, world.rules.energy?.initial ?? maximum) : previous ? Math.min(previous.current, maximum) : 0;
  if (previous) Object.assign(previous, { name: '行动力', current, max: maximum, recovery: 'manual' });
  else actor.resources.push({ id: 'ap', name: '行动力', current, max: maximum, recovery: 'manual' });
}
/** Whole-hour accrual keeps sub-hour time in energyAt; offline members are eligible. */
export function recoverHourly(state: GameState, now: number): void {
  const world = state.world;
  if (!world || world.phase !== 'running' || world.rules.energy?.recoveryMode !== 'hour') return;
  assert(Number.isSafeInteger(now) && now >= 0, 'WORLD_TIME', '服务器时间无效');
  for (const actor of state.actors.filter(isActiveActor)) {
    const previous = world.energyAt[actor.id];
    if (previous === undefined) { world.energyAt[actor.id] = now; continue; }
    assert(Number.isSafeInteger(previous) && previous >= 0, 'WORLD_TIME', '行动力恢复时间损坏');
    if (now <= previous) continue;
    const hours = Math.floor((now - previous) / HOUR_MS);
    if (!hours) continue;
    const resource = apResource(actor);
    if (resource) {
      const value = BigInt(micro(resource.current)) + BigInt(hours) * BigInt(micro(energyLimits(actor, world).recovery));
      resource.current = decimal(Number(value > BigInt(micro(resource.max)) ? BigInt(micro(resource.max)) : value));
    }
    world.energyAt[actor.id] = previous + hours * HOUR_MS;
  }
}
export function recoverRound(state: GameState, onlineMemberIds: readonly string[]): void {
  const world = state.world;
  if (!world || world.rules.energy?.recoveryMode !== 'round') return;
  const online = new Set(onlineMemberIds);
  for (const actor of state.actors.filter(actor => isActiveActor(actor) && online.has(actor.ownerId))) {
    const resource = apResource(actor);
    if (resource) resource.current = decimal(Math.min(micro(resource.max), micro(resource.current) + micro(energyLimits(actor, world).recovery)));
  }
}
export function spendEnergy(actor: Actor, cost: number): void {
  const amount = micro(cost), resource = apResource(actor);
  if (!amount) return;
  assert(resource && micro(resource.current) >= amount, 'WORLD_AP', '行动力不足');
  resource.current = decimal(micro(resource.current) - amount);
}
