export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = typeof ABILITIES[number];
export const DAMAGE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'] as const;
export type DamageType = typeof DAMAGE_TYPES[number];
export type Dice = (sides: number) => number;
export type Recovery = 'short' | 'long' | 'turn' | 'manual';
export interface Resource { id: string; name: string; current: number; max: number; recovery: Recovery }
export interface ClassLevel { classId: string; level: number; subclassId?: string }
export interface ItemInstance { id: string; contentId: string; name: string; quantity: number; equipped: boolean; attuned?: boolean; notes?: string; baseContentId?: string; componentFor?: string; charges?: { current: number; max: number; recharge?: 'dawn' | 'short' | 'long' | 'manual'; rechargeFormula?: string }; storedSpells?: { spellId: string; rank: number; saveDC: number; attackBonus: number; casterAbility: Ability; casterModifier: number }[] }
export interface Effect { id: string; name: string; condition?: string; sourceActorId?: string; sourceId?: string; concentration?: boolean; duration?: number; timing?: 'start' | 'end'; modifiers?: Record<string, number>; resistance?: DamageType[]; immunity?: DamageType[]; vulnerability?: DamageType[]; notes?: string; gmOnly?: boolean; expiresOn?: { actorId: string; timing: 'start' | 'end'; round: number }; saveAdvantages?: { abilities?: Ability[]; conditions?: string[]; spellsOnly?: boolean }; conditionImmunities?: string[] }
export interface Position { x: number; y: number }
export interface Actor {
  profile?: 'srd2024' | 'free';
  manual?: { maxHp: number; proficiency: number; ac: number; speed: number };
  customActions?: ActionDefinition[];
  registration?: 'available' | 'requested' | 'registered' | 'archived'; requestedBy?: string;
  publicGroups?: import('./world').DisclosureGroup[]; knownEntries?: string[]; growth?: import('./world').ActorGrowth;
  id: string; name: string; kind: 'hero' | 'companion' | 'monster'; ownerId: string;
  abilities: Record<Ability, number>; classes: ClassLevel[]; speciesId: string; backgroundId: string;
  hp: { current: number; max: number; temp: number }; deathSaves: { successes: number; failures: number }; dead?: boolean;
  skills: string[]; expertise: string[]; saveProficiencies: Ability[]; languages: string[];
  resources: Resource[]; inventory: ItemInstance[]; spells: string[]; features: string[]; effects: Effect[];
  position: Position; hidden: boolean; portrait?: string; story?: string; notes: string; concentration?: string;
  acOverride?: number; speedOverride?: number; initiative?: number; size?: number;
  draft?: boolean; migrationId?: string; migrationIssues?: string[]; choices?: Record<string, unknown>;
  monsterActions?: ActionDefinition[]; baseAc?: number; baseSpeed?: number; resistances?: DamageType[]; immunities?: DamageType[]; vulnerabilities?: DamageType[];
}
export interface DamagePart { formula: string; type: DamageType; addAbility?: Ability; label?: string }
export interface ActionDefinition {
  id: string; name: string; source: 'weapon' | 'spell' | 'feature' | 'monster' | 'custom'; castingAbility?: Ability;
  economy: 'action' | 'bonus' | 'reaction' | 'free'; level?: number; range?: number; reach?: number; targets?: number;
  attack?: { ability?: Ability; proficient?: boolean; bonus?: number; ranged?: boolean };
  save?: { ability: Ability; dc?: number; success: 'half' | 'none' | 'other' };
  damage?: DamagePart[]; healing?: string; healingAbility?: Ability; conditions?: string[]; duration?: number;
  concentration?: boolean; ritual?: boolean; costs?: { resourceId: string; amount: number }[];
  scaling?: Record<string, string>; description: string;
  automation: 'automatic' | 'choice' | 'adjudication' | 'unsupported'; reason?: string; sourcePage?: number;
  area?: { shape: 'sphere' | 'cone' | 'cube' | 'line' | 'cylinder'; size: number };
}
export interface ContentEntry {
  id: string; name: string; nameZh?: string; category: string; description: string; source: string; sourcePage?: number;
  automation: 'automatic' | 'choice' | 'adjudication' | 'unsupported'; reason?: string;
  data: Record<string, any>; action?: ActionDefinition;
}
export interface Wall { id: string; a: Position; b: Position; door?: boolean; open?: boolean }
export interface Terrain { id: string; x: number; y: number; width: number; height: number; type: 'difficult' | 'half-cover' | 'three-quarter-cover' }
export interface Scene { width: number; height: number; gridFeet: number; background?: string; walls: Wall[]; terrain: Terrain[]; fog: boolean }
export interface Combat { active: boolean; round: number; turn: number; order: string[]; budgets: Record<string, { action: number; bonus: number; reaction: number; movement: number; attacks?: number }> }
export interface ChoiceRequest { id: string; actorId: string; ownerId: string; kind: string; prompt: string; options: { id: string; label: string }[]; payload: Record<string, unknown> }
export interface ResultEvent { id: string; sequence: number; operationId: string; type: string; actorId?: string; targetIds?: string[]; message: string; rolls?: { expression: string; rolls: number[]; total: number }[]; changes?: unknown; source?: string; timestamp: string; gmOnly?: boolean }
export interface GameState { id: string; name: string; rev: number; actors: Actor[]; scene: Scene; combat: Combat; choices: ChoiceRequest[]; paused: boolean; events: ResultEvent[]; world?: import('./world').WorldState }
export interface Command { operationId: string; expectedRev: number; type: string; actorId?: string; targetIds?: string[]; payload?: Record<string, unknown> }
export interface Member { id: string; name: string; role: 'gm' | 'player'; online?: boolean }
export interface Session { member: Member; campaignId: string }
export interface Snapshot { session: Session; state: GameState; members: Member[]; inviteCode?: string; world?: import('./world').WorldView; tokens?: import('./world').TokenView[]; offers?: import('./world').CharacterOffer[]; profiles?: import('./world').PublicCharacterProfile[]; actorViews?: Record<string, DerivedActor> }
export interface MigrationReport { id: string; fingerprint: string; version: number; importedAt: string; actors: { oldId: string; newId: string; issues: string[] }[]; issues: string[]; original: unknown }
export interface DerivedActor { level: number; proficiency: number; modifiers: Record<Ability, number>; ac: number; speed: number; initiative: number; spellAbility: Ability; spellAttack: number; spellDC: number; maxHp: number; attacks: ActionDefinition[]; explanation: string[] }
export interface Resolution { state: GameState; events: Omit<ResultEvent, 'id' | 'sequence' | 'timestamp' | 'operationId'>[]; choices?: ChoiceRequest[] }
