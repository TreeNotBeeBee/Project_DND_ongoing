// === 自定义条联动：物品 / 状态 / 条值 三者互相影响 ===
// 自定义条按「名称」关联，加条删条不会错位；改名时会把引用一起迁移。
import { LIMITS, clampNum, clampInt } from "./limits.js";
import { normalizeBuff } from "./core.js";

// 联动后的界面刷新钩子（skills_buffs 注册，避免循环 import）
export const barLinkHooks = { onChange: null };

export function barNameOf(v) {
    return String(v == null ? "" : v).trim().slice(0, 40);
}

export function findCustomBar(data, name) {
    const n = barNameOf(name);
    if (!data || !n) return null;
    const list = Array.isArray(data.customStats) ? data.customStats : [];
    return list.find(cs => cs && barNameOf(cs.name) === n) || null;
}

export function customBarMax(bar) {
    return Math.max(1, clampNum(bar && bar.max, LIMITS.customMax[0], LIMITS.customMax[1], 100));
}

export function customBarVal(bar) {
    return clampNum(bar && bar.val, LIMITS.customVal[0], LIMITS.customVal[1], 0);
}

// 条值的下限：默认不允许负数（防止「透支条」白嫖大招），勾了「允许负值」才放开
export function customBarFloor(bar) {
    return barCfg(bar).allowNegative ? LIMITS.customVal[0] : 0;
}

// 改条值（正=加，负=减），条不存在或增量为 0 时返回 null
export function adjustCustomBar(data, name, delta) {
    const bar = findCustomBar(data, name);
    if (!bar) return null;
    const n = clampInt(delta, LIMITS.customVal[0], LIMITS.customVal[1], 0);
    if (!n) return null;
    const before = customBarVal(bar);
    // 物品/状态带来的增减不会把条压成负数（除非这条勾了「允许负值」；手动编辑同理）
    const after = clampNum(before + n, customBarFloor(bar), customBarMax(bar), before);
    bar.val = after;
    return { bar, name: barNameOf(bar.name), delta: n, before, after, changed: after !== before };
}

// 条的触发配置：满值 / 归零时自动挂上的状态
function triggerCfg(cfg) {
    if (!cfg || typeof cfg !== "object") return null;
    const name = barNameOf(cfg.name);
    if (!name) return null;
    return { name, round: clampInt(cfg.round, LIMITS.round[0], LIMITS.round[1], 0) };
}

// 条配置的统一读取（旧存档没有这些字段时给默认值）
export function barCfg(cs) {
    const s = (cs && typeof cs === "object") ? cs : {};
    const g = (s.gain && typeof s.gain === "object") ? s.gain : {};
    const cap = 999999;
    return {
        atkPct: clampNum(s.atkPct, -500, 500, 0),           // 满值时攻击加成%（按条值比例线性生效）
        fullAtkPct: clampNum(s.fullAtkPct, -500, 500, 0),   // 满值时额外攻击加成%
        gain: {
            round: clampInt(g.round, -cap, cap, 0),         // 回合结束
            damage: clampInt(g.damage, -cap, cap, 0),       // 伤害技能
            heal: clampInt(g.heal, -cap, cap, 0),           // 治疗技能
            buff: clampInt(g.buff, -cap, cap, 0),           // 状态技能
            kill: clampInt(g.kill, -cap, cap, 0)            // 击杀
        },
        onFullBuff: triggerCfg(s.onFullBuff),
        onEmptyBuff: triggerCfg(s.onEmptyBuff),
        shield: s.shield === true,                          // 护盾条：受伤先扣这条
        allowNegative: s.allowNegative === true,            // 允许负值（默认夹在 0）
        shieldMode: s.shieldMode === "hits" ? "hits" : "value", // value=按伤害数值扣盾；hits=次数护盾
        shieldHitCost: clampInt(s.shieldHitCost, 1, LIMITS.customVal[1], 1), // 次数护盾每次受击扣几层
        shieldFlat: clampNum(s.shieldFlat, 0, LIMITS.hpMp[1], 0),            // 有盾时的固定减伤
        shieldPct: clampNum(s.shieldPct, 0, 90, 0)                           // 有盾时的百分比减伤（最多 90）
    };
}

export const BAR_GAIN_KINDS = [
    { key: "round", cn: "回合结束" },
    { key: "damage", cn: "伤害技能" },
    { key: "heal", cn: "治疗技能" },
    { key: "buff", cn: "状态技能" },
    { key: "kill", cn: "击杀敌人" }
];

// 条带来的攻击加成（小数：0.2 = +20%）。条值比例线性缩放，满值再叠额外加成。
export function barDamagePct(cs) {
    const cfg = barCfg(cs);
    if (!cfg.atkPct && !cfg.fullAtkPct) return 0;
    const val = customBarVal(cs);
    const max = customBarMax(cs);
    const ratio = clampNum(val / max, -2, 2, 0);
    let pct = ratio * cfg.atkPct / 100;
    if (val >= max) pct += cfg.fullAtkPct / 100;
    return clampNum(pct, -9.99, 9.99, 0);
}

