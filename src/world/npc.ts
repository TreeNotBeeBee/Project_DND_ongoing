import type { Actor, GameState, Position, Resolution } from '../shared/model';
import type { PlannedIntent, WorldContext } from '../shared/world';
import { deriveActor } from '../engine/actors';
import { actorDistance } from '../engine/spatial';
import { pathCost } from '../engine/map';
import { isActiveActor } from './energy';
import { requireWorld, note } from './governance';

interface Runner {
  cost(state: GameState, actor: Actor, type: PlannedIntent['type'], payload: Record<string, any>): number;
  execute(state: GameState, intentId: string, ctx: WorldContext): Resolution;
}
/** Breadth-first legal footprint search. Each round advances one cell rather than teleporting. */
function stepToward(state: GameState, actor: Actor, destination: Position, reach = 0): Position | undefined {
  const key = (position: Position) => `${position.x},${position.y}`, seen = new Set([key(actor.position)]), queue = [{ position: actor.position, first: undefined as Position | undefined }];
  const actors = state.actors.filter(isActiveActor);
  for (let cursor = 0; cursor < queue.length && cursor < 10_000; cursor++) {
    const entry = queue[cursor];
    if (entry.first && Math.max(Math.abs(entry.position.x - destination.x), Math.abs(entry.position.y - destination.y)) <= reach) return entry.first;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue; const next = { x: entry.position.x + dx, y: entry.position.y + dy };
      if (next.x < 0 || next.y < 0 || next.x >= state.scene.width || next.y >= state.scene.height || seen.has(key(next))) continue;
      const shadow = { ...actor, position: entry.position };
      try { pathCost(state.scene, shadow, [next], actors); } catch { continue; }
      seen.add(key(next)); queue.push({ position: next, first: entry.first || next });
    }
  }
  return undefined;
}
function triggerMatches(state: GameState, actor: Actor, trigger = 'round'): boolean {
  if (trigger === 'round') return true;
  if (/^round:\d+$/.test(trigger)) return requireWorld(state).round.number === Number(trigger.slice(6));
  if (trigger === 'nearby') return state.actors.some(target => target.kind === 'hero' && target.registration === 'registered' && isActiveActor(target) && actorDistance(actor, target, state.scene.gridFeet) <= 5);
  if (/^hp-below:(?:\d+(?:\.\d+)?)$/.test(trigger)) return actor.hp.current / actor.hp.max * 100 < Number(trigger.slice(9));
  return false;
}
export function runNpcPolicies(input: GameState, ctx: WorldContext, runner: Runner): Resolution {
  let state = input; const events: Resolution['events'] = [], number = requireWorld(state).round.number;
  for (const behavior of [...requireWorld(state).npcBehaviors]) {
    const actor = state.actors.find(actor => actor.id === behavior.actorId);
    if (!actor || actor.kind === 'hero' || !isActiveActor(actor) || actor.choices?._worldNpcRound === number) continue;
    actor.choices ||= {}; actor.choices._worldNpcRound = number;
    if (behavior.kind === 'idle' || behavior.kind === 'trade') continue;
    let type: PlannedIntent['type'] = 'narrative', payload: Record<string, any> = {}, targetIds: string[] = [];
    if (behavior.kind === 'patrol') {
      if (!behavior.waypoints?.length) continue;
      let index = Number(actor.choices._worldWaypoint || 0) % behavior.waypoints.length;
      if (actor.position.x === behavior.waypoints[index].x && actor.position.y === behavior.waypoints[index].y) index = (index + 1) % behavior.waypoints.length;
      actor.choices._worldWaypoint = index;
      const next = stepToward(state, actor, behavior.waypoints[index]); if (!next) { note(events, 'npc-patrol-blocked', `${actor.name}的巡逻路径暂时不可通行`, actor.id); continue; }
      type = 'move'; payload = { path: [next] };
    } else if (behavior.kind === 'hostile') {
      const target = state.actors.filter(target => target.id !== actor.id && isActiveActor(target) && !target.hidden && (behavior.targetKinds || ['hero']).includes(target.kind) && !(actor.choices?.team && target.choices?.team === actor.choices.team)).sort((a, b) => actorDistance(actor, a, state.scene.gridFeet) - actorDistance(actor, b, state.scene.gridFeet) || a.id.localeCompare(b.id))[0];
      if (!target) continue;
      const action = deriveActor(actor).attacks.find(action => (!behavior.actionId || action.id === behavior.actionId) && action.automation === 'automatic' && (action.damage?.length || action.attack || action.save));
      if (!action) { note(events, 'npc-action-unavailable', `${actor.name}没有已配置且可执行的敌对动作`, actor.id); continue; }
      const range = action.range ?? action.reach ?? 5;
      if (actorDistance(actor, target, state.scene.gridFeet) <= range) { type = 'action'; payload = { actionId: action.id }; targetIds = [target.id]; }
      else { const next = stepToward(state, actor, target.position, Math.max(1, Math.floor(range / state.scene.gridFeet))); if (!next) continue; type = 'move'; payload = { path: [next] }; }
    } else if (behavior.kind === 'event') {
      if (!triggerMatches(state, actor, behavior.trigger)) continue;
      if (behavior.ruleId) { type = 'recipe'; payload = { ruleId: behavior.ruleId }; }
      else if (behavior.actionId) { type = 'action'; payload = { actionId: behavior.actionId }; }
      else { note(events, 'npc-event', `${actor.name}触发世界事件：${behavior.trigger || 'round'}`, actor.id); continue; }
    }
    const world = requireWorld(state), intentId = `npc:${number}:${actor.id}`;
    if (world.round.intents.length >= 2000) { note(events, 'npc-action-unavailable', '本轮意图数量已达上限，NPC没有执行', actor.id); continue; }
    try {
      const cost = runner.cost(state, actor, type, payload);
      world.round.intents.push({ id: intentId, actorId: actor.id, memberId: actor.ownerId, type, payload, targetIds, cost, round: number, status: 'approved' });
      const result = runner.execute(state, intentId, ctx); state = result.state; events.push(...result.events);
    } catch (error) {
      const failed = requireWorld(state).round.intents.find(intent => intent.id === intentId); if (failed) { failed.status = 'failed'; failed.result = error instanceof Error ? error.message : String(error); }
      note(events, 'npc-action-failed', `${actor.name}未能执行，未扣行动力：${error instanceof Error ? error.message : String(error)}`, actor.id);
    }
    if (state.choices.length) break;
  }
  return { state, events };
}
