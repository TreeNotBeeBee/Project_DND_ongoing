import type { Actor, DerivedActor } from '../shared/model';

/** Copy the current visible mechanics; never change or reuse the original actor identity. */
export function freeCharacterCopy(source: Actor, view: DerivedActor, uid: () => string = () => crypto.randomUUID()): Partial<Actor> {
  const resources = structuredClone(source.resources.filter(resource => !/^(slot|pact|hit-dice)-/.test(resource.id)));
  const resourceIds = new Set(resources.map(resource => resource.id));
  return {
    profile: 'free', kind: 'hero', name: `${source.name}（自由副本）`, draft: false,
    abilities: structuredClone(source.abilities), manual: { maxHp: view.maxHp, ac: view.ac, speed: view.speed, proficiency: view.proficiency },
    hp: { max: view.maxHp, current: Math.min(view.maxHp, source.hp.current), temp: source.hp.temp }, resources,
    inventory: source.inventory.map(item => ({ ...structuredClone(item), id: uid() })),
    notes: source.notes, story: source.story, portrait: source.portrait, skills: [...source.skills], expertise: [...source.expertise], saveProficiencies: [...source.saveProficiencies], languages: [...source.languages],
    size: source.size, resistances: [...source.resistances || []], immunities: [...source.immunities || []], vulnerabilities: [...source.vulnerabilities || []],
    choices: { offerDescription: String(source.choices?.offerDescription || '') },
    customActions: view.attacks.map(action => ({ ...structuredClone(action), id: `custom:${uid()}`, source: 'custom',
      ...(action.source === 'spell' ? { castingAbility: action.castingAbility || view.spellAbility } : {}),
      costs: action.costs?.filter(cost => resourceIds.has(cost.resourceId)),
      description: `${action.description}\n[自由副本] 从当前结构复制。法术位、材料、升级缩放与职业触发未自动转换，请GM核对资源费用和效果。`,
    })),
  };
}
