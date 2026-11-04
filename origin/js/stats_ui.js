import { LIMITS, clampNum, clampInt } from "./limits.js";
import { statKeys, statCn } from "./core.js";
import { barNameOf, customBarVal, customBarMax, customBarFloor, renameBarRefs, syncBarLinks, barLinkHooks, barCfg, barCfgText } from "./bar_link.js";
import { d, lastSnap } from "./state.js";
import { esc, mod } from "./util.js";
import { computeAll, normalizeGrowth, levelTierRow, levelPctAt, isScaledCompanion } from "./compute.js";
import { recalcGearBonus, layerText, raceSuffix, pctText, bonusSummary, renderCarry } from "./display.js";
import { parseBonus } from "./bonus.js";
import { read } from "./persist.js";
import { save, closeModal } from "./modal_misc.js";

export function statFormulaText(nativeVal, k, s) {
    const tier = Number(s.tier[k]) || 0;
    const flat = Number(s.agg.flat[k]) || 0;
    const pct = Number(s.agg.pct[k]) || 0;
    const rPct = (Number(s.race.pct[k]) || 0) + (Number(s.race.perLevelPct[k]) || 0) * (Number(s.lvl) || 1);
    const rFlat = (Number(s.race.flat[k]) || 0) + (Number(s.race.perLevel[k]) || 0) * (Number(s.lvl) || 1);
    let txt = `${nativeVal}`;
    if (tier) txt += ` ×${(1 + tier).toFixed(2)}`;
    if (flat) txt += ` ${flat >= 0 ? "+" : "-"}${Math.abs(flat)}`;
    if (pct) txt += ` ×${(1 + pct).toFixed(2)}`;
    if (tier || flat || pct || rPct || rFlat) txt += ` = ${s.mid[k]}`;
    if (rPct) txt += ` ×${(1 + rPct).toFixed(2)}`;
    if (rFlat) txt += ` ${rFlat >= 0 ? "+" : "-"}${Math.abs(rFlat)}`;
    if (rPct || rFlat) txt += ` = ${s.total[k]}`;
    return txt;
}

export function renderStatPanel(snap) {
    const el = document.getElementById("statPanel");
    if (!el) return;
    const s = snap || lastSnap || computeAll();
    el.innerHTML = statKeys.map(k => {
        const nativeVal = clampNum(d[k], LIMITS.stat[0], LIMITS.stat[1], 0);
        const total = s.total[k];
        const formula = statFormulaText(nativeVal, k, s);
        return `<div class="stat">
    <div class="stat-total">${total}</div>
    <span>${esc(statCn[k])}</span>
    <input class="native" data-statkey="${esc(k)}" type="number" value="${nativeVal}" min="0" title="原生${esc(statCn[k])}，修改后自动叠加加成">
    <div class="stat-bonus">${formula === `${nativeVal}` ? "原生" : formula}</div>
</div>`;
    }).join("");
}

export function renderDerived(snap) {
    const s = snap || lastSnap || computeAll();
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText("damageTotal", s.total.damage);
    setText("initiativeTotal", s.total.initiative);
    setText("conModText", (s.total.conMod >= 0 ? "+" : "") + s.total.conMod);
    setText("resistPhysical", pctText(s.total.resist.physical));
    setText("resistFire", pctText(s.total.resist.fire));
    setText("resistIce", pctText(s.total.resist.ice));
    setText("resistPoison", pctText(s.total.resist.poison));
    const setInfo = document.getElementById("setInfo");
    if (setInfo) {
        setInfo.textContent = s.agg.sets.length
            ? "套装生效：" + s.agg.sets.map(x => `${x.name}(${x.count}/${x.pieces})`).join("、")
            : "";
    }
    const growthInfo = document.getElementById("growthInfo");
    if (growthInfo) {
        const race = String(d.race || "").trim();
        const raceText = bonusSummary(parseBonus(d.raceBonus));
        const lp = levelPctAt(d.level);
        const growthParts = statKeys
            .filter(k => Math.abs(Number(lp[k]) || 0) > 1e-9)
            .map(k => `${statCn[k]}${lp[k] >= 0 ? "+" : ""}${Math.round(lp[k] * 1000) / 10}%`);
        const tierRow = levelTierRow(d.level, normalizeGrowth(d.levelGrowth));
        growthInfo.textContent = `种族：${race || "未设置"}${raceText ? `（${raceText}）` : ""}`
            + (growthParts.length
                ? `｜等级成长：${tierRow ? `${tierRow.level}级档 ` : ""}${growthParts.join(" ")}`
                : "｜等级成长：无");
    }
}

