// === 宠物/随从/召唤物 ===
// 四种属性来源模式（效果不同，由 mode 决定）：
//  own    —— 独立角色：完全自定义自己的数值，和主角没有联动
//  hero   —— 主角的另一个形态（变身）：只同步等级，属性仍用自己的数值；
//            勾选「血量百分比同步」后 HP 百分比跟着主角走；参战时主角本体不参战（但不强制参战）
//  growth —— 随主成长：数值 = 主角最终总值 × 倍率 scale（可在界面上自己调），等级自己填
//  summon —— 临时招募（死灵法师式）：自带固定数值；可勾选「吃成长倍率」改用主角总值 × scale；
//            并且可以「复制」自己，方便召唤师一次拉出多个同款召唤物
import { LIMITS, FINAL_MIN, FINAL_MAX, clampNum, clampInt } from "./limits.js";
import { statKeys, charBase } from "./core.js";
import { makeId, mod } from "./util.js";
import { normalizeGearSlots, normalizeHiddenSlots } from "./bonus.js";
import { computeSnapshotWithOwner, scaleHeroTotal } from "./compute.js";
import { loadRawChar } from "./persist.js";
import { d, activeCharId } from "./state.js";

export const companionModes = ["own", "hero", "growth", "summon"];
export const companionModeCn = { own: "独立", hero: "主角相关", growth: "随主成长", summon: "临时招募" };

export function emptyCompanion() {
    return {
        id: makeId(),
        name: "新随从", icon: "🐾", species: "未知生物", desc: "",
        type: "companion", ownerId: "",
        mode: "growth", combat: false,
        level: 1, hp: 20, mp: 10, maxHpBase: 20, maxMpBase: 10,
        strength: 10, dexterity: 10, constitution: 10,
        intelligence: 10, wisdom: 10, charisma: 10,
        armorBase: 0, speed: 30,
        scale: 0.6, heroCoeff: 0.6, summonScale: false, hpSync: false,
        gearSlots: [], gear: {}, hiddenSlots: []
    };
}

// 统一随从结构：旧存档缺字段自动补默认，数值全部钳制
export function normalizeCompanion(c) {
    const s = (c && typeof c === "object") ? c : {};
    const out = emptyCompanion();
    out.id = String(s.id || "") || makeId();
    out.type = s.type === "hero" ? "hero" : "companion";
    out.ownerId = String(s.ownerId || "");
    out.name = String(s.name || "").trim().slice(0, 40) || "新随从";
    out.icon = String(s.icon || "").trim().slice(0, 4) || "🐾";
    out.species = String(s.species || "").trim().slice(0, 40);
    out.desc = String(s.desc || "").slice(0, 300);
    out.mode = companionModes.includes(s.mode) ? s.mode : "growth";
    out.combat = s.combat === true || Number(s.combat) === 1;
    out.level = clampInt(s.level, LIMITS.level[0], LIMITS.level[1], 1);
    out.hp = clampNum(s.hp, LIMITS.hpMp[0], LIMITS.hpMp[1], 0);
    out.mp = clampNum(s.mp, LIMITS.hpMp[0], LIMITS.hpMp[1], 0);
    out.maxHpBase = clampNum(s.maxHpBase, LIMITS.hpMpBase[0], LIMITS.hpMpBase[1], 0);
    out.maxMpBase = clampNum(s.maxMpBase, LIMITS.hpMpBase[0], LIMITS.hpMpBase[1], 0);
    statKeys.forEach(k => { out[k] = clampNum(s[k], LIMITS.stat[0], LIMITS.stat[1], 0); });
    out.armorBase = clampNum(s.armorBase, LIMITS.armor[0], LIMITS.armor[1], 0);
    out.speed = clampNum(s.speed, LIMITS.speed[0], LIMITS.speed[1], 0);
    if (s.scale !== undefined && s.scale !== null && String(s.scale).trim() !== "")
        out.scale = clampNum(s.scale, LIMITS.companionScale[0], LIMITS.companionScale[1], 0.6);
    if (s.heroCoeff !== undefined && s.heroCoeff !== null && String(s.heroCoeff).trim() !== "")
        out.heroCoeff = clampNum(s.heroCoeff, LIMITS.companionScale[0], LIMITS.companionScale[1], 0.6);
    out.summonScale = s.summonScale === true || Number(s.summonScale) === 1;
    out.hpSync = s.hpSync === true || Number(s.hpSync) === 1;
    out.gearSlots = normalizeGearSlots(s.gearSlots);
    out.hiddenSlots = normalizeHiddenSlots(s.hiddenSlots);
    out.gear = (s.gear && typeof s.gear === "object") ? { ...s.gear } : {};
    return out;
}

