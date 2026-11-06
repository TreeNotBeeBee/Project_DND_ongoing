import { ABILITIES, type Actor } from './model';
import type { RulesData } from './build-validation';
const unprefix = (id: unknown) => String(id || '').split(':').at(-1)!;
const find = (data: RulesData, category: string, id: unknown) => data[category]?.find(entry => entry.index === unprefix(id));
export const standardStatblock = (a: Actor, data: RulesData) => a.kind === 'monster' || a.kind === 'companion' && Boolean(find(data, 'monsters', a.choices?.monsterId));
/** Shared source validation receives its data; no private catalog is bundled into a client. */
export function validateStandardActor(a: Actor, data: RulesData): string[] {
  const errors: string[] = [];
  for (const key of ABILITIES) if (!Number.isInteger(a.abilities?.[key]) || a.abilities[key] < 1 || a.abilities[key] > 30) errors.push(`Invalid ${key}: expected integer 1..30`);
  if (standardStatblock(a, data)) return errors;
  if (!find(data, 'species', a.speciesId)) errors.push('Choose a SRD species');
  if (!find(data, 'backgrounds', a.backgroundId)) errors.push('Choose a SRD background');
  const level = a.classes.reduce((sum, cls) => sum + cls.level, 0);
  if (level < 1 || level > 20) errors.push('Total class level must be 1..20');
  const ids = new Set<string>();
  for (const cls of a.classes) {
    const id = unprefix(cls.classId), entry = find(data, 'classes', id);
    if (!entry || !Number.isInteger(cls.level) || cls.level < 1 || cls.level > 20) errors.push(`Invalid class ${id}`);
    if (ids.has(id)) errors.push(`Duplicate class ${id}`); ids.add(id);
    if (cls.level >= 3 && !cls.subclassId) errors.push(`Choose ${id} subclass`);
    if (cls.subclassId && !entry?.subclasses?.some((value: any) => value.index === unprefix(cls.subclassId))) errors.push(`Invalid ${id} subclass`);
    if (a.classes.length > 1) {
      for (const requirement of entry?.multi_classing?.prerequisites || []) if (a.abilities[requirement.ability_score.index as keyof Actor['abilities']] < requirement.minimum_score) errors.push(`Multiclass ${id} requires ${requirement.ability_score.index} ${requirement.minimum_score}`);
      const choice = entry?.multi_classing?.prerequisite_options;
      if (choice && !choice.from.options.some((value: any) => a.abilities[value.ability_score.index as keyof Actor['abilities']] >= value.minimum_score)) errors.push(`Multiclass ${id} ability requirement not met`);
    }
  }
  for (const id of a.spells) if (!find(data, 'spells', id)) errors.push(`Unknown spell ${id}`);
  if (a.inventory.filter(item => item.attuned).length > 3) errors.push('At most three attuned magic items');
  return errors;
}
