import { randomBytes, createHash, timingSafeEqual, randomInt } from 'node:crypto';
import type { Actor, Command, GameState, Member } from '../shared/model.js';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function equalSecret(a: unknown, b: string) { if (typeof a !== 'string') return false; const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
export const cryptoDice = (sides: number) => { if (!Number.isInteger(sides) || sides < 2 || sides > 1_000_000) throw new Error('骰面无效'); return randomInt(1, sides + 1); };
export class ApiError extends Error { constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); } }

export class RateLimiter {
  private buckets = new Map<string, { count: number; reset: number }>();
  check(key: string, limit: number, duration = 60_000) {
    const now = Date.now();
    if (this.buckets.size > 10_000) for (const [k,v] of this.buckets) if (v.reset <= now) this.buckets.delete(k);
    if (this.buckets.size > 20_000) throw new ApiError(429, 'rate_limit', '请求过于频繁，请稍后重试');
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset <= now) { bucket = { count: 0, reset: now + duration }; this.buckets.set(key, bucket); }
    if (++bucket.count > limit) throw new ApiError(429, 'rate_limit', '请求过于频繁，请稍后重试');
  }
}

const GM_COMMANDS = new Set(['actor.delete', 'inventory.add', 'inventory.component', 'effect.add', 'effect.remove', 'gm.adjust', 'gm.pause', 'gm.undo', 'gm.poisonExposure', 'gm.itemTiming', 'scene.update', 'combat.start', 'combat.next', 'combat.end']);
const PLAYER_COMMANDS = new Set(['actor.create', 'actor.update', 'actor.levelup', 'inventory.equip', 'inventory.consume', 'action.use', 'actor.move', 'actor.rest', 'actor.deathSave', 'choice.resolve']);
const BUILD_KEYS = new Set(['name','abilities','classes','speciesId','backgroundId','skills','expertise','saveProficiencies','languages','spells','features','portrait','notes','choices','draft']);
const PLAYER_CHOICES = new Set(['characterBuild','magicInitiate','weaponMasteries','ownerActorId','parentActorId','startingEquipment']);
function playerChoices(value:unknown,levelup=false){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'invalid_choices','建卡选择必须为对象');
  return Object.fromEntries(Object.entries(value).filter(([key])=>PLAYER_CHOICES.has(key)||levelup&&key==='featId'));
}

