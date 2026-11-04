// Executable mechanics live in engine/feature-rules.ts or the core actor/combat pipeline.
// This is an explicit coverage declaration, not a description-to-code heuristic.
export const automatedFeatures=new Set([
 'barbarian-rage','barbarian-unarmored-defense','barbarian-danger-sense','barbarian-extra-attack','barbarian-fast-movement','barbarian-feral-instinct',
 'bard-spellcasting','bard-expertise','bard-jack-of-all-trades','bard-font-of-inspiration',
 'cleric-spellcasting','druid-spellcasting','fighter-fighting-style','fighter-second-wind','fighter-action-surge','fighter-extra-attack','fighter-two-extra-attacks','fighter-three-extra-attacks','fighter-studied-attacks',
 'champion-improved-critical','champion-remarkable-athlete','champion-superior-critical','champion-heroic-warrior',
 'monk-unarmored-defense','monk-unarmored-movement','monk-extra-attack','monk-evasion',
 'paladin-lay-on-hands','paladin-spellcasting','paladin-extra-attack','paladin-aura-of-protection','paladin-aura-expansion','paladin-radiant-strikes',
 'ranger-spellcasting','ranger-deft-explorer','ranger-fighting-style','ranger-extra-attack','ranger-expertise','ranger-tireless','ranger-natures-veil',
 'rogue-expertise','rogue-sneak-attack','rogue-evasion','rogue-reliable-talent','rogue-slippery-mind',
 'sorcerer-spellcasting','sorcerer-innate-sorcery','sorcerer-font-of-magic','warlock-pact-magic','warlock-magical-cunning','wizard-spellcasting','wizard-scholar','wizard-arcane-recovery'
]);
export const automatedTraits=new Set(['brave','dwarven-resilience','dwarven-toughness','fey-ancestry','gnomish-cunning','luck','resourceful','adrenaline-rush']);
export const automatedFeats=new Set(['magic-initiate','ability-score-improvement','archery','defense','great-weapon-fighting','two-weapon-fighting']);
export const partialFeatureReasons:Record<string,string>={
 'monk-martial-arts':'Unarmed damage die and Dexterity are implemented; monk-weapon damage replacement and the free bonus strike need completion.',
 'monk-monks-focus':'Flurry, Patient Defense and Step of the Wind execute; split-target Flurry and full jump movement validation remain.',
 'monk-disciplined-survivor':'All-save proficiency is implemented; the optional Focus reroll prompt remains.',
 'paladin-aura-of-courage':'Incoming Frightened effects are blocked in the aura; suppression of an existing effect when entering/leaving remains.',
 'ranger-roving':'Walking speed +10 without heavy armor is implemented; separate Climb/Swim speeds remain.',
};
