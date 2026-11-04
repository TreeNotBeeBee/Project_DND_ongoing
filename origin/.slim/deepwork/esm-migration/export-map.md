# 规范导出映射（按文件，供 ESM 迁移各 lane 引用）

## state.js
export let: `d, charList, activeCharId, lastSnap`（可被任意模块 import 并重赋值——ESM live binding）。

## limits.js
export const: `LIMITS, FINAL_MIN, FINAL_MAX, nativeNumLimits`
export function: `clampNum, clampInt`

## util.js
export function: `esc, rollOne, makeId, mod`

## core.js
export const: `charBase, slots, catText, nativeFields, statKeys, statCn, bonusKeys, bonusCn, resistKeys, resistCn, buffTypeKeys, buffTypeCn, buffTypeIcon, buffTypeColor`
export function: `normalizeBuffType, normalizeBuff, buffTickText`

## bonus.js
export function: `numMap, normalizeBonus, parseBonus, addMaps, conditionMet, applyBonus, gearSlotIdSet, findGearItem, normalizeGearSlots, cleanGearRefs`

## aggregate.js
export function: `aggregateBonuses`

## compute.js
export function: `computeAll, normalizeGrowth, levelTierRow, levelTierPct, levelPctAt, computeSnapshotWithOwner, scaleHeroTotal, isScaledCompanion, computeSnapshot`
注意：compute.js 的 computeSnapshot/computeSnapshotWithOwner 运行时调用 persist 的 `loadRawChar`。

## display.js
export function: `recalcGearBonus, layerText, raceSuffix, pctText, bonusSummary, hasBonusContent, normalizeItem`
注意：recalcGearBonus 运行时调用 compute 的 `computeSnapshot`。

## companion.js
export const: `companionModes, companionModeCn`
export function: `emptyCompanion, normalizeCompanion, computeCompanion`
注意：computeCompanion 运行时调用 compute 的 `computeSnapshotWithOwner/scaleHeroTotal` 和 persist 的 `loadRawChar`。

## 以下文件当前==无== import/export，均为平铺全局。需全部转 ESM（补 import + export）：

## persist.js（需 export，含供 inline 与跨文件用）
page, loadCharList, makeId(与 util 重名——本文件自带 makeId，改名或复用 util 的；保留本地定义导出), normalizeAvatar, saveCharListMeta, renderCharSelect, loadRawChar, saveRawChar, loadActiveCharacter, migrateHeroCompanions, createCompanion, saveCurrentCharacter, newCharacter, deleteCharacter, read

## sanitize.js
sanitizeCharData

## stats_ui.js
statFormulaText, renderStatPanel, renderDerived, hpUpdate, toggleCustomPanel, renderCustomStats, addCustomStat, removeCustomStat

## companion_ui.js
toggleCompanionPanel, ownedCompanions, companionData, updateOwnedCompanion, openCompanionOverview, removeCompanion, setSelfCompanion, setSelfCompanionMode, renderCompanions, renderCombatTargets, addCompanion, applyHpDelta, applyMpDelta

## items_gear_ui.js
renderGear, addGearSlot, renameGearSlot, removeGearSlot, renderItems, renderQuickConsume, openQuickAssignModal, confirmAssignQuickSlot, clearQuickSlot, useQuickSlot, useItemDirect, bonusEditorHTML, renderBonusEditor, readBonusEditor, collectItemBonus, updateBonusSummaries, syncItemBonusJson, fillItemBonusForm, applyItemBonusJson, openAddItemModal, openEditItemModal, saveItemModal, removeItem

## skills_buffs.js
openAddSkillModal, openEditSkillModal, saveSkillModal, renderSkills, openAddBuffModal, openEditBuffModal, saveBuffModal, upsertBuffTemplate, removeBuffTemplate, applyBuffTemplate, buffToast, renderQuickBuffs, tickBuffs, renderBuffs (let: buffToastTimer)

## combat_dice.js
addDiceLog, rollDice, rollAdv, rollDis, clearDiceLog, rollCheck, parseDiceExpr, addCombatLog, combatAttack, playerTakeDamage, enemyDamage, enemyHeal, resetEnemy

## modal_misc.js
closeModal, openResetModal, doReset, save, exportSave, importSave, renderAvatar, pickAvatar, resetAvatar, dropAvatar, handleAvatarFile, processAvatarFile, growthDraft(let), pctCellInput, renderLevelTable, readLevelTable, updateGrowthPreview, openRaceModal, saveRaceModal, openLevelModal, addLevelRow, removeLevelRow, clearLevelRows, saveLevelModal

## init.js
fill, renderAll, init

## 全局 API 桥（新增文件 bridge.js 或 api.js）
把所有需被 globalThis 访问的符号（inline onclick/onchange 引用的函数 + 上述 export）`Object.assign(globalThis, {...})`，并在末尾调用 `init()`。index.html 改为单一 `<script type="module" src="js/bridge.js"></script>`。

## 循环依赖说明（ESM 允许，运行时才执行，模块求值无副作用→安全）
companion → compute → persist → companion；companion → persist。各 import 仅在函数体内被调用，无顶层执行。

## 顶层副作用核查
所有文件仅定义；DOM/init 在 bridge 末尾调用 init() 后才执行 → 模块求值无副作用，import 顺序/循环安全。