// 一次事件给所有条加值（负数即扣，可作为惩罚机制）
// kind: round / damage / heal / buff / kill
export function applyBarGain(data, kind) {
    const out = { gained: [], added: [], removed: [] };
    if (!data || !Array.isArray(data.customStats)) return out;
    if (!BAR_GAIN_KINDS.some(k => k.key === kind)) return out;
    data.customStats.forEach(cs => {
        if (!cs) return;
        const n = barCfg(cs).gain[kind] || 0;
        if (!n) return;
        const r = adjustCustomBar(data, cs.name, n);
        if (!r) return;
        out.gained.push(`${r.name}${n > 0 ? "+" : ""}${n}${r.changed ? `→${r.after}` : "（已到边界）"}`);
    });
    const link = syncBarLinks(data);
    out.added = link.added;
    out.removed = link.removed;
    return out;
}

// 条卡片上的配置摘要（放在 ⚙ 的 tooltip 里，不占版面）
export function barCfgText(cs) {
    const cfg = barCfg(cs);
    const parts = [];
    if (cfg.atkPct) parts.push(`条值比例伤害${cfg.atkPct > 0 ? "+" : ""}${cfg.atkPct}%`);
    if (cfg.fullAtkPct) parts.push(`满值伤害${cfg.fullAtkPct > 0 ? "+" : ""}${cfg.fullAtkPct}%`);
    BAR_GAIN_KINDS.forEach(k => {
        const n = cfg.gain[k.key];
        if (n) parts.push(`${k.cn}${n > 0 ? "+" : ""}${n}`);
    });
    if (cfg.onFullBuff) parts.push(`满值挂「${cfg.onFullBuff.name}」`);
    if (cfg.onEmptyBuff) parts.push(`归零挂「${cfg.onEmptyBuff.name}」`);
    if (cfg.shield) {
        parts.push(cfg.shieldMode === "hits"
            ? `🛡 次数护盾（每击耗 ${cfg.shieldHitCost}）`
            : "🛡 护盾条（按伤害扣）");
        if (cfg.shieldFlat) parts.push(`固定减伤${cfg.shieldFlat}`);
        if (cfg.shieldPct) parts.push(`减伤${cfg.shieldPct}%`);
    }
    if (cfg.allowNegative) parts.push("允许负值");
    return parts.join(" · ");
}

// 护盾减伤：只统计「有值的护盾条」；固定减伤相加，百分比减伤相加后最多 90%
export function shieldReduction(data) {
    const out = { flat: 0, pct: 0 };
    if (!data || !Array.isArray(data.customStats)) return out;
    data.customStats.forEach(cs => {
        if (!cs || !barCfg(cs).shield) return;
        if (customBarVal(cs) <= 0) return;
        const cfg = barCfg(cs);
        out.flat += Math.max(0, cfg.shieldFlat);
        out.pct += Math.max(0, cfg.shieldPct);
    });
    out.pct = Math.min(90, out.pct);
    return out;
}

// 受伤结算：减伤 → 扣护盾条（按 customStats 顺序）→ 剩余打到 HP。
// 返回 { absorbed, saved, charges, rest, hits, added, removed }：
// rest 是还要从 HP 里扣的伤害；saved 是被减伤吃掉的部分；absorbed 是被护盾吸收的部分。
export function absorbShields(data, dmg) {
    const out = { absorbed: 0, saved: 0, charges: 0, rest: clampNum(dmg, 0, LIMITS.hpMp[1], 0), hits: [], added: [], removed: [] };
    if (!data || !Array.isArray(data.customStats) || out.rest <= 0) return out;
    const red = shieldReduction(data);
    const before = out.rest;
    out.rest = Math.max(0, Math.ceil(out.rest * (1 - red.pct / 100) - red.flat));
    out.saved = clampNum(before - out.rest, 0, LIMITS.hpMp[1], 0);
    if (out.rest <= 0) return out; // 减伤挡光了，不消耗护盾
    let changed = false;
    for (const cs of data.customStats) {
        if (!cs || typeof cs !== "object") continue;
        const cfg = barCfg(cs);
        if (!cfg.shield) continue;
        const have = Math.max(0, customBarVal(cs));
        if (have <= 0) continue;
        if (cfg.shieldMode === "hits") {
            // 次数护盾：整次伤害由一层挡住，与伤害数值无关
            if (have < cfg.shieldHitCost) {
                cs.val = 0;
                changed = true;
                out.hits.push(`${barNameOf(cs.name)}（层数不足·破盾）`);
                continue;
            }
            const blocked = out.rest;
            cs.val = have - cfg.shieldHitCost;
            out.absorbed += blocked;
            out.rest = 0;
            out.charges += 1;
            changed = true;
            out.hits.push(`${barNameOf(cs.name)} 挡下 ${blocked} 点`);
            break;
        }
        const take = Math.min(have, out.rest);
        cs.val = have - take;
        out.rest -= take;
        out.absorbed += take;
        changed = true;
        out.hits.push(`${barNameOf(cs.name)}-${take}`);
        if (out.rest <= 0) break;
    }
    if (changed) {
        const link = syncBarLinks(data);
        out.added = link.added;
        out.removed = link.removed;
    }
    return out;
}

