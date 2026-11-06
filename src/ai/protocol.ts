import { z } from 'zod';
import type { Actor, Command, Dice, GameState, Resolution } from '../shared/model';
import type { AiExchange } from '../shared/world';
import { assert, rollExpression, RuleError, uid } from '../engine/dice';
import { configureWorld } from '../world/rounds';
import { executeEngine } from '../world/engine';
import { parseAiReply, AI_REPLY_JSON_SCHEMA, type AiContext, type AiPacket, type AiReply, type ExchangeKind } from './schema';
export * from './schema';

type Log = Resolution['events'];
type Decision = Extract<AiReply, { packetType: 'decision' }>;
type Step = NonNullable<Decision['payload']['steps']>[number];
type Roll = NonNullable<Decision['payload']['aiRolls']>[number];
interface Pool extends Roll { sides: number[]; offset: number }
interface Receipt { canonical: string; status: 'pending' | 'applied' | 'failed'; next: number; used: string[]; reaction?: string; error?: string; narratives: boolean }
interface Reaction { pool?: Pool; decisionId: string; stepId: string; requested?: { choiceId: string; optionId: string; side: number }; done?: boolean }
const providers = new WeakMap<Dice, Pool>();
const canonical = (value: any): string => value && typeof value === 'object' ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const own = (value: any, key: string) => value && Object.hasOwn(value, key) ? value[key] : undefined;
function records(exchange: AiExchange): Record<string, Receipt> { return (exchange.payload._decisions ||= {}) as Record<string, Receipt>; }
function reactions(exchange: AiExchange): Record<string, Reaction> { return (exchange.payload._reactions ||= {}) as Record<string, Reaction>; }
function exchangeBy(state: GameState, id: string) { const result = state.world!.ai.exchanges.find(entry => entry.id === id); assert(result, 'AI_EXCHANGE', 'This exchange was not exported by this campaign'); return result; }
function reactionBy(state: GameState, id: string) { for (const exchange of state.world!.ai.exchanges) { const record = own(exchange.payload._reactions, id) as Reaction | undefined; if (record) return { exchange, record }; } throw new RuleError('AI_REACTION', 'The private AI continuation is missing'); }
function access(state: GameState, ctx: AiContext) { assert(state.world && state.world.mode === 'ai', 'AI_MODE', 'AI packets can only change an AI-hosted world'); assert(ctx.member.id === state.world.ownerId && ctx.members.some(member => member.id === ctx.member.id), 'AI_OWNER', 'Only the world owner may export or confirm an AI import'); }
function note(log: Log, type: string, message: string, actorId?: string) { log.push({ type, actorId, message, source: 'jigerpg-ai/v1' }); }
const safeScene = (scene: GameState['scene']) => ({ width: scene.width, height: scene.height, gridFeet: scene.gridFeet, walls: scene.walls, terrain: scene.terrain, fog: scene.fog });
const intentPayloadKeys = new Set(['actionId', 'origin', 'path', 'options', 'slotLevel', 'commandType', 'itemId', 'equipped', 'ruleId', 'nodeId', 'items', 'text']);
function contextPayload(state: GameState, ctx: AiContext): Record<string, unknown> {
  const world = state.world!;
  return {
    mode: world.mode, phase: world.phase, lore: world.lore, secretLore: world.secretLore, scene: safeScene(state.scene), rules: world.rules,
    characters: state.actors.map(actor => ({ id: actor.id, name: actor.name, kind: actor.kind, profile: actor.profile || 'srd2024', registration: actor.registration,
      story: actor.story || '', abilities: actor.abilities, manual: actor.manual, hp: actor.hp, resources: actor.resources, position: actor.position, size: actor.size, hidden: actor.hidden,
      skills: actor.skills, spells: actor.spells, features: actor.features, actions: ctx.engine.deriveActor?.(actor).attacks || actor.customActions || [],
      effects: actor.effects.map(effect => ({ id: effect.id, name: effect.name, condition: effect.condition, duration: effect.duration, sourceActorId: effect.sourceActorId, gmOnly: effect.gmOnly })),
      inventory: actor.inventory.map(item => ({ id: item.id, contentId: item.contentId, name: item.name, quantity: item.quantity, equipped: item.equipped, attuned: item.attuned, charges: item.charges })),
    })),
    round: { ...world.round, intents: world.round.intents.map(intent => ({ ...intent, payload: Object.fromEntries(Object.entries(intent.payload).filter(([key]) => intentPayloadKeys.has(key))) })) },
    items: world.items, nodes: world.nodes, npcBehaviors: world.npcBehaviors,
    choices: state.choices.map(choice => ({ id: choice.id, actorId: choice.actorId, kind: choice.kind, prompt: choice.prompt, options: choice.options })),
    pendingDice: world.ai.exchanges.flatMap(exchange => Object.entries((exchange.payload._reactions || {}) as Record<string, Reaction>).filter(([, record]) => record.requested && !record.done).map(([reference, record]) => ({ reference, ...record.requested }))),
  };
}
export function createAiExchange(input: GameState, kind: ExchangeKind, ctx: AiContext): { state: GameState; packet: AiPacket; schema: unknown; prompt: string } {
  access(input, ctx); assert(['initialize', 'player_selection', 'turn_context', 'roll_results'].includes(kind), 'AI_KIND', 'Unknown export type');
  if (kind === 'initialize') assert(input.world!.phase === 'setup', 'AI_PHASE', 'Initialization is only available during setup');
  const state = structuredClone(input), world = state.world!, payload = contextPayload(state, ctx);
  if (kind === 'roll_results') { const source = ctx.exchangeId ? exchangeBy(state, ctx.exchangeId) : [...world.ai.exchanges].reverse().find(exchange => exchange.rolls?.length); payload.rolls = structuredClone(source?.rolls || []); payload.replyTo = source?.id; }
  const id = uid(); world.ai.exchanges.push({ id, kind, worldRevision: world.gameplayRev, round: world.round.number, payload: {}, createdAt: ctx.now, appliedDecisionIds: [] });
  assert(world.ai.exchanges.length <= 2000, 'AI_LIMIT', 'Archive this campaign before creating more AI exchanges');
  const packet: AiPacket = { protocol: 'jigerpg-ai', version: 1, packetType: kind, campaignId: state.id, exchangeId: id, worldRevision: world.gameplayRev, payload };
  const example = { protocol: 'jigerpg-ai', version: 1, packetType: kind === 'initialize' ? 'initialize' : 'decision', campaignId: state.id, exchangeId: id, worldRevision: world.gameplayRev, payload: { decisionId: 'your-stable-unique-decision-id', ...(kind === 'initialize' ? { lore: 'World description', characters: [{ id: 'hero-template-1', name: 'An available free character', profile: 'free' }] } : { steps: [] }) } };
  const prompt = `You are the external game host. Return only one JSON reply matching the supplied JSON Schema. Echo campaignId, exchangeId and worldRevision exactly; provide a stable payload.decisionId. Never invent ownership, membership, grants, votes, whole-state replacements or private notes. Initialization is setup-only; heroes become unclaimed offers. Use explicit custom actions, thirteen damage types and per-action casting/attack/damage abilities. Unimplemented SRD rules must not be called automatic. Rulings are external adjudications and require owner confirmation. Dice source: ${world.ai.diceSource}. ${world.ai.diceSource === 'program' ? 'Do not send aiRolls. Request a roll using a roll step, then wait for a roll_results export before choosing subsequent effects.' : 'For each random command provide step.rollId referencing one aiRolls record. List actual individual dice in execution order; expression, sides and total are validated. Never change a recorded die. If a reaction needs more dice, reply with exactly one choice.resolve command matching pendingDice.choiceId/optionId and a fresh rollId.'} Stop at reactions; later steps are persisted and cannot bypass a player choice. Example: ${JSON.stringify(example)}`;
  return { state, packet, schema: AI_REPLY_JSON_SCHEMA, prompt };
}

