import { LIMITS, FINAL_MIN, FINAL_MAX, clampNum, clampInt } from "./limits.js";
import { statCn, resistCn } from "./core.js";
import { d, charList } from "./state.js";
import { rollOne, mod } from "./util.js";
import { computeSnapshot } from "./compute.js";
import { pctText } from "./display.js";
import { read, saveRawChar, saveCurrentCharacter, pushHpToOwner } from "./persist.js";
import { companionData, renderCombatTargets } from "./companion_ui.js";
import { computeCompanion } from "./companion.js";
import { renderDerived } from "./stats_ui.js";
import { applyBarGain, absorbShields } from "./bar_link.js";

// 投骰审计：每次投骰都报给主持人面板（GM 数据 = 将来的房间状态）。
// 用 globalThis 调用，避免 combat_dice ↔ gm_ui 循环 import。
function logRoll(kind, detail, total) {
    if (typeof globalThis.gmLogRoll === "function") {
        try { globalThis.gmLogRoll({ kind, detail, total }); } catch (e) { }
    }
}

//骰子
export function addDiceLog(text) {
    const log = document.getElementById("diceLog");
    const div = document.createElement("div"); div.innerText = text; log.prepend(div);
}
export function rollDice() {
    const sides = clampInt(document.getElementById("diceSides").value, LIMITS.diceSides[0], LIMITS.diceSides[1], 6);
    const count = clampInt(document.getElementById("diceCount").value, LIMITS.diceCount[0], LIMITS.diceCount[1], 1);
    const mod = clampNum(document.getElementById("diceMod").value, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
    const res = [];
    for (let i = 0; i < count; i++) res.push(rollOne(sides));
    const sum = clampNum(res.reduce((a, b) => a + b, 0) + mod, FINAL_MIN, FINAL_MAX, 0);
    addDiceLog(`投${count}d${sides}${mod >= 0 ? "+" + mod : mod} → [${res.join(",")}] 总和=${sum}`);
    logRoll("dice", `${count}d${sides}${mod >= 0 ? "+" + mod : mod}`, sum);
}
export function rollAdv() {
    const sides = clampInt(document.getElementById("diceSides").value, LIMITS.diceSides[0], LIMITS.diceSides[1], 6);
    const mod = clampNum(document.getElementById("diceMod").value, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
    const r1 = rollOne(sides), r2 = rollOne(sides);
    const best = clampNum(Math.max(r1, r2) + mod, FINAL_MIN, FINAL_MAX, 0);
    addDiceLog(`优势投2d${sides}${mod >= 0 ? "+" + mod : mod} →(${r1},${r2})取大=${best}`);
    logRoll("adv", `2d${sides}${mod >= 0 ? "+" + mod : mod} 取大(${r1},${r2})`, best);
}
export function rollDis() {
    const sides = clampInt(document.getElementById("diceSides").value, LIMITS.diceSides[0], LIMITS.diceSides[1], 6);
    const mod = clampNum(document.getElementById("diceMod").value, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
    const r1 = rollOne(sides), r2 = rollOne(sides);
    const worst = clampNum(Math.min(r1, r2) + mod, FINAL_MIN, FINAL_MAX, 0);
    addDiceLog(`劣势投2d${sides}${mod >= 0 ? "+" + mod : mod} →(${r1},${r2})取小=${worst}`);
    logRoll("dis", `2d${sides}${mod >= 0 ? "+" + mod : mod} 取小(${r1},${r2})`, worst);
}
export function clearDiceLog() { document.getElementById("diceLog").innerHTML = ""; }
export function rollCheck() {
    const key = document.getElementById("checkStat").value;
    const dc = clampNum(document.getElementById("checkDC").value, LIMITS.diceMod[0], LIMITS.diceMod[1], 10);
    const prof = clampNum(document.getElementById("checkProf").value, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
    const snap = computeSnapshot();
    const m = mod(snap.total[key]);
    const r = rollOne(20);
    const total = clampNum(r + m + prof, FINAL_MIN, FINAL_MAX, 0);
    addDiceLog(`${statCn[key]}检定: d20(${r}) ${m >= 0 ? "+" : ""}${m}${prof ? ` +熟练${prof}` : ""} = ${total} vs DC${dc} → ${total >= dc ? "✅成功" : "❌失败"}`);
    logRoll("check", `${statCn[key]}检定 vs DC${dc}`, total);
}

//战斗计算器
export function parseDiceExpr(expr) {
    const m = String(expr || "").match(/(\d+)d(\d+)([+-]\d+)?/i);
    if (!m) return { total: clampNum(expr, FINAL_MIN, FINAL_MAX, 0), rolls: [] };
    const cnt = clampInt(m[1], LIMITS.diceCount[0], LIMITS.diceCount[1], 1);
    const side = clampInt(m[2], LIMITS.diceSides[0], LIMITS.diceSides[1], 6);
    const mod = clampNum(m[3] || 0, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
    const rolls = []; for (let i = 0; i < cnt; i++) rolls.push(rollOne(side));
    const sum = clampNum(rolls.reduce((a, b) => a + b, 0) + mod, FINAL_MIN, FINAL_MAX, 0);
    return { total: sum, rolls, mod };
}
export function addCombatLog(txt) {
    const log = document.getElementById("combatLog");
    const div = document.createElement("div"); div.innerText = txt; log.prepend(div);
}
export function combatAttack() {
    const atkMod = clampNum(document.getElementById("combatAtkMod").value, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
    const ac = clampNum(document.getElementById("enemyAC").value, LIMITS.enemyAc[0], LIMITS.enemyAc[1], 0);
    const dmgExpr = document.getElementById("combatDmgExpr").value.trim();
    const enemyHpEl = document.getElementById("enemyHp");
    let ehp = clampNum(enemyHpEl.value, LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
    const enemyTypeEl = document.getElementById("enemyType");
    const enemyType = enemyTypeEl ? enemyTypeEl.value : "";
    const snap = computeSnapshot(enemyType);
    const atkRoll = rollOne(20);
    const isCrit = atkRoll === 20;
    const isMiss = atkRoll === 1;
    const atkTotal = clampNum(atkRoll + atkMod, FINAL_MIN, FINAL_MAX, 0);
    addCombatLog(`攻击骰 d20+${atkMod}: ${atkRoll}+${atkMod}=${atkTotal} 敌人AC:${ac}`);
    logRoll("attack", `d20+${atkMod} vs AC ${ac}`, atkTotal);
    if (isMiss) { addCombatLog("▶ 大失败！攻击完全落空"); return; }
    if (isCrit) addCombatLog("★★暴击！双倍伤害！");
    if (isCrit || atkTotal >= ac) {
        const dmgRes = parseDiceExpr(dmgExpr);
        // 骰子/纯数字先掷出，再叠加固定伤害，最后乘百分比
        let dice = dmgRes.rolls.length
            ? dmgRes.rolls.reduce((s, v) => s + v, 0) + (dmgRes.mod || 0)
            : dmgRes.total;
        if (isCrit) dice *= 2;
        dice = clampNum(dice, FINAL_MIN, FINAL_MAX, 0);
        const raw = clampNum(dice + snap.total.damageFlat, FINAL_MIN, FINAL_MAX, 0);
        const midDmg = clampNum(Math.floor(raw * (1 + (snap.agg.pct.damage || 0))), FINAL_MIN, FINAL_MAX, 0);
        const rDmgPct = clampNum(clampNum(snap.race.pct.damage, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0) +
            clampNum(snap.race.perLevelPct.damage, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0) * snap.lvl,
            FINAL_MIN, FINAL_MAX, 0);
        const rDmgFlat = clampNum(clampNum(snap.race.flat.damage, FINAL_MIN, FINAL_MAX, 0) +
            clampNum(snap.race.perLevel.damage, FINAL_MIN, FINAL_MAX, 0) * snap.lvl,
            FINAL_MIN, FINAL_MAX, 0);
        const dmg = clampNum(Math.max(0, Math.floor(midDmg * (1 + rDmgPct) + rDmgFlat)), 0, FINAL_MAX, 0);
        logRoll("damage", dmgExpr || "伤害", dmg);
        // 伤害结算目标：选了参战随从就扣随从，否则扣敌人
        const targetEl = document.getElementById("combatTarget");
        const targetVal = targetEl ? targetEl.value : "hero";
        // 目标值：自定义角色为 "companion_<charId>"
        const cid = targetVal.indexOf("companion_") === 0 ? targetVal.slice("companion_".length) : "";
        const cmeta = cid ? (charList || []).find(x => x.id === cid) : null;
        if (cmeta && cmeta.type === "companion") {
            const cdata = companionData(cid);
            const cc = computeCompanion({ ...cdata, ownerId: cmeta.ownerId || cdata.ownerId || "" });
            cdata.hp = clampNum(Math.max(0, cc.hp - dmg), 0, cc.maxHp, 0);
            const label = `${cdata.name || ""} (HP ${cdata.hp}/${cc.maxHp})`;
            const bonusTxt = snap.total.damageFlat ? ` +伤害加值${snap.total.damageFlat}` : "";
            const pctTxt = snap.agg.pct.damage ? ` ×${(1 + snap.agg.pct.damage).toFixed(2)}` : "";
            addCombatLog(`命中【${label}】！伤害 ${dice}${bonusTxt}${pctTxt} = ${dmg}`);
            saveRawChar(cid, cdata);
            renderCombatTargets();
        } else {
            ehp = clampNum(Math.max(0, ehp - dmg), LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
            const bonusTxt = snap.total.damageFlat ? ` +伤害加值${snap.total.damageFlat}` : "";
            const pctTxt = snap.agg.pct.damage ? ` ×${(1 + snap.agg.pct.damage).toFixed(2)}` : "";
            const raceTxt = (rDmgPct || rDmgFlat)
                ? ` 种族${rDmgPct ? ` ×${(1 + rDmgPct).toFixed(2)}` : ""}${rDmgFlat ? ` ${rDmgFlat >= 0 ? "+" : "-"}${Math.abs(rDmgFlat)}` : ""}`
                : "";
            addCombatLog(`命中！伤害 ${dice}${bonusTxt}${pctTxt}${raceTxt} = ${dmg}`);
        }
    } else {
        addCombatLog("▶未命中，攻击被格挡");
    }
    enemyHpEl.value = ehp;
}
// 按当前战斗目标结算一次纯伤害（小被动/持续伤害复用）
export function applyDamageToCombatTarget(dmg, tag) {
    const targetEl = document.getElementById("combatTarget");
    const targetVal = targetEl ? targetEl.value : "hero";
    const cid = targetVal.indexOf("companion_") === 0 ? targetVal.slice("companion_".length) : "";
    const cmeta = cid ? (charList || []).find(x => x.id === cid) : null;
    if (cmeta && cmeta.type === "companion") {
        const cdata = companionData(cid);
        const cc = computeCompanion({ ...cdata, ownerId: cmeta.ownerId || cdata.ownerId || "" });
        const sh = absorbShields(cdata, dmg);
        cdata.hp = clampNum(Math.max(0, cc.hp - sh.rest), 0, cc.maxHp, 0);
        saveRawChar(cid, cdata);
        renderCombatTargets();
        addCombatLog(`${tag} → 命中【${cdata.name || ""}】 ${dmg} 点${sh.saved ? `（减伤 ${sh.saved}）` : ""}${sh.absorbed ? `（🛡 护盾吸收 ${sh.absorbed}）` : ""}，剩余HP:${cdata.hp}/${cc.maxHp}`);
        return;
    }
    const el = document.getElementById("enemyHp");
    let ehp = clampNum(el.value, LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
    const beforeHp = ehp;
    ehp = clampNum(Math.max(0, ehp - dmg), LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
    el.value = ehp;
    addCombatLog(`${tag} → 敌人受到 ${dmg} 点伤害，剩余HP:${ehp}`);
    // 击杀奖励：给大招条涨值
    if (beforeHp > 0 && ehp <= 0) {
        const gain = applyBarGain(d, "kill");
        if (gain.added.length) gain.added.forEach(n => addCombatLog(`🔋 条触发：${n}`));
        if (gain.gained.length) addCombatLog(`🔋 击杀奖励：${gain.gained.join("、")}`);
    }
}

export function playerTakeDamage() {
    read();
    const raw = clampNum(document.getElementById("incomingDmg").value, 0, FINAL_MAX, 0);
    const type = document.getElementById("incomingType").value;
    const snap = computeSnapshot();
    const resist = clampNum(snap.total.resist[type], 0, 0.75, 0);
    const dmg = raw > 0 ? clampNum(Math.max(1, Math.ceil(raw * (1 - resist))), 0, FINAL_MAX, 0) : 0;
    // 小被动：每 N 回合百分百闪避（按 combatRounds 计数，与 tickBuffs 同步）
    const rounds = clampInt(Number(d.combatRounds) || 0, 0, 999999, 0);
    const dodgeEvery = (Array.isArray(d.extraMods) ? d.extraMods : [])
        .filter(m => m && m.enabled !== false && clampInt(m.passive && m.passive.dodgeEvery, 0, 999, 0) > 0)
        .map(m => clampInt(m.passive.dodgeEvery, 0, 999, 0));
    if (raw > 0 && dodgeEvery.some(n => rounds > 0 && rounds % n === 0)) {
        addCombatLog(`被动·百分百闪避！本回合免疫 ${raw} 点${resistCn[type]}伤害`);
        document.getElementById("hp").value = d.hp;
        document.getElementById("hptext").textContent = `${d.hp} / ${snap.total.maxHp}`;
        document.getElementById("hpfill").style.width = Math.min(100, d.hp / snap.total.maxHp * 100) + "%";
        renderDerived(snap);
        saveCurrentCharacter();
        return;
    }
    // 护盾条：伤害先扣护盾，扣完才轮到 HP（状态技能给护盾条加值就是「套盾」）
    const shield = absorbShields(d, dmg);
    const realDmg = shield.rest;
    if (shield.saved > 0) addCombatLog(`🛡 护盾减伤 ${shield.saved} 点`);
    if (shield.absorbed > 0) {
        addCombatLog(`🛡 ${shield.hits.join("、")} 吸收 ${shield.absorbed} 点${realDmg > 0 ? `，剩余 ${realDmg} 点打到本体` : "，伤害被完全挡住"}`);
        if (shield.removed.length) shield.removed.forEach(n => addCombatLog(`状态失效：${n}`));
        if (shield.added.length) shield.added.forEach(n => addCombatLog(`🔋 条触发：${n}`));
    }
    d.hp = clampNum(Math.max(0, d.hp - realDmg), 0, snap.total.maxHp, 0);
    document.getElementById("hp").value = d.hp;
    document.getElementById("hptext").textContent = `${d.hp} / ${snap.total.maxHp}`;
    document.getElementById("hpfill").style.width = Math.min(100, d.hp / snap.total.maxHp * 100) + "%";
    addCombatLog(`受到 ${raw} 点${resistCn[type]}伤害，抗性${pctText(resist)}减免 → 实际 ${dmg}${shield.saved ? `（护盾减伤 ${shield.saved}）` : ""}${shield.absorbed ? `（护盾吸收 ${shield.absorbed}${shield.charges ? ` · 挡下 ${shield.charges} 击` : ""}）` : ""}，剩余HP:${d.hp}`);
    renderDerived(snap);
    // 主角形态开了「血量百分比同步」：扣血也要写回主角（同一个人共用一个血条）
    if (d.type === "companion") pushHpToOwner(d);
    saveCurrentCharacter();
}
export function enemyDamage() {
    const dmg = clampNum(prompt("敌人受到伤害值", "5"), 0, FINAL_MAX, 0);
    let ehp = clampNum(document.getElementById("enemyHp").value, LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
    ehp = clampNum(Math.max(0, ehp - dmg), LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
    document.getElementById("enemyHp").value = ehp;
    addCombatLog(`敌人受到 ${dmg} 点伤害，剩余HP:${ehp}`);
}
export function enemyHeal() {
    const heal = clampNum(prompt("敌人治疗数值", "5"), 0, FINAL_MAX, 0);
    const emax = clampNum(document.getElementById("enemyMaxHp").value, LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
    let ehp = clampNum(document.getElementById("enemyHp").value, LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
    ehp = clampNum(Math.min(emax, ehp + heal), LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
    document.getElementById("enemyHp").value = ehp;
    addCombatLog(`敌人治疗 ${heal} 点，剩余HP:${ehp}`);
}
export function resetEnemy() {
    const mv = clampNum(document.getElementById("enemyMaxHp").value, LIMITS.enemyHp[0], LIMITS.enemyHp[1], 0);
    document.getElementById("enemyHp").value = mv;
    addCombatLog(`敌人HP重置为${mv}`);
}
