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
// Rules are validated by the authoritative world reducer before initialization commits.
const initializePayload = z.strictObject({
  decisionId: id, lore: text.optional(), secretLore: text.optional(), scene: sceneSchema.optional(), rules: arbitrary.optional(),
  characters: z.array(actorInputSchema).max(500).optional(), npcs: z.array(actorInputSchema).max(500).optional(), monsters: z.array(actorInputSchema).max(500).optional(),
  items: z.array(arbitrary).max(2000).optional(), nodes: z.array(arbitrary).max(1000).optional(), npcBehaviors: z.array(arbitrary).max(500).optional(),
});
export const effectCommands = ['action.use', 'actor.move', 'actor.rest', 'actor.deathSave', 'actor.create', 'inventory.add', 'inventory.equip', 'inventory.consume', 'knowledge.unlock', 'character.patch', 'growth.award', 'gm.adjust', 'effect.add', 'effect.remove', 'choice.resolve'] as const;
const commandSchema = z.strictObject({ type: z.enum(effectCommands), actorId: id.optional(), payload: arbitrary.optional(), targetIds: z.array(id).max(500).optional() });
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