const bounded = z.number().finite().min(-1_000_000).max(1_000_000), text = z.string().max(4000), id = z.string().min(1).max(256);
const commandPayloads: Record<string, z.ZodType> = {
  'action.use': z.strictObject({ actionId: id, slotLevel: z.number().int().min(0).max(9).optional(), origin: z.strictObject({ x: bounded, y: bounded }).optional(), advantage: z.number().int().min(-1).max(1).optional(), options: z.record(z.string(), z.unknown()).optional() }),
  'actor.move': z.strictObject({ path: z.array(z.strictObject({ x: bounded.int(), y: bounded.int() })).min(1).max(500) }),
  'actor.rest': z.strictObject({ kind: z.enum(['short', 'long']), hitDice: z.record(z.string(), z.number().int().min(0).max(20)).optional() }),
  'actor.deathSave': z.strictObject({}), 'inventory.equip': z.strictObject({ itemId: id, equipped: z.boolean(), attuned: z.boolean().optional() }),
  'inventory.consume': z.strictObject({ itemId: id, options: z.record(z.string(), z.unknown()).optional() }),
  'gm.adjust': z.strictObject({ hp: bounded.min(0).optional(), temp: bounded.min(0).optional(), resourceId: id.optional(), resourceDelta: bounded.optional(), condition: id.optional(), exhaustion: z.number().int().min(0).max(6).optional() }),
  'effect.add': z.strictObject({ effect: z.strictObject({ name: text, condition: id, duration: bounded.min(0).optional() }) }),
  'effect.remove': z.strictObject({ effectId: id }), 'choice.resolve': z.strictObject({ choiceId: id, optionId: id, ruling: text.optional() }),
};
function checkedCommand(state: GameState, command: Extract<Step, { type: 'command' | 'ruling' }>['command'], ruling = false, ctx?: AiContext): void {
  assert(commandPayloads[command.type], 'AI_COMMAND', 'This command is not an AI game effect'); commandPayloads[command.type].parse(command.payload || {});
  if (ruling) assert(['gm.adjust', 'effect.add', 'effect.remove'].includes(command.type), 'AI_RULING', 'An external ruling can only adjust HP, resources or conditions');
  if (command.actorId) { const actor = state.actors.find(actor => actor.id === command.actorId); assert(actor && !(actor.kind === 'hero' && actor.registration && actor.registration !== 'registered'), 'AI_ACTOR', 'Command refers to an unavailable actor'); }
  else assert(command.type === 'choice.resolve', 'AI_ACTOR', 'A game effect requires actorId');
  for (const target of command.targetIds || []) assert(state.actors.some(actor => actor.id === target), 'AI_TARGET', 'Command target does not exist');
  const options = command.payload?.options as Record<string, unknown> | undefined;
  assert(!options || Object.keys(options).every(key => !key.startsWith('_') && !['dice', 'rolls', 'damageTotal', 'skipResources', 'economy'].includes(key)), 'AI_COMMAND', 'Command contains a private engine override');
  if (command.type === 'action.use' && ctx?.engine.deriveActor && command.actorId) {
    const actor = state.actors.find(actor => actor.id === command.actorId)!, actionId = command.payload?.actionId;
    const action = ctx.engine.deriveActor(actor).attacks.find(action => action.id === actionId);
    const basic = ['dash', 'dodge', 'disengage', 'stand', 'drop-prone', 'grapple', 'shove', 'escape-grapple', 'help', 'roll-dice', 'check', 'ability-check'];
    assert(action || basic.includes(String(actionId)), 'AI_ACTION', 'The actor does not have that executable action ID');
    assert(!action || action.automation !== 'unsupported', 'AI_ACTION', 'This deterministic action is not implemented');
  }
  if (command.type === 'choice.resolve') {
    const choice = state.choices.find(choice => choice.id === command.payload?.choiceId); assert(choice, 'AI_CHOICE', 'Choice is no longer pending');
    const ref = choice.payload.aiResolutionRef as string | undefined, requested = ref ? reactionBy(state, ref).record.requested : undefined;
    assert(choice.ownerId === state.world!.ownerId || choice.ownerId === '__gm__' || requested?.choiceId === choice.id && requested.optionId === command.payload?.optionId, 'AI_CHOICE_OWNER', 'AI cannot choose a player reaction without that player requesting this exact option');
  }
}
function makePool(roll: Roll): Pool {
  const sides: number[] = []; let index = 0;
  const result = rollExpression(roll.expression, side => { sides.push(side); const value = roll.rolls[index++]; assert(Number.isInteger(value) && value >= 1 && value <= side, 'AI_DICE_RANGE', 'AI die is missing or outside its actual sides'); return value; });
  assert(index === roll.rolls.length && result.total === roll.total, 'AI_DICE_TOTAL', 'AI dice count or total does not match its expression');
  return { ...structuredClone(roll), sides, offset: 0 };
}
function provider(pool: Pool): Dice { const dice: Dice = side => { assert(pool.offset < pool.rolls.length, 'AI_DICE_NEEDED', `AI must supply the next d${side}`); assert(pool.sides[pool.offset] === side, 'AI_DICE_NEEDED', `AI die purpose/order mismatch: next request is d${side}`); return pool.rolls[pool.offset++]; }; providers.set(dice, pool); return dice; }
function packetInput(value: unknown): AiReply { return parseAiReply(typeof value === 'string' ? JSON.parse(value) : value); }
function inspect(input: GameState, packet: AiReply, ctx: AiContext): Receipt | undefined {
  access(input, ctx); assert(packet.campaignId === input.id, 'AI_CAMPAIGN', 'Packet belongs to a different campaign');
  assert(!['__proto__', 'constructor', 'prototype'].includes(packet.payload.decisionId), 'AI_DECISION', 'Invalid decision ID');
  const exchange = exchangeBy(input, packet.exchangeId), receipt = own(exchange.payload._decisions, packet.payload.decisionId) as Receipt | undefined;
  assert(packet.worldRevision === exchange.worldRevision, 'AI_REVISION', 'Reply must echo the exported gameplay revision');
  if (receipt) { assert(receipt.canonical === canonical(packet), 'AI_DECISION_CONFLICT', 'This decisionId was already used with different content'); return receipt; }
  assert(packet.worldRevision === input.world!.gameplayRev, 'AI_STALE', 'Gameplay changed; export a fresh context before importing');
  if (packet.packetType === 'initialize') { assert(exchange.kind === 'initialize' && input.world!.phase === 'setup', 'AI_PHASE', 'This is not a setup initialization exchange'); return; }
  assert(exchange.kind !== 'initialize', 'AI_KIND', 'Initialization exchanges require an initialization reply');
  const steps = packet.payload.steps || []; assert(new Set(steps.map(step => step.id)).size === steps.length, 'AI_STEP', 'Step IDs must be unique');
  const pools = packet.payload.aiRolls || []; assert(new Set(pools.map(roll => roll.id)).size === pools.length, 'AI_DICE_ID', 'Die result IDs must be unique');
  for (const roll of pools) assert(!Object.values((exchange.payload._decisions || {}) as Record<string, Receipt>).some(record => record.used.includes(roll.id)), 'AI_DICE_ID', 'This exchange already consumed that AI roll ID');
  for (const step of steps) if (step.type === 'roll') assert(!exchange.rolls?.some(roll => roll.id === step.rollId), 'AI_DICE_ID', 'This requested roll ID already has a recorded result');
  if (input.world!.ai.diceSource === 'program') assert(!pools.length, 'AI_DICE_SOURCE', 'AI cannot supply dice while program dice are selected');
  pools.forEach(makePool);
  const used = new Set<string>();
  for (const step of steps) {
    if (step.type === 'command' || step.type === 'ruling') checkedCommand(input, step.command, step.type === 'ruling', ctx);
    if (step.type === 'intent') { assert(ctx.resolveWorldCommand, 'AI_WORLD_HOOK', 'World intent resolver is unavailable'); assert(input.world!.round.intents.some(intent => intent.id === step.intentId), 'AI_INTENT', 'Intent does not exist'); }
    if (step.type === 'roll') rollExpression(step.expression, () => 1);
    if ('rollId' in step && step.rollId && input.world!.ai.diceSource === 'ai') { assert(!used.has(step.rollId) && pools.some(roll => roll.id === step.rollId), 'AI_DICE_ID', 'Every AI roll reference must exist and have one purpose'); used.add(step.rollId); }
    if (step.type === 'command' && step.rollId && input.world!.ai.diceSource === 'ai') assert(/^(?:\d*d\d+)(?:\+\d*d\d+)*$/i.test(pools.find(roll => roll.id === step.rollId)!.expression.replace(/\s/g, '')), 'AI_DICE_USAGE', 'A command die pool contains only positive dice terms; the engine calculates modifiers');
  }
  if (input.world!.ai.diceSource === 'ai') assert(pools.every(roll => used.has(roll.id)), 'AI_DICE_UNUSED', 'AI supplied dice without an assigned step');
  if (input.world!.ai.diceSource === 'program') { const firstRoll = steps.findIndex(step => step.type === 'roll'); assert(firstRoll < 0 || steps.slice(firstRoll).every(step => step.type === 'roll'), 'AI_ROLL_BARRIER', 'After requesting program dice, wait for roll_results before choosing subsequent game effects'); }
  for (const narrative of packet.payload.narratives || []) for (const actorId of narrative.actorIds || []) assert(input.actors.some(actor => actor.id === actorId), 'AI_NARRATIVE', 'Narrative actor does not exist');
  if (input.choices.length) assert(steps.length === 1 && steps[0].type === 'command' && steps[0].command.type === 'choice.resolve', 'AI_REACTION_BARRIER', 'Resolve the current reaction before another AI batch');
}