// 血条染色：血魔共池 / 烧血种族用颜色区分「这条其实是生命」
const HP_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export function renderHpColor() {
    const c = (d && HP_COLOR_RE.test(String(d.hpColor || ""))) ? String(d.hpColor) : "";
    const fill = document.getElementById("hpfill");
    if (fill) fill.style.background = c || "";
    const pick = document.getElementById("hpColorPick");
    if (pick) pick.value = c || "#4caf50";
}
export function setHpColor(v) {
    if (!d) return;
    const s = String(v || "").trim();
    d.hpColor = HP_COLOR_RE.test(s) ? s : "";
    hpUpdate();
    save();
}
export function hpUpdate() {
    read();
    const snap = recalcGearBonus();
    const totalMaxHp = snap.total.maxHp;
    const totalMaxMp = snap.total.maxMp;

    // 生命与魔力计算
    d.hp = Math.max(0, Math.min(d.hp, totalMaxHp));
    d.mp = Math.max(0, Math.min(d.mp, totalMaxMp));
    document.getElementById("hp").value = d.hp;
    document.getElementById("maxHpBase").value = d.maxHpBase;
    document.getElementById("hptext").textContent = `${d.hp} / ${totalMaxHp}`;
    document.getElementById("hpfill").style.width = Math.min(100, d.hp / totalMaxHp * 100) + "%";
    document.getElementById("mp").value = d.mp;
    document.getElementById("maxMpBase").value = d.maxMpBase;
    document.getElementById("mptext").textContent = `${d.mp} / ${totalMaxMp}`;
    document.getElementById("mpfill").style.width = Math.min(100, d.mp / totalMaxMp * 100) + "%";
    renderHpColor();

    // 护甲合计（含种族乘区后缀）；随主成长的随从没有中间值，直接显示缩放后的最终值
    const scaled = isScaledCompanion(snap);
    const scaledTag = scaled ? `（随主角 ×${Math.round((Number(snap.coeff) || 0) * 100) / 100}）` : "";
    if (scaled) {
        document.getElementById("armorBaseText").textContent = `${snap.total.armor}${scaledTag}`;
    } else {
        document.getElementById("armorBaseText").textContent =
            layerText(d.armorBase, snap.agg.flat.armor, snap.agg.pct.armor, snap.mid.armor)
            + raceSuffix(snap.race.pct.armor, snap.race.flat.armor, snap.race.perLevel.armor, snap.race.perLevelPct.armor, snap.lvl, snap.total.armor);
    }

    // 速度：基础+固定，乘百分比，再加敏捷调整（中间值），最后种族乘区；随主成长的随从直接显示缩放值
    if (scaled) {
        document.getElementById("speedTotalText").textContent = `${snap.total.speed}${scaledTag}`;
    } else {
        const speedBase = clampNum(d.speed, LIMITS.speed[0], LIMITS.speed[1], 0);
        const flatSpd = Number(snap.agg.flat.speed) || 0;
        const pctSpd = clampNum(snap.agg.pct.speed, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0);
        const dexMod = mod(snap.mid.dexterity);
        // 单一等式：基础 → 固定/百分比 → 敏捷，最后给中间值；无任何加成时只显示数字
        let speedExpr = `${speedBase}`;
        if (flatSpd !== 0) speedExpr += ` ${flatSpd > 0 ? "+" : "-"}${Math.abs(flatSpd)}`;
        if (pctSpd !== 0) speedExpr = (flatSpd !== 0 ? `(${speedExpr})` : speedExpr) + ` ×${(1 + pctSpd).toFixed(2)}`;
        if (dexMod !== 0) speedExpr += ` ${dexMod > 0 ? "+" : "-"}${Math.abs(dexMod)}`;
        const speedChanged = flatSpd !== 0 || pctSpd !== 0 || dexMod !== 0;
        document.getElementById("speedTotalText").textContent =
            (speedChanged ? `${speedExpr} = ${snap.mid.speed}` : `${snap.mid.speed}`)
            + raceSuffix(snap.race.pct.speed, snap.race.flat.speed, snap.race.perLevel.speed, snap.race.perLevelPct.speed, snap.lvl, snap.total.speed);
    }

    renderStatPanel(snap);
    renderDerived(snap);
    renderCarry();
}

