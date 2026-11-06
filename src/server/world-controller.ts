import { randomUUID } from 'node:crypto';
import type { Actor, Command, GameState, Member, Resolution, Snapshot } from '../shared/model';
import { CAPABILITIES, type Capability, type DisclosureGroup, type WorldView } from '../shared/world';
import { ApiError } from './security';
import { validateTokenPosition } from '../engine/map';
import { tokenFootprint } from '../engine/size';

const TYPES = new Set(['character.create', 'character.claim', 'character.register', 'character.release', 'character.patch', 'profile.update', 'knowledge.unlock']);
export const isCharacterCommand = (type: string) => TYPES.has(type);
export function validateWorldEnvelope(command: Command) {
  if (!command || typeof command !== 'object' || typeof command.operationId !== 'string' || !/^[A-Za-z0-9_:-]{8,128}$/.test(command.operationId)) throw new ApiError(400, 'invalid_operation', '操作编号无效');
  if (!Number.isSafeInteger(command.expectedRev) || command.expectedRev < 0 || typeof command.type !== 'string') throw new ApiError(400, 'invalid_revision', '操作版本无效');
}
export function capabilities(state: GameState, member: Member): Capability[] {
  const world = state.world; if (!world) return member.role === 'gm' ? [...CAPABILITIES] : [];
  if (member.id === world.ownerId) return [...CAPABILITIES];
  return world.mode === 'co-create' && world.governance.system === 'dictatorship' ? world.governance.delegations[member.id] || [] : [];
}
function permission(state: GameState, member: Member, capability: Capability, runtime = true) {
  const w = state.world!;
  const allowed = capabilities(state, member).includes(capability);
  if (!allowed || runtime && w.phase === 'running' && (w.mode === 'ai' || w.mode === 'co-create' && w.governance.system === 'democracy') && capability === 'manage.characters') throw new ApiError(403, 'world_permission', '当前模式下此修改需要GM决策或通过提案，不能直接改值');
}
function finite(value: unknown, label: string, min = -1e9, max = 1e9) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new ApiError(400, 'invalid_value', `${label}不是允许范围内的有限数值`); return value; }
function picture(value: unknown): string { if (value === '' || value === undefined || value === null) return ''; if (typeof value !== 'string' || value.length > 3_000_000 || !/^(https:\/\/|data:image\/(png|jpe?g|webp|gif);base64,|\/api\/assets\/)/i.test(value)) throw new ApiError(400, 'invalid_portrait', '头像必须是HTTPS图片或已上传图片'); return value; }
function actorBy(state: GameState, id: unknown) { const a = state.actors.find(a => a.id === id); if (!a) throw new ApiError(404, 'actor_missing', '角色不存在'); return a; }
function vacantPosition(state: GameState, actor: Actor, engine: any) {
  const occupied = state.actors.filter(a => a.id !== actor.id && !a.dead && !a.draft && (a.kind !== 'hero' || a.registration === 'registered'));
  for (let y = 0; y < state.scene.height; y++) for (let x = 0; x < state.scene.width; x++) {
    const position = { x, y };
    try { validateTokenPosition(state.scene, actor, position, occupied); return position; } catch { /* next candidate */ }
  }
  throw new ApiError(409, 'scene_full', '场景没有可容纳角色的空位，请先调整场景');
}
function validateFreePatch(patch: Record<string, any>) {
  if (Object.hasOwn(patch, 'manual') && (!patch.manual || typeof patch.manual !== 'object' || Array.isArray(patch.manual))) throw new ApiError(400, 'invalid_manual', '手动数值必须为对象');
  if (Object.hasOwn(patch, 'hp') && (!patch.hp || typeof patch.hp !== 'object' || Array.isArray(patch.hp))) throw new ApiError(400, 'invalid_hp', '生命数值必须为对象');
  if (patch.size !== undefined) finite(patch.size, '体型', 0.25, 4);
  for (const [key, value] of Object.entries(patch.abilities || {})) { if (!['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(key)) throw new ApiError(400, 'invalid_ability', '未知基础属性'); finite(value, key); }
  if (patch.manual) for (const [key, value] of Object.entries(patch.manual)) finite(value, key, key === 'maxHp' ? 0.000001 : 0);
  if (patch.hp) { for (const [key, value] of Object.entries(patch.hp)) { if (!['current', 'max', 'temp'].includes(key)) throw new ApiError(400, 'invalid_hp', '未知生命字段'); finite(value, key, 0); } }
  if (patch.resources) {
    if (!Array.isArray(patch.resources) || patch.resources.length > 1000) throw new ApiError(400, 'invalid_resources', '资源列表无效');
    const ids = new Set(); for (const r of patch.resources) { if (!r || typeof r.id !== 'string' || ids.has(r.id)) throw new ApiError(400, 'invalid_resources', '资源编号无效或重复'); ids.add(r.id); finite(r.max, '资源上限', 0, r.id === 'ap' ? 100 : 1e9); finite(r.current, '当前资源', 0, r.max); if (!['short', 'long', 'turn', 'manual'].includes(r.recovery)) throw new ApiError(400, 'invalid_resources', '资源恢复方式无效'); }
  }
}
export function resolveCharacterCommand(input: GameState, command: Command, member: Member, members: Member[], engine: any, now = Date.now()): Resolution {
  const state = structuredClone(input), w = state.world!; if (!w) throw new ApiError(400, 'world_required', '此房间尚未启用新角色流程');
  const p = command.payload || {}, id = command.actorId || p.actorId;
  let changed: Actor | undefined; let message = '';
  switch (command.type) {
    case 'character.create': {
      permission(state, member, 'manage.characters', false);
      const supplied = p.actor && typeof p.actor === 'object' ? structuredClone(p.actor) as Record<string, any> : {};
      if (w.phase === 'running' && w.mode !== 'gm' && !(w.mode === 'co-create' && w.governance.system === 'dictatorship')) {
        if (Object.keys(supplied).some(key => !['name', 'portrait', 'story'].includes(key))) throw new ApiError(403, 'proposal_required', '开局后的自定义数值需要通过当前模式的决策');
      }
      validateFreePatch(supplied);
      const kind = ['hero', 'companion', 'monster'].includes(supplied.kind) ? supplied.kind : 'hero';
      if (kind !== 'hero' && w.phase === 'running' && w.mode !== 'gm' && !(w.mode === 'co-create' && w.governance.system === 'dictatorship')) throw new ApiError(403, 'proposal_required', 'NPC与怪物必须经当前模式的决策创建');
      changed = engine.createActor({ ...supplied, id: randomUUID(), ownerId: w.ownerId, name: String(supplied.name || `${kind === 'hero' ? '角色' : '生物'} ${state.actors.length + 1}`).slice(0, 80), kind, profile: supplied.profile === 'srd2024' ? 'srd2024' : 'free', requestedBy: undefined, hidden: kind === 'hero' ? true : Boolean(supplied.hidden), draft: supplied.profile === 'srd2024' ? Boolean(supplied.draft ?? true) : false, portrait: picture(supplied.portrait), publicGroups: [], knownEntries: [] }) as Actor;
      if (kind === 'hero') changed.registration = 'available'; changed.hidden = kind === 'hero' ? true : Boolean(supplied.hidden); changed.publicGroups = []; changed.knownEntries = [];
      state.actors.push(changed); message = `创建了待领取角色「${changed.name}」`; break;
    }
    case 'character.claim': {
      changed = actorBy(state, id);
      if (state.actors.some(a => a.kind === 'hero' && (a.ownerId === member.id && a.registration === 'registered' || a.requestedBy === member.id))) throw new ApiError(409, 'already_claimed', '你已领取或正在申请一个角色');
      if (changed.kind !== 'hero' || changed.registration !== 'available') throw new ApiError(409, 'character_taken', '这个角色已被领取或正在等待确认');
      changed.registration = 'requested'; changed.requestedBy = member.id; message = `${member.name}申请领取「${changed.name}」`; break;
    }
    case 'character.register': {
      permission(state, member, 'manage.members', false); changed = actorBy(state, id);
      const target = String(p.memberId || changed.requestedBy || '');
      if (!members.some(m => m.id === target) || changed.kind !== 'hero') throw new ApiError(400, 'invalid_registration', '请选择该房间成员和主角');
      if (p.approved === false) { changed.registration = 'available'; delete changed.requestedBy; message = '角色领取申请已退回'; break; }
      if (!['available', 'requested'].includes(changed.registration || '') || state.actors.some(a => a.id !== changed!.id && a.kind === 'hero' && a.ownerId === target && a.registration === 'registered')) throw new ApiError(409, 'already_registered', '该角色或该成员已有注册绑定');
      const problems = [...engine.validateActor(changed), ...(changed.profile === 'free' ? [] : engine.validateBuild(changed))];
      if (problems.length) throw new ApiError(400, 'invalid_character', problems.join('；'));
      changed.ownerId = target; changed.registration = 'registered'; changed.hidden = false; changed.draft = false; delete changed.requestedBy;
      changed.position = vacantPosition(state, changed, engine);
      if (w.rules.energy && changed.profile === 'free') { let ap = changed.resources.find(r => r.id === 'ap'); if (!ap) { ap = { id: 'ap', name: '行动力', current: 0, max: 0, recovery: 'manual' }; changed.resources.push(ap); } const previous = Object.hasOwn(w.energyAt, changed.id); ap.max = w.rules.energy.maximum; ap.current = Math.min(ap.max, previous ? ap.current : w.rules.energy.initial ?? ap.max); w.energyAt[changed.id] = now; }
      message = `角色「${changed.name}」已注册`; break;
    }
    case 'character.release': {
      permission(state, member, 'manage.members', false); changed = actorBy(state, id);
      if (w.round.phase === 'planning' && w.round.intents.some(i => i.actorId === changed!.id && i.status === 'planned' || i.actorId === changed!.id && i.status === 'approved')) throw new ApiError(409, 'pending_intent', '请先处理该角色本轮行动');
      changed.registration = 'available'; changed.ownerId = w.ownerId; changed.hidden = true; delete changed.requestedBy; message = `角色「${changed.name}」已归还角色池`; break;
    }
    case 'character.patch': {
      permission(state, member, 'manage.characters'); changed = actorBy(state, id);
      const patch = structuredClone(p.patch) as Record<string, any>;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ApiError(400, 'invalid_patch', '修改必须为对象');
      const allowed = new Set(['name', 'story', 'notes', 'abilities', 'manual', 'resources', 'customActions', 'hp', 'portrait', 'size', 'inventory', 'resistances', 'immunities', 'vulnerabilities', 'classes', 'speciesId', 'backgroundId', 'skills', 'expertise', 'features', 'spells', 'choices', 'draft']);
      if (Object.keys(patch).some(key => !allowed.has(key))) throw new ApiError(403, 'protected_field', '不能通过改值修改角色归属、注册或权限');
      validateFreePatch(patch); if (patch.portrait !== undefined) patch.portrait = picture(patch.portrait);
      if (patch.manual) patch.manual = { ...changed.manual, ...patch.manual };
      Object.assign(changed, patch);
      if (changed.profile === 'free') { changed.hp.max = changed.manual!.maxHp; changed.hp.current = Math.min(changed.hp.current, changed.hp.max); }
      const problems = engine.validateActor(changed); if (problems.length && !changed.draft) throw new ApiError(400, 'invalid_character', problems.join('；'));
      message = `更新角色「${changed.name}」`; break;
    }
    case 'profile.update': {
      changed = actorBy(state, id);
      if (changed.ownerId !== member.id && changed.requestedBy !== member.id) throw new ApiError(403, 'ownership', '只能设置自己角色的头像与公开范围');
      if (p.portrait !== undefined) changed.portrait = picture(p.portrait);
      if (p.publicGroups !== undefined) { if (!Array.isArray(p.publicGroups) || p.publicGroups.some(g => !['story', 'stats', 'skills', 'equipment'].includes(String(g)))) throw new ApiError(400, 'invalid_groups', '公开分组无效'); changed.publicGroups = [...new Set(p.publicGroups)] as DisclosureGroup[]; }
      message = '更新了角色展示设置'; break;
    }
    case 'knowledge.unlock': {
      permission(state, member, 'manage.knowledge'); changed = actorBy(state, id);
      if (typeof p.entryId !== 'string') throw new ApiError(400, 'entry_required', '请选择图鉴条目'); changed.knownEntries = [...new Set([...(changed.knownEntries || []), p.entryId])]; message = `为「${changed.name}」解锁了知识`; break;
    }
    default: throw new ApiError(400, 'unknown_command', '角色指令不存在');
  }
  return { state, events: [{ type: command.type, actorId: changed?.id, message, gmOnly: ['character.claim', 'character.patch', 'knowledge.unlock'].includes(command.type) }] };
}

export function projectWorld(raw: GameState, session: Snapshot['session'], members: Member[], engine: any): Pick<Snapshot, 'state' | 'world' | 'tokens' | 'offers' | 'profiles' | 'actorViews'> {
  const w = raw.world!, owner = session.member.id === w.ownerId;
  const manageCards = owner || capabilities(raw, session.member).includes('manage.characters');
  const manageMembers = owner || capabilities(raw, session.member).includes('manage.members');
  const projected: GameState = engine.projectState ? engine.projectState(structuredClone(raw), session.member) : structuredClone(raw);
  const allowed = new Set(projected.actors.map(a => a.id));
  const own = raw.actors.filter(a => a.ownerId === session.member.id && (a.registration === 'registered' || a.kind === 'companion'));
  const world: WorldView = {
    version: 1, ownerId: w.ownerId, mode: w.mode, governance: structuredClone(w.governance), phase: w.phase, gameplayRev: w.gameplayRev,
    lore: w.lore, ...(owner ? { secretLore: w.secretLore } : {}), rules: structuredClone(w.rules),
    round: { ...structuredClone(w.round), intents: w.round.intents.filter(i => owner || i.memberId === session.member.id).map(i => structuredClone(i)) },
    drafts: w.drafts.filter(d => d.ownerId === session.member.id).map(d => structuredClone(d)),
    proposals: structuredClone(w.proposals), timeoutVotes: { [session.member.id]: w.timeoutVotes[session.member.id] || 'abstain' },
    items: structuredClone(w.items), nodes: w.nodes.filter(n => owner || !n.hidden).map(n => structuredClone(n)), ...(owner ? { npcBehaviors: structuredClone(w.npcBehaviors) } : {}), energyAt: Object.fromEntries(Object.entries(w.energyAt).filter(([id]) => owner || own.some(a => a.id === id))),
    ai: { diceSource: w.ai.diceSource, narratives: w.ai.narratives.filter(n => owner || !n.actorIds?.length || n.actorIds.some(id => own.some(a => a.id === id))).map(n => structuredClone(n)), ...(owner ? { exchanges: structuredClone(w.ai.exchanges) } : {}) }, capabilities: capabilities(raw, session.member),
  };
  const state = structuredClone(raw); delete state.world;
  state.actors = manageCards ? structuredClone(raw.actors).map(a => { if (!owner && a.ownerId !== session.member.id) a.notes = ''; return a; }) : structuredClone(own);
  state.choices = state.choices.filter(c => owner || c.ownerId === session.member.id || own.some(a => a.id === c.actorId));
  state.events = state.events.filter(e => owner || !e.gmOnly && (!e.actorId || allowed.has(e.actorId))).map(e => ({ ...e, changes: owner ? e.changes : undefined }));
  if (!owner) { const active = state.combat.order[state.combat.turn]; state.combat.order = state.combat.order.filter(id => allowed.has(id)); state.combat.turn = Math.max(0, state.combat.order.indexOf(active)); state.combat.budgets = Object.fromEntries(Object.entries(state.combat.budgets).filter(([id]) => allowed.has(id))); state.events = state.events.filter(e => !e.targetIds?.some(id => !allowed.has(id))); }
  const visible = raw.actors.filter(a => allowed.has(a.id) && (!a.hidden || owner || a.ownerId === session.member.id) && (a.kind !== 'hero' || a.registration === 'registered'));
  const tokens = visible.map(a => ({ id: a.id, name: a.name, kind: a.kind, ownerId: a.ownerId, position: structuredClone(a.position), size: tokenFootprint(a), hidden: a.hidden, portrait: a.portrait, dead: a.dead, conditions: a.effects.filter(e => !e.gmOnly && e.condition).map(e => e.condition!), ...((owner || a.ownerId === session.member.id || a.publicGroups?.includes('stats')) ? { hp: structuredClone(a.hp) } : {}) }));
  const profiles = visible.map(a => {
    const groups = a.publicGroups || [], d = engine.deriveActor(a);
    return { id: a.id, name: a.name, portrait: a.portrait, ownerId: a.ownerId, groups, ...(groups.includes('story') ? { story: a.story || '' } : {}), ...(groups.includes('stats') ? { stats: { abilities: structuredClone(a.abilities), hp: structuredClone(a.hp), resources: structuredClone(a.resources), ac: d.ac, speed: d.speed } } : {}), ...(groups.includes('skills') ? { skills: { actions: structuredClone(a.customActions || []), skills: [...a.skills], spells: [...a.spells] } } : {}), ...(groups.includes('equipment') ? { equipment: structuredClone(a.inventory) } : {}) };
  });
  const offers = raw.actors.filter(a => a.kind === 'hero' && (manageMembers || a.registration === 'available' || a.registration === 'requested' && a.requestedBy === session.member.id)).map(a => ({ id: a.id, name: a.name, portrait: a.portrait, story: String(a.choices?.offerDescription || ''), requestedBy: a.requestedBy, registration: a.registration }));
  const actorViews = Object.fromEntries(state.actors.map(a => [a.id, engine.deriveActor(a)]));
  return { state, world, tokens, offers, profiles, actorViews };
}
