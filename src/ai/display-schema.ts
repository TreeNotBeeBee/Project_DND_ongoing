import { z } from 'zod';
import type { DisplayJson } from '../shared/ai-display';

const unsafeControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
export const displayId = z.string().min(1).max(128).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value) && !/[\u0000-\u001F\u007F]/u.test(value), 'Unsafe identifier/control character');
const key = displayId;
export const displayJsonSchema: z.ZodType<DisplayJson> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(1_000_000), z.array(displayJsonSchema).max(10_000), z.record(key, displayJsonSchema)]));
const audience = { visibility: z.enum(['public', 'private', 'gm']), audience: z.array(displayId).max(500).optional() };
export const displayFieldSchema = z.strictObject({ value: displayJsonSchema, source: z.enum(['module', 'ai', 'unknown']), visibility: audience.visibility.optional(), audience: audience.audience });
const fields = z.record(key, displayFieldSchema);
export const displayPositionSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
export const displayImageSchema = z.string().max(4_000_000).regex(/^(?:https:\/\/|\/api\/assets\/[a-zA-Z0-9-]{8,128}$|data:image\/(?:png|jpeg|webp|gif);base64,)/i);
const image = displayImageSchema;
export const displayEntitySchema = z.strictObject({ id: displayId, kind: z.enum(['pc', 'npc', 'enemy', 'item', 'landmark']), name: z.string().max(1000), source: z.enum(['module', 'ai', 'unknown']), ...audience, fields, position: displayPositionSchema.optional(), image: image.optional() });
export const displayNarrativeSchema = z.strictObject({ id: displayId, text: z.string().max(100_000), source: z.enum(['module', 'ai', 'unknown']), ...audience, actorIds: z.array(displayId).max(500).optional() });
export const displayMapSchema = z.strictObject({ width: z.number().finite().positive(), height: z.number().finite().positive(), image: image.optional(), ...audience });
export const moduleInitializationSchema = z.strictObject({
  freedom: z.enum(['A', 'B', 'C']),
  rules: z.strictObject({ edition: z.enum(['5e2014', '5e2024']), moduleId: displayId.optional(), title: z.string().max(1000).optional(), fields }),
  pcs: z.array(displayEntitySchema).max(500), background: z.strictObject({ fields }),
  setting: z.strictObject({ fields, entities: z.array(displayEntitySchema).max(5000).optional(), map: displayMapSchema.optional() }),
  opening: z.strictObject({ fields, narratives: z.array(displayNarrativeSchema).max(5000).optional() }),
});
// Backup state permits exactly the server-owned field flag. Gameplay value.pending remains ordinary JSON.
export const storedDisplayFieldSchema = displayFieldSchema.extend({ pending: z.boolean().optional() });
const storedFields = z.record(key, storedDisplayFieldSchema);
export const storedDisplayEntitySchema = displayEntitySchema.extend({ fields: storedFields });
export const storedModuleInitializationSchema = moduleInitializationSchema.extend({
  rules: moduleInitializationSchema.shape.rules.extend({ fields: storedFields }),
  pcs: z.array(storedDisplayEntitySchema).max(500),
  background: z.strictObject({ fields: storedFields }),
  setting: z.strictObject({ fields: storedFields, entities: z.array(storedDisplayEntitySchema).max(5000).optional(), map: displayMapSchema.optional() }),
  opening: z.strictObject({ fields: storedFields, narratives: z.array(displayNarrativeSchema).max(5000).optional() }),
});
const patch = z.union([
  z.strictObject({ op: z.literal('upsert'), target: z.literal('entity'), id: displayId, value: displayEntitySchema }),
  z.strictObject({ op: z.literal('upsert'), target: z.literal('narrative'), id: displayId, value: displayNarrativeSchema }),
  z.strictObject({ op: z.literal('delete'), target: z.enum(['entity', 'narrative']), id: displayId }),
]);
const envelope = { protocol: z.literal('jigerpg-ai'), version: z.literal(2), campaignId: displayId, exchangeId: displayId, displayRevision: z.number().int().nonnegative() };
export const aiDisplayReplySchema = z.discriminatedUnion('packetType', [
  z.strictObject({ ...envelope, packetType: z.literal('initialize'), payload: z.strictObject({ decisionId: displayId, initialization: moduleInitializationSchema }) }),
  z.strictObject({ ...envelope, packetType: z.literal('update'), payload: z.strictObject({ decisionId: displayId, patches: z.array(patch).max(5000) }) }),
]);
export type AiDisplayReply = z.infer<typeof aiDisplayReplySchema>;
export const AI_DISPLAY_REPLY_JSON_SCHEMA = z.toJSONSchema(aiDisplayReplySchema, { target: 'draft-2020-12', unrepresentable: 'any' });
/** Bound JSON depth/nodes before recursive schema parsing, without imposing game-stat ranges. */
export function parseDisplayJson(input: unknown): unknown {
  const value = typeof input === 'string' ? JSON.parse(input) : structuredClone(input); let nodes = 0;
  function visit(item: unknown, depth: number, path: string): void {
    if (++nodes > 200_000 || depth > 40) throw new Error('AI JSON exceeds the technical size/depth limit');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('AI JSON numbers must be finite');
    if (typeof item === 'string' && unsafeControls.test(item)) throw new Error(`AI_JSON_CONTROL at ${JSON.stringify(path)}: strings cannot contain C0 control characters except tab/CR/LF, or DEL`);
    if (item && typeof item === 'object') { if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('AI JSON must contain plain objects'); for (const [name, child] of Object.entries(item)) { const pointer = path + '/' + name.replaceAll('~', '~0').replaceAll('/', '~1'); if (unsafeControls.test(name)) throw new Error(`AI_JSON_CONTROL at ${JSON.stringify(pointer)}: object keys contain a prohibited control character`); if (['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('Unsafe AI JSON key'); visit(child, depth + 1, pointer); } }
    else if (item !== null && !['number', 'string', 'boolean'].includes(typeof item)) throw new Error('AI JSON contains a non-JSON value');
  }
  visit(value, 0, '$'); if (JSON.stringify(value).length > 8_000_000) throw new Error('AI JSON exceeds 8 MB'); return value;
}
export const parseAiDisplayReply = (input: unknown): AiDisplayReply => aiDisplayReplySchema.parse(parseDisplayJson(input));