// === 自定义机制系统 ===
export function toggleCustomPanel() {
    const wrapper = document.getElementById("customStatWrapper");
    wrapper.style.display = (wrapper.style.display === "none") ? "block" : "none";
}

export function renderCustomStats() {
    if (!Array.isArray(d.customStats)) d.customStats = [];
    const el = document.getElementById("customStatPanel");
    if (!el) return;

    if (d.customStats.length === 0) {
        el.innerHTML = '<div class="small" style="text-align: center;">暂无机制</div>';
        return;
    }

    el.innerHTML = d.customStats.map((cs, i) => {
        const color = cs.color || '#63a8e0';
        const val = customBarVal(cs);
        const max = customBarMax(cs);
        const pct = Math.max(0, Math.min(100, (val / max) * 100));
        const negStyle = val < 0 ? "color: var(--red);" : "color: var(--gold);";
        return `
        <div style="margin-bottom: 5px;">
            <div class="bar">
                <input type="text" value="${esc(cs.name)}" onchange="setCustomBarName(${i}, this.value)" style="font-weight: bold; font-size: 15px; border: none; background: transparent; padding: 0; width: 50%;">
                <div>
                    <span style="font-size: 14px; font-weight: bold; ${negStyle} white-space: nowrap; margin-right: 6px;">${val} / ${max}</span>
                    <input type="color" value="${color}" onchange="d.customStats[${i}].color = this.value; renderCustomStats(); save();" style="width: 17px; height: 17px; padding: 0; border: none; cursor: pointer; vertical-align: middle;">
                    <span class="bar-cfg-btn" onclick="openBarCfg(${i})" title="${esc(barCfgText(cs) || "联动设置：攻击加成 / 增长机制 / 满值状态")}">⚙</span>
                    ${barCfg(cs).shield ? `<span class="bar-flag" title="护盾条：受伤先扣这条（可当额外血量）">🛡</span>` : ""}
                    ${barCfg(cs).allowNegative ? `<span class="bar-flag neg" title="允许负值：可以扣成负数">负</span>` : ""}
                    <span onclick="removeCustomStat(${i})" style="color: var(--red); cursor: pointer; margin-left: 8px; font-size: 14px;">✖</span>
                </div>
            </div>
            <!-- 进度条 -->
            <div style="height: 8px; background: #454d5c; border-radius: 20px; overflow: hidden; margin: 5px 0;">
                <div style="height: 100%; width: ${pct}%; background: ${color};"></div>
            </div>
            <!-- 数值 -->
            <div class="twocol">
                <div><input type="number" value="${val}" min="${customBarFloor(cs)}" onchange="setCustomBarVal(${i}, this.value)"></div>
                <div><input type="number" value="${max}" min="1" onchange="setCustomBarMax(${i}, this.value)"></div>
            </div>
            </div>
        `;
    }).join("");
}

// 联动变化后统一刷新：条面板 + 状态列表（钩子避免循环 import）
export function syncCustomBarLinks(data) {
    const res = syncBarLinks(data || d);
    if ((res.added.length || res.removed.length) && barLinkHooks.onChange) {
        try { barLinkHooks.onChange(); } catch (e) { }
    }
    return res;
}

export function setCustomBarName(idx, value) {
    const cs = d.customStats[idx];
    if (!cs) return;
    const oldName = cs.name;
    const next = barNameOf(value) || String(oldName || "").trim();
    cs.name = next;
    renameBarRefs(d, oldName, next);
    syncCustomBarLinks();
    renderCustomStats();
    save();
}

export function setCustomBarVal(idx, value) {
    const cs = d.customStats[idx];
    if (!cs) return;
    cs.val = clampNum(value, customBarFloor(cs), LIMITS.customVal[1], customBarVal(cs));
    if (cs.val > customBarMax(cs)) cs.max = Math.max(1, cs.val);
    syncCustomBarLinks();
    renderCustomStats();
    save();
}

