import { ABILITIES, type Actor, type GameState } from '../shared/model';
import type { GrowthTarget, GrowthTrackRule, WorldRules, WorldState } from '../shared/world';
import { assert } from '../engine/dice';
import { decimal, finite, micro, natural } from './fixed';
import { reconcileEnergy, worldItemBonuses } from './energy';

export function threshold(rule: GrowthTrackRule, level: number): number { return rule.curve[Math.min(Math.max(0, level - 1), rule.curve.length - 1)]; }
export function grantExperience(actor: Actor, rules: WorldRules, awards: { trackId: string; amount: number }[]): void {
  actor.growth ||= { tracks: {}, bonuses: {} };
  for (const award of awards) {
    const amount = natural(award.amount, '经验', 1_000_000_000), rule = rules.growth.kind === 'global' ? rules.growth.tracks[0] : rules.growth.tracks.find(track => track.id === award.trackId);
    assert(rule, 'WORLD_TRACK', '成长轨道不存在');
    const progress = actor.growth.tracks[rule.id] ||= { level: 1, xp: 0, totalXp: 0, points: 0 };
    progress.xp = natural(progress.xp + amount, '本级经验');
    progress.totalXp = natural(progress.totalXp + amount, '总经验');
    while (progress.level < rule.curve.length && progress.xp >= threshold(rule, progress.level)) {
      progress.xp -= threshold(rule, progress.level); progress.level++; progress.points = natural(progress.points + rule.pointsPerLevel, '成长点');
    }
    const remaining = Math.floor(progress.xp / threshold(rule, progress.level));
    if (remaining) { progress.xp -= remaining * threshold(rule, progress.level); progress.level = natural(progress.level + remaining, '成长等级'); progress.points = natural(progress.points + remaining * rule.pointsPerLevel, '成长点'); }
  }
}
/** A curve edit preserves level, total XP and every historically earned/spent point. */
export function migrateGrowth(actor: Actor, before: WorldRules, after: WorldRules): void {
  for (const [id, progress] of Object.entries(actor.growth?.tracks || {})) {
    const oldRule = before.growth.tracks.find(track => track.id === id), newRule = after.growth.tracks.find(track => track.id === id);
    if (!oldRule || !newRule) continue;
    const previous = threshold(oldRule, progress.level), next = threshold(newRule, progress.level);
    progress.xp = Number(BigInt(progress.xp) * BigInt(next) / BigInt(previous));
  }
}
export function reconcileWorldBonuses(state: GameState): void {
  const world = state.world;
  if (!world) return;
  for (const actor of state.actors) {
    const equipment = worldItemBonuses(actor, world), next: Partial<Record<GrowthTarget, number>> = {};
    for (const key of [...ABILITIES, 'hp', 'mp', 'stamina'] as GrowthTarget[]) next[key] = finite((actor.growth?.bonuses[key] || 0) + (equipment[key] || 0), key, true);
    actor.choices ||= {};
    const previous = (actor.choices._worldAppliedBonuses || {}) as Partial<Record<GrowthTarget, number>>;
    if (actor.profile === 'free') {
      for (const ability of ABILITIES) {
        actor.abilities[ability] = finite(actor.abilities[ability] + (next[ability] || 0) - (previous[ability] || 0), ability, true);
      }
      const oldMaximum = actor.hp.max, delta = (next.hp || 0) - (previous.hp || 0);
      const maximum = finite(oldMaximum + delta, '最大生命');
      assert(maximum > 0, 'WORLD_GROWTH', '装备和成长不能将最大生命降至0');
      if (actor.manual) actor.manual.maxHp = finite(actor.manual.maxHp + delta, '基础最大生命');
      actor.hp.max = maximum; actor.hp.current = Math.min(actor.hp.current, maximum);
      for (const id of ['mp', 'stamina'] as const) {
        const delta = (next[id] || 0) - (previous[id] || 0);
        let resource = actor.resources.find(resource => resource.id === id);
        if (!resource && delta > 0) { resource = { id, name: id === 'mp' ? '法力' : '体力', max: 0, current: 0, recovery: 'manual' }; actor.resources.push(resource); }
        if (resource) { resource.max = finite(resource.max + delta, '资源上限'); resource.current = Math.min(resource.current, resource.max); }
      }
      actor.choices._worldAppliedBonuses = next;
    }
    if (world.phase === 'running') reconcileEnergy(actor, world);
  }
}
export function spendGrowth(actor: Actor, rules: WorldRules, trackId: string, target: GrowthTarget, points: number, world?: WorldState): void {
  assert(actor.profile === 'free', 'WORLD_GROWTH', '此成长系统仅适用于自由规则角色');
  const rule = rules.growth.tracks.find(track => track.id === trackId), upgrade = rule?.upgrades.find(upgrade => upgrade.target === target), progress = actor.growth?.tracks[trackId];
  assert(rule && upgrade && progress, 'WORLD_TRACK', '成长轨道或加点规则不存在');
  natural(points, '消费点数');
  assert(points > 0 && points % upgrade.cost === 0 && points <= progress.points, 'WORLD_POINTS', '点数不足，或消费点数不是规则成本的整数倍');
  let value: number;
  if (target.startsWith('ap.')) {
    const current = micro(actor.growth!.bonuses[target] || 0, target, true), increase = BigInt(micro(upgrade.amount)) * BigInt(points / upgrade.cost);
    assert(increase <= BigInt(Number.MAX_SAFE_INTEGER), 'WORLD_GROWTH', '成长数值超出安全范围'); value = decimal(current + Number(increase));
  } else value = finite((actor.growth!.bonuses[target] || 0) + upgrade.amount * (points / upgrade.cost), target, true);
  const previous = (actor.choices?._worldAppliedBonuses || {}) as Partial<Record<GrowthTarget, number>>;
  const increase = value - (actor.growth!.bonuses[target] || 0);
  const existingBonus = actor.growth!.bonuses[target] || 0;
  const base = ABILITIES.includes(target as any) ? actor.abilities[target as keyof Actor['abilities']] - (previous[target] || 0) + existingBonus : target === 'hp' ? (actor.manual?.maxHp ?? actor.hp.max) - (previous.hp || 0) + existingBonus : target === 'mp' || target === 'stamina' ? (actor.resources.find(resource => resource.id === target)?.max || 0) - (previous[target] || 0) + existingBonus : (target === 'ap.maximum' ? rules.energy?.maximum : target === 'ap.recovery' ? rules.energy?.recovery : rules.energy?.perRound) ?? 0;
  const finalValue = target.startsWith('ap.') ? base + value : base + increase;
  assert(upgrade.max === undefined || finalValue <= upgrade.max, 'WORLD_GROWTH_CAP', '成长后的基础最终值将超过规则上限（装备临时加成不占成长上限）');
  if (target === 'ap.maximum') assert(finalValue <= 100, 'WORLD_GROWTH_CAP', '成长后的基础行动力上限不能超过100');
  actor.growth!.bonuses[target] = value; progress.points -= points;
}
