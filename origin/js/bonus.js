// === 加成系统：基础 → 固定 → 百分比 → 派生 → 抗性上限 ===
import { LIMITS, FINAL_MIN, FINAL_MAX, clampNum, clampInt } from "./limits.js";
import { bonusKeys, resistKeys, slots } from "./core.js";
import { d } from "./state.js";
import { makeId } from "./util.js";

export function numMap(src, keys, min, max) {
    const out = {};
    keys.forEach(k => {
        const v = clampNum(src && src[k], min, max, 0);
        if (v !== 0) out[k] = v;
    });
    return out;
}

// 统一解析：兼容旧格式 {"damage":2} 与新格式 {flat,pct,resist,set,condition}
export function normalizeBonus(raw) {
    let b = raw;
    if (typeof b === "string") {
        try { b = b.trim() ? JSON.parse(b) : {}; } catch (e) { b = {}; }
    }
    if (!b || typeof b !== "object" || Array.isArray(b)) b = {};
    const hasLayers = b.flat || b.pct || b.resist || b.perLevel || b.perLevelPct || b.set || b.condition;
    if (!hasLayers) {
        const flat = {};
        Object.keys(b).forEach(k => {
            if (!bonusKeys.includes(k)) return;
            const v = clampNum(b[k], LIMITS.bonusFlat[0], LIMITS.bonusFlat[1], 0);
            if (v !== 0) flat[k] = v;
        });
        return {
            flat, pct: {}, resist: {}, perLevel: {}, perLevelPct: {},
            set: { name: "", pieces: 0, flat: {}, pct: {}, resist: {} },
            condition: { type: "", value: "", flat: {}, pct: {}, resist: {} }
        };
    }
    const setRaw = (b.set && typeof b.set === "object") ? b.set : {};
    const condRaw = (b.condition && typeof b.condition === "object") ? b.condition : {};
    const condType = ["hpBelow", "hpAbove", "enemyType"].includes(condRaw.type) ? condRaw.type : "";
    return {
        flat: numMap(b.flat, bonusKeys, LIMITS.bonusFlat[0], LIMITS.bonusFlat[1]),
        pct: numMap(b.pct, bonusKeys, LIMITS.bonusPct[0], LIMITS.bonusPct[1]),
        resist: numMap(b.resist, resistKeys, LIMITS.bonusResist[0], LIMITS.bonusResist[1]),
        perLevel: numMap(b.perLevel, bonusKeys, LIMITS.bonusPerLevel[0], LIMITS.bonusPerLevel[1]),
        perLevelPct: numMap(b.perLevelPct, bonusKeys, LIMITS.bonusPct[0], LIMITS.bonusPct[1]),
        set: {
            name: String(setRaw.name || "").trim().slice(0, 100),
            pieces: clampInt(setRaw.pieces, 0, 999, 0),
            flat: numMap(setRaw.flat, bonusKeys, LIMITS.bonusFlat[0], LIMITS.bonusFlat[1]),
            pct: numMap(setRaw.pct, bonusKeys, LIMITS.bonusPct[0], LIMITS.bonusPct[1]),
            resist: numMap(setRaw.resist, resistKeys, LIMITS.bonusResist[0], LIMITS.bonusResist[1])
        },
        condition: {
            type: condType,
            value: condRaw.value === undefined ? "" : String(condRaw.value).slice(0, 200),
            flat: numMap(condRaw.flat, bonusKeys, LIMITS.bonusFlat[0], LIMITS.bonusFlat[1]),
            pct: numMap(condRaw.pct, bonusKeys, LIMITS.bonusPct[0], LIMITS.bonusPct[1]),
            resist: numMap(condRaw.resist, resistKeys, LIMITS.bonusResist[0], LIMITS.bonusResist[1])
        }
    };
}

export function parseBonus(raw) { return normalizeBonus(raw); }

export function addMaps(dst, src) {
    if (!src) return;
    Object.keys(src).forEach(k => { dst[k] = (dst[k] || 0) + (Number(src[k]) || 0); });
}

export function conditionMet(c, ctx) {
    if (!c || !c.type) return false;
    if (c.type === "hpBelow") return Number(ctx.hpPct) < Number(c.value);
    if (c.type === "hpAbove") return Number(ctx.hpPct) > Number(c.value);
    if (c.type === "enemyType") {
        const want = String(c.value || "").trim().toLowerCase();
        const have = String(ctx.enemyType || "").trim().toLowerCase();
        return want !== "" && want === have;
    }
    return false;
}

