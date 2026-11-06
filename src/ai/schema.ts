import { z } from 'zod';
import type { Actor, Command, DerivedActor, GameState, Member, Resolution } from '../shared/model';
import type { WorldContext } from '../shared/world';

export type ExchangeKind = 'initialize' | 'player_selection' | 'turn_context' | 'roll_results';
export interface AiContext extends WorldContext {
  member: Member;
  /** Optional source exchange for exporting its actual roll results; the new ID is always program-generated. */
  exchangeId?: string;
  engine: {
    createActor(input: Partial<Actor> & Record<string, any>): Actor;
    createMonster?(id: string, ownerId: string): Actor;
    validateActor(actor: Actor): string[];
    validateBuild?(actor: Actor): string[];
    deriveActor?(actor: Actor): DerivedActor;
  };
  resolveWorldCommand?: (state: GameState, command: Command, member: Member, context: WorldContext) => Resolution;
}
const id = z.string().min(1).max(256).regex(/^(?!__proto__$|constructor$|prototype$)[\s\S]+$/);
const text = z.string().max(100_000);
const number = z.number().finite().min(-1_000_000).max(1_000_000);
const nonnegative = number.min(0);
const ability = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);
const position = z.strictObject({ x: nonnegative.int().max(199), y: nonnegative.int().max(199) });
const arbitrary = z.record(z.string().max(256), z.unknown());
export const actorInputSchema = z.strictObject({
  id: id.optional(), name: z.string().min(1).max(100), profile: z.enum(['free', 'srd2024']).optional(),
  monsterId: id.optional(), kind: z.enum(['hero', 'companion', 'monster']).optional(),
  abilities: z.object({ str: number, dex: number, con: number, int: number, wis: number, cha: number }).partial().optional(),
  manual: z.strictObject({ maxHp: number.min(1), proficiency: number, ac: number, speed: nonnegative }).partial().optional(),
  hp: z.strictObject({ current: nonnegative, max: number.min(1), temp: nonnegative }).optional(),
  resources: z.array(z.strictObject({ id, name: z.string().max(100), current: nonnegative, max: nonnegative, recovery: z.enum(['manual', 'short', 'long', 'turn']) })).max(1000).optional(),
  classes: z.array(z.strictObject({ classId: id, level: z.number().int().min(1).max(20), subclassId: id.optional() })).max(20).optional(),
  speciesId: z.string().max(256).optional(), backgroundId: z.string().max(256).optional(),
  skills: z.array(id).max(1000).optional(), expertise: z.array(id).max(1000).optional(),
  saveProficiencies: z.array(ability).max(6).optional(), languages: z.array(id).max(1000).optional(),
  spells: z.array(id).max(1000).optional(), features: z.array(id).max(1000).optional(),
  customActions: z.array(arbitrary).max(1000).optional(),
  story: text.optional(), notes: text.optional(), portrait: z.string().max(2_000_000).optional(),
  position: position.optional(), hidden: z.boolean().optional(), size: z.number().min(.25).max(4).optional(),
  choices: arbitrary.optional(),
  resistances: z.array(id).max(13).optional(), immunities: z.array(id).max(13).optional(), vulnerabilities: z.array(id).max(13).optional(),
});
export const sceneSchema = z.strictObject({
  width: z.number().int().min(1).max(200), height: z.number().int().min(1).max(200), gridFeet: z.literal(5),
  background: z.string().max(4_000_000).optional(), fog: z.boolean(),
  walls: z.array(z.strictObject({ id, a: position, b: position, door: z.boolean().optional(), open: z.boolean().optional() })).max(1000),
  terrain: z.array(z.strictObject({ id, x: nonnegative.int(), y: nonnegative.int(), width: number.positive().int(), height: number.positive().int(), type: z.enum(['difficult', 'half-cover', 'three-quarter-cover']) })).max(1000),
});
const amountSchema = z.strictObject({ itemId: id, quantity: z.number().int().min(1).max(1_000_000) });
const growthTarget = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha', 'hp', 'mp', 'stamina', 'ap.maximum', 'ap.recovery', 'ap.perRound']);
const trackSchema = z.strictObject({ id, name: z.string().min(1).max(128), curve: z.array(z.number().int().min(1).max(1_000_000_000)).min(1).max(1000), pointsPerLevel: z.number().int().min(0).max(1_000_000), upgrades: z.array(z.strictObject({ target: growthTarget, cost: z.number().int().min(1).max(1_000_000), amount: z.number().finite().positive().max(1_000_000_000), max: z.number().finite().nonnegative().max(1_000_000_000).optional() })).max(100) });
const awardsSchema = z.array(z.strictObject({ trackId: id, amount: z.number().int().min(0).max(1_000_000_000) })).max(100);
export const worldRulesSchema = z.strictObject({
  energy: z.strictObject({ maximum: z.number().min(0).max(100), initial: z.number().min(0).max(100).optional(), perRound: z.number().finite().min(0).max(1_000_000_000), recoveryMode: z.enum(['hour', 'round']), recovery: z.number().finite().min(0).max(1_000_000_000) }).optional(),
  costs: z.strictObject({ move: nonnegative.optional(), action: nonnegative.optional(), narrative: nonnegative.optional(), proposal: nonnegative.optional() }), proposalHours: z.number().positive().max(8760).optional(),
  conflict: z.strictObject({ kind: z.enum(['random', 'cancel-refund', 'attribute']), attribute: z.string().min(1).max(128).optional() }),
  growth: z.strictObject({ kind: z.enum(['global', 'tracks']), tracks: z.array(trackSchema).max(100) }),
  recipes: z.array(z.strictObject({ id, name: z.string().min(1).max(128), description: z.string().max(10_000), cost: nonnegative, inputs: z.array(amountSchema).max(100), outputs: z.array(amountSchema).max(100), resourceCosts: z.array(z.strictObject({ resourceId: id, amount: nonnegative })).max(100).optional(), experience: awardsSchema, durationRounds: z.number().int().min(1).max(1_000_000).optional(), unlockEntries: z.array(id).max(100).optional() })).max(1000),
});
const worldItemsSchema = z.array(z.strictObject({ id, name: z.string().min(1).max(128), description: z.string().max(10_000), bonuses: z.partialRecord(growthTarget, z.number().finite().min(-1_000_000_000).max(1_000_000_000)).optional() })).max(2000);
const worldNodesSchema = z.array(z.strictObject({ id, name: z.string().min(1).max(128), position, inventory: z.array(amountSchema.extend({ quantity: z.number().int().min(0).max(1_000_000) })).max(1000), hidden: z.boolean().optional() })).max(1000);
const npcBehaviorsSchema = z.array(z.strictObject({ actorId: id, kind: z.enum(['idle', 'patrol', 'hostile', 'trade', 'event']), waypoints: z.array(position).max(1000).optional(), targetKinds: z.array(z.enum(['hero', 'companion', 'monster'])).max(3).optional(), actionId: id.optional(), ruleId: id.optional(), trigger: z.string().max(4000).optional() })).max(500);
export const worldConfigurationSchema = z.strictObject({ lore: text.optional(), secretLore: text.optional(), rules: worldRulesSchema.optional(), items: worldItemsSchema.optional(), nodes: worldNodesSchema.optional(), npcBehaviors: npcBehaviorsSchema.optional() });
// Catalog references and adopted-rule constraints are also checked by the authoritative world reducer.
const initializePayload = z.strictObject({
  decisionId: id, lore: text.optional(), secretLore: text.optional(), scene: sceneSchema.optional(), rules: worldRulesSchema.optional(),
  characters: z.array(actorInputSchema).max(500).optional(), npcs: z.array(actorInputSchema).max(500).optional(), monsters: z.array(actorInputSchema).max(500).optional(),
  items: worldItemsSchema.optional(), nodes: worldNodesSchema.optional(), npcBehaviors: npcBehaviorsSchema.optional(),
});
export const effectCommands = ['action.use', 'actor.move', 'actor.rest', 'actor.deathSave', 'actor.create', 'inventory.add', 'inventory.equip', 'inventory.consume', 'knowledge.unlock', 'character.patch', 'growth.award', 'world.configure', 'gm.adjust', 'effect.add', 'effect.remove', 'choice.resolve'] as const;
const resourceInput = z.strictObject({ id, name: z.string().max(100), current: nonnegative, max: nonnegative, recovery: z.enum(['short', 'long', 'turn', 'manual']) });
const patchSchema = z.strictObject({ abilities: z.strictObject({ str: number, dex: number, con: number, int: number, wis: number, cha: number }).partial().optional(), manual: z.strictObject({ maxHp: number.min(1), proficiency: number, ac: number, speed: nonnegative }).partial().optional(), hp: z.strictObject({ current: nonnegative.optional(), temp: nonnegative.optional() }).optional(), resources: z.array(resourceInput).max(1000).optional(), customActions: z.array(arbitrary).max(1000).optional(), skills: z.array(id).max(1000).optional(), expertise: z.array(id).max(1000).optional(), saveProficiencies: z.array(ability).max(6).optional(), resistances: z.array(id).max(13).optional(), immunities: z.array(id).max(13).optional(), vulnerabilities: z.array(id).max(13).optional(), size: number.min(.25).max(4).optional() });
export const gameCommandPayloadSchemas = {
  'actor.create': actorInputSchema, 'world.configure': worldConfigurationSchema,
  'inventory.add': z.strictObject({ contentId: id, quantity: z.number().int().min(1).max(1_000_000).optional(), baseContentId: id.optional(), variant: z.string().max(100).optional() }),
  'knowledge.unlock': z.strictObject({ entryId: id }), 'character.patch': z.strictObject({ patch: patchSchema }), 'growth.award': z.strictObject({ awards: awardsSchema.min(1) }),
  'action.use': z.strictObject({ actionId: id, slotLevel: z.number().int().min(0).max(9).optional(), origin: z.strictObject({ x: number, y: number }).optional(), advantage: z.number().int().min(-1).max(1).optional(), options: arbitrary.optional() }),
  'actor.move': z.strictObject({ path: z.array(z.strictObject({ x: number.int(), y: number.int() })).min(1).max(500) }),
  'actor.rest': z.strictObject({ kind: z.enum(['short', 'long']), hitDice: z.record(z.string(), z.number().int().min(0).max(20)).optional() }),
  'actor.deathSave': z.strictObject({}), 'inventory.equip': z.strictObject({ itemId: id, equipped: z.boolean(), attuned: z.boolean().optional() }), 'inventory.consume': z.strictObject({ itemId: id, options: arbitrary.optional() }),
  'gm.adjust': z.strictObject({ hp: nonnegative.optional(), temp: nonnegative.optional(), resourceId: id.optional(), resourceDelta: number.optional(), condition: id.optional(), exhaustion: z.number().int().min(0).max(6).optional() }),
  'effect.add': z.strictObject({ effect: z.strictObject({ name: z.string().max(4000), condition: id, duration: nonnegative.optional() }) }), 'effect.remove': z.strictObject({ effectId: id }), 'choice.resolve': z.strictObject({ choiceId: id, optionId: id, ruling: z.string().max(4000).optional() }),
};
function effectCommand<T extends typeof effectCommands[number]>(type: T) { return z.strictObject({ type: z.literal(type), actorId: id.optional(), payload: gameCommandPayloadSchemas[type].optional(), targetIds: z.array(id).max(500).optional() }); }
const commandSchema = z.discriminatedUnion('type', [effectCommand('action.use'), effectCommand('actor.move'), effectCommand('actor.rest'), effectCommand('actor.deathSave'), effectCommand('actor.create'), effectCommand('inventory.add'), effectCommand('inventory.equip'), effectCommand('inventory.consume'), effectCommand('knowledge.unlock'), effectCommand('character.patch'), effectCommand('growth.award'), effectCommand('world.configure'), effectCommand('gm.adjust'), effectCommand('effect.add'), effectCommand('effect.remove'), effectCommand('choice.resolve')]);
const stepSchema = z.discriminatedUnion('type', [
  z.strictObject({ id, type: z.literal('command'), command: commandSchema, rollId: id.optional() }),
  z.strictObject({ id, type: z.literal('intent'), intentId: id, approve: z.boolean(), rollId: id.optional() }),
  z.strictObject({ id, type: z.literal('ruling'), command: commandSchema }),
  z.strictObject({ id, type: z.literal('roll'), expression: z.string().min(1).max(200), rollId: id }),
]);
const rollSchema = z.strictObject({ id, expression: z.string().min(1).max(200), rolls: z.array(z.number().int().min(1).max(1000)).max(2000), total: z.number().int().min(-1_000_000_000).max(1_000_000_000) });
const decisionPayload = z.strictObject({ decisionId: id, completeRound: z.boolean().optional(), narratives: z.array(z.strictObject({ text, actorIds: z.array(id).max(500).optional() })).max(500).optional(), steps: z.array(stepSchema).max(500).optional(), aiRolls: z.array(rollSchema).max(500).optional() });
const envelope = { protocol: z.literal('jigerpg-ai'), version: z.literal(1), campaignId: id, exchangeId: id, worldRevision: z.number().int().nonnegative() };
export const aiReplySchema = z.discriminatedUnion('packetType', [
  z.strictObject({ ...envelope, packetType: z.literal('initialize'), payload: initializePayload }),
  z.strictObject({ ...envelope, packetType: z.literal('decision'), payload: decisionPayload }),
]);
export type AiReply = z.infer<typeof aiReplySchema>;
export interface AiPacket { protocol: 'jigerpg-ai'; version: 1; packetType: ExchangeKind | 'decision'; campaignId: string; exchangeId: string; worldRevision: number; payload: Record<string, unknown> }
export const AI_REPLY_JSON_SCHEMA = z.toJSONSchema(aiReplySchema, { target: 'draft-2020-12' });
export function parseAiReply(input: unknown): AiReply { return aiReplySchema.parse(input); }
