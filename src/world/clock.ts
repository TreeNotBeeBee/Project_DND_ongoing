import type { GameState, Resolution } from '../shared/model';
import type { WorldContext } from '../shared/world';
import { assert } from '../engine/dice';
import { recoverHourly } from './energy';
import { closeDueProposals } from './governance';

export function advanceWorldTime(input: GameState, ctx: WorldContext): Resolution {
  assert(Number.isSafeInteger(ctx.now) && ctx.now >= 0, 'WORLD_TIME', '服务器时间无效');
  const state = structuredClone(input), events: Resolution['events'] = [];
  recoverHourly(state, ctx.now);
  if (state.world) closeDueProposals(state.world, ctx.now, events);
  return { state, events };
}
