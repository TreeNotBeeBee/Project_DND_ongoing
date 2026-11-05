import type { Actor, ContentEntry } from '../shared/model';
import { validateBuild, type RulesData } from '../shared/build-validation';
import { createActor, isStatblock, validateActor } from '../engine/actors';

export type BuilderTab = 'identity' | 'abilities' | 'equipment' | 'spells' | 'notes';
export interface BuilderIssue { message: string; source: string; tab: BuilderTab; field: string }
const id = (value: unknown) => String(value || '').split(':').at(-1)!;
export function builderRulesData(entries: ContentEntry[]): RulesData {
  const categories: Record<string, string> = { class: 'classes', subclass: 'subclasses', level: 'levels', background: 'backgrounds', species: 'species', feat: 'feats', skill: 'skills', spell: 'spells', equipment: 'equipment' };
  const data: RulesData = {};
  for (const entry of entries) if (categories[entry.category]) (data[categories[entry.category]] ||= []).push(entry.data);
  return data;
}

/** Membership comes from the selected class's published subclass list. */
export function builderSubclasses(entries: ContentEntry[], classId: string, level: number): ContentEntry[] {
  if (!classId || level < 3) return [];
  const cls = entries.find(entry => entry.category === 'class' && id(entry.id) === id(classId));
  const allowed = new Set((cls?.data.subclasses || []).map((value: { index: string }) => id(value.index)));
  return entries.filter(entry => entry.category === 'subclass' && allowed.has(id(entry.id)));
}

function locateIssue(source: string, actor: Actor, data: RulesData): BuilderIssue {
  const issue = (message: string, tab: BuilderTab, field: string): BuilderIssue => ({ message, source, tab, field });
  if (source === 'Name is required') return issue('请填写角色名称。', 'identity', 'name');
  if (source === 'Choose a SRD species') return issue('请选择物种。', 'identity', 'species');
  if (source === 'Choose a SRD background' || source === '请选择有效的2024背景。') return issue('请选择背景。', 'identity', 'background');
  const subclass = source.match(/^Choose (.+) subclass$/);
  if (subclass) {
    const index = actor.classes.findIndex(row => id(row.classId) === subclass[1]);
    return issue(`请为第 ${index + 1} 项职业选择子职。`, 'identity', `subclass-${Math.max(0, index)}`);
  }
  if (/^Invalid class |^Duplicate class |^Total class level/.test(source)) {
    const classId = source.replace(/^(?:Invalid|Duplicate) class /, '');
    const index = Math.max(0, actor.classes.findIndex(row => id(row.classId) === classId));
    const known = data.classes?.some(row => row.index === classId);
    return issue(source.startsWith('Duplicate') ? '多职业不能重复选择同一职业。' : known || source.startsWith('Total') ? '请检查职业等级，总等级应为 1 至 20。' : '请选择有效的职业。', 'identity', known ? `level-${index}` : `class-${index}`);
  }
  if (/^Multiclass/.test(source)) return issue(`多职业前提未满足：${source}`, 'abilities', 'base-abilities');
  if (/subclass/i.test(source)) return issue(`子职与职业不匹配：${source}`, 'identity', 'classes');
  if (/魔法学徒/.test(source)) return issue(source, 'spells', 'magic-initiate');
  if (/法术|戏法|spell/i.test(source)) return issue(source, 'spells', 'spells');
  if (/技能|熟练|专精|学者/.test(source)) return issue(source, 'abilities', 'skills');
  if (/人类|起源专长|多才多艺/.test(source)) return issue(source, 'equipment', 'origin-feat');
  if (/武器精通|精通必须/.test(source)) return issue(source, 'equipment', 'masteries');
  if (/战斗风格/.test(source)) return issue(source, 'equipment', 'fighting-styles');
  if (/专长|恩惠|能力没有合法来源/.test(source)) return issue(source, 'equipment', 'feats');
  if (/背景提升|背景不允许/.test(source)) return issue(source, 'abilities', 'background-bonuses');
  if (/属性|数组|购点|合计|^Invalid (str|dex|con|int|wis|cha)/i.test(source)) return issue(source, 'abilities', 'base-abilities');
  if (/attuned/.test(source)) return issue('同调物品数量超出允许范围。', 'equipment', 'inventory');
  return issue(source, 'notes', 'choices');
}

/** The checklist routes authoritative validation results; it defines no 5e rules. */
export function builderIssues(input: Partial<Actor> & Record<string, unknown>, data: RulesData, creation = true): BuilderIssue[] {
  try {
    const actor = createActor({ ...input, id: 'builder-validation-preview' });
    actor.name = String(input.name || '').trim();
    const errors = [...validateActor(actor), ...(creation && !isStatblock(actor) ? validateBuild(actor, data) : [])];
    const issues = errors.map(message => locateIssue(message, actor, data));
    return issues.filter((issue, index) => issues.findIndex(other => other.message === issue.message && other.field === issue.field) === index);
  } catch {
    return [{ message: '规则选择暂时无法解析，请检查职业与规则选择格式。', source: 'Invalid builder input', tab: 'notes', field: 'choices' }];
  }
}
