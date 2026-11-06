import { createHash, randomUUID } from 'node:crypto';
import { ABILITIES, type Actor } from '../shared/model';
import { deriveActor, effectModifier, FREE_NUMBER_LIMIT, levelOf, maximumHp } from './actors';
import { featureActions, extraSpeed } from './feature-rules';
import { itemBaseEquipment, itemBonuses } from './item-effects';
import { lookup } from '../content';
import { assert } from './dice';

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
function worn(actor: Actor) {
  const equipment = actor.inventory.filter(item => item.equipped).map(item => lookup('equipment', itemBaseEquipment(item) || item.contentId)).filter(Boolean);
  return { armor: equipment.filter(item => item.armor_class && item.index !== 'shield'), shield: equipment.some(item => item.index === 'shield') };
}
function unrestrictedSpeed(actor: Actor): number {
  const copy = structuredClone(actor), stopped = ['grappled', 'restrained', 'paralyzed', 'petrified', 'stunned', 'unconscious'];
  for (const effect of copy.effects) {
    if (effect.condition && stopped.includes(effect.condition)) delete effect.condition;
    if (effect.sourceId && stopped.includes(effect.sourceId)) effect.sourceId = `copy-speed-probe:${effect.id}`;
    if (effect.modifiers) delete effect.modifiers.speedMaximum;
  }
  return deriveActor(copy).speed;
}

