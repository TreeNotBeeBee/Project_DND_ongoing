import type { ActionDefinition, Actor, ContentEntry } from '../shared/model';
import { zhName } from './labels';

// These expose implemented server commands; the client never resolves their effects.
const BASIC: [string, string, ActionDefinition['economy'], string][] = [
  ['ability-check', '属性与技能检定', 'action', '选择属性、技能与难度。服务器投骰并结合熟练、专精和当前状态给出结果。'],
  ['roll-dice', '自由掷骰', 'free', '输入完整骰式，例如 2d6+1d4+3。骰面与总和由服务器生成并记入冒险日志。'],
  ['dash', '疾走', 'action', '使用动作疾走。服务器根据当前速度增加本回合可用移动距离。'],
  ['dodge', '闪避', 'action', '采取闪避动作。攻击与敏捷豁免的实际优势、劣势由服务器结合状态判定。'],
  ['disengage', '撤离', 'action', '采取撤离动作，服务器记录本回合的撤离状态。'],
  ['grapple', '擒抱', 'action', '选择触及内的一名目标。服务器验证体型、动作并结算目标豁免。'],
  ['shove', '推撞', 'action', '选择触及内的一名目标，推离一格或击倒。结果由服务器结算。'],
  ['help', '协助', 'action', '协助相邻盟友。主持人确认协助所适用的检定情境。'],
  ['drop-prone', '卧倒', 'free', '主动陷入倒地状态。'],
];
export function availableActions(actor: Actor, derived: ActionDefinition[], entries: ContentEntry[]): ActionDefinition[] {
  const actions = derived.map(action => ({ ...action, name: zhName(action.id, action.name) }));
  for (const [id, name, economy, description] of BASIC) actions.push({ id, name, source: 'feature', economy, reach: ['grapple', 'shove', 'help'].includes(id) ? 5 : undefined, targets: ['grapple', 'shove', 'help'].includes(id) ? 1 : undefined, description, automation: id === 'help' ? 'choice' : 'automatic' });
  if (actor.effects.some(effect => effect.condition === 'prone')) actions.push({ id: 'stand', name: '起立', source: 'feature', economy: 'free', description: '花费一半速度的移动距离结束倒地；服务器验证剩余移动。', automation: 'automatic' });
  if (actor.effects.some(effect => effect.condition === 'grappled')) actions.push({ id: 'escape-grapple', name: '挣脱擒抱', source: 'feature', economy: 'action', description: '选择力量（运动）或敏捷（杂技）检定，由服务器投掷并结算。', automation: 'choice' });
  for (const [feature, resourceId, economy, description] of [
    ['fighter-second-wind', 'second-wind', 'bonus', '使用回气恢复生命，消耗一次对应资源。'],
    ['fighter-action-surge', 'action-surge', 'free', '在自己的回合使用动作如潮，获得一个额外的非魔法动作。'],
    ['barbarian-rage', 'rage', 'bonus', '进入狂暴。服务器结算资源、抗性和专注限制。'],
    ['paladin-lay-on-hands', 'lay-on-hands', 'bonus', '选择触及内的目标，并指定恢复点数，或花费资源移除中毒。'],
  ] as const) {
    if (actor.resources.some(resource => resource.id === resourceId)) actions.push({ id: `feature:${feature}`, name: zhName(feature, feature), source: 'feature', economy, range: feature === 'paladin-lay-on-hands' ? 5 : undefined, description, automation: 'automatic' });
  }
  for (const spell of actor.spells) {
    if (actions.some(action => action.id.split(':').pop() === spell.split(':').pop())) continue;
    const entry = entries.find(value => value.id === spell || value.id === `spell:${spell}`);
    if (entry) actions.push({ id: entry.id, name: zhName(entry.id, entry.name), source: 'spell', economy: 'action', level: Number(entry.data.level) || 0, description: entry.description, automation: entry.automation, reason: entry.reason || '当前条目需要专用规则适配，暂不能自动执行。' });
  }
  const seen = new Set<string>();
  return actions.filter(action => { if (seen.has(action.id)) return false; seen.add(action.id); return true; });
}
export function actionRangeLabel(action: ActionDefinition) {
  if (action.range === 0) return '自身';
  if (action.range !== undefined) return `${action.range} 尺`;
  if (action.reach !== undefined) return `触及 ${action.reach} 尺`;
  return action.source === 'feature' ? '能力效果' : '见说明';
}
