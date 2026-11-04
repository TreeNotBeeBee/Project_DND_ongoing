// 单角色基础模板
import { LIMITS, clampInt } from "./limits.js";

export const charBase = {
    name: "无名冒险者", job: "", level: 1, xp: 0, avatar: "",
    race: "", raceBonus: "", levelMode: "cumulative", levelGrowth: [],
    hp: 20, maxHpBase: 20,
    mp: 10, maxMpBase: 10,
    strength: 12, dexterity: 14, constitution: 10,
    intelligence: 13, wisdom: 11, charisma: 10,
    gold: 0, armorBase: 0, speed: 30,
    carryBase: 10, carryStrCap: 60,
    items: [
        { name: "长剑", icon: "⚔️", qty: 1, desc: "普通铁制长剑", category: "weapon", isConsume: 0, healHp: 0, healMp: 0, bonus: '{"damage":2}' },
        { name: "治疗药水", icon: "🧪", qty: 2, desc: "恢复少量生命值", category: "consumable", isConsume: 1, healHp: 8, healMp: 0, bonus: '' },
        { name: "冒险者背包", icon: "🎒", qty: 1, desc: "普通的旅行背包", category: "misc", isConsume: 0, healHp: 0, healMp: 0, bonus: '' }
    ],
    gear: { weapon: "", armor: "", shield: "", helmet: "", ring: "", accessory: "" },
    skills: [],
    buffs: [],
    buffLib: [],
    quickConsumeSlots: [null, null, null, null, null, null],
    customStats: [],
    extraMods: [],
    gearSlots: [],
    hiddenSlots: [],
    companions: [],
    storyNote: "",
    // 角色类型：hero（主角）/ companion（随从/宠物）
    type: "hero",
    ownerId: "",                       // 随从的归属主角（char id）；英雄为空
    icon: "🐾", species: "", desc: "", // 随从身份信息
    mode: "own", combat: false,        // 随从属性来源模式 + 是否参战
    scale: 0.6, heroCoeff: 0.6         // growth/hero 模式系数
};

export const slots = {
    weapon: ["⚔️", "武器"],
    armor: ["🛡️", "盔甲"],
    shield: ["🔰", "盾牌"],
    helmet: ["⛑️", "头盔"],
    ring: ["💍", "戒指"],
    accessory: ["📿", "饰品"]
};
//分类显示文本
export const catText = { weapon: "武器", armor: "盔甲", shield: "盾牌", helmet: "头盔", ring: "戒指", accessory: "饰品", special: "特殊装备", consumable: "消耗品", misc: "杂物" };

export const nativeFields = [
    "name", "job", "level", "xp",
    "hp", "maxHpBase", "mp", "maxMpBase",
    "strength", "dexterity", "constitution",
    "intelligence", "wisdom", "charisma",
    "gold", "armorBase", "speed"
];
export const statKeys = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
export const statCn = { strength: "力量", dexterity: "敏捷", constitution: "体质", intelligence: "智力", wisdom: "感知", charisma: "魅力" };
export const bonusKeys = [...statKeys, "maxHp", "maxMp", "armor", "damage", "speed"];
export const bonusCn = {
    strength: "力量", dexterity: "敏捷", constitution: "体质",
    intelligence: "智力", wisdom: "感知", charisma: "魅力",
    maxHp: "最大HP", maxMp: "最大MP", armor: "护甲", damage: "伤害", speed: "速度"
};
export const resistKeys = ["physical", "fire", "ice", "poison"];
export const resistCn = { physical: "物理", fire: "火焰", ice: "冰霜", poison: "毒素" };

// === Buff 类型与每回合结算（正数恢复 / 负数扣血） ===
export const buffTypeKeys = ["buff", "debuff", "hot", "dot", "other"];
export const buffTypeCn = { buff: "增益", debuff: "减益", hot: "持续回复", dot: "持续伤害", other: "其他" };
export const buffTypeIcon = { buff: "✨", debuff: "💀", hot: "💚", dot: "🩸", other: "🌀" };
export const buffTypeColor = { buff: "var(--gold)", debuff: "var(--red)", hot: "#6dd400", dot: "var(--red)", other: "var(--muted)" };

export function normalizeBuffType(v) {
    const t = String(v || "").trim();
    return buffTypeKeys.includes(t) ? t : "";
}
// 统一 Buff 结构：类型 + 每回合 HP/MP 变化。旧存档没有这些字段时自动补默认值。
export function normalizeBuff(src) {
    const s = (src && typeof src === "object") ? src : {};
    const hp = clampInt(s.hpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
    const mp = clampInt(s.mpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
    let type = normalizeBuffType(s.type);
    // 没显式选类型时按效果自动归类，省得每次手动挑
    if (!type) {
        if (hp > 0 || mp > 0) type = "hot";
        else if (hp < 0 || mp < 0) type = "dot";
        else type = "buff";
    }
    return { ...s, type, hpPerRound: hp, mpPerRound: mp };
}
export function buffTickText(b) {
    const hp = clampInt(b && b.hpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
    const mp = clampInt(b && b.mpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
    const parts = [];
    if (hp) parts.push(`HP${hp > 0 ? "+" : ""}${hp}`);
    if (mp) parts.push(`MP${mp > 0 ? "+" : ""}${mp}`);
    return parts.length ? `每回合 ${parts.join(" / ")}` : "";
}
