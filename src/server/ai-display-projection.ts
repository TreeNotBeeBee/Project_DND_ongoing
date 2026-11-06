import type { AiDisplayView } from '../shared/ai-display';
import type { GameState, Member, Session, Snapshot } from '../shared/model';
import type { WorldView } from '../shared/world';
import { CAPABILITIES, DEFAULT_RULES } from '../shared/world';

/** AI display worlds never pass through the mechanical Actor projection/derivation path. */
export function projectAiWorld(raw: GameState, session: Session, members: Member[], display: AiDisplayView): Snapshot {
  const owner = session.member.id === raw.world!.ownerId;
  const world: WorldView = {
    version: 1, ownerId: raw.world!.ownerId, mode: 'ai',
    governance: { system: 'dictatorship', ownerVeto: false, delegations: {} },
    phase: raw.world!.phase, gameplayRev: raw.world!.gameplayRev,
    lore: '', rules: structuredClone(DEFAULT_RULES),
    round: { number: 0, phase: 'intermission', participants: [], ended: [], spent: {}, intents: [] },
    drafts: [], proposals: [], timeoutVotes: {}, items: [], nodes: [], energyAt: {},
    ai: { diceSource: raw.world!.ai.diceSource, narratives: [], display }, capabilities: owner ? [...CAPABILITIES] : [],
  };
  const state: GameState = {
    id: raw.id, name: raw.name, rev: raw.rev, actors: [], choices: [], paused: raw.paused,
    scene: { width: 30, height: 20, gridFeet: 5, walls: [], terrain: [], fog: false },
    combat: { active: false, round: 0, turn: 0, order: [], budgets: {} },
    events: owner ? structuredClone(raw.events) : [],
  };
  return { session, state, members, world, tokens: [], offers: [], profiles: [], actorViews: {} };
}
