import { LIMITS, FINAL_MIN, FINAL_MAX, clampNum, clampInt } from "./limits.js";
import { statKeys, charBase, resistKeys } from "./core.js";
import { d, lastSnap, setD, setLastSnap } from "./state.js";
import { mod } from "./util.js";
import { parseBonus } from "./bonus.js";
import { aggregateBonuses } from "./aggregate.js";
import { loadRawChar } from "./persist.js";

export function computeAll(enemyType) {
    const lvl = clampInt(d.level, LIMITS.level[0], LIMITS.level[1], 1);
    const tier = levelPctAt(lvl);
    const race = parseBonus(d.raceBonus);
    const baseStat = k => clampNum(d[k], LIMITS.stat[0], LIMITS.stat[1], 0);
    const baseHp = clampNum(d.maxHpBase, LIMITS.hpMpBase[0], LIMITS.hpMpBase[1], 0);
    const baseMp = clampNum(d.maxMpBase, LIMITS.hpMpBase[0], LIMITS.hpMpBase[1], 0);
    const baseArmor = clampNum(d.armorBase, LIMITS.armor[0], LIMITS.armor[1], 0);
    const baseSpeed = clampNum(d.speed, LIMITS.speed[0], LIMITS.speed[1], 0);
    // 种族乘区包装：×(1+种族百分比+种族每级百分比×等级) + 种族固定 + 种族每级固定×等级
    const wrapVal = (v, k) => clampNum(Math.floor(
        clampNum(v, FINAL_MIN, FINAL_MAX, 0) *
        (1 + (race.pct[k] || 0) + (race.perLevelPct[k] || 0) * lvl) +
        (race.flat[k] || 0) + (race.perLevel[k] || 0) * lvl
    ), FINAL_MIN, FINAL_MAX, 0);

    // 第一遍：忽略条件，用稳定的最大HP估算当前HP百分比
    const agg0 = aggregateBonuses(false, { hpPct: 0, enemyType: "", level: lvl });
    const midStat0 = k => clampNum(Math.floor(
        (baseStat(k) * (1 + (tier[k] || 0)) + (agg0.flat[k] || 0)) * (1 + (agg0.pct[k] || 0))
    ), FINAL_MIN, FINAL_MAX, 0);
    const conAdd0 = Math.max(0, mod(wrapVal(midStat0("constitution"), "constitution")));
    const maxHp0 = Math.max(1, wrapVal(Math.max(1, Math.floor(
        (baseHp + (agg0.flat.maxHp || 0) + conAdd0) * (1 + (agg0.pct.maxHp || 0))
    )), "maxHp"));

    const ctx = {
        hpPct: Math.max(0, Math.min(200,
            clampNum(d.hp, LIMITS.hpMp[0], LIMITS.hpMp[1], 0) / maxHp0 * 100)),
        enemyType: String(enemyType || "").trim(),
        level: lvl
    };
    const agg = aggregateBonuses(true, ctx);

    // 中间值（种族乘区之前）：基础 ×(1+等级档位加成)，再叠装备/Buff 固定与百分比
    const mid = {};
    statKeys.forEach(k => {
        mid[k] = clampNum(Math.floor(
            (baseStat(k) * (1 + (tier[k] || 0)) + (agg.flat[k] || 0)) * (1 + (agg.pct[k] || 0))
        ), FINAL_MIN, FINAL_MAX, 0);
    });

    // 体质/智力转换：取最终总值（含种族乘区）的调整值，一次性加进生命/魔力基础值
    const statTotal = {};
    statKeys.forEach(k => { statTotal[k] = wrapVal(mid[k], k); });
    const conMod = clampNum(Math.max(0, mod(statTotal.constitution)), 0, FINAL_MAX, 0);
    const intMod = clampNum(Math.max(0, mod(statTotal.intelligence)), 0, FINAL_MAX, 0);
    mid.maxHp = Math.max(1, clampNum(Math.floor(
        (baseHp + (agg.flat.maxHp || 0) + conMod) * (1 + (agg.pct.maxHp || 0))
    ), FINAL_MIN, FINAL_MAX, 0));
    mid.maxMp = Math.max(1, clampNum(Math.floor(
        (baseMp + (agg.flat.maxMp || 0) + intMod) * (1 + (agg.pct.maxMp || 0))
    ), FINAL_MIN, FINAL_MAX, 0));
    mid.armor = Math.max(0, clampNum(Math.floor(
        (baseArmor + (agg.flat.armor || 0)) * (1 + (agg.pct.armor || 0))
    ), FINAL_MIN, FINAL_MAX, 0));
    mid.speed = Math.max(0, clampNum(Math.floor(
        (baseSpeed + (agg.flat.speed || 0)) * (1 + (agg.pct.speed || 0))
    ) + mod(mid.dexterity), FINAL_MIN, FINAL_MAX, 0));
    const damageFlat = clampNum(mod(mid.strength) + (agg.flat.damage || 0), FINAL_MIN, FINAL_MAX, 0);
    mid.damage = Math.max(0, clampNum(Math.floor(damageFlat * (1 + (agg.pct.damage || 0))), FINAL_MIN, FINAL_MAX, 0));

    // 种族独立乘区（最外层）
    const total = {};
    statKeys.forEach(k => { total[k] = statTotal[k]; });
    total.maxHp = Math.max(1, wrapVal(mid.maxHp, "maxHp"));
    total.maxMp = Math.max(1, wrapVal(mid.maxMp, "maxMp"));
    total.armor = Math.max(0, wrapVal(mid.armor, "armor"));
    total.speed = Math.max(0, wrapVal(mid.speed, "speed"));
    total.damage = Math.max(0, wrapVal(mid.damage, "damage"));

    total.damageFlat = clampNum(damageFlat, FINAL_MIN, FINAL_MAX, 0);
    total.resist = {};
    resistKeys.forEach(k => {
        total.resist[k] = Math.max(0, Math.min(0.75,
            clampNum((agg.resist[k] || 0) + (race.resist[k] || 0), LIMITS.bonusResist[0], LIMITS.bonusResist[1], 0)));
    });
    total.initiative = clampNum(mod(mid.dexterity) + mod(mid.wisdom), FINAL_MIN, FINAL_MAX, 0);
    total.conMod = clampNum(conMod, 0, FINAL_MAX, 0);
    total.intMod = clampNum(intMod, 0, FINAL_MAX, 0);

    return { agg, total, mid, race, tier, lvl, ctx };
}