function initialize(input: GameState, packet: Extract<AiReply, { packetType: 'initialize' }>, ctx: AiContext): Resolution {
  let state = structuredClone(input); const events: Log = [], payload = packet.payload;
  if (payload.rules) assert(Object.keys(payload.rules).every(key => ['energy', 'costs', 'proposalHours', 'conflict', 'growth', 'recipes'].includes(key)), 'AI_RULES', 'Initialization rules contain an unknown state or governance field');
  for (const [list, keys] of [[payload.items, ['id', 'name', 'description', 'bonuses']], [payload.nodes, ['id', 'name', 'position', 'inventory', 'hidden']], [payload.npcBehaviors, ['actorId', 'kind', 'waypoints', 'targetKinds', 'actionId', 'ruleId', 'trigger']]] as const) for (const entry of list || []) assert(Object.keys(entry).every(key => (keys as readonly string[]).includes(key)), 'AI_INITIALIZE', 'Initialization contains an unknown catalog or ownership field');
  if (payload.scene) { const result = executeEngine(state, { operationId: uid(), expectedRev: state.rev, type: 'scene.update', payload: { scene: payload.scene } }, ctx); state = result.state; events.push(...result.events); }
  const mapping: Record<string, string> = {}, pending = [...(payload.characters || []).map(actor => ({ actor, hero: true })), ...(payload.npcs || []).map(actor => ({ actor, hero: false })), ...(payload.monsters || []).map(actor => ({ actor, hero: false }))];
  const external = pending.map(({ actor }, index) => actor.id || 'generated:' + index); assert(new Set(external).size === external.length, 'AI_EXTERNAL_ID', 'Initialization actor IDs must be unique');
  for (let index = 0; index < pending.length; index++) {
    const { actor, hero } = pending[index]; assert(!hero || !actor.monsterId, 'AI_CHARACTER', 'A player-character offer cannot be a monster statblock');
    assert(!(actor.resources || []).some(resource => resource.id === 'ap' && (resource.max !== 0 || resource.current !== 0)), 'AI_AP', 'Initial AP is controlled by adopted world energy rules');
    const before = new Set(state.actors.map(actor => actor.id)), choices = Object.fromEntries(Object.entries(actor.choices || {}).filter(([key]) => ['characterBuild', 'magicInitiate', 'weaponMasteries', 'startingEquipment', 'team', 'creatureType'].includes(key)));
    const result = executeEngine(state, { operationId: uid(), expectedRev: state.rev, type: 'actor.create', payload: { ...actor, ...(actor.profile !== 'srd2024' && !actor.monsterId ? { manual: { maxHp: actor.hp?.max || 10, ...actor.manual } } : {}), id: uid(), profile: actor.profile || 'free', ownerId: hero ? '' : state.world!.ownerId, kind: hero ? 'hero' : 'monster', draft: false, choices } }, ctx);
    state = result.state; events.push(...result.events); const created = state.actors.find(actor => !before.has(actor.id)); assert(created, 'AI_CHARACTER', 'Character constructor did not return a new card');
    created.ownerId = hero ? '' : state.world!.ownerId; created.registration = hero ? 'available' : 'registered'; created.publicGroups = []; delete created.requestedBy;
    mapping[external[index]] = created.id;
    const problems = [...ctx.engine.validateActor(created), ...(ctx.engine.validateBuild?.(created) || [])]; assert(!problems.length, 'AI_CHARACTER', problems.join('; '));
  }
  const configuration: Record<string, unknown> = {};
  for (const key of ['lore', 'secretLore', 'rules', 'items', 'nodes'] as const) if (payload[key] !== undefined) configuration[key] = payload[key];
  if (payload.npcBehaviors) configuration.npcBehaviors = payload.npcBehaviors.map(behavior => ({ ...behavior, actorId: mapping[String(behavior.actorId)] || behavior.actorId }));
  configureWorld(state, configuration, ctx); exchangeBy(state, packet.exchangeId).payload.externalActorIds = mapping;
  note(events, 'ai-initialized', 'Owner confirmed the external AI world draft; character offers remain unclaimed'); return { state, events };
}

