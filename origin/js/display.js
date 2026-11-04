import { LIMITS, FINAL_MIN, FINAL_MAX, clampNum, clampInt } from "./limits.js";
import { bonusCn, resistCn } from "./core.js";
import { d, lastSnap, setLastSnap } from "./state.js";
import { computeAll, computeSnapshot } from "./compute.js";

// === 背包载重 ===
// 没填重量的旧存档按分类补一个合理默认值，避免导入后全部变成 0kg
const catDefaultWeight = {
    weapon: 3, armor: 8, shield: 4, helmet: 2, ring: 0.1,
    accessory: 0.5, special: 1, consumable: 0.5, misc: 0.5
};
export function defaultItemWeight(category) {
    return catDefaultWeight[category] !== undefined ? catDefaultWeight[category] : 0.5;
}
// 单件重量 × 数量（整组物品所占载重）；缺省重量按分类补齐
export function itemStackWeight(it) {
    if (!it) return 0;
    const cat = it.category || "misc";
    const w = (it.weight === undefined || it.weight === null || String(it.weight).trim() === "")
        ? defaultItemWeight(cat)
        : clampNum(it.weight, LIMITS.weight[0], LIMITS.weight[1], defaultItemWeight(cat));
    const rawQty = Number(it.qty);
    const q = (Number.isFinite(rawQty) && rawQty > 0) ? clampInt(rawQty, LIMITS.qty[0], LIMITS.qty[1], 1) : 0;
    return clampNum(w * q, 0, FINAL_MAX, 0);
}
// 当前总载重：背包里所有物品（含已穿戴装备，装备本身也在 items 中）
export function carryWeight() {
    const list = (d && Array.isArray(d.items)) ? d.items : [];
    let sum = 0;
    list.forEach(it => { sum += itemStackWeight(it); });
    return clampNum(sum, 0, FINAL_MAX, 0);
}
// 载重明细：基础负重 + 力量加成（受上限限制）+ 储物道具容量
// 角色可手动设置 carryBase（基础负重）与 carryStrCap（力量加成上限），马车类随从可填很大的基础值
export function carryBreakdown() {
    const snap = lastSnap || computeAll();
    const str = clampNum(snap && snap.total ? snap.total.strength : 0, 0, FINAL_MAX, 0);
    const base = clampNum(d && d.carryBase, 0, LIMITS.weight[1], 10);
    const cap = clampNum(d && d.carryStrCap, 0, LIMITS.weight[1], 60);
    const raw = clampNum(str * 3, 0, FINAL_MAX, 0);
    const strBonus = Math.min(raw, cap);
    let container = 0;
    // 已穿戴物品统计（用于「需装备才生效」的储物道具）
    const equippedNames = {};
    if (d && d.gear && typeof d.gear === "object") {
        Object.keys(d.gear).forEach(slotKey => {
            const nm = String(d.gear[slotKey] || "").trim();
            if (nm) equippedNames[nm] = (equippedNames[nm] || 0) + 1;
        });
    }
    ((d && Array.isArray(d.items)) ? d.items : []).forEach(it => {
        const c = clampNum(it && it.containerCap, 0, LIMITS.weight[1], 0);
        if (!c) return;
        const mode = (it && it.containerMode === "gear") ? "gear" : "bag";
        // 背包型：背包里有几件算几件；装备型：必须穿戴在身上才算（穿戴几件算几件）
        const count = mode === "gear"
            ? (equippedNames[String((it && it.name) || "").trim()] || 0)
            : ((Number(it && it.qty) > 0) ? clampInt(it.qty, LIMITS.qty[0], LIMITS.qty[1], 1) : 0);
        container += c * Math.min(count, LIMITS.qty[1]);
    });
    container = clampNum(container, 0, LIMITS.weight[1], 0);
    const total = clampNum(base + strBonus + container, 1, FINAL_MAX, 1);
    return { base, str, raw, cap, strBonus, container, total };
}

