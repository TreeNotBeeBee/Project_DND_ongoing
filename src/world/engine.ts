import type { Command, GameState, Resolution } from '../shared/model';
import type { WorldContext } from '../shared/world';

/** Unclaimed character offers do not occupy the world or become attack targets. */
export function executeEngine(state: GameState, command: Command, ctx: WorldContext): Resolution {
  const excluded = state.actors.filter(actor => actor.kind === 'hero' && actor.registration !== undefined && actor.registration !== 'registered');
  const working = structuredClone(state); working.actors = working.actors.filter(actor => !excluded.some(offer => offer.id === actor.id));
  const result = ctx.resolveEngine(working, command, ctx.dice);
  const actors = new Map(result.state.actors.map(actor => [actor.id, actor])), hidden = new Map(excluded.map(actor => [actor.id, actor]));
  const previousIds = new Set(state.actors.map(actor => actor.id));
  result.state.actors = [...state.actors.flatMap(actor => actors.has(actor.id) ? [actors.get(actor.id)!] : hidden.has(actor.id) ? [hidden.get(actor.id)!] : []), ...result.state.actors.filter(actor => !previousIds.has(actor.id))];
  return result;
}