function attachReaction(state: GameState, exchangeId: string, decisionId: string, stepId: string, pool?: Pool, reference?: string): string {
  const ref = reference || uid(), exchange = exchangeBy(state, exchangeId), record = own(exchange.payload._reactions, ref) as Reaction | undefined;
  reactions(exchange)[ref] = { ...record, pool: pool ? structuredClone(pool) : undefined, decisionId, stepId, done: false };
  for (const choice of state.choices) if (!choice.payload.aiResolutionRef || choice.payload.aiResolutionRef === ref) choice.payload.aiResolutionRef = ref;
  return ref;
}
export function applyAiPacket(input: GameState, value: unknown, ctx: AiContext): Resolution {
  const packet = packetInput(value), old = inspect(input, packet, ctx);
  if (old?.status === 'applied') return { state: structuredClone(input), events: [] };
  assert(old?.status !== 'failed', 'AI_CONTINUATION_FAILED', old?.error || 'This continuation failed; import a fresh decision');
  if (old?.reaction && input.choices.some(choice => choice.payload.aiResolutionRef === old.reaction)) return { state: structuredClone(input), events: [] };
  let state = structuredClone(input), events: Log = [], exchange = exchangeBy(state, packet.exchangeId), receipt: Receipt = old ? structuredClone(old) : { canonical: canonical(packet), status: 'pending', next: 0, used: [], narratives: false };
  records(exchange)[packet.payload.decisionId] = receipt;
  if (packet.packetType === 'initialize') { const result = initialize(state, packet, ctx); state = result.state; events.push(...result.events); }
  else {
    const steps = packet.payload.steps || [];
    for (let index = receipt.next; index < steps.length; index++) {
      const step = steps[index]; let result: Resolution | undefined, pool: Pool | undefined;
      const dice = state.world!.ai.diceSource === 'ai' ? provider(pool = 'rollId' in step && step.rollId ? makePool(packet.payload.aiRolls!.find(roll => roll.id === step.rollId)!) : { id: 'missing', expression: '0', rolls: [], sides: [], total: 0, offset: 0 }) : ctx.dice;
      if (step.type === 'command' || step.type === 'ruling') {
        checkedCommand(state, step.command, step.type === 'ruling', ctx);
        const command = { ...step.command, operationId: `ai:${packet.exchangeId}:${index}`, expectedRev: state.rev } as Command;
        result = executeEngine(state, command, { ...ctx, dice });
        if (step.type === 'ruling' || ['gm.adjust', 'effect.add', 'effect.remove'].includes(command.type)) note(events, 'ai-external-ruling', `Owner confirmed AI external adjudication: ${step.id}`, command.actorId);
      } else if (step.type === 'intent') result = ctx.resolveWorldCommand!(state, { operationId: `ai:${packet.exchangeId}:${index}`, expectedRev: state.rev, type: 'intent.review', payload: { intentId: step.intentId, approve: step.approve } }, ctx.member, { ...ctx, dice });
      else {
        const roll = rollExpression(step.expression, dice); if (pool) assert(pool.offset === pool.rolls.length && pool.expression === roll.expression, 'AI_DICE_USAGE', 'Die-request formula must match its assigned AI results');
        exchangeBy(state, packet.exchangeId).rolls ||= []; exchangeBy(state, packet.exchangeId).rolls!.push({ id: step.rollId, ...roll }); note(events, 'ai-roll', `Program audited ${step.rollId}`, undefined); events.at(-1)!.rolls = [roll];
      }
      if (result) { state = result.state; events.push(...result.events); }
      exchange = exchangeBy(state, packet.exchangeId); receipt = records(exchange)[packet.payload.decisionId]; receipt.next = index + 1;
      if (pool && pool.id !== 'missing') receipt.used.push(pool.id);
      if (result) for (const [eventIndex, event] of result.events.entries()) for (const [rollIndex, roll] of (event.rolls || []).entries()) { exchange.rolls ||= []; exchange.rolls.push({ id: `${step.id}:${eventIndex}:${rollIndex}`, ...roll }); }
      if (state.choices.length) { receipt.reaction = state.choices.find(choice => typeof choice.payload.aiResolutionRef === 'string')?.payload.aiResolutionRef as string | undefined || attachReaction(state, packet.exchangeId, packet.payload.decisionId, step.id, pool); records(exchangeBy(state, packet.exchangeId))[packet.payload.decisionId] = receipt; note(events, 'ai-paused', 'AI batch paused at a rule choice; remaining steps were saved'); return { state, events }; }
      if (pool) assert(pool.offset === pool.rolls.length, 'AI_DICE_USAGE', 'AI supplied extra dice that this step did not consume');
    }
    if (!receipt.narratives) for (const narrative of packet.payload.narratives || []) state.world!.ai.narratives.push({ id: uid(), text: narrative.text, actorIds: narrative.actorIds });
  }
  exchange = exchangeBy(state, packet.exchangeId); receipt = records(exchange)[packet.payload.decisionId]; receipt.status = 'applied'; receipt.narratives = true;
  if (!exchange.appliedDecisionIds.includes(packet.payload.decisionId)) exchange.appliedDecisionIds.push(packet.payload.decisionId);
  note(events, 'ai-decision', 'External AI decision applied once: ' + packet.payload.decisionId); return { state, events };
}

