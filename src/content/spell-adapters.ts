import type { ActionDefinition } from '../shared/model.ts';

/** Each adapter below is paired with a concrete effect handler and regression tests. */
export const additionalSpellPatches: Record<string, Partial<ActionDefinition>> = {
  'false-life': { damage: [], healing: undefined, range: 0, sourcePage: 129 },
  'spare-the-dying': { damage: [], range: 15, sourcePage: 163 },
  'protection-from-poison': { damage: [], range: 5, duration: 600, sourcePage: 157 },
  'stoneskin': { damage: [], range: 5, duration: 600, sourcePage: 165 },
  'longstrider': { damage: [], range: 5, duration: 600, sourcePage: 145 },
  'darkvision': { damage: [], range: 5, duration: 4800, sourcePage: 122 },
  'see-invisibility': { damage: [], range: 0, duration: 600, sourcePage: 160 },
  'ray-of-sickness': { attack: { ranged: true }, duration: 1, sourcePage: 158 },
  'misty-step': { damage: [], range: 0, sourcePage: 150 },
  'barkskin': { damage: [], range: 5, duration: 600, sourcePage: 112 },
  'heroism': { damage: [], range: 5, duration: 10, sourcePage: 140 },
  'greater-restoration': { damage: [], range: 5, sourcePage: 137 },
  'power-word-kill': { damage: [], range: 60, sourcePage: 154 },
  'power-word-heal': { damage: [], healing: undefined, range: 60, sourcePage: 154 },
  'power-word-stun': { damage: [], range: 60, sourcePage: 154 },
  'mass-heal': { damage: [], healing: undefined, range: 60, targets: 100, sourcePage: 147 },
};
export const NARRATIVE_SPELL_IDS = ['wish','augury','divination','commune','contact-other-plane','legend-lore','speak-with-dead','dream','minor-illusion','silent-image','major-image','hallucinatory-terrain','mirage-arcane','prestidigitation','thaumaturgy','druidcraft'] as const;
for (const id of NARRATIVE_SPELL_IDS) additionalSpellPatches[id] = {
  automation:'adjudication', damage:[],
  reason:'The GM supplies narrative facts or an open-ended ruling. Casting resources and the decision are recorded by the server.'
};
additionalSpellPatches['legend-lore'] = {
  ...additionalSpellPatches['legend-lore'], automation:'unsupported',
  reason:'The separate consumed incense and reusable ivory components require a dedicated inventory workflow before casting.'
};