// 等级成长表：里程碑制，每行是"从该等级起生效的六维总加成"，高档位覆盖低档位
export function normalizeGrowth(arr) {
    const map = new Map();
    (Array.isArray(arr) ? arr.slice(0, 1000) : []).forEach(row => {
        const lvl = clampInt(row && row.level, LIMITS.level[0], LIMITS.level[1], 1);
        if (!map.has(lvl)) map.set(lvl, { level: lvl, pct: {} });
        const target = map.get(lvl);
        statKeys.forEach(k => {
            const v = clampNum(row && row.pct && row.pct[k], LIMITS.growthPct[0], LIMITS.growthPct[1], 0);
            if (v !== 0) target.pct[k] = clampNum((target.pct[k] || 0) + v, LIMITS.growthPct[0], LIMITS.growthPct[1], 0);
        });
    });
    return [...map.values()].sort((a, b) => a.level - b.level);
}

// 生效档位：取等级 ≤ 当前等级的最高一行（高档位覆盖低档位，没填的等级沿用上一档）
export function levelTierRow(level, rows) {
    const lvl = clampInt(level, LIMITS.level[0], LIMITS.level[1], 1);
    let best = null;
    (rows || []).forEach(r => {
        const rl = clampInt(r && r.level, LIMITS.level[0], LIMITS.level[1], 0);
        if (rl <= lvl && (!best || rl > (Number(best.level) || 0))) best = r;
    });
    return best;
}

export function levelTierPct(level, rows) {
    const out = {};
    statKeys.forEach(k => out[k] = 0);
    const row = levelTierRow(level, rows);
    if (row) statKeys.forEach(k => out[k] = clampNum(row.pct && row.pct[k], LIMITS.growthPct[0], LIMITS.growthPct[1], 0));
    return out;
}

export function levelPctAt(level) {
    return levelTierPct(level, normalizeGrowth(d.levelGrowth));
}

// === 随从快照 ===
// 用任意一份角色数据替换全局 d 跑一遍完整 computeAll，再还原现场。
// 用于：随从(独立模式)自身数值 / 被随从引用的主人的完整数值。
export function computeSnapshotWithOwner(data) {
    if (!data || typeof data !== "object") return null;
    const savedD = d, savedSnap = lastSnap;
    let snap = null;
    try {
        setD({ ...JSON.parse(JSON.stringify(charBase)), ...data });
        snap = computeAll("");
    } catch (e) {
        snap = null;
    } finally {
        setD(savedD);
        setLastSnap(savedSnap);
    }
    return snap;
}

