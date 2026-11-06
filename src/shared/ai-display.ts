import type { Dice, Member } from './model';

export type DisplayJson = null | boolean | number | string | DisplayJson[] | { [key: string]: DisplayJson };
export type AiFreedom = 'A' | 'B' | 'C';
export type AiFieldSource = 'module' | 'ai' | 'unknown';
export type AiVisibility = 'public' | 'private' | 'gm';
export interface AiAudience { visibility: AiVisibility; /** Stable PC IDs, resolved through trusted member bindings. */ audience?: string[] }
export interface AiDisplayField extends Partial<AiAudience> { value: DisplayJson; source: AiFieldSource; pending?: boolean }
export interface AiDisplayEntity extends AiAudience {
  id: string; kind: 'pc' | 'npc' | 'enemy' | 'item' | 'landmark'; name: string; source: AiFieldSource;
  fields: Record<string, AiDisplayField>;
  /** Normalized map coordinates. Values are preserved; no movement/range calculation is performed. */
  position?: { x: number; y: number }; image?: string;
}
export interface AiDisplayNarrative extends AiAudience { id: string; text: string; source: AiFieldSource; actorIds?: string[] }
export interface AiMapView extends AiAudience { width: number; height: number; image?: string }
export interface AiModuleInitialization {
  freedom: AiFreedom;
  rules: { edition: '5e2014' | '5e2024'; moduleId?: string; title?: string; fields: Record<string, AiDisplayField> };
  pcs: AiDisplayEntity[];
  background: { fields: Record<string, AiDisplayField> };
  setting: { fields: Record<string, AiDisplayField>; entities?: AiDisplayEntity[]; map?: AiMapView };
  opening: { fields: Record<string, AiDisplayField>; narratives?: AiDisplayNarrative[] };
}
export interface AiPlayerBehavior { id: string; memberId: string; actorId: string; type: 'action' | 'dialogue' | 'explore' | 'other'; text: string; targetIds: string[]; createdAt: number; untrusted: true }
export interface AiDisplayRoll { id: string; sides: number; count: number; faces: number[]; purpose?: string; requestedBy: string; createdAt: number }
export type AiDisplayExportKind = 'initialize' | 'player_selection' | 'turn_context' | 'roll_results';
export interface AiDisplayExchange { id: string; kind: AiDisplayExportKind; revision: number; createdAt: number }
export interface AiPendingConfirmation { id: string; path: string[]; value: DisplayJson; source: 'ai' }
export interface AiDisplayState {
  version: 2; revision: number; freedom: AiFreedom; initialized: boolean;
  initialization?: AiModuleInitialization;
  entities: AiDisplayEntity[]; narratives: AiDisplayNarrative[]; map?: AiMapView;
  bindings: Record<string, string>; actions: AiPlayerBehavior[]; rolls: AiDisplayRoll[];
  draft?: { raw: string; updatedAt: number };
  pendingConfirmations: AiPendingConfirmation[];
  exchanges: AiDisplayExchange[];
  decisions: Record<string, { canonical: string; exchangeId: string }>;
}
export interface AiDisplayView {
  version: 2; revision: number; freedom: AiFreedom; initialized: boolean; ownPcId?: string;
  initialization?: AiModuleInitialization; entities: AiDisplayEntity[]; narratives: AiDisplayNarrative[]; map?: AiMapView;
  bindings: Record<string, string>; actions: AiPlayerBehavior[]; rolls: AiDisplayRoll[];
  draft?: AiDisplayState['draft']; pendingConfirmations?: AiPendingConfirmation[]; exchanges?: AiDisplayExchange[];
}
export interface AiDisplayContext { member: Member; members: Member[]; now: number; dice?: Dice }
export function newAiDisplay(freedom: AiFreedom = 'B'): AiDisplayState {
  return { version: 2, revision: 0, freedom, initialized: false, entities: [], narratives: [], bindings: {}, actions: [], rolls: [], pendingConfirmations: [], exchanges: [], decisions: {} };
}