export function previewAiPacket(state: GameState, value: unknown, ctx: AiContext): { valid: boolean; errors: string[]; summary: string[]; packet?: AiReply } {
  try {
    const packet = packetInput(value), receipt = inspect(state, packet, ctx);
    if (packet.packetType === 'initialize' && !receipt) initialize(state, packet, { ...ctx, dice: () => { throw new RuleError('AI_PREVIEW_DICE', 'Preview must not consume random dice'); } });
    return { valid: true, errors: [], summary: [receipt?.status === 'applied' ? 'Already applied; import is an idempotent no-op.' : packet.packetType === 'initialize' ? `Initialize world; ${(packet.payload.characters || []).length} unclaimed character offers; ${(packet.payload.npcs || []).length + (packet.payload.monsters || []).length} NPCs.` : `${(packet.payload.steps || []).length} game-effect steps; ${(packet.payload.narratives || []).length} narratives; ${state.world!.ai.diceSource} dice.`, 'External rulings require owner confirmation. Private notes and membership are not AI-authoritative.'], packet };
  } catch (error) { return { valid: false, errors: error instanceof z.ZodError ? error.issues.map(issue => issue.path.join('.') + ': ' + issue.message) : [error instanceof Error ? error.message : String(error)], summary: [] }; }
}

/** Server-only: a choice carries an opaque reference; actual future dice stay in private AI exchange data. */
export function resolveAiReaction(input: GameState, command: Command, dice: Dice, resolveEngine: (state: GameState, command: Command, dice: Dice) => Resolution): Resolution {
  const choice = command.type === 'choice.resolve' ? input.choices.find(choice => choice.id === command.payload?.choiceId) : undefined, ref = choice?.payload.aiResolutionRef as string | undefined;
  if (!ref) return resolveEngine(input, command, dice);
  assert(choice!.options.some(option => option.id === command.payload?.optionId), 'AI_CHOICE', 'Invalid reaction option');
  const working = structuredClone(input), found = reactionBy(working, ref), supplied = providers.get(dice), originalPool = supplied || found.record.pool, pool = originalPool ? structuredClone(originalPool) : undefined, source = pool ? provider(pool) : dice;
  try {
    const result = resolveEngine(working, command, source), current = reactionBy(result.state, ref); current.record.pool = pool; delete current.record.requested;
    for (const pending of result.state.choices) if (!pending.payload.aiResolutionRef) pending.payload.aiResolutionRef = ref;
    current.record.done = !result.state.choices.some(choice => choice.payload.aiResolutionRef === ref);
    if (supplied && pool) supplied.offset = pool.offset;
    return result;
  } catch (error) {
    if (!(error instanceof RuleError) || error.code !== 'AI_DICE_NEEDED' || supplied) throw error;
    found.record.requested = { choiceId: choice!.id, optionId: String(command.payload?.optionId), side: Number(error.message.match(/d(\d+)/)?.[1] || 20) };
    return { state: working, events: [{ type: 'ai-dice-needed', actorId: choice!.actorId, message: 'Player reaction recorded; owner must export context and supply correctly ordered AI dice before continuing.', source: 'jigerpg-ai/v1' }] };
  }
}
/** Resume only a previously owner-confirmed, byte-identical private continuation. */
export function resumeAiDecisions(input: GameState, ctx: AiContext): Resolution {
  let state = structuredClone(input); const events: Log = [];
  if (state.choices.length) return { state, events };
  for (const exchange of state.world?.ai.exchanges || []) for (const [decisionId, receipt] of Object.entries((exchange.payload._decisions || {}) as Record<string, Receipt>)) if (receipt.status === 'pending' && receipt.reaction) {
    try { const result = applyAiPacket(state, JSON.parse(receipt.canonical), ctx); state = result.state; events.push(...result.events); }
    catch (error) { const failed = records(exchangeBy(state, exchange.id))[decisionId]; failed.status = 'failed'; failed.error = error instanceof Error ? error.message : String(error); note(events, 'ai-continuation-failed', 'AI continuation stopped atomically: ' + failed.error); }
    if (state.choices.length) return { state, events };
  }
  return { state, events };
}