// 计算一个随从的最终属性。
// own / summon(未吃倍率) / hero：用随从自己的数据跑完整管线，得到自身最终值；
// hero 只额外把等级同步成主角等级，并可按开关把 HP 百分比映射到主角的 HP 百分比；
// growth / summon(勾选吃倍率)：主角最终总值 × scale。
export function computeCompanion(c) {
    c = normalizeCompanion(c);
    // 主人可能就是当前正在编辑的主角：优先用内存里的实时数据，避免读到尚未落盘的旧存档
    const liveHero = (d && d.type !== "companion" && activeCharId === c.ownerId) ? d : null;
    const heroData = liveHero || (c.ownerId ? loadRawChar(c.ownerId) : null);
    const heroSnap = heroData ? computeSnapshotWithOwner(heroData) : null;
    const heroMode = c.mode === "hero";
    const scaleMode = c.mode === "growth" || (c.mode === "summon" && c.summonScale === true);
    // 主角形态＝同一个「人」的另一种形态：等级跟着主角走，属性仍走自己的数值
    const syncedLevel = heroMode && heroSnap ? heroSnap.lvl : c.level;
    const base = { ...c, level: syncedLevel };
    let total = null;
    if (scaleMode) {
        total = scaleHeroTotal(heroSnap, base, c.scale);
    } else if (c.id && c.type === "companion") {
        const snap = computeSnapshotWithOwner(JSON.parse(JSON.stringify({ ...charBase, ...base })));
        total = snap ? snap.total : null;
    }
    // HP：默认用自己存的血量；主角形态可勾选「血量百分比同步」，按主角当前 HP% 换算
    const hpFor = (maxHp) => {
        let v = clampNum(c.hp, 0, maxHp, 0);
        if (heroMode && c.hpSync && heroSnap && heroData) {
            const heroMax = Math.max(1, heroSnap.total.maxHp);
            const pct = clampNum(heroData.hp, 0, heroMax, 0) / heroMax;
            v = clampNum(Math.round(pct * maxHp), 0, maxHp, 0);
        }
        return v;
    };
    if (!total) {
        // 兜底：独立简化公式
        const stats = {};
        statKeys.forEach(k => stats[k] = clampNum(Math.floor(c[k] + (c.level - 1)), FINAL_MIN, FINAL_MAX, 0));
        const conMod = Math.max(0, mod(stats.constitution));
        const intMod = Math.max(0, mod(stats.intelligence));
        const maxHp = Math.max(1, clampNum(Math.floor(c.maxHpBase + conMod), 1, FINAL_MAX, 1));
        const maxMp = Math.max(1, clampNum(Math.floor(c.maxMpBase + intMod), 1, FINAL_MAX, 1));
        return { ...c, level: syncedLevel, stats, maxHp, maxMp, armor: clampNum(c.armorBase, 0, FINAL_MAX, 0), speed: clampNum(c.speed + mod(stats.dexterity), 0, FINAL_MAX, 0), hp: hpFor(maxHp), mp: clampNum(c.mp, 0, maxMp, 0), damage: Math.max(0, mod(stats.strength)) };
    }
    const stats = {};
    statKeys.forEach(k => stats[k] = total[k]);
    const maxHp = total.maxHp, maxMp = total.maxMp, armor = total.armor, speed = total.speed;
    return { ...c, level: syncedLevel, stats, maxHp, maxMp, armor, speed, hp: hpFor(maxHp), mp: clampNum(c.mp, 0, maxMp, 0), damage: Math.max(0, total.damage || 0) };
}
