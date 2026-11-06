import type { Ability, Actor, Command, Dice, GameState, ItemInstance, Member, Position, Resolution, Scene } from './model';

export type WorldMode = 'gm' | 'ai' | 'co-create';
export type DisclosureGroup = 'story' | 'stats' | 'skills' | 'equipment';
export type TimeoutVote = 'approve' | 'reject' | 'abstain';
export type Capability = 'review.map' | 'review.rules' | 'review.creatures' | 'review.story' | 'manage.characters' | 'manage.members' | 'manage.knowledge' | 'manage.rounds';
export interface Governance { system: 'democracy' | 'dictatorship'; ownerVeto: boolean; delegations: Record<string, Capability[]> }
export type GrowthTarget = Ability | 'hp' | 'mp' | 'stamina' | 'ap.maximum' | 'ap.recovery' | 'ap.perRound';
export interface GrowthTrackRule {
  id: string; name: string; curve: number[]; pointsPerLevel: number;
  upgrades: { target: GrowthTarget; cost: number; amount: number; max?: number }[];
}
export interface ActorGrowth {
  tracks: Record<string, { level: number; xp: number; totalXp: number; points: number }>;
  bonuses: Partial<Record<GrowthTarget, number>>;
}
export interface EnergyRule { maximum: number; perRound: number; recoveryMode: 'hour' | 'round'; recovery: number; initial?: number }
export interface ItemAmount { itemId: string; quantity: number }
export interface WorldActionRule {
  id: string; name: string; description: string; cost: number;
  resourceCosts?: { resourceId: string; amount: number }[];
  inputs: ItemAmount[]; outputs: ItemAmount[]; experience: { trackId: string; amount: number }[];
  durationRounds?: number; unlockEntries?: string[];
}
export interface WorldItem { id: string; name: string; description: string; bonuses?: Partial<Record<GrowthTarget, number>> }
export interface WorldNode { id: string; name: string; position: Position; inventory: ItemAmount[]; hidden?: boolean }
export interface NpcBehavior { actorId: string; kind: 'idle' | 'patrol' | 'hostile' | 'trade' | 'event'; waypoints?: Position[]; targetKinds?: Actor['kind'][]; actionId?: string; ruleId?: string; trigger?: string }
export interface WorldRules {
  energy?: EnergyRule;
  costs: { move?: number; action?: number; narrative?: number; proposal?: number };
  proposalHours?: number;
  conflict: { kind: 'random' | 'cancel-refund' | 'attribute'; attribute?: Ability | 'level' | string };
  growth: { kind: 'global' | 'tracks'; tracks: GrowthTrackRule[] };
  recipes: WorldActionRule[];
}
export interface WorldDraft { id: string; ownerId: string; kind: 'scene' | 'rules' | 'actor' | 'story' | 'items' | 'nodes'; title: string; payload: Record<string, unknown>; updatedAt: number }
export interface PlannedIntent {
  id: string; actorId: string; memberId: string; type: 'move' | 'action' | 'recipe' | 'gather' | 'proposal' | 'narrative';
  payload: Record<string, unknown>; targetIds: string[]; cost: number; round: number;
  status: 'planned' | 'approved' | 'rejected' | 'executed' | 'failed'; result?: string;
}
export interface WorldProposal {
  id: string; draftId: string; authorId: string; title: string; kind: WorldDraft['kind']; payload: Record<string, unknown>;
  electorate: string[]; ballots: Record<string, { vote: TimeoutVote; source: 'manual' | 'timeout' }>;
  opensAt: number; closesAt: number; status: 'open' | 'owner-review' | 'approved' | 'rejected' | 'applied' | 'conflict';
  ownerDecision?: boolean; result?: string; effectiveRound?: number;
}
export interface WorldRound {
  number: number; phase: 'planning' | 'intermission' | 'settling'; participants: string[]; ended: string[];
  spent: Record<string, number>; intents: PlannedIntent[];
}
export interface AiExchange {
  id: string; worldRevision: number; round: number; kind: 'initialize' | 'player_selection' | 'turn_context' | 'roll_results';
  payload: Record<string, unknown>; createdAt: number; appliedDecisionIds: string[];
  rolls?: { id: string; expression: string; rolls: number[]; total: number }[];
}
export interface WorldState {
  version: 1; ownerId: string; mode: WorldMode; governance: Governance; phase: 'setup' | 'running'; gameplayRev: number;
  lore: string; secretLore: string; rules: WorldRules; round: WorldRound;
  drafts: WorldDraft[]; proposals: WorldProposal[]; timeoutVotes: Record<string, TimeoutVote>;
  items: WorldItem[]; nodes: WorldNode[]; npcBehaviors: NpcBehavior[];
  energyAt: Record<string, number>; jobs: { id: string; actorId: string; ruleId: string; completesRound: number }[];
  ai: { diceSource: 'program' | 'ai'; exchanges: AiExchange[]; narratives: { id: string; text: string; actorIds?: string[] }[]; display?: import('./ai-display').AiDisplayState };
}
export interface WorldContext {
  now: number; onlineMemberIds: string[]; members: Member[]; dice: Dice;
  resolveEngine: (state: GameState, command: Command, dice: Dice) => Resolution;
}
export interface TokenView {
  id: string; name: string; kind: Actor['kind']; ownerId: string; position: Position; size: number;
  hidden: boolean; portrait?: string; dead?: boolean; hp?: Actor['hp']; conditions: string[];
}
export interface PublicCharacterProfile { id: string; name: string; portrait?: string; ownerId: string; groups: DisclosureGroup[]; story?: string; stats?: { abilities: Actor['abilities']; hp: Actor['hp']; resources: Actor['resources']; ac: number; speed: number }; skills?: { actions: Actor['customActions']; skills: string[]; spells: string[] }; equipment?: ItemInstance[] }
export interface CharacterOffer { id: string; name: string; portrait?: string; story: string; requestedBy?: string; registration?: Actor['registration'] }
export interface WorldView {
  version: 1; ownerId: string; mode: WorldMode; governance: Governance; phase: WorldState['phase']; gameplayRev: number;
  lore: string; secretLore?: string; rules: WorldRules; round: WorldRound;
  drafts: WorldDraft[]; proposals: WorldProposal[]; timeoutVotes: Record<string, TimeoutVote>;
  items: WorldItem[]; nodes: WorldNode[]; npcBehaviors?: NpcBehavior[]; energyAt: Record<string, number>;
  ai: { diceSource: 'program' | 'ai'; narratives: WorldState['ai']['narratives']; exchanges?: AiExchange[]; display?: import('./ai-display').AiDisplayView };
  capabilities: Capability[];
}

export const CAPABILITIES: Capability[] = ['review.map', 'review.rules', 'review.creatures', 'review.story', 'manage.characters', 'manage.members', 'manage.knowledge', 'manage.rounds'];
export const DEFAULT_RULES: WorldRules = { costs: {}, conflict: { kind: 'random' }, growth: { kind: 'global', tracks: [] }, recipes: [] };
export function newWorld(ownerId: string, mode: WorldMode, governance: Partial<Governance> = {}): WorldState {
  return {
    version: 1, ownerId, mode, governance: { system: governance.system || 'democracy', ownerVeto: Boolean(governance.ownerVeto), delegations: {} }, phase: 'setup', gameplayRev: 0,
    lore: '', secretLore: '', rules: structuredClone(DEFAULT_RULES), round: { number: 0, phase: 'intermission', participants: [], ended: [], spent: {}, intents: [] },
    drafts: [], proposals: [], timeoutVotes: {}, items: [], nodes: [], npcBehaviors: [], energyAt: {}, jobs: [],
    ai: { diceSource: 'program', exchanges: [], narratives: [] },
  };
}