export function applyBonus(agg, b, ctx, useConditional) {
    if (!b) return;
    addMaps(agg.flat, b.flat);
    addMaps(agg.pct, b.pct);
    addMaps(agg.resist, b.resist);
    // 每级成长：perLevel（每级固定）× 当前等级累加到 flat；perLevelPct（每级百分比）× 当前等级累加到 pct
    const lvl = clampInt((ctx && ctx.level !== undefined) ? ctx.level : (d && d.level), LIMITS.level[0], LIMITS.level[1], 1);
    if (b.perLevel) {
        Object.keys(b.perLevel).forEach(k => {
            agg.flat[k] = (agg.flat[k] || 0) + (Number(b.perLevel[k]) || 0) * lvl;
        });
    }
    if (b.perLevelPct) {
        Object.keys(b.perLevelPct).forEach(k => {
            agg.pct[k] = (agg.pct[k] || 0) + (Number(b.perLevelPct[k]) || 0) * lvl;
        });
    }
    if (useConditional && conditionMet(b.condition, ctx)) {
        addMaps(agg.flat, b.condition.flat);
        addMaps(agg.pct, b.condition.pct);
        addMaps(agg.resist, b.condition.resist);
    }
}

// === 自定义装备栏：槽定义 d.gearSlots=[{id,name,icon,cat}]，穿戴记录在 d.gear[id] ===
// cat = 该栏可穿戴的物品分类（默认「特殊装备」），让随从/坐骑也能按需定制（例：马没有盾牌栏）
export const gearCats = ["weapon", "armor", "shield", "helmet", "ring", "accessory", "special"];
// 每个角色可隐藏不需要的内置装备栏（例：马隐藏 盾牌/武器），记录在 d.hiddenSlots
export function normalizeHiddenSlots(arr) {
    const out = [];
    (Array.isArray(arr) ? arr : []).forEach(k => {
        const key = String(k || "");
        if (slots[key] && !out.includes(key)) out.push(key);
    });
    return out;
}
export function gearSlotIdSet() {
    const s = new Set(Object.keys(slots));
    normalizeHiddenSlots(d.hiddenSlots).forEach(k => s.delete(k));
    (Array.isArray(d.gearSlots) ? d.gearSlots : []).forEach(gs => { if (gs && gs.id) s.add(String(gs.id)); });
    return s;
}
// 装备槽物品查找：内置槽按分类严格匹配；自定义槽按该栏的 cat 分类匹配
export function findGearItem(slotKey, itemName) {
    if (!itemName || !Array.isArray(d.items) || !gearSlotIdSet().has(slotKey)) return null;
    if (slots[slotKey]) return d.items.find(it => it.name === itemName && it.category === slotKey) || null;
    const def = (Array.isArray(d.gearSlots) ? d.gearSlots : []).find(gs => gs && gs.id === slotKey);
    const cat = (def && def.cat) || "special";
    return d.items.find(it => it.name === itemName && it.category === cat) || null;
}
export function normalizeGearSlots(arr) {
    const out = [];
    const seen = new Set();
    (Array.isArray(arr) ? arr.slice(0, 50) : []).forEach(s => {
        if (!s || typeof s !== "object") return;
        let id = String(s.id || "").trim().slice(0, 80);
        if (!id || slots[id] || seen.has(id)) id = "cs_" + makeId();
        seen.add(id);
        out.push({
            id,
            name: String(s.name || "").trim().slice(0, 60) || "自定义栏",
            icon: String(s.icon || "").trim().slice(0, 8) || "✨",
            cat: gearCats.includes(s.cat) ? s.cat : "special"
        });
    });
    return out;
}
// 清理失效装备引用（槽位已删或物品已不存在）
export function cleanGearRefs() {
    const valid = gearSlotIdSet();
    Object.keys(d.gear || {}).forEach(slotKey => {
        const itemName = d.gear[slotKey];
        if (!itemName) return;
        if (!valid.has(slotKey) || !findGearItem(slotKey, itemName)) d.gear[slotKey] = "";
    });
}