export function setCustomBarMax(idx, value) {
    const cs = d.customStats[idx];
    if (!cs) return;
    cs.max = Math.max(1, clampNum(value, LIMITS.customMax[0], LIMITS.customMax[1], customBarMax(cs)));
    syncCustomBarLinks();
    renderCustomStats();
    save();
}

// 满值 / 归零触发的状态配置
export function setBarLink(idx, which, field, value) {
    const cs = d.customStats[idx];
    if (!cs) return;
    const key = which === "empty" ? "onEmptyBuff" : "onFullBuff";
    const cur = (cs[key] && typeof cs[key] === "object") ? { ...cs[key] } : { name: "", round: 0 };
    if (field === "round") cur.round = clampInt(value, LIMITS.round[0], LIMITS.round[1], 0);
    else cur.name = barNameOf(value);
    cs[key] = cur.name ? cur : null;
    syncCustomBarLinks();
    renderCustomStats();
    save();
}

// === 自定义条联动设置弹窗（⚙ 按钮）===
let barCfgIndex = -1;

function barCfgNum(id, lo, hi) {
    const el = document.getElementById(id);
    return clampNum(el ? el.value : 0, lo, hi, 0);
}

function barCfgInt(id) {
    const el = document.getElementById(id);
    return clampInt(el ? el.value : 0, -999999, 999999, 0);
}

export function openBarCfg(idx) {
    const cs = d.customStats[idx];
    if (!cs) return;
    barCfgIndex = idx;
    const cfg = barCfg(cs);
    const title = document.getElementById("barCfgTitle");
    if (title) title.innerText = `🔋 ${barNameOf(cs.name) || "自定义条"} · 联动设置`;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set("barCfgAtkPct", cfg.atkPct);
    set("barCfgFullAtk", cfg.fullAtkPct);
    set("barGainRound", cfg.gain.round);
    set("barGainDamage", cfg.gain.damage);
    set("barGainHeal", cfg.gain.heal);
    set("barGainBuff", cfg.gain.buff);
    set("barGainKill", cfg.gain.kill);
    set("barFullName", cfg.onFullBuff ? cfg.onFullBuff.name : "");
    set("barFullRound", cfg.onFullBuff ? cfg.onFullBuff.round : 0);
    set("barEmptyName", cfg.onEmptyBuff ? cfg.onEmptyBuff.name : "");
    set("barEmptyRound", cfg.onEmptyBuff ? cfg.onEmptyBuff.round : 0);
    const shieldEl = document.getElementById("barCfgShield");
    if (shieldEl) shieldEl.checked = cfg.shield;
    set("barShieldMode", cfg.shieldMode);
    set("barShieldHitCost", cfg.shieldHitCost);
    set("barShieldFlat", cfg.shieldFlat);
    set("barShieldPct", cfg.shieldPct);
    barShieldModeChanged();
    const negEl = document.getElementById("barCfgAllowNeg");
    if (negEl) negEl.checked = cfg.allowNegative;
    const el = document.getElementById("modalBarCfg");
    if (el) el.classList.remove("hide");
}

// 次数护盾才需要「每击耗几层」；数值护盾把这一项收起来
export function barShieldModeChanged() {
    const modeEl = document.getElementById("barShieldMode");
    const wrap = document.getElementById("barShieldHitWrap");
    if (!wrap) return;
    wrap.style.display = (modeEl && modeEl.value === "hits") ? "" : "none";
}

// 不使用 MP 的角色可以隐藏魔力条（数据仍保留，只是界面收起）
export function renderMpHidden() {
    const hidden = !!(d && d.hideMp === true);
    const block = document.getElementById("mpBlock");
    if (block) block.style.display = hidden ? "none" : "";
    const hint = document.getElementById("mpHiddenHint");
    if (hint) hint.style.display = hidden ? "" : "none";
    const dw = document.getElementById("mpDeltaWrap");
    if (dw) dw.style.display = hidden ? "none" : "";
}

export function toggleMpHidden() {
    if (!d) return;
    d.hideMp = d.hideMp !== true;
    renderMpHidden();
    save();
}