export function authorizeCommand(state: GameState, command: Command, member: Member, options: {allowPlayerFinalization?:boolean} = {}) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) throw new ApiError(400, 'invalid_command', '指令格式无效');
  if (typeof command.operationId !== 'string' || !/^[A-Za-z0-9_:-]{8,128}$/.test(command.operationId)) throw new ApiError(400, 'invalid_operation', '操作编号无效');
  if (!Number.isSafeInteger(command.expectedRev) || command.expectedRev < 0) throw new ApiError(400, 'invalid_revision', '版本号无效');
  if (!GM_COMMANDS.has(command.type) && !PLAYER_COMMANDS.has(command.type)) throw new ApiError(400, 'unknown_command', '不支持的指令');
  if (member.role === 'gm') return;
  if (GM_COMMANDS.has(command.type)) throw new ApiError(403, 'gm_only', '只有主持人可以执行此操作');
  if (command.type === 'actor.create') {
    const supplied: any = command.payload?.actor || command.payload || {};
    if(Object.hasOwn(supplied,'monsterId'))throw new ApiError(403,'gm_only','只有主持人可以授予怪物数据随从');
    const input: any = Object.fromEntries(Object.entries(supplied).filter(([key])=>BUILD_KEYS.has(key)||key==='kind'));
    command.payload=input;
    input.ownerId = member.id;
    input.kind = input.kind === 'companion' ? 'companion' : 'hero';
    input.hidden = false;
    if(input.choices)input.choices=playerChoices(input.choices);
    if(!options.allowPlayerFinalization)input.draft=true;
    return;
  }
  if (command.type === 'choice.resolve') {
    const choiceId = String(command.payload?.choiceId || command.payload?.id || '');
    const choice = state.choices.find(c => c.id === choiceId);
    if (!choice || choice.ownerId !== member.id) throw new ApiError(403, 'ownership', '不能处理他人的选择');
    return;
  }
  const actor = state.actors.find(a => a.id === command.actorId);
  if (!actor || actor.ownerId !== member.id) throw new ApiError(403, 'ownership', '只能操作自己的角色');
  if(['action.use','inventory.consume'].includes(command.type)){
    const payload=command.payload||{},rollOptions=payload.options as Record<string,unknown>|undefined;
    if([payload.advantage,payload.saveAdvantage,rollOptions?.advantage,rollOptions?.saveAdvantage].some(value=>value!==undefined&&value!==null&&value!==0))throw new ApiError(403,'gm_roll_adjudication','优势、劣势由规则效果自动计算；特殊情况请由主持人代角色裁定');
    if(payload.saveAbility!==undefined||rollOptions?.saveAbility!==undefined)throw new ApiError(403,'defender_save_choice','不能替目标选择豁免属性；规则引擎自动处理，特殊情况请由主持人裁定');
  }
  if(command.type==='actor.levelup'&&actor.kind==='companion'&&actor.choices?.monsterId)throw new ApiError(403,'statblock_levelup','怪物数据随从不能通过主角职业升级；请由主持人重新匹配数据');
  if (command.type === 'actor.update') {
    const patch: any = command.payload?.patch || command.payload || {};
    const allowed = actor.draft ? BUILD_KEYS : new Set(['name','portrait','notes',...(options.allowPlayerFinalization?['spells']:[])]);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new ApiError(403, 'protected_field', `该字段由规则引擎管理：${key}`);
    if(Object.hasOwn(patch,'choices'))patch.choices={...actor.choices,...playerChoices(patch.choices)};
    if((patch.draft===false||command.payload?.activate)&&!options.allowPlayerFinalization)throw new ApiError(409,'build_review_required','此建卡路径的来源验证尚未完成，需要主持人审核后激活');
  }
  if(command.type==='actor.levelup'&&command.payload?.choices)command.payload.choices=playerChoices(command.payload.choices,true);
  if(actor.draft&&!['actor.update','actor.levelup'].includes(command.type))throw new ApiError(409,'draft_actor','请完成建卡验证或由主持人审核激活角色');
  if (state.paused) throw new ApiError(409, 'paused', '主持人已暂停游戏');
}

/** Enforce confidentiality independently of UI and engine implementation. */
export function confidentialProjection(input: GameState, member: Member): GameState {
  if (member.role === 'gm') return structuredClone(input);
  const state = structuredClone(input);
  const visible = new Set(state.actors.filter(a => !a.hidden||a.ownerId===member.id).map(a => a.id));
  state.actors = state.actors.filter(a => visible.has(a.id)).map(a => {
    a.effects=a.effects.filter(effect=>!effect.gmOnly);
    if (a.ownerId === member.id) return a;
    const clean: Actor = { ...a, notes: '', choices: undefined, migrationIssues: undefined, migrationId: undefined };
    return clean;
  });
  state.choices = state.choices.filter(c => c.ownerId === member.id && visible.has(c.actorId));
  const activeActorId=state.combat.order[state.combat.turn];
  state.combat.order = state.combat.order.filter(id => visible.has(id));
  state.combat.turn=state.combat.active?state.combat.order.indexOf(activeActorId):Math.max(0,state.combat.order.indexOf(activeActorId));
  state.combat.budgets = Object.fromEntries(Object.entries(state.combat.budgets).filter(([id]) => visible.has(id)));
  state.events = state.events.filter(e => !e.gmOnly && (!e.actorId || visible.has(e.actorId))&&(e.type!=='inventory'||!!e.actorId&&state.actors.some(a=>a.id===e.actorId&&a.ownerId===member.id))).map(e => ({ ...e, changes: undefined }));
  return state;
}