// 载重上限：基础 + 力量加成（封顶）+ 储物道具
export function carryCapacity() { return carryBreakdown().total; }

// 超重惩罚：超过载重上限后，每超 10% 命中 -1，最多 -10
// （背包过重时抬手/瞄准/施法都受影响，所以技能命中加值会吃这个惩罚）
export function encumbrancePenalty(used, cap) {
    const u = clampNum(used, 0, FINAL_MAX, 0);
    const c = clampNum(cap, 0, FINAL_MAX, 0);
    if (!(c > 0) || u <= c) return 0;
    const overPct = (u / c - 1) * 100;
    return -Math.min(10, Math.max(1, Math.ceil(overPct / 10)));
}

// 重量显示：最多保留两位小数，避免 0.30000000000000004 这类浮点噪音
export function roundWeight(v) { return Math.round(clampNum(v, 0, FINAL_MAX, 0) * 100) / 100; }

// 背包载重条：总重 / 上限；超重变红提示；同时同步基础负重/力量上限两个输入框
export function renderCarry() {
    const el = document.getElementById("carryBar");
    if (!el) return;
    const b = carryBreakdown();
    const used = carryWeight();
    const over = used > b.total;
    const pct = b.total > 0 ? Math.min(100, used / b.total * 100) : 100;
    const baseIn = document.getElementById("carryBaseInput");
    if (baseIn) baseIn.value = b.base;
    const capIn = document.getElementById("carryStrCapInput");
    if (capIn) capIn.value = b.cap;
    const parts = [`基础 ${roundWeight(b.base)}`];
    parts.push(`力量 ${roundWeight(b.strBonus)}${b.raw > b.cap ? `（原 ${roundWeight(b.raw)}，上限 ${roundWeight(b.cap)}）` : ""}`);
    if (b.container > 0) parts.push(`储物 ${roundWeight(b.container)}`);
    const pen = encumbrancePenalty(used, b.total);
    if (pen) parts.push(`命中 ${pen}（超重）`);
    el.innerHTML = `<div class="carry-top">
        <span>⚖ 背包载重</span>
        <span class="carry-num${over ? " over" : ""}">${roundWeight(used)} / ${roundWeight(b.total)} kg${over ? ` · 超重！命中 ${pen}` : ""}</span>
    </div>
    <div class="carry-track"><div class="carry-fill${over ? " over" : ""}" style="width:${pct}%"></div></div>
    <div class="carry-detail">${parts.join(" + ")}</div>`;
    // 重量变化会影响技能命中加值，顺手刷新技能列表徽章
    if (typeof globalThis.renderSkills === "function") {
        try { globalThis.renderSkills(); } catch (e) { }
    }
}

export function recalcGearBonus() {
    setLastSnap(computeSnapshot());
    return lastSnap;
}

export function layerText(base, flat, pct, total) {
    const f = clampNum(flat, FINAL_MIN, FINAL_MAX, 0);
    const p = Math.round(clampNum(pct, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0) * 100);
    const b = clampNum(base, FINAL_MIN, FINAL_MAX, 0);
    let s = `${b}`;
    if (f !== 0) s += ` ${f >= 0 ? "+" : "-"}${Math.abs(f)}`;
    if (p !== 0) s += ` ×${(1 + p / 100).toFixed(2)}`;
    // 没有任何加成时不显示 “x = x” 这种冗余等式
    return (f !== 0 || p !== 0) ? `${s} = ${clampNum(total, FINAL_MIN, FINAL_MAX, 0)}` : s;
}

