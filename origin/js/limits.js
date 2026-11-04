// === 数值安全边界：防止超大/非法数值（NaN、Infinity、1e308 等）导致页面卡死或崩溃 ===
// 四道防线：输入框 → 存档/导入 → 加成解析 → 最终计算。所有边界都取得很大，正常跑团不会碰到。
export const LIMITS = {
    level: [1, 9999],
    xp: [0, 999999999999],
    stat: [0, 9999999],                 // 六维基础值
    hpMp: [0, 999999999999],            // 当前 HP/MP（与最终值硬上限一致，避免最大生命超过10亿时当前值填不满）
    hpMpBase: [0, 999999999],           // HP/MP 基础值
    gold: [0, 9999999999999],           // 金币
    armor: [0, 99999999],
    speed: [0, 9999999],
    bonusFlat: [-9999999, 9999999],     // 固定加成
    bonusPerLevel: [-999999, 999999],   // 每级固定加成
    bonusPct: [-100, 100],              // 小数形式：±10000%
    bonusResist: [-100, 100],           // 解析边界；最终抗性仍限制在 0%~75%
    qty: [1, 999999],                   // 物品数量
    weight: [0, 999999],                // 单件物品重量（kg）
    heal: [0, 999999999],               // 消耗品回复量
    customVal: [-999999999, 999999999], // 自定义条当前值（允许负值）
    customMax: [1, 999999999],          // 自定义条上限
    enemyHp: [0, 999999999],
    enemyAc: [0, 999999],
    diceCount: [1, 1000],               // 骰子个数（防止 999999d6 把浏览器卡死）
    diceSides: [1, 1000000],
    diceMod: [-999999, 999999],
    round: [0, 999999],                 // Buff 回合
    buffTick: [-999999999, 999999999],  // Buff 每回合 HP/MP 变化（正=恢复，负=扣血）
    growthPct: [-100, 100],             // 等级成长（小数形式：±10000%）
    companionScale: [0.01, 100]         // 随从相对主角的系数（默认 0.6，限制 0.01~100 倍）
};

// 计算层硬边界：任何最终数值都不会超出 ±1e12
export const FINAL_MIN = -999999999999;
export const FINAL_MAX = 999999999999;

export function clampNum(v, min, max, fallback = 0) {
    let n = (typeof v === "number") ? v : Number(String(v == null ? "" : v).trim());
    if (Number.isNaN(n)) n = Number(fallback);
    if (Number.isNaN(n)) n = 0;
    if (n === Infinity) return max;
    if (n === -Infinity) return min;
    return n < min ? min : (n > max ? max : n);
}
export function clampInt(v, min, max, fallback = 0) {
    return Math.floor(clampNum(v, min, max, fallback));
}

// 原生输入框的边界（level 单独取整）
export const nativeNumLimits = {
    level: LIMITS.level, xp: LIMITS.xp,
    hp: LIMITS.hpMp, maxHpBase: LIMITS.hpMpBase,
    mp: LIMITS.hpMp, maxMpBase: LIMITS.hpMpBase,
    strength: LIMITS.stat, dexterity: LIMITS.stat, constitution: LIMITS.stat,
    intelligence: LIMITS.stat, wisdom: LIMITS.stat, charisma: LIMITS.stat,
    gold: LIMITS.gold, armorBase: LIMITS.armor, speed: LIMITS.speed
};
