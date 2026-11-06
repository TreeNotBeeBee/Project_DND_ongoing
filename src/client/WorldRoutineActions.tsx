import type { ActionDefinition, Actor, Snapshot } from '../shared/model';
import { WorldField } from './WorldPrimitives';

export interface RoutinePlanSelection { kind: 'use' | 'rest' | 'consume' | 'deathSave' | 'equip'; restKind: 'short' | 'long'; hitDice: Record<string, number>; itemId: string; equipped: boolean; optionsText: string; targetId: string }
export const newRoutineSelection = (): RoutinePlanSelection => ({ kind: 'use', restKind: 'short', hitDice: {}, itemId: '', equipped: true, optionsText: '', targetId: '' });
export function routineActionPayload(actor: Actor | undefined, value: RoutinePlanSelection, actions: ActionDefinition[]) {
  let error = ''; let payload: Record<string, unknown> = {}; let targetIds: string[] = [];
  if (!actor || value.kind === 'use') return { error, payload, targetIds };
  if (value.kind === 'rest') {
    if (actor.dead) error = '死亡角色无法通过休息恢复。';
    const hitDice = Object.fromEntries(Object.entries(value.hitDice).filter(([, count]) => count > 0));
    if (value.restKind === 'short') for (const [classId, count] of Object.entries(hitDice)) if (!Number.isInteger(count) || count < 0 || count > (actor.resources.find(resource => resource.id === `hit-dice-${classId}`)?.current || 0)) error = '生命骰数量超过可用资源。';
    payload = { commandType: 'actor.rest', kind: value.restKind, ...(value.restKind === 'short' && Object.keys(hitDice).length ? { hitDice } : {}) };
  } else if (value.kind === 'deathSave') {
    if (actor.hp.current !== 0 || actor.dead) error = '只有生命为0且尚未死亡的角色可以进行死亡豁免。';
    payload = { commandType: 'actor.deathSave' };
  } else {
    const item = actor.inventory.find(item => item.id === value.itemId && item.quantity > 0);
    if (!item) error = '请选择背包中仍有数量的物品。';
    if (value.kind === 'equip') payload = { commandType: 'inventory.equip', itemId: value.itemId, equipped: value.equipped };
    else {
      if (!actions.some(action => action.id === `item:${value.itemId}` && action.automation !== 'unsupported')) error = '这个物品当前没有可用的服务器动作。';
      let options: Record<string, unknown> = {};
      if (value.optionsText.trim()) try { const parsed = JSON.parse(value.optionsText); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); options = parsed; } catch { error = '道具选项须为有效JSON对象，或留空。'; }
      payload = { commandType: 'inventory.consume', itemId: value.itemId, ...(Object.keys(options).length ? { options } : {}) }; targetIds = value.targetId ? [value.targetId] : [];
    }
  }
  return { error, payload, targetIds };
}
export function WorldRoutineActions({ snapshot, actor, actions, value, onChange }: { snapshot: Snapshot; actor?: Actor; actions: ActionDefinition[]; value: RoutinePlanSelection; onChange: (value: RoutinePlanSelection) => void }) {
  const update = (patch: Partial<RoutinePlanSelection>) => onChange({ ...value, ...patch });
  const available = actor?.inventory.filter(item => item.quantity > 0 && (value.kind !== 'consume' || actions.some(action => action.id === `item:${item.id}` && action.automation !== 'unsupported'))) || [];
  return <><WorldField label="常规行动类型"><select value={value.kind} onChange={event => update({ kind: event.target.value as RoutinePlanSelection['kind'], itemId: '', targetId: '' })}><option value="use">技能 / 攻击 / 法术</option><option value="rest">休息</option><option value="consume">使用可消耗物品</option><option value="deathSave">死亡豁免</option><option value="equip">装备 / 卸下</option></select></WorldField>
    {value.kind === 'rest' && <><WorldField label="休息类型"><select value={value.restKind} onChange={event => update({ restKind: event.target.value as 'short' | 'long' })}><option value="short">短休</option><option value="long">长休</option></select></WorldField><p className="w-subtle">休息也先加入计划，按当前世界行动费用审批与结算；不会自动触发物品黎明充能。</p>{value.restKind === 'short' && actor?.resources.filter(resource => resource.id.startsWith('hit-dice-')).map(resource => <WorldField key={resource.id} label={`花费生命骰 · ${resource.name}`} hint={`可用 ${resource.current}/${resource.max}；不选则为0。`}><input type="number" min="0" max={resource.current} step="1" value={value.hitDice[resource.id.slice(9)] || 0} onChange={event => update({ hitDice: { ...value.hitDice, [resource.id.slice(9)]: Number(event.target.value) } })} /></WorldField>)}</>}
    {(value.kind === 'consume' || value.kind === 'equip') && <><WorldField label={value.kind === 'consume' ? '可使用物品' : '背包装备'} hint={value.kind === 'consume' ? '仅列出服务器提供了可用动作、且数量大于0的物品。' : '数量大于0；具体装备限制由服务器核对。'}><select value={value.itemId} onChange={event => { const item = available.find(item => item.id === event.target.value); update({ itemId: event.target.value, equipped: !item?.equipped }); }}><option value="">请选择物品</option>{available.map(item => <option key={item.id} value={item.id}>{item.name} ×{item.quantity}{item.equipped ? ' · 已装备' : ''}</option>)}</select></WorldField>{!available.length && <p className="w-locked">{value.kind === 'consume' ? '背包中没有服务器认可的可使用物品。' : '背包中没有可选择的装备。'}</p>}{value.kind === 'equip' && <WorldField label="装备操作"><select value={value.equipped ? 'on' : 'off'} onChange={event => update({ equipped: event.target.value === 'on' })}><option value="on">装备</option><option value="off">卸下</option></select></WorldField>}{value.kind === 'consume' && <><WorldField label="服用 / 使用目标"><select value={value.targetId} onChange={event => update({ targetId: event.target.value })}><option value="">自己（默认）</option>{snapshot.tokens?.filter(token => token.id !== actor?.id).map(token => <option key={token.id} value={token.id}>{token.name}</option>)}</select></WorldField><details><summary>需要特殊选项的道具</summary><WorldField label="道具选项 JSON" hint="普通药水可留空。复杂魔法物品按其动作说明填写，例如施法编号、等级或涂毒武器。"><textarea className="w-code" rows={3} value={value.optionsText} onChange={event => update({ optionsText: event.target.value })} placeholder="{}" /></WorldField></details></>}</>}
    {value.kind === 'deathSave' && <p className="w-notice">服务器掷死亡豁免并记录实际骰面。仅生命为0且尚未死亡时可提交，不允许客户端自报骰子结果。</p>}
  </>;
}