// 把主人/基础 total 按系数缩放出随从的 total 对象（六维 + HP/MP/护甲/速度/伤害/先攻/豁免 + 抗性）
export function scaleHeroTotal(heroSnap, base, coeff) {
    const st = k => (heroSnap && heroSnap.total ? heroSnap.total[k] : clampNum(base[k], LIMITS.stat[0], LIMITS.stat[1], 0));
    const total = {};
    statKeys.forEach(k => total[k] = clampNum(Math.floor(st(k) * coeff), FINAL_MIN, FINAL_MAX, 0));
    total.maxHp = Math.max(1, clampNum(Math.floor((heroSnap && heroSnap.total ? heroSnap.total.maxHp : clampNum(base.maxHpBase, LIMITS.hpMpBase[0], LIMITS.hpMpBase[1], 0)) * coeff), 1, FINAL_MAX, 1));
    total.maxMp = Math.max(1, clampNum(Math.floor((heroSnap && heroSnap.total ? heroSnap.total.maxMp : clampNum(base.maxMpBase, LIMITS.hpMpBase[0], LIMITS.hpMpBase[1], 0)) * coeff), 1, FINAL_MAX, 1));
    total.armor = Math.max(0, clampNum(Math.floor((heroSnap && heroSnap.total ? heroSnap.total.armor : clampNum(base.armorBase, LIMITS.armor[0], LIMITS.armor[1], 0)) * coeff), 0, FINAL_MAX, 0));
    total.speed = Math.max(0, clampNum(Math.floor((heroSnap && heroSnap.total ? heroSnap.total.speed : clampNum(base.speed, LIMITS.speed[0], LIMITS.speed[1], 0)) * coeff), 0, FINAL_MAX, 0));
    const srcDmg = heroSnap && heroSnap.total ? (heroSnap.total.damage || 0) : mod(clampNum(base.strength, LIMITS.stat[0], LIMITS.stat[1], 0));
    total.damage = Math.max(0, clampNum(Math.floor(srcDmg * coeff), 0, FINAL_MAX, 0));
    total.damageFlat = clampNum(Math.floor(srcDmg * coeff), FINAL_MIN, FINAL_MAX, 0);
    total.initiative = clampNum(Math.floor((heroSnap && heroSnap.total ? heroSnap.total.initiative : 0) * coeff), FINAL_MIN, FINAL_MAX, 0);
    total.conMod = clampNum(Math.floor((heroSnap && heroSnap.total ? heroSnap.total.conMod : 0) * coeff), 0, FINAL_MAX, 0);
    total.intMod = clampNum(Math.floor((heroSnap && heroSnap.total ? heroSnap.total.intMod : 0) * coeff), 0, FINAL_MAX, 0);
    total.resist = {};
    resistKeys.forEach(k => total.resist[k] = heroSnap && heroSnap.total ? clampNum(heroSnap.total.resist[k], 0, 0.75, 0) : 0);
    return total;
}

// 随从缩放模式（growth / summon 吃倍率）是否为当前生效。
// 主角形态(hero)不同步属性，只同步等级，所以不算缩放。
export function isScaledCompanion(snap) {
    return !!(snap && snap.type === "companion" &&
        (snap.mode === "growth" || (snap.mode === "summon" && snap.summonScale === true)));
}

// 统一的"当前角色快照"：
// 主角 / 独立随从 / 固定召唤物 / 主角形态 → 用当前角色自己的数据跑 computeAll；
// 其中主角形态只把等级对齐主人（属性独立，变身才有意义）。
// growth / 吃倍率的 summon → 主角最终总值 × scale。
export function computeSnapshot(enemyType) {
    if (!d || d.type !== "companion") return computeAll(enemyType || "");
    const heroMode = d.mode === "hero";
    const scaleMode = d.mode === "growth" || (d.mode === "summon" && d.summonScale === true);
    if (heroMode) {
        const heroSnap = d.ownerId ? computeSnapshotWithOwner(loadRawChar(d.ownerId)) : null;
        if (heroSnap) d.level = clampInt(heroSnap.lvl, LIMITS.level[0], LIMITS.level[1], 1);
        const snap = computeAll(enemyType || "");
        // 勾选「血量百分比同步」时，按主角当前 HP% 换算本形态的当前血量
        if (d.hpSync && heroSnap) {
            const heroData = loadRawChar(d.ownerId) || {};
            const heroMax = Math.max(1, heroSnap.total.maxHp);
            const pct = clampNum(heroData.hp, 0, heroMax, 0) / heroMax;
            d.hp = clampNum(Math.round(pct * snap.total.maxHp), 0, snap.total.maxHp, 0);
        }
        return snap;
    }
    if (!scaleMode) return computeAll(enemyType || "");
    const coeff = clampNum(d.scale, LIMITS.companionScale[0], LIMITS.companionScale[1], 0.6);
    const heroSnap = d.ownerId ? computeSnapshotWithOwner(loadRawChar(d.ownerId)) : null;
    const total = scaleHeroTotal(heroSnap, d, coeff);
    return {
        type: "companion", mode: d.mode, coeff, summonScale: d.summonScale === true,
        total,
        agg: { flat: {}, pct: {}, resist: {}, sets: [] },
        mid: {},
        race: { pct: {}, flat: {}, perLevel: {}, perLevelPct: {}, resist: {} },
        tier: {},
        lvl: clampInt(d.level, LIMITS.level[0], LIMITS.level[1], 1),
        ctx: {}
    };
}
