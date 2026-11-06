import type { Snapshot } from '../shared/model';

/** A UI preview over authoritative resource and derived limit fields. */
export function remainingActionPoints(snapshot: Snapshot, actorId?: string): number {
  const world = snapshot.world, actor = snapshot.state.actors.find(actor => actor.id === actorId);
  if (!world || !actor) return 0;
  if (!world.rules.energy && world.mode !== 'co-create') return Infinity;
  const pool = actor.resources.find(resource => resource.id === 'ap')?.current || 0;
  const perRound = snapshot.actorViews?.[actor.id]?.energyLimits?.perRound ?? world.rules.energy?.perRound ?? 0;
  const reserved = world.round.intents.filter(intent => intent.actorId === actor.id && ['planned', 'approved'].includes(intent.status)).reduce((sum, intent) => sum + intent.cost, 0);
  return Math.max(0, Math.round((Math.min(pool, perRound - (world.round.spent[actor.id] || 0)) - reserved) * 1e6) / 1e6);
}
