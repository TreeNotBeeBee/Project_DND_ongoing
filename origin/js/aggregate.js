import { FINAL_MAX, clampNum, LIMITS } from "./limits.js";
import { bonusKeys, resistKeys } from "./core.js";
import { d } from "./state.js";
import { parseBonus, applyBonus, findGearItem } from "./bonus.js";
import { barDamagePct } from "./bar_link.js";

export function aggregateBonuses(useConditional, ctx) {
    const agg = { flat: {}, pct: {}, resist: {}, sets: [] };
    bonusKeys.forEach(k => { agg.flat[k] = 0; agg.pct[k] = 0; });
    resistKeys.forEach(k => { agg.resist[k] = 0; });

    const equipped = [];
    Object.keys(d.gear || {}).forEach(slotKey => {
        const itemName = d.gear[slotKey];
        if (!itemName) return;
        const item = findGearItem(slotKey, itemName);
        if (!item) { d.gear[slotKey] = ""; return; }
        equipped.push(item);
    });

    const setCount = {};
    equipped.forEach(it => {
        const b = parseBonus(it.bonus);
        if (b.set.name) setCount[b.set.name] = (setCount[b.set.name] || 0) + 1;
    });

    const appliedSets = new Set();
    equipped.forEach(it => {
        const b = parseBonus(it.bonus);
        applyBonus(agg, b, ctx, useConditional);
        if (b.set.name && b.set.pieces > 0 && (setCount[b.set.name] || 0) >= b.set.pieces) {
            const sig = b.set.name + "|" + b.set.pieces + "|" + JSON.stringify([b.set.flat, b.set.pct, b.set.resist]);
            if (!appliedSets.has(sig)) {
                appliedSets.add(sig);
                applyBonus(agg, { flat: b.set.flat, pct: b.set.pct, resist: b.set.resist, condition: null }, ctx, false);
                agg.sets.push({ name: b.set.name, pieces: b.set.pieces, count: setCount[b.set.name] });
            }
        }
    });

    const seenBuffs = new Set();
    (Array.isArray(d.buffs) ? d.buffs : []).forEach(bf => {
        if (!bf || seenBuffs.has(bf.name)) return; // 同名 Buff 只取第一个，避免叠加失控
        seenBuffs.add(bf.name);
        applyBonus(agg, parseBonus(bf.bonus), ctx, useConditional);
    });

    // 其他修正（职业/被动）：常量数值走加成，另有「血量越低伤害越高」的连续缩放
    (Array.isArray(d.extraMods) ? d.extraMods : []).forEach(m => {
        if (!m || m.enabled === false) return;
        applyBonus(agg, parseBonus(m.bonus), ctx, useConditional);
        const p = (m.passive && typeof m.passive === "object") ? m.passive : {};
        const lowMax = clampNum(p.lowHpDamage, 0, 500, 0);        // 百分比：HP 越低时最高 +X%
        const threshold = clampNum(p.lowHpThreshold, 1, 100, 50); // 低于该 HP% 才开始增长
        if (lowMax > 0) {
            const hpPct = clampNum(ctx && ctx.hpPct, 0, 200, 100);
            const factor = clampNum((threshold - Math.min(hpPct, threshold)) / threshold, 0, 1, 0);
            agg.pct.damage = clampNum((agg.pct.damage || 0) + (lowMax / 100) * factor, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0);
        }
    });

    // 自定义条：按条值比例加攻击（满值可再叠一层，适合慢启动/大招条；填负数即惩罚）
    (Array.isArray(d.customStats) ? d.customStats : []).forEach(cs => {
        const add = barDamagePct(cs);
        if (!add) return;
        agg.pct.damage = clampNum((agg.pct.damage || 0) + add, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0);
    });

    // 种族与等级成长已拆分为独立层，不在此聚合（见 computeAll）
    // 汇总后再钳制一次：即使穿了很多件装备、叠了很多 Buff，也不会把数值堆到失控
    bonusKeys.forEach(k => {
        agg.flat[k] = clampNum(agg.flat[k], -FINAL_MAX, FINAL_MAX, 0);
        agg.pct[k] = clampNum(agg.pct[k], LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0);
    });
    resistKeys.forEach(k => {
        agg.resist[k] = clampNum(agg.resist[k], LIMITS.bonusResist[0], LIMITS.bonusResist[1], 0);
    });
    return agg;
}
