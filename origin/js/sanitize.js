import { LIMITS, clampNum, clampInt } from "./limits.js";
import { charBase, statKeys, normalizeBuff } from "./core.js";
import { d } from "./state.js";
import { makeId } from "./util.js";
import { normalizeGearSlots, normalizeHiddenSlots, cleanGearRefs, normalizeBonus } from "./bonus.js";
import { normalizeGrowth } from "./compute.js";
import { normalizeItem } from "./display.js";
import { normalizeCompanion } from "./companion.js";

// 「其他修正」（职业/血脉/灵根等不随等级成长的一次性修正 + 小被动）
export function normalizeExtraMod(m) {
    const s = (m && typeof m === "object") ? m : {};
    const p = (s.passive && typeof s.passive === "object") ? s.passive : {};
    return {
        id: String(s.id || "") || makeId(),
        name: String(s.name || "").trim().slice(0, 40) || "其他修正",
        icon: String(s.icon || "").trim().slice(0, 4) || "✨",
        enabled: s.enabled !== false,
        bonus: typeof s.bonus === "string" ? s.bonus : (s.bonus ? JSON.stringify(normalizeBonus(s.bonus)) : ""),
        passive: {
            hpPerRound: clampInt(p.hpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0),
            mpPerRound: clampInt(p.mpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0),
            autoAttack: p.autoAttack === true || Number(p.autoAttack) === 1,
            lowHpDamage: clampNum(p.lowHpDamage, 0, 500, 0),
            lowHpThreshold: clampNum(p.lowHpThreshold, 1, 100, 50),
            dodgeEvery: clampInt(p.dodgeEvery, 0, 999, 0),
            skillHpPct: clampNum(p.skillHpPct, 0, 100, 0)
        },
        note: String(s.note || "").slice(0, 300)
    };
}

// 载入/导入/保存前统一清洗角色数据，保证任何入口都绕不过数值边界
export function sanitizeCharData() {
    if (!d || typeof d !== "object") return;
    d.level = clampInt(d.level, LIMITS.level[0], LIMITS.level[1], 1);
    d.xp = clampNum(d.xp, LIMITS.xp[0], LIMITS.xp[1], 0);
    statKeys.forEach(k => { d[k] = clampNum(d[k], LIMITS.stat[0], LIMITS.stat[1], 0); });
    d.hp = clampNum(d.hp, LIMITS.hpMp[0], LIMITS.hpMp[1], 0);
    d.mp = clampNum(d.mp, LIMITS.hpMp[0], LIMITS.hpMp[1], 0);
    d.maxHpBase = clampNum(d.maxHpBase, LIMITS.hpMpBase[0], LIMITS.hpMpBase[1], 0);
    d.maxMpBase = clampNum(d.maxMpBase, LIMITS.hpMpBase[0], LIMITS.hpMpBase[1], 0);
    d.gold = clampNum(d.gold, LIMITS.gold[0], LIMITS.gold[1], 0);
    d.armorBase = clampNum(d.armorBase, LIMITS.armor[0], LIMITS.armor[1], 0);
    d.speed = clampNum(d.speed, LIMITS.speed[0], LIMITS.speed[1], 0);
    // 载重设置：基础负重 / 力量加成上限（马车类随从可把基础负重填很大）
    d.carryBase = clampNum(d.carryBase, 0, LIMITS.weight[1], 10);
    d.carryStrCap = clampNum(d.carryStrCap, 0, LIMITS.weight[1], 60);
    d.levelGrowth = normalizeGrowth(d.levelGrowth);
    if (!Array.isArray(d.items)) d.items = [];
    d.items = d.items.slice(0, 5000).map(normalizeItem);
    d.gear = { ...charBase.gear, ...((d.gear && typeof d.gear === "object") ? d.gear : {}) };
    d.gearSlots = normalizeGearSlots(d.gearSlots);
    d.hiddenSlots = normalizeHiddenSlots(d.hiddenSlots);
    cleanGearRefs();
    if (!Array.isArray(d.skills)) d.skills = [];
    d.skills = d.skills.slice(0, 1000).map(s => typeof s === "string" ? { name: s, desc: "" } : { name: "", desc: "", ...s });
    if (!Array.isArray(d.buffs)) d.buffs = [];
    d.buffs = d.buffs.slice(0, 500).filter(bf => bf && typeof bf === "object").map(bf => ({
        ...bf,
        round: clampInt(bf.round, LIMITS.round[0], LIMITS.round[1], 0),
        type: normalizeBuff(bf).type,
        hpPerRound: normalizeBuff(bf).hpPerRound,
        mpPerRound: normalizeBuff(bf).mpPerRound
    }));
    if (!Array.isArray(d.buffLib)) d.buffLib = [];
    d.buffLib = d.buffLib.slice(0, 200).filter(t => t && typeof t === "object").map(t => ({
        id: String(t.id || "") || makeId(),
        name: String(t.name || "").trim().slice(0, 60),
        round: clampInt(t.round, LIMITS.round[0], LIMITS.round[1], 0),
        desc: String(t.desc || "").slice(0, 300),
        bonus: typeof t.bonus === "string" ? t.bonus : (t.bonus ? JSON.stringify(t.bonus) : ""),
        type: normalizeBuff(t).type,
        hpPerRound: normalizeBuff(t).hpPerRound,
        mpPerRound: normalizeBuff(t).mpPerRound
    })).filter(t => t.name);
    if (!Array.isArray(d.customStats)) d.customStats = [];
    d.customStats = d.customStats.slice(0, 100).filter(cs => cs && typeof cs === "object").map(cs => ({
        ...cs,
        val: clampNum(cs.val, LIMITS.customVal[0], LIMITS.customVal[1], 0),
        max: Math.max(1, clampNum(cs.max, LIMITS.customMax[0], LIMITS.customMax[1], 100))
    }));
    if (!Array.isArray(d.quickConsumeSlots) || d.quickConsumeSlots.length !== 6) {
        d.quickConsumeSlots = [null, null, null, null, null, null];
    }
    if (!Array.isArray(d.companions)) d.companions = [];
    d.companions = d.companions.slice(0, 50).filter(c => c && typeof c === "object").map(normalizeCompanion);
    if (!Array.isArray(d.extraMods)) d.extraMods = [];
    d.extraMods = d.extraMods.slice(0, 20).filter(m => m && typeof m === "object").map(normalizeExtraMod);
}