// 种族乘区后缀：×1.10 +3 = 最终（无内容时返回空串）
export function raceSuffix(rPct, rFlat, rPer, rPerPct, lvl, total) {
    const l = clampInt(lvl, LIMITS.level[0], LIMITS.level[1], 1);
    const rp = clampNum(clampNum(rPct, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0) +
        clampNum(rPerPct, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0) * l, FINAL_MIN, FINAL_MAX, 0);
    const rf = clampNum(clampNum(rFlat, FINAL_MIN, FINAL_MAX, 0) +
        clampNum(rPer, FINAL_MIN, FINAL_MAX, 0) * l, FINAL_MIN, FINAL_MAX, 0);
    if (!rp && !rf) return "";
    let s = " 种族";
    if (rp) s += ` ×${(1 + rp).toFixed(2)}`;
    if (rf) s += ` ${rf >= 0 ? "+" : "-"}${Math.abs(rf)}`;
    return `${s} = ${clampNum(total, FINAL_MIN, FINAL_MAX, 0)}`;
}

export function pctText(v) { return `${Math.round(clampNum(v, -1, 1, 0) * 100)}%`; }

export function bonusSummary(b) {
    const parts = [];
    const walk = (layer, suffix, mult) => Object.keys(layer || {}).forEach(k => {
        const v = clampNum(layer[k], FINAL_MIN, FINAL_MAX, 0);
        if (!v) return;
        const name = bonusCn[k] || resistCn[k] || k;
        const num = Math.round(v * mult * 100) / 100;
        parts.push(`${name}${num >= 0 ? "+" : ""}${num}${suffix}`);
    });
    walk(b.flat, "", 1);
    walk(b.perLevel, "/级", 1);
    walk(b.pct, "%", 100);
    walk(b.perLevelPct, "%/级", 100);
    walk(b.resist, "%抗性", 100);
    return parts.join(" ");
}

export function hasBonusContent(b) {
    if (!b) return false;
    return !!(Object.keys(b.flat || {}).length > 0 ||
        Object.keys(b.pct || {}).length > 0 ||
        Object.keys(b.resist || {}).length > 0 ||
        Object.keys(b.perLevel || {}).length > 0 ||
        Object.keys(b.perLevelPct || {}).length > 0 ||
        (b.set && b.set.name) ||
        (b.condition && b.condition.type));
}

//统一物品结构，兼容旧存档/导入存档里缺失或类型不正确的字段
export function normalizeItem(it) {
    const src = (it && typeof it === "object") ? it : {};
    let bonus = "";
    if (typeof src.bonus === "string") bonus = src.bonus;
    else if (src.bonus && typeof src.bonus === "object") bonus = JSON.stringify(src.bonus);
    return {
        category: "misc",
        isConsume: 0,
        healHp: 0,
        healMp: 0,
        qty: 1,
        icon: "📦",
        desc: "",
        ...src,
        bonus,
        weight: (src.weight === undefined || src.weight === null || String(src.weight).trim() === "")
            ? defaultItemWeight(src.category || "misc")
            : clampNum(src.weight, LIMITS.weight[0], LIMITS.weight[1], defaultItemWeight(src.category || "misc")),
        containerCap: clampNum(src.containerCap, 0, LIMITS.weight[1], 0),
        // 储物道具生效方式：bag=背包内生效，gear=需穿戴在装备栏才生效
        containerMode: src.containerMode === "gear" ? "gear" : "bag",
        isConsume: Number(src.isConsume) === 1 ? 1 : 0,
        healHp: clampNum(src.healHp, LIMITS.heal[0], LIMITS.heal[1], 0),
        healMp: clampNum(src.healMp, LIMITS.heal[0], LIMITS.heal[1], 0),
        // 战斗中对目标生效：useEffect 为空表示老式「对自己即时生效」
        useEffect: src.useEffect === "damage" || src.useEffect === "heal" ? src.useEffect : "",
        useAmount: clampInt(src.useAmount, 0, 999999, 0),
        useTarget: src.useTarget === "enemy" || src.useTarget === "ally" ? src.useTarget : "self",
        qty: clampInt(src.qty, LIMITS.qty[0], LIMITS.qty[1], 1)
    };
}