// 当前护盾总量（面板/提示用）
export function shieldTotal(data) {
    if (!data || !Array.isArray(data.customStats)) return 0;
    return data.customStats.reduce((sum, cs) => {
        if (!cs || !barCfg(cs).shield) return sum;
        return sum + Math.max(0, customBarVal(cs));
    }, 0);
}

// 条改名后，把状态/物品/快速库里的引用一起改名
export function renameBarRefs(data, oldName, newName) {
    const o = barNameOf(oldName);
    const n = barNameOf(newName);
    if (!data || !o || !n || o === n) return 0;
    let count = 0;
    const fix = obj => {
        if (!obj || typeof obj !== "object") return;
        ["barName", "reqBar", "srcBar"].forEach(k => {
            if (barNameOf(obj[k]) === o) { obj[k] = n; count++; }
        });
    };
    (Array.isArray(data.buffs) ? data.buffs : []).forEach(fix);
    (Array.isArray(data.items) ? data.items : []).forEach(fix);
    (Array.isArray(data.buffLib) ? data.buffLib : []).forEach(fix);
    return count;
}

// 同步联动：
// 1) 条满 / 归零 → 自动挂上配置的状态；条件不成立就摘掉（只摘自己挂的）
// 2) 状态带「存续要求 条≥N」→ 条值不足时自动失效
export function syncBarLinks(data, opts) {
    const out = { added: [], removed: [] };
    if (!data || typeof data !== "object") return out;
    if (!Array.isArray(data.buffs)) data.buffs = [];
    const checkRequire = !(opts && opts.checkRequire === false);

    (Array.isArray(data.customStats) ? data.customStats : []).forEach(cs => {
        if (!cs || typeof cs !== "object") return;
        const name = barNameOf(cs.name);
        if (!name) return;
        const v = customBarVal(cs);
        const mx = customBarMax(cs);
        const defs = [
            { key: "full", on: v >= mx, cfg: triggerCfg(cs.onFullBuff) },
            { key: "empty", on: v <= 0, cfg: triggerCfg(cs.onEmptyBuff) }
        ];
        defs.forEach(def => {
            const own = data.buffs.filter(b => b && b.srcBar === name && b.srcTrigger === def.key);
            if (!def.on || !def.cfg) {
                if (!own.length) return;
                data.buffs = data.buffs.filter(b => !(b && b.srcBar === name && b.srcTrigger === def.key));
                own.forEach(b => out.removed.push(b.name || "状态"));
                return;
            }
            if (own.length) {
                // 已挂着：只刷新剩余回合，避免每回合重置
                const cur = own.find(b => b && b.name === def.cfg.name) || own[0];
                if (cur.name !== def.cfg.name) { cur.name = def.cfg.name; }
                return;
            }
            data.buffs.push(normalizeBuff({
                name: def.cfg.name,
                round: def.cfg.round,
                desc: def.key === "full" ? `「${name}」充满时自动获得` : `「${name}」归零时自动获得`,
                type: def.key === "full" ? "buff" : "debuff",
                srcBar: name,
                srcTrigger: def.key
            }));
            out.added.push(def.cfg.name);
        });
    });

    if (checkRequire) {
        data.buffs = data.buffs.filter(b => {
            if (!b || typeof b !== "object") return false;
            const rn = barNameOf(b.reqBar);
            const min = clampInt(b.reqMin, LIMITS.customVal[0], LIMITS.customVal[1], 0);
            if (!rn || min <= 0) return true;
            const bar = findCustomBar(data, rn);
            if (!bar) return true; // 条被删了就先保留，避免误清玩家手写的状态
            if (customBarVal(bar) >= min) return true;
            out.removed.push(b.name || "状态");
            return false;
        });
    }
    return out;
}

// 物品卡片上的联动文案，例如「能量+15」
export function itemBarText(it) {
    const n = barNameOf(it && it.barName);
    const delta = clampInt(it && it.barDelta, LIMITS.customVal[0], LIMITS.customVal[1], 0);
    if (!n || !delta) return "";
    return `${n}${delta > 0 ? "+" : ""}${delta}`;
}

// 状态卡片上的联动文案，例如「每回合 能量+5 · 施加 能量-3 · 需 能量≥10」
export function buffBarText(b) {
    const parts = [];
    const n = barNameOf(b && b.barName);
    if (n) {
        const r = clampInt(b.barPerRound, LIMITS.customVal[0], LIMITS.customVal[1], 0);
        const a = clampInt(b.barOnApply, LIMITS.customVal[0], LIMITS.customVal[1], 0);
        if (r) parts.push(`每回合 ${n}${r > 0 ? "+" : ""}${r}`);
        if (a) parts.push(`施加 ${n}${a > 0 ? "+" : ""}${a}`);
    }
    const rn = barNameOf(b && b.reqBar);
    const min = clampInt(b && b.reqMin, LIMITS.customVal[0], LIMITS.customVal[1], 0);
    if (rn && min > 0) parts.push(`需 ${rn}≥${min}`);
    return parts.join(" · ");
}