export function saveBarCfg() {
    const cs = d.customStats[barCfgIndex];
    if (!cs) { barCfgIndex = -1; closeModal("modalBarCfg"); return; }
    cs.atkPct = barCfgNum("barCfgAtkPct", -500, 500);
    cs.fullAtkPct = barCfgNum("barCfgFullAtk", -500, 500);
    cs.gain = {
        round: barCfgInt("barGainRound"),
        damage: barCfgInt("barGainDamage"),
        heal: barCfgInt("barGainHeal"),
        buff: barCfgInt("barGainBuff"),
        kill: barCfgInt("barGainKill")
    };
    const fullNameEl = document.getElementById("barFullName");
    const emptyNameEl = document.getElementById("barEmptyName");
    const fullName = barNameOf(fullNameEl ? fullNameEl.value : "");
    const emptyName = barNameOf(emptyNameEl ? emptyNameEl.value : "");
    const fullRoundEl = document.getElementById("barFullRound");
    const emptyRoundEl = document.getElementById("barEmptyRound");
    cs.onFullBuff = fullName
        ? { name: fullName, round: clampInt(fullRoundEl ? fullRoundEl.value : 0, LIMITS.round[0], LIMITS.round[1], 0) }
        : null;
    cs.onEmptyBuff = emptyName
        ? { name: emptyName, round: clampInt(emptyRoundEl ? emptyRoundEl.value : 0, LIMITS.round[0], LIMITS.round[1], 0) }
        : null;
    const shieldEl = document.getElementById("barCfgShield");
    cs.shield = !!(shieldEl && shieldEl.checked);
    const modeEl = document.getElementById("barShieldMode");
    cs.shieldMode = (modeEl && modeEl.value === "hits") ? "hits" : "value";
    cs.shieldHitCost = clampInt(barCfgNum("barShieldHitCost", 1, LIMITS.customVal[1]), 1, LIMITS.customVal[1], 1);
    cs.shieldFlat = clampNum(barCfgNum("barShieldFlat", 0, LIMITS.hpMp[1]), 0, LIMITS.hpMp[1], 0);
    cs.shieldPct = clampNum(barCfgNum("barShieldPct", 0, 90), 0, 90, 0);
    const negEl = document.getElementById("barCfgAllowNeg");
    cs.allowNegative = !!(negEl && negEl.checked);
    // 关掉「允许负值」时，把已经透支的条拉回 0
    if (!cs.allowNegative && customBarVal(cs) < 0) cs.val = 0;
    barCfgIndex = -1;
    closeModal("modalBarCfg");
    syncCustomBarLinks();
    renderCustomStats();
    hpUpdate();
    save();
    const st = document.getElementById("status");
    if (st) st.textContent = `⚙ 已保存「${barNameOf(cs.name) || "自定义条"}」的联动设置`;
}

export function addCustomStat() {
    if (!Array.isArray(d.customStats)) d.customStats = [];
    d.customStats.push({ name: "新机制", val: 50, max: 100, color: "#63a8e0" });
    document.getElementById("customStatWrapper").style.display = "block"; // 添加时自动展开
    renderCustomStats();
    save();
}

export function removeCustomStat(idx) {
    if (!confirm("确定删除这个自定义机制吗？")) return;
    d.customStats.splice(idx, 1);
    renderCustomStats();
    save();
}

// === 参战开关（主角）===
// 不参战：主持人队伍看板不显示、回合结束不结算、也不能提交本回合行动。
// 默认值视为参战，旧存档无需迁移。
export function renderCombatToggle() {
    const btn = document.getElementById("combatToggle");
    if (!btn) return;
    const on = d.outOfCombat !== true;
    btn.textContent = on ? "⚔ 参战中" : "🚫 未参战";
    btn.classList.toggle("on", on);
    btn.classList.toggle("off", !on);
    btn.title = on
        ? "点击退出参战：主持人面板不再显示这个角色，回合结算会跳过"
        : "点击参战：出现在主持人队伍看板并参与回合结算";
}

export function toggleCombat() {
    d.outOfCombat = d.outOfCombat === true ? false : true;
    renderCombatToggle();
    save();
    if (typeof globalThis.renderGmPanel === "function") globalThis.renderGmPanel();
    if (typeof globalThis.renderPlayerActionPanel === "function") globalThis.renderPlayerActionPanel();
}