/** Server-side, copy-only conversion. Source rule references stay native; this never converts spells to generic custom damage. */
export function createFreeCopy(source: Actor): Actor {
  assert(source && typeof source === 'object' && source.id, 'COPY_SOURCE', '请选择有效的原角色');
  const originalHash = createHash('sha256').update(JSON.stringify(source)).digest('hex'), original = deriveActor(source), copy = structuredClone(source);
  const issues: string[] = [...(copy.migrationIssues || [])], issue = (message: string) => { if (!issues.includes(message)) issues.push(message); };
  copy.id = randomUUID(); copy.name = `${source.name}（自由副本）`.slice(0, 100); copy.profile = 'free'; copy.kind = 'hero'; copy.draft = false;
  copy.registration = 'available'; copy.hidden = true; copy.publicGroups = []; copy.knownEntries = []; delete copy.requestedBy; delete copy.initiative;
  copy.choices ||= {};
  Object.assign(copy.choices, {
    copySourceActorId: source.id, copySourceProfile: source.profile || 'srd2024', copySourceKind: source.kind,
    copySourceHash: originalHash, copySourceRootActorId: source.choices?.copySourceRootActorId || source.choices?.copySourceActorId || source.id,
  });
  const parent = copy.choices.parentActorId ?? copy.choices.ownerActorId ?? copy.choices.legacyOwnerId;
  if (parent !== undefined) copy.choices.copySourceParentActorId = parent;
  for (const key of ['parentActorId', 'ownerActorId', 'legacyOwnerId', '_worldJobs', '_worldNpcRound', '_worldWaypoint']) delete copy.choices[key];
  for (const effect of copy.effects) if (effect.sourceActorId === source.id) effect.sourceActorId = copy.id;

  if (source.profile !== 'free') {
    // The standard score cap must not become an accidental buff when the free profile removes it.
    for (const ability of ABILITIES) {
      const bonus = effectModifier(source, ability), adjusted = Math.max(0, Math.min(30, source.abilities[ability] + bonus)) - bonus;
      copy.abilities[ability] = Math.max(-FREE_NUMBER_LIMIT, Math.min(FREE_NUMBER_LIMIT, adjusted));
      if (copy.abilities[ability] !== source.abilities[ability]) issue(`${ability}基础值已为原规则0至30有效值范围校准；临时属性效果结束后请核对基础值。`);
    }
    const gear = worn(source), armor = gear.armor[0], dexterity = original.modifiers.dex;
    const ac = armor ? armor.armor_class.base + (armor.armor_class.dex_bonus ? Math.min(dexterity, armor.armor_class.max_bonus ?? Infinity) : 0) - Math.max(0, armor.armor_class.base - 10) : source.baseAc ?? 10 + dexterity;
    const maximum = source.hp.max - effectModifier(copy, 'maxHp');
    const monkSpeed = !gear.armor.length && !gear.shield && levelOf(source, 'monk') ? lookup('levels', `monk-${levelOf(source, 'monk')}`)?.class_specific?.unarmored_movement_bonus || 0 : 0;
    const classSpeed = extraSpeed(source, gear.armor.some(item => item.equipment_categories?.some((entry: any) => entry.index === 'heavy-armor')));
    const speed = (source.speedOverride ?? source.baseSpeed ?? lookup('species', source.speciesId)?.speed ?? 30) + monkSpeed + classSpeed;
    copy.manual = { maxHp: Math.max(1, maximum), proficiency: original.proficiency, ac, speed: Math.max(0, speed) };
    if (maximum < 1) issue(`原生命上限${source.hp.max}与保留的最大生命效果不一致，手动基础已设为1，无法精确等价。`);
    if (source.speedOverride !== undefined) copy.speedOverride = Math.max(0, speed);
    const desiredSpeed = unrestrictedSpeed(source), multiplier = itemBonuses(copy).speedMultiplier;
    for (let attempt = 0; attempt < 3 && multiplier > 0; attempt++) {
      const delta = desiredSpeed - unrestrictedSpeed(copy); if (near(delta, 0)) break;
      if (copy.speedOverride !== undefined) copy.speedOverride = Math.max(0, copy.speedOverride + delta / multiplier);
      else copy.manual.speed = Math.max(0, copy.manual.speed + delta / multiplier);
    }
    // Free profiles intentionally do not generate class feature actions. Preserve only those references,
    // retaining their original source/id so Second Wind, teleportation and resource hooks still execute.
    const existing = new Set([...(copy.monsterActions || []), ...(copy.customActions || [])].map(action => action.id));
    for (const action of featureActions(source)) if (!existing.has(action.id)) { (copy.monsterActions ||= []).push(structuredClone(action)); existing.add(action.id); }
    copy.choices.copyPreservedFeatureActionIds = featureActions(source).map(action => action.id);
    issue('职业、种族、法术与装备引用及原资源余额均已保留；生命、熟练与速度转为当前手动基准，之后更改职业等级不会自动重建这些池或补满资源。');
    if (monkSpeed || classSpeed) issue(`已将当前职业速度加成${monkSpeed + classSpeed}尺计入手动速度；以后更换盔甲或职业等级时请核对该项。`);
    if (itemBonuses(source).abilityMinimums.con && source.classes.length) issue('当前体质装备对职业生命上限的影响已计入手动生命基准；更换该装备时请核对生命上限。');
  } else copy.manual = source.manual ? structuredClone(source.manual) : { maxHp: source.hp.max - effectModifier(source, 'maxHp'), proficiency: original.proficiency, ac: original.ac, speed: original.speed };

  const current = deriveActor(copy);
  // AC overrides remain before item/effect bonuses, exactly as in the original resolver.
  if (!near(current.ac, original.ac) && source.acOverride === undefined) {
    copy.manual!.ac += original.ac - current.ac;
    if (!near(deriveActor(copy).ac, original.ac)) issue(`护甲等级无法精确等价：原${original.ac}，副本${deriveActor(copy).ac}；保留装备与效果，请主持人复核。`);
  }
  copy.hp.max = maximumHp(copy); copy.hp.current = Math.max(0, Math.min(source.hp.current, copy.hp.max));
  const derived = deriveActor(copy);
  for (const [label, actual, expected] of [['生命上限', derived.maxHp, source.hp.max], ['护甲等级', derived.ac, original.ac], ['速度', derived.speed, original.speed], ['熟练加值', derived.proficiency, original.proficiency]] as const) if (!near(actual, expected)) issue(`${label}无法精确等价：原${expected}，副本${actual}。`);
  for (const ability of ABILITIES) if (!near(derived.modifiers[ability], original.modifiers[ability])) issue(`${ability}调整值无法精确等价：原${original.modifiers[ability]}，副本${derived.modifiers[ability]}。`);
  const missing = original.attacks.filter(action => !derived.attacks.some(copyAction => copyAction.id === action.id));
  for (const action of missing) issue(`动作「${action.name}」(${action.id})未能保留原引用，请主持人复核。`);
  for (const action of original.attacks.filter(action => action.automation === 'unsupported' || action.automation === 'adjudication')) issue(`动作「${action.name}」仍保持原${action.automation === 'unsupported' ? '尚未自动化' : '需要裁定'}状态，复制不会把它变成自动结算。`);
  if (source.concentration) issue('专注及本卡效果已保留，原角色施加在其他角色上的效果没有复制；请主持人核对跨角色专注关系。');
  if (source.kind !== 'hero') issue('副本已作为待领取主角保存；原阵营、随从主人关系及跨角色效果需要重新确认。');
  if (source.choices?._worldJobs) issue('进行中的世界制作任务仍归原角色，未为副本复制产出或任务权利。');
  copy.migrationIssues = issues;
  return copy;
}
