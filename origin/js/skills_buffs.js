import { LIMITS, FINAL_MIN, FINAL_MAX, clampNum, clampInt } from "./limits.js";
import { normalizeBuff, normalizeBuffType, buffTypeCn, buffTypeIcon, buffTypeColor, buffTickText } from "./core.js";
import { d, activeCharId } from "./state.js";
import { esc, makeId, rollOne, mod } from "./util.js";
import { parseBonus } from "./bonus.js";
import { bonusSummary, hasBonusContent, recalcGearBonus, carryWeight, carryCapacity, encumbrancePenalty } from "./display.js";
import { read, loadRawChar, saveRawChar } from "./persist.js";
import { hpUpdate, renderCustomStats, syncCustomBarLinks } from "./stats_ui.js";
import { barNameOf, buffBarText, adjustCustomBar, syncBarLinks, barLinkHooks, findCustomBar, applyBarGain } from "./bar_link.js";
import { save, closeModal } from "./modal_misc.js";
import { renderBonusEditor, readBonusEditor, updateBonusSummaries } from "./items_gear_ui.js";
import { applyDamageToCombatTarget, parseDiceExpr } from "./combat_dice.js";
import { computeSnapshot } from "./compute.js";

// 自定义条联动：条值变化后刷新状态列表（用钩子避免 stats_ui ↔ skills_buffs 循环 import）
barLinkHooks.onChange = () => {
    if (typeof document === "undefined") return;
    const el = document.getElementById("buffList");
    if (el) renderBuffs();
};

//技能
// 技能可选带「公式」，这样发动时可以直接掷出结果并交付主持人结算，不用口头报数。
export const SKILL_KINDS = { damage: "⚔ 伤害", heal: "💚 治疗", buff: "🎁 施加状态" };
// 命中加值 = 所选属性的调整值 + 额外加值（熟练/武器等）。
// 只存「属性 key」，不存算好的数字：角色升级、装备、Buff 变化后命中会自动跟着变。
export const SKILL_ATK_STATS = { strength: "力量", dexterity: "敏捷", constitution: "体质", intelligence: "智力", wisdom: "感知", charisma: "魅力" };
function skillKindCn(k) { return SKILL_KINDS[k] || ""; }
function skillAtkCn(k) { return SKILL_ATK_STATS[k] || "力量"; }
function normalizeSkill(s) {
    const o = (s && typeof s === "object") ? s : {};
    const kind = Object.prototype.hasOwnProperty.call(SKILL_KINDS, o.kind) ? o.kind : "";
    const atkStat = Object.prototype.hasOwnProperty.call(SKILL_ATK_STATS, o.atkStat) ? o.atkStat : "strength";
    const costType = (o.costType === "mp" || o.costType === "custom" || o.costType === "hp") ? o.costType : "";
    return {
        name: String(o.name || "").slice(0, 60),
        desc: String(o.desc || "").slice(0, 2000),
        kind,
        formula: String(o.formula || "").trim().slice(0, 40),
        // 施加状态类技能：指向自己「快速施加库」里的模板，发动时取最新数值
        buffId: String(o.buffId || "").trim().slice(0, 64),
        hit: o.hit === true || o.hit === 1 ? 1 : 0,
        atkStat,
        hitBonus: clampInt(o.hitBonus, LIMITS.diceMod[0], LIMITS.diceMod[1], 0),
        // 发动消耗：MP 或某一条自定义条（自定义条按名称记录，改名后会提示找不到）
        costType,
        costAmount: clampInt(o.costAmount, 0, LIMITS.hpMp[1], 0),
        costBar: String(o.costBar || "").trim().slice(0, 40)
    };
}
// 技能消耗：空 = 不消耗
export const SKILL_COST_TYPES = { mp: "💧 MP", custom: "🔋 自定义条", hp: "💔 HP（生命）" };
// 自定义条按「名称」定位：加/删条不会让索引错位，改名后需要重新选一次
// （findCustomBar 来自 bar_link.js，与物品/状态联动共用同一套查找）
// 规范化后的消耗对象；不消耗返回 null
function skillCost(s) {
    const sk = normalizeSkill(s);
    if (!sk.costType || sk.costAmount <= 0) return null;
    return { type: sk.costType, amount: sk.costAmount, bar: sk.costBar };
}
function skillCostText(s) {
    const c = skillCost(s);
    if (!c) return "";
    if (c.type === "mp") return `💧 ${c.amount} MP`;
    if (c.type === "hp") return `💔 ${c.amount} HP`;
    return `🔋 ${c.amount} ${c.bar || "自定义条"}`;
}
// 当前角色这项资源还剩多少：{ ok, have, max }
function costState(data, c) {
    if (!c) return { ok: true, have: 0, max: 0 };
    if (c.type === "mp") {
        const have = clampNum(data.mp, LIMITS.hpMp[0], LIMITS.hpMp[1], 0);
        let max = have;
        try { max = computeSnapshot().total.maxMp; } catch (e) { max = have; }
        return { ok: true, have, max };
    }
    if (c.type === "hp") {
        const have = clampNum(data.hp, LIMITS.hpMp[0], LIMITS.hpMp[1], 0);
        let max = have;
        try { max = computeSnapshot().total.maxHp; } catch (e) { max = have; }
        return { ok: true, have, max };
    }
    const bar = findCustomBar(data, c.bar);
    if (!bar) return { ok: false, have: 0, max: 0 };
    return {
        ok: true,
        have: clampNum(bar.val, LIMITS.customVal[0], LIMITS.customVal[1], 0),
        max: Math.max(1, clampNum(bar.max, LIMITS.customMax[0], LIMITS.customMax[1], 100))
    };
}
// 真正扣资源（不做事前检查，调用前先 costState 判断够不够）
function paySkillCost(data, c) {
    if (!c) return;
    if (c.type === "mp") {
        data.mp = clampNum(data.mp - c.amount, LIMITS.hpMp[0], LIMITS.hpMp[1], 0);
        return;
    }
    if (c.type === "hp") {
        data.hp = clampNum(data.hp - c.amount, LIMITS.hpMp[0], LIMITS.hpMp[1], 0);
        return;
    }
    const bar = findCustomBar(data, c.bar);
    if (bar) bar.val = clampNum(bar.val - c.amount, LIMITS.customVal[0], LIMITS.customVal[1], 0);
}
// 「其他修正」里的施法代价：每次发动技能固定消耗最大生命的百分比（可多条叠加，合计最多 100%）
export function extraSkillHpPct(data) {
    const list = (data && Array.isArray(data.extraMods)) ? data.extraMods : [];
    let pct = 0;
    list.forEach(m => {
        if (!m || m.enabled === false) return;
        pct += clampNum(m.passive && m.passive.skillHpPct, 0, 100, 0);
    });
    return Math.min(100, pct);
}
export function extraSkillHpCost(data, maxHp) {
    const pct = extraSkillHpPct(data);
    if (pct <= 0) return 0;
    const mx = Math.max(1, clampNum(maxHp, 1, LIMITS.hpMp[1], 1));
    return Math.ceil(mx * pct / 100);
}
// 当前超重带来的命中惩罚（背包越重越难命中，最多 -10）
function encumbranceNow() {
    try { return encumbrancePenalty(carryWeight(), carryCapacity()); } catch (e) { return 0; }
}
// 当前角色的「命中加值」：属性调整值 + 额外加值 + 超重惩罚
function skillHitMod(s) {
    const sk = normalizeSkill(s);
    let statMod = 0;
    try { statMod = mod(computeSnapshot().total[sk.atkStat]); } catch (e) { statMod = 0; }
    return clampInt(statMod + sk.hitBonus, LIMITS.diceMod[0], LIMITS.diceMod[1], 0) + encumbranceNow();
}
function skillStatMod(statKey) {
    try { return mod(computeSnapshot().total[statKey]); } catch (e) { return 0; }
}
// 弹窗里的实时预览：让玩家看见这个数字是怎么来的
function renderSkillHitPreview() {
    const el = document.getElementById("skillHitPreview");
    if (!el) return;
    const statEl = document.getElementById("skillAtkStat");
    const stat = statEl && SKILL_ATK_STATS[statEl.value] ? statEl.value : "strength";
    const bonusEl = document.getElementById("skillHitBonus");
    const bonus = clampInt(bonusEl ? bonusEl.value : 0, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
    const base = skillStatMod(stat);
    const pen = encumbranceNow();
    const total = base + bonus + pen;
    el.innerText = `${skillAtkCn(stat)}调整值 ${base >= 0 ? "+" : ""}${base}${bonus ? `${bonus > 0 ? " +" : " "}${bonus} 额外` : ""}${pen ? ` ${pen} 超重` : ""} → 命中 ${total >= 0 ? "+" : ""}${total}`;
}
export function skillAtkStatChanged() { renderSkillHitPreview(); }
// 勾「需命中检定」时才显示命中加值的来源设置
export function skillHitChanged() {
    const chk = document.getElementById("skillHit");
    const row = document.getElementById("skillHitRow");
    if (row) row.style.display = chk && chk.checked ? "" : "none";
    renderSkillHitPreview();
}

// 技能弹窗里的「附带状态」下拉：数据来自角色自己的 buffLib
function renderSkillBuffOptions(selected) {
    const sel = document.getElementById("skillBuff");
    if (!sel) return;
    const lib = Array.isArray(d.buffLib) ? d.buffLib : [];
    sel.innerHTML = lib.length
        ? lib.map(t => `<option value="${esc(t.id)}"${t.id === selected ? " selected" : ""}>${esc(t.name)}${Number(t.round) > 0 ? `（${t.round} 回合）` : "（永久）"}</option>`).join("")
        : '<option value="">快速施加库为空 · 先去「状态/Buff」建一个</option>';
}

// 只有「施加状态」才需要选状态，其它类型把这一行藏起来
export function skillKindChanged() {
    const kindEl = document.getElementById("skillKind");
    const row = document.getElementById("skillBuffRow");
    if (!row) return;
    row.style.display = kindEl && kindEl.value === "buff" ? "" : "none";
}

// ---------- 资源消耗（MP / 自定义条） ----------
// 自定义条下拉：用当前角色已有的机制条名称
function renderSkillCostBarOptions(selected) {
    const sel = document.getElementById("skillCostBar");
    if (!sel) return;
    const names = (Array.isArray(d.customStats) ? d.customStats : [])
        .map(cs => String(cs.name || "").trim()).filter(Boolean);
    sel.innerHTML = names.length
        ? names.map(n => `<option value="${esc(n)}"${n === selected ? " selected" : ""}>${esc(n)}</option>`).join("")
        : '<option value="">还没有自定义条</option>';
}
// 弹窗里实时显示「当前有多少 → 发动后剩多少」
function renderSkillCostPreview() {
    const el = document.getElementById("skillCostPreview");
    if (!el) return;
    const typeEl = document.getElementById("skillCostType");
    const amtEl = document.getElementById("skillCostAmount");
    const type = typeEl ? typeEl.value : "";
    const amt = clampInt(amtEl ? amtEl.value : 0, 0, LIMITS.hpMp[1], 0);
    if (!type || amt <= 0) { el.innerText = "不消耗资源"; return; }
    if (type === "mp") {
        const st = costState(d, { type: "mp", amount: amt });
        el.innerText = `当前 MP ${st.have}/${st.max} → 发动后剩 ${Math.max(0, st.have - amt)}`;
        return;
    }
    if (type === "hp") {
        const st = costState(d, { type: "hp", amount: amt });
        el.innerText = `当前 HP ${st.have}/${st.max} → 发动后剩 ${Math.max(0, st.have - amt)}（至少要留 1 点）`;
        return;
    }
    const barSel = document.getElementById("skillCostBar");
    const bar = findCustomBar(d, barSel ? barSel.value : "");
    if (!bar) { el.innerText = "先选一个自定义条"; return; }
    const st = costState(d, { type: "custom", amount: amt, bar: bar.name });
    el.innerText = `当前 ${bar.name} ${st.have}/${st.max} → 发动后剩 ${Math.max(0, st.have - amt)}`;
}
// 消耗类型切换：只有「自定义条」才显示条名下拉
export function skillCostTypeChanged() {
    const typeEl = document.getElementById("skillCostType");
    const wrap = document.getElementById("skillCostBarWrap");
    const type = typeEl ? typeEl.value : "";
    if (wrap) wrap.style.display = type === "custom" ? "" : "none";
    renderSkillCostPreview();
}
// 数量或条名变化时刷新预览
export function skillCostChanged() { renderSkillCostPreview(); }
export function openAddSkillModal() {
    document.getElementById("editSkillIndex").value = "-1";
    document.getElementById("modalSkillTitle").innerText = "添加技能";
    document.getElementById("skillName").value = "";
    document.getElementById("skillDesc").value = "";
    const kindEl = document.getElementById("skillKind");
    if (kindEl) kindEl.value = "";
    document.getElementById("skillFormula").value = "";
    const hitEl = document.getElementById("skillHit");
    if (hitEl) hitEl.checked = false;
    const atkStatEl = document.getElementById("skillAtkStat");
    if (atkStatEl) atkStatEl.value = "strength";
    const hitBonusEl = document.getElementById("skillHitBonus");
    if (hitBonusEl) hitBonusEl.value = "0";
    const costTypeEl = document.getElementById("skillCostType");
    if (costTypeEl) costTypeEl.value = "";
    const costAmtEl = document.getElementById("skillCostAmount");
    if (costAmtEl) costAmtEl.value = "0";
    renderSkillCostBarOptions("");
    skillCostTypeChanged();
    renderSkillBuffOptions("");
    skillKindChanged();
    skillHitChanged();
    document.getElementById("modalSkill").classList.remove("hide");
}
export function openEditSkillModal(idx) {
    const s = normalizeSkill(d.skills[idx]);
    document.getElementById("editSkillIndex").value = String(idx);
    document.getElementById("modalSkillTitle").innerText = "编辑技能";
    document.getElementById("skillName").value = s.name;
    document.getElementById("skillDesc").value = s.desc;
    const kindEl = document.getElementById("skillKind");
    if (kindEl) kindEl.value = s.kind;
    document.getElementById("skillFormula").value = s.formula;
    const hitEl = document.getElementById("skillHit");
    if (hitEl) hitEl.checked = s.hit === 1;
    const atkStatEl = document.getElementById("skillAtkStat");
    if (atkStatEl) atkStatEl.value = s.atkStat;
    const hitBonusEl = document.getElementById("skillHitBonus");
    if (hitBonusEl) hitBonusEl.value = String(s.hitBonus);
    const costTypeEl = document.getElementById("skillCostType");
    if (costTypeEl) costTypeEl.value = s.costType;
    const costAmtEl = document.getElementById("skillCostAmount");
    if (costAmtEl) costAmtEl.value = String(s.costAmount);
    renderSkillCostBarOptions(s.costBar);
    skillCostTypeChanged();
    renderSkillBuffOptions(s.buffId);
    skillKindChanged();
    skillHitChanged();
    document.getElementById("modalSkill").classList.remove("hide");
}
export function saveSkillModal() {
    const idx = Number(document.getElementById("editSkillIndex").value);
    const name = document.getElementById("skillName").value.trim();
    const desc = document.getElementById("skillDesc").value.trim();
    const kindEl = document.getElementById("skillKind");
    const kind = kindEl ? kindEl.value : "";
    const formula = document.getElementById("skillFormula").value.trim().slice(0, 40);
    const hitEl = document.getElementById("skillHit");
    const atkStatEl = document.getElementById("skillAtkStat");
    const atkStat = atkStatEl && SKILL_ATK_STATS[atkStatEl.value] ? atkStatEl.value : "strength";
    const hitBonusEl = document.getElementById("skillHitBonus");
    const hitBonus = clampInt(hitBonusEl ? hitBonusEl.value : 0, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
    const buffSel = document.getElementById("skillBuff");
    const buffId = buffSel ? String(buffSel.value || "") : "";
    const costTypeEl = document.getElementById("skillCostType");
    const costType = (costTypeEl && SKILL_COST_TYPES[costTypeEl.value]) ? costTypeEl.value : "";
    const costAmtEl = document.getElementById("skillCostAmount");
    const costAmount = clampInt(costAmtEl ? costAmtEl.value : 0, 0, LIMITS.hpMp[1], 0);
    const costBarSel = document.getElementById("skillCostBar");
    const costBar = (costType === "custom" && costBarSel) ? String(costBarSel.value || "").trim() : "";
    if (!name) { alert("技能名称不能为空"); return; }
    if ((kind === "damage" || kind === "heal") && !formula) { alert("选了伤害/治疗类型就要填公式，例如 2d6+3"); return; }
    if (costType === "custom" && costAmount > 0 && !costBar) { alert("选了自定义条消耗，要先选一条自定义机制（没有的话先在角色卡里加一条）"); return; }
    if (kind === "buff") {
        if (!buffId) { alert("选了施加状态，要先在「状态/Buff」里建一个并存进快速施加库"); return; }
        const tpl = (Array.isArray(d.buffLib) ? d.buffLib : []).find(t => t.id === buffId);
        if (!tpl) { alert("找不到这个状态模板，请在「状态/Buff」里重新建一个"); return; }
    }
    const o = normalizeSkill({ name, desc, kind, formula, buffId, hit: hitEl && hitEl.checked ? 1 : 0, atkStat, hitBonus, costType, costAmount, costBar });
    if (idx === -1) d.skills.push(o);
    else d.skills[idx] = o;
    closeModal("modalSkill");
    renderSkills();
    save();
}
export function renderSkills() {
    const el = document.getElementById("skillsList");
    if (!d.skills.length) {
        el.innerHTML = '<div class="empty">还没有记录技能。</div>';
    } else {
        el.innerHTML = d.skills.map((raw, i) => {
            const s = normalizeSkill(raw);
            const tags = [];
            if (s.kind) tags.push(`<span class="skill-badge">${skillKindCn(s.kind)}</span>`);
            if (s.kind === "buff") {
                const tpl = (Array.isArray(d.buffLib) ? d.buffLib : []).find(t => t.id === s.buffId);
                tags.push(`<span class="skill-formula">${esc(tpl ? tpl.name : "状态模板已删除")}</span>`);
            } else if (s.formula) {
                tags.push(`<span class="skill-formula">${esc(s.formula)}</span>`);
            }
            if (s.kind === "damage" && s.hit) {
                const hm = skillHitMod(s);
                tags.push(`<span class="skill-badge hit" title="${esc(skillAtkCn(s.atkStat))}调整值 + 额外加值">需命中 ${hm >= 0 ? "+" : ""}${hm}</span>`);
            }
            const costTxt = skillCostText(s);
            if (costTxt) tags.push(`<span class="skill-badge cost" title="发动时扣掉这项资源">${esc(costTxt)}</span>`);
            const useBtn = s.kind
                ? `<button onclick="openSkillUse(${i})">⚔ 发动</button>`
                : "";
            return `
<div class="skill">
    <div class="skill-head">
        <span>✦ ${esc(s.name)}${tags.length ? " " + tags.join(" ") : ""}</span>
        <div>
            ${useBtn}
            <button onclick="openEditSkillModal(${i})">编辑</button>
            <button onclick="{d.skills.splice(${i},1);renderSkills();save();}">删除</button>
        </div>
    </div>
    <div class="skill-desc">${esc(s.desc || "无描述")}</div>
</div>`;
        }).join("");
    }
    renderQuickSkills();
}

// 「本回合行动」面板里的快捷技能条：点一下直接打开发动弹窗。
// index 必须是 d.skills 里的真实下标（openSkillUse 按它取技能），所以不过滤数组、只过滤展示。
export function renderQuickSkills() {
    const el = document.getElementById("paQuickSkills");
    if (!el) return;
    const list = Array.isArray(d.skills) ? d.skills : [];
    const usable = list
        .map((raw, i) => ({ s: normalizeSkill(raw), i }))
        .filter(x => x.s && x.s.kind);
    el.innerHTML = usable.length
        ? usable.map(({ s, i }) => {
            const tip = `${skillKindCn(s.kind)}${s.formula ? " · " + s.formula : ""}${s.desc ? " · " + s.desc : ""}`;
            return `<span class="buff-chip" title="${esc(tip)}" onclick="openSkillUse(${i})">⚔ ${esc(s.name)}</span>`;
        }).join("")
        : `<span class="small pa-chip-empty">暂无技能</span>`;
}

// ---------- 发动技能：掷公式 → 交给主持人结算 ----------
// 只在「本回合行动」还为空白时可用（一次行动 = 一个技能）。
let skillUse = null;   // { idx, skill, targets:[], effect:{...} }

export function openSkillUse(idx) {
    const skill = normalizeSkill(d.skills[idx]);
    if (!skill.kind) { alert("这个技能没有可结算的效果，直接在「本回合行动」里描述即可"); return; }
    const buffTpl = skill.kind === "buff"
        ? (Array.isArray(d.buffLib) ? d.buffLib : []).find(t => t.id === skill.buffId)
        : null;
    if (skill.kind === "buff" && !buffTpl) { alert("这个技能对应的状态模板已被删除，请先编辑技能重新选一个"); return; }
    if (typeof globalThis.gmCanAct === "function" && !globalThis.gmCanAct()) {
        alert("本回合已经提交过行动了，先去「本回合行动」页撤回再发动技能");
        return;
    }
    const targets = (typeof globalThis.gmActionTargets === "function") ? (globalThis.gmActionTargets() || []) : [];
    skillUse = { idx, skill, targets, buffTpl, effect: null };
    const titleEl = document.getElementById("modalSkillUseTitle");
    if (titleEl) titleEl.innerText = `发动技能：${skill.name}`;
    const infoEl = document.getElementById("skillUseInfo");
    if (infoEl) {
        const head = skill.kind === "buff"
            ? `<span class="skill-badge">${skillKindCn(skill.kind)}</span><span class="skill-formula">${esc(buffTpl.name)}${Number(buffTpl.round) > 0 ? `（${buffTpl.round} 回合）` : "（永久）"}</span>`
            : `<span class="skill-badge">${skillKindCn(skill.kind)}</span><span class="skill-formula">${esc(skill.formula || "无公式")}</span>`;
        // 资源消耗提示：不够时标红，发送会被拦下
        const c = skillCost(skill);
        let maxHpNow = d.maxHpBase;
        try { maxHpNow = computeSnapshot().total.maxHp; } catch (e) { maxHpNow = d.maxHpBase; }
        const extraHp = extraSkillHpCost(d, maxHpNow);
        const hpCost = (c && c.type === "hp" ? c.amount : 0) + extraHp;
        let costLine = "";
        if (c) {
            const st = costState(d, c);
            const short = !st.ok || (c.type === "hp" ? st.have <= hpCost : st.have < c.amount);
            const now = st.ok ? `${st.have}/${st.max}` : "缺少该自定义条";
            costLine = `<div class="su-cost${short ? " short" : ""}">消耗 ${esc(skillCostText(skill))} · 当前 ${esc(now)}${short ? "（不足）" : ""}</div>`;
        }
        if (extraHp > 0) {
            costLine += `<div class="su-cost${d.hp <= extraHp ? " short" : ""}">施法代价 💔 ${extraHp} HP（最大生命 ${extraSkillHpPct(d)}%）</div>`;
        }
        infoEl.innerHTML = `${head}
            ${skill.kind === "damage" && skill.hit ? `<span class="skill-badge hit">需命中检定 · ${esc(skillAtkCn(skill.atkStat))} ${skillHitMod(skill) >= 0 ? "+" : ""}${skillHitMod(skill)}</span>` : ""}
            ${skill.desc ? `<div class="skill-desc">${esc(skill.desc)}</div>` : ""}
            ${costLine}`;
    }
    const sel = document.getElementById("skillUseTarget");
    if (sel) {
        const usable = skill.kind === "heal"
            ? targets.filter(t => t.kind === "ally")
            : (skill.kind === "buff" ? targets : targets.filter(t => t.kind === "enemy"));
        sel.innerHTML = usable.length
            ? usable.map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.hp !== undefined ? `（${t.hp}/${t.maxHp}）` : ""}</option>`).join("")
            : `<option value="">${skill.kind === "heal" ? "队伍里没有可治疗的角色" : (skill.kind === "buff" ? "没有可施加状态的目标" : "遭遇里没有存活的敌人")}</option>`;
    }
    const atkEl = document.getElementById("skillUseAtkMod");
    if (atkEl) atkEl.value = String(skillHitMod(skill));
    rollSkillUse();
    document.getElementById("modalSkillUse").classList.remove("hide");
}

// 掷一次并把结果写进预览区（发送时用的是这一掷的结果，不重掷）
// 投骰审计：每次掷骰都报给主持人（skill 弹窗的自动首掷与「重掷」都算）
function logRoll(kind, detail, total) {
    if (typeof globalThis.gmLogRoll === "function") {
        try { globalThis.gmLogRoll({ kind, detail, total }); } catch (e) { }
    }
}

export function rollSkillUse() {
    if (!skillUse) return;
    const { skill, targets } = skillUse;
    const sel = document.getElementById("skillUseTarget");
    const usable = skill.kind === "heal"
        ? targets.filter(t => t.kind === "ally")
        : (skill.kind === "buff" ? targets : targets.filter(t => t.kind === "enemy"));
    // 下拉框在弹窗刚打开/被重建时可能还没有选中值，兜底选第一个合法目标，
    // 否则会被误判成「没有目标」，伤害技能就变成“自动命中”了
    let targetId = sel ? sel.value : "";
    if (!targetId && usable.length) {
        targetId = usable[0].id;
        if (sel) sel.value = targetId;
    }
    const target = targets.find(t => t.id === targetId) || usable[0] || null;
    const res = { rolls: [], dice: 0, total: 0, hit: true, atkRoll: 0, atkTotal: 0, ac: null, target, noTarget: false };
    if (skill.kind === "damage") {
        const dmg = skillDamageTotal(skill.formula);
        res.rolls = dmg.rolls; res.dice = dmg.dice; res.total = dmg.total;
        if (!skill.hit) {
            // 没勾「需命中检定」：本来就是自动命中，后面会明确提示原因
        } else if (target && target.kind === "enemy") {
            const atkEl = document.getElementById("skillUseAtkMod");
            const atkMod = clampInt(atkEl ? atkEl.value : 0, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
            res.ac = clampInt(target.ac, LIMITS.enemyAc[0], LIMITS.enemyAc[1], 10);
            res.atkRoll = rollOne(20);
            res.atkTotal = clampNum(res.atkRoll + atkMod, FINAL_MIN, FINAL_MAX, 0);
            res.hit = res.atkRoll === 20 || (res.atkRoll !== 1 && res.atkTotal >= res.ac);
        } else {
            // 勾了需命中但没有可打的敌人：不要伪装成“自动命中”，直接标成无目标
            res.hit = false;
            res.noTarget = true;
        }
    } else if (skill.kind === "heal") {
        const heal = parseDiceExpr(skill.formula);
        res.rolls = heal.rolls;
        res.dice = heal.rolls.length ? heal.rolls.reduce((a, b) => a + b, 0) + (heal.mod || 0) : heal.total;
        res.total = clampNum(Math.max(0, res.dice), 0, FINAL_MAX, 0);
    } else if (skill.kind === "buff") {
        // 施加状态不需要掷骰：发送时把模板快照一起交给主持人
        const tpl = skillUse.buffTpl;
        res.buff = tpl ? normalizeBuff({
            name: tpl.name, round: tpl.round, desc: tpl.desc, bonus: tpl.bonus,
            type: tpl.type, hpPerRound: tpl.hpPerRound, mpPerRound: tpl.mpPerRound
        }) : null;
        res.total = 0;
    }
    skillUse.effect = res;
    // 投骰审计：技能每次掷骰（含弹窗自动首掷与重掷）都算进本回合记录
    if (skill.kind === "damage") {
        if (res.ac !== null) logRoll("skill", `${skill.name} · 命中 d20(${res.atkRoll}) vs AC ${res.ac}`, res.atkTotal);
        if (res.hit) logRoll("damage", `${skill.name} · ${skill.formula || "伤害"}`, res.total);
    } else if (skill.kind === "heal") {
        logRoll("skill", `${skill.name} · 治疗 ${skill.formula || ""}`.trim(), res.total);
    }
    const out = document.getElementById("skillUseResult");
    if (!out) return;
    const rollTxt = res.rolls.length ? `[${res.rolls.join(",")}]` : "";
    if (skill.kind === "damage") {
        const hitTxt = res.noTarget
            ? '<span class="su-bad">没有可攻击的目标 · 先去主持人面板添加敌人</span>'
            : (res.ac === null
                ? '<span class="su-ok">未勾选「需命中检定」· 自动命中</span>'
                : (res.hit
                    ? `<span class="su-ok">命中 d20(${res.atkRoll}) → ${res.atkTotal} vs AC ${res.ac}</span>`
                    : `<span class="su-bad">未命中 d20(${res.atkRoll}) → ${res.atkTotal} vs AC ${res.ac}</span>`));
        out.innerHTML = `${hitTxt}<div>伤害 <b>${res.hit ? res.total : 0}</b>${rollTxt ? `　骰面 ${rollTxt}` : ""}${res.dice !== res.total ? `　基础 ${res.dice} + 加成` : ""}</div>`;
    } else if (skill.kind === "heal") {
        out.innerHTML = `<span class="su-ok">治疗 <b>${res.total}</b></span>${rollTxt ? `<div>骰面 ${rollTxt}</div>` : ""}`;
    } else {
        const b = res.buff;
        out.innerHTML = b
            ? `<span class="su-ok">施加状态「${esc(b.name)}」</span><div>持续 ${Number(b.round) > 0 ? `${b.round} 回合` : "永久"}${b.hpPerRound ? ` · 每回合 HP${b.hpPerRound > 0 ? "+" : ""}${b.hpPerRound}` : ""}${b.mpPerRound ? ` · 每回合 MP${b.mpPerRound > 0 ? "+" : ""}${b.mpPerRound}` : ""}</div>`
            : '<span class="su-bad">状态模板已失效</span>';
    }
}

function skillDamageTotal(formula) {
    const res = parseDiceExpr(formula);
    const snap = computeSnapshot();
    let dice = res.rolls.length
        ? res.rolls.reduce((a, b) => a + b, 0) + (res.mod || 0)
        : res.total;
    dice = clampNum(dice, FINAL_MIN, FINAL_MAX, 0);
    const raw = clampNum(dice + (snap.total.damageFlat || 0), FINAL_MIN, FINAL_MAX, 0);
    const mid = clampNum(Math.floor(raw * (1 + (snap.agg.pct.damage || 0))), FINAL_MIN, FINAL_MAX, 0);
    const rPct = clampNum(clampNum(snap.race.pct.damage, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0) +
        clampNum(snap.race.perLevelPct.damage, LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0) * snap.lvl,
        LIMITS.bonusPct[0], LIMITS.bonusPct[1], 0);
    const rFlat = clampNum(clampNum(snap.race.flat.damage, FINAL_MIN, FINAL_MAX, 0) +
        clampNum(snap.race.perLevel.damage, FINAL_MIN, FINAL_MAX, 0) * snap.lvl,
        FINAL_MIN, FINAL_MAX, 0);
    const total = clampNum(Math.max(0, Math.floor(mid * (1 + rPct) + rFlat)), 0, FINAL_MAX, 0);
    return { rolls: res.rolls, dice, total };
}

export function sendSkillUse() {
    if (!skillUse) return;
    const { skill, effect } = skillUse;
    const target = effect && effect.target;
    if (effect && effect.noTarget) { alert("没有可攻击的目标，先去主持人面板添加敌人"); return; }
    if (!target) { alert("先选择一个目标"); return; }
    const amount = skill.kind === "damage" ? (effect.hit ? effect.total : 0) : effect.total;
    const isBuff = skill.kind === "buff";
    if (isBuff && (!effect.buff || !effect.buff.name)) { alert("状态模板已失效，请重新编辑这个技能"); return; }
    // 资源消耗：先确认够不够（提交失败时不扣资源）
    // 「其他修正」还可能给所有技能挂一笔固定比例的施法代价（不占技能栏，也不可豁免）
    let maxHpNow = d.maxHpBase;
    try { maxHpNow = computeSnapshot().total.maxHp; } catch (e) { maxHpNow = d.maxHpBase; }
    const extraHp = extraSkillHpCost(d, maxHpNow);
    const cost = skillCost(skill);
    const hpCost = (cost && cost.type === "hp" ? cost.amount : 0) + extraHp;
    if (cost) {
        const st = costState(d, cost);
        if (!st.ok) { alert(`这个技能要消耗自定义条「${cost.bar}」，但当前角色已经没有这条了，请编辑技能重新选择`); return; }
        if (cost.type === "hp") {
            if (st.have <= hpCost) { alert(`生命不足：这次发动要消耗 ${hpCost} 点生命，当前只剩 ${st.have}（至少要保留 1 点）`); return; }
        } else if (st.have < cost.amount) {
            alert(`资源不足：需要 ${skillCostText(skill)}，当前只剩 ${st.have}`); return;
        }
    } else if (extraHp > 0 && d.hp <= extraHp) {
        alert(`生命不足：施法代价要消耗 ${extraHp} 点生命，当前只剩 ${d.hp}（至少要保留 1 点）`); return;
    }
    const costNote = `${cost ? `｜消耗 ${skillCostText(skill)}` : ""}${extraHp > 0 ? `｜施法代价 💔 ${extraHp} HP（${extraSkillHpPct(d)}%）` : ""}`;
    const detail = isBuff
        ? `施加状态「${effect.buff.name}」${Number(effect.buff.round) > 0 ? `（${effect.buff.round} 回合）` : "（永久）"}${costNote}`
        : (skill.kind === "damage"
            ? (effect.hit
                ? `${skill.formula} = ${amount} 伤害${effect.dice !== amount ? `（骰面 ${effect.dice}，已含加成）` : ""}`
                : `未命中（${skill.formula}）`)
            : `${skill.formula} = ${amount} 治疗`) + costNote;
    const payload = {
        skillName: skill.name,
        effect: skill.kind,
        targetId: target.id,
        targetName: target.name,
        amount,
        detail,
        buff: isBuff ? effect.buff : null
    };
    const ok = (typeof globalThis.gmSubmitSkillAction === "function")
        ? globalThis.gmSubmitSkillAction(payload)
        : false;
    if (!ok) return;
    // 大招条：按技能类型涨值（伤害/治疗/状态），负数即扣
    const gainKind = isBuff ? "buff" : (skill.kind === "damage" ? "damage" : "heal");
    const gainRes = applyBarGain(d, gainKind);
    if (gainRes.gained.length) {
        renderCustomStats();
        save();
    }
    // 扣资源并落盘：先把新值同步到输入框，避免 save()/read() 用旧值覆盖内存
    if (cost || extraHp > 0) {
        if (cost) paySkillCost(d, cost);
        if (extraHp > 0) d.hp = clampNum(Math.max(0, d.hp - extraHp), LIMITS.hpMp[0], LIMITS.hpMp[1], 0);
        if (cost && cost.type === "custom") renderCustomStats();
        const mpEl = document.getElementById("mp");
        if (mpEl) mpEl.value = String(d.mp);
        const hpEl = document.getElementById("hp");
        if (hpEl) hpEl.value = String(d.hp);
        hpUpdate();
        save();
    }
    skillUse = null;
    closeModal("modalSkillUse");
    const st = document.getElementById("status");
    if (st) st.textContent = `⚔ 已把「${skill.name}」发给主持人结算${gainRes.gained.length ? ` · ${gainRes.gained.join("、")}` : ""}`;
}

//buff
// 主持人派发模式：弹窗目标不是当前角色时，保存写进目标存档，而不是内存里的 d
let buffModalTargetId = "";
let buffModalOnSaved = null;

function fillBuffBarOptions(data) {
    const list = document.getElementById("gmBarOptions");
    if (!list) return;
    const bars = (data && Array.isArray(data.customStats)) ? data.customStats : [];
    list.innerHTML = bars.map(cs => `<option value="${esc(barNameOf(cs.name))}"></option>`).join("");
}

export function openAddBuffModal() {
    buffModalTargetId = "";
    buffModalOnSaved = null;
    document.getElementById("editBuffIndex").value = "-1";
    document.getElementById("modalBuffTitle").innerText = "新增状态/Buff";
    document.getElementById("buffName").value = "";
    document.getElementById("buffRound").value = 3;
    document.getElementById("buffDesc").value = "";
    const typeEl = document.getElementById("buffType");
    if (typeEl) typeEl.value = "buff";
    document.getElementById("buffHpRound").value = 0;
    document.getElementById("buffMpRound").value = 0;
    const barNameEl = document.getElementById("buffBarName");
    if (barNameEl) barNameEl.value = "";
    const barRoundEl = document.getElementById("buffBarRound");
    if (barRoundEl) barRoundEl.value = 0;
    const barApplyEl = document.getElementById("buffBarApply");
    if (barApplyEl) barApplyEl.value = 0;
    const barMinEl = document.getElementById("buffBarMin");
    if (barMinEl) barMinEl.value = 0;
    fillBuffBarOptions(d);
    const libChk = document.getElementById("buffSaveToLib");
    if (libChk) libChk.checked = true;
    renderBonusEditor("buffBonusFields", "buff", parseBonus(""));
    updateBonusSummaries();
    document.getElementById("modalBuff").classList.remove("hide");
}
export function openEditBuffModal(idx) {
    buffModalTargetId = "";
    buffModalOnSaved = null;
    const b = normalizeBuff(d.buffs[idx]);
    document.getElementById("editBuffIndex").value = String(idx);
    document.getElementById("modalBuffTitle").innerText = "编辑状态";
    document.getElementById("buffName").value = b.name || "";
    document.getElementById("buffRound").value = b.round || 0;
    document.getElementById("buffDesc").value = b.desc || "";
    const typeEl = document.getElementById("buffType");
    if (typeEl) typeEl.value = b.type || "buff";
    document.getElementById("buffHpRound").value = b.hpPerRound || 0;
    document.getElementById("buffMpRound").value = b.mpPerRound || 0;
    const barNameEl = document.getElementById("buffBarName");
    if (barNameEl) barNameEl.value = barNameOf(b.barName);
    const barRoundEl = document.getElementById("buffBarRound");
    if (barRoundEl) barRoundEl.value = clampInt(b.barPerRound, LIMITS.customVal[0], LIMITS.customVal[1], 0);
    const barApplyEl = document.getElementById("buffBarApply");
    if (barApplyEl) barApplyEl.value = clampInt(b.barOnApply, LIMITS.customVal[0], LIMITS.customVal[1], 0);
    const barMinEl = document.getElementById("buffBarMin");
    if (barMinEl) barMinEl.value = clampInt(b.reqMin, LIMITS.customVal[0], LIMITS.customVal[1], 0);
    fillBuffBarOptions(d);
    const libChk = document.getElementById("buffSaveToLib");
    if (libChk) libChk.checked = false;
    renderBonusEditor("buffBonusFields", "buff", parseBonus(b.bonus || ""));
    updateBonusSummaries();
    document.getElementById("modalBuff").classList.remove("hide");
}
// 主持人派发：复用同一个「新增状态/Buff」弹窗，保存时写进指定角色/随从的存档
export function openGmBuffModal(targetId, onSaved) {
    const id = String(targetId || "");
    const data = id ? loadRawChar(id) : null;
    if (!data) { alert("目标角色不存在"); return; }
    openAddBuffModal();
    buffModalTargetId = id;
    buffModalOnSaved = typeof onSaved === "function" ? onSaved : null;
    fillBuffBarOptions(data);
    const titleEl = document.getElementById("modalBuffTitle");
    if (titleEl) titleEl.innerText = `给 ${data.name || "角色"} 新增状态/Buff`;
}

export function saveBuffModal() {
    const idx = Number(document.getElementById("editBuffIndex").value);
    const targetId = buffModalTargetId;
    const onSaved = buffModalOnSaved;
    const name = document.getElementById("buffName").value.trim();
    const round = clampInt(document.getElementById("buffRound").value, LIMITS.round[0], LIMITS.round[1], 0);
    const desc = document.getElementById("buffDesc").value.trim();
    if (!name) { alert("状态名称不能为空"); return; }
    const typeEl = document.getElementById("buffType");
    const hpPerRound = clampInt(document.getElementById("buffHpRound").value, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
    const mpPerRound = clampInt(document.getElementById("buffMpRound").value, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
    const barNameEl = document.getElementById("buffBarName");
    const barName = barNameOf(barNameEl ? barNameEl.value : "");
    const barRoundEl = document.getElementById("buffBarRound");
    const barPerRound = clampInt(barRoundEl ? barRoundEl.value : 0, LIMITS.customVal[0], LIMITS.customVal[1], 0);
    const barApplyEl = document.getElementById("buffBarApply");
    const barOnApply = clampInt(barApplyEl ? barApplyEl.value : 0, LIMITS.customVal[0], LIMITS.customVal[1], 0);
    const barMinEl = document.getElementById("buffBarMin");
    const reqBar = barName;
    const reqMin = barName ? clampInt(barMinEl ? barMinEl.value : 0, LIMITS.customVal[0], LIMITS.customVal[1], 0) : 0;
    const bonusObj = readBonusEditor("buff");
    const bonus = hasBonusContent({ ...bonusObj, set: { name: "" }, condition: { type: "" } })
        ? JSON.stringify(bonusObj) : "";
    const o = normalizeBuff({
        name, round, desc, bonus,
        type: typeEl ? typeEl.value : "",
        hpPerRound, mpPerRound,
        barName, barPerRound, barOnApply, reqBar, reqMin
    });
    const isActive = !targetId || targetId === activeCharId;
    const target = targetId ? (isActive ? d : loadRawChar(targetId)) : d;
    if (!target || typeof target !== "object") { alert("目标角色不存在"); return; }
    // 校验都过了才清空派发状态，避免填错后重试写到自己身上
    buffModalTargetId = "";
    buffModalOnSaved = null;
    if (!Array.isArray(target.buffs)) target.buffs = [];
    if (idx === -1) target.buffs.push(o);
    else target.buffs[idx] = o;
    // 施加时立即改条（编辑已有状态不重复结算）
    if (idx === -1 && barName && barOnApply) adjustCustomBar(target, barName, barOnApply);
    const linkRes = syncBarLinks(target);
    const libChk = document.getElementById("buffSaveToLib");
    if (libChk && libChk.checked) upsertBuffTemplateInto(target, o);
    closeModal("modalBuff");
    if (targetId && !isActive) {
        saveRawChar(targetId, target);
    } else {
        renderBuffs(); renderQuickBuffs(); renderCustomStats(); hpUpdate(); save();
    }
    if (onSaved) { try { onSaved(o, target); } catch (e) { } }
}

// === 快速施加库：把常用 Buff 存成模板，战斗中点一下就能重新挂上，不用重复填写 ===
export function upsertBuffTemplateInto(data, b) {
    if (!data || typeof data !== "object") return null;
    if (!Array.isArray(data.buffLib)) data.buffLib = [];
    const nb = normalizeBuff(b);
    const name = String(nb.name || "").trim();
    if (!name) return null;
    const tpl = {
        name,
        round: clampInt(nb.round, LIMITS.round[0], LIMITS.round[1], 0),
        desc: String(nb.desc || "").slice(0, 300),
        bonus: typeof nb.bonus === "string" ? nb.bonus : (nb.bonus ? JSON.stringify(nb.bonus) : ""),
        type: nb.type,
        hpPerRound: nb.hpPerRound,
        mpPerRound: nb.mpPerRound,
        barName: barNameOf(nb.barName),
        barPerRound: clampInt(nb.barPerRound, LIMITS.customVal[0], LIMITS.customVal[1], 0),
        barOnApply: clampInt(nb.barOnApply, LIMITS.customVal[0], LIMITS.customVal[1], 0),
        reqBar: barNameOf(nb.reqBar),
        reqMin: clampInt(nb.reqMin, LIMITS.customVal[0], LIMITS.customVal[1], 0)
    };
    const exist = data.buffLib.find(x => x && x.name === name);
    if (exist) {
        exist.round = tpl.round;
        exist.desc = tpl.desc;
        exist.bonus = tpl.bonus;
        exist.type = tpl.type;
        exist.hpPerRound = tpl.hpPerRound;
        exist.mpPerRound = tpl.mpPerRound;
        exist.barName = tpl.barName;
        exist.barPerRound = tpl.barPerRound;
        exist.barOnApply = tpl.barOnApply;
        exist.reqBar = tpl.reqBar;
        exist.reqMin = tpl.reqMin;
        return exist;
    }
    tpl.id = makeId();
    data.buffLib.push(tpl);
    if (data.buffLib.length > 200) data.buffLib = data.buffLib.slice(-200);
    return tpl;
}
export function upsertBuffTemplate(b) {
    return upsertBuffTemplateInto(d, b);
}
export function removeBuffTemplate(id) {
    if (!Array.isArray(d.buffLib)) return;
    d.buffLib = d.buffLib.filter(t => t.id !== id);
    renderQuickBuffs();
    save();
}
export function applyBuffTemplate(id) {
    if (!Array.isArray(d.buffLib)) return;
    const tpl = d.buffLib.find(t => t.id === id);
    if (!tpl) return;
    if (!Array.isArray(d.buffs)) d.buffs = [];
    const round = clampInt(tpl.round, LIMITS.round[0], LIMITS.round[1], 0);
    const durTxt = round > 0 ? `${round} 回合` : "永久";
    const exist = d.buffs.find(b => b && b.name === tpl.name);
    if (exist) {
        // 同名只刷新回合，保留玩家手动改过的描述/加成
        exist.round = round;
        if (!exist.desc) exist.desc = tpl.desc || "";
        if (!exist.bonus) exist.bonus = tpl.bonus || "";
        if (exist.hpPerRound === undefined) exist.hpPerRound = clampInt(tpl.hpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
        if (exist.mpPerRound === undefined) exist.mpPerRound = clampInt(tpl.mpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
        if (!exist.barName && tpl.barName) exist.barName = barNameOf(tpl.barName);
        if (exist.barPerRound === undefined) exist.barPerRound = clampInt(tpl.barPerRound, LIMITS.customVal[0], LIMITS.customVal[1], 0);
        if (exist.barOnApply === undefined) exist.barOnApply = clampInt(tpl.barOnApply, LIMITS.customVal[0], LIMITS.customVal[1], 0);
        if (!exist.reqBar && tpl.reqBar) exist.reqBar = barNameOf(tpl.reqBar);
        if (exist.reqMin === undefined) exist.reqMin = clampInt(tpl.reqMin, LIMITS.customVal[0], LIMITS.customVal[1], 0);
        if (!exist.type) exist.type = normalizeBuffType(tpl.type) || "buff";
        buffToast(`⚡ 刷新「${tpl.name}」 ${durTxt}`);
    } else {
        d.buffs.push(normalizeBuff({
            name: tpl.name, round,
            desc: tpl.desc || "",
            bonus: tpl.bonus || "",
            type: tpl.type,
            hpPerRound: tpl.hpPerRound,
            mpPerRound: tpl.mpPerRound,
            barName: tpl.barName,
            barPerRound: tpl.barPerRound,
            barOnApply: tpl.barOnApply,
            reqBar: tpl.reqBar,
            reqMin: tpl.reqMin
        }));
        if (tpl.barName && tpl.barOnApply) adjustCustomBar(d, tpl.barName, tpl.barOnApply);
        buffToast(`⚡ 施加「${tpl.name}」 ${durTxt}`);
    }
    syncBarLinks(d);
    renderBuffs(); renderCustomStats(); hpUpdate(); save();
}
export let buffToastTimer = null;
export function buffToast(msg) {
    const ids = ["buffToast", "combatBuffToast"];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = msg;
        el.style.opacity = "1";
    });
    if (typeof clearTimeout === "function") clearTimeout(buffToastTimer);
    if (typeof setTimeout === "function") {
        buffToastTimer = setTimeout(() => {
            ids.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.opacity = "0";
            });
        }, 5000);
    }
}
export function renderQuickBuffs() {
    if (!Array.isArray(d.buffLib)) d.buffLib = [];
    const html = d.buffLib.length
        ? d.buffLib.map(raw => {
            const t = normalizeBuff(raw);
            const sum = bonusSummary(parseBonus(t.bonus || ""));
            const tick = buffTickText(t);
            const bbar = buffBarText(t);
            const tip = `${buffTypeCn[t.type] || "增益"} · ${t.round > 0 ? t.round + " 回合" : "永久"}${tick ? " · " + tick : ""}${bbar ? " · " + bbar : ""}${sum ? " · " + sum : ""}${t.desc ? " · " + t.desc : ""}`;
            return `<span class="buff-chip" title="${esc(tip)}" onclick="applyBuffTemplate('${esc(t.id)}')">${buffTypeIcon[t.type] || ""}${esc(t.name)}<b>${t.round > 0 ? t.round : "∞"}</b><i title="从快速库删除" onclick="event.stopPropagation();removeBuffTemplate('${esc(t.id)}')">✖</i></span>`;
        }).join("")
        : `<span class="small">快速库为空 · 新增状态时勾选「存入快速施加库」</span>`;
    ["quickBuffBar", "combatQuickBuffBar"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    });
}
export function tickBuffs() {
    if (!Array.isArray(d.buffs)) d.buffs = [];
    read();
    const snap = recalcGearBonus();
    const ticks = [];
    let hpSum = 0, mpSum = 0;
    d.buffs.forEach(b => {
        const nb = normalizeBuff(b);
        if (nb.hpPerRound) { hpSum += nb.hpPerRound; ticks.push(`${nb.name} HP${nb.hpPerRound > 0 ? "+" : ""}${nb.hpPerRound}`); }
        if (nb.mpPerRound) { mpSum += nb.mpPerRound; ticks.push(`${nb.name} MP${nb.mpPerRound > 0 ? "+" : ""}${nb.mpPerRound}`); }
    });
    // 其他修正的小被动：每回合回血/回蓝（正=回复，负=扣血）
    (Array.isArray(d.extraMods) ? d.extraMods : []).forEach(m => {
        if (!m || m.enabled === false) return;
        const p = m.passive || {};
        const hp = clampInt(p.hpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
        const mp = clampInt(p.mpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
        const label = String(m.name || "其他修正");
        if (hp) { hpSum += hp; ticks.push(`${label} HP${hp > 0 ? "+" : ""}${hp}`); }
        if (mp) { mpSum += mp; ticks.push(`${label} MP${mp > 0 ? "+" : ""}${mp}`); }
    });
    hpSum = clampNum(hpSum, FINAL_MIN, FINAL_MAX, 0);
    mpSum = clampNum(mpSum, FINAL_MIN, FINAL_MAX, 0);
    let hpNote = "";
    if (hpSum) {
        d.hp = clampNum(d.hp + hpSum, 0, snap.total.maxHp, 0);
        hpNote = `HP${d.hp <= 0 ? " 归零（角色倒下）" : ` → ${d.hp}`}`;
    }
    if (mpSum) d.mp = clampNum(d.mp + mpSum, 0, snap.total.maxMp, 0);
    // 状态每回合改自定义条（正=加，负=减）
    const barSums = new Map();
    d.buffs.forEach(b => {
        const nb = normalizeBuff(b);
        const bn = barNameOf(nb.barName);
        const delta = clampInt(nb.barPerRound, LIMITS.customVal[0], LIMITS.customVal[1], 0);
        if (bn && delta) barSums.set(bn, (barSums.get(bn) || 0) + delta);
    });
    barSums.forEach((delta, name) => {
        const r = adjustCustomBar(d, name, delta);
        if (r) ticks.push(`${name}${delta > 0 ? "+" : ""}${delta} → ${r.after}`);
    });
    // 先写回输入框，避免 hpUpdate() 里的 read() 用旧值覆盖刚才的结算
    document.getElementById("hp").value = d.hp;
    document.getElementById("mp").value = d.mp;

    const expired = [];
    d.buffs = d.buffs.filter(b => {
        if (!(Number(b.round) > 0)) return true; // 0 = 永久
        b.round = clampInt(Number(b.round) - 1, 0, LIMITS.round[1], 0);
        if (b.round <= 0) { expired.push(b.name); return false; }
        return true;
    });
    // 大招条：回合结束涨值（负数即每回合倒扣）
    const gainRound = applyBarGain(d, "round");
    gainRound.gained.forEach(g => ticks.push(g));
    gainRound.removed.forEach(n => expired.push(n));
    // 条值联动：满值/归零触发状态；存续条件不满足的状态自动失效
    const linkRes = syncBarLinks(d);
    linkRes.added.forEach(n => ticks.push(`触发「${n}」`));
    linkRes.removed.forEach(n => expired.push(n));
    // 小被动：回合计数 + 每回合自动攻击（伤害取当前最终伤害值）
    d.combatRounds = clampInt((Number(d.combatRounds) || 0) + 1, 0, 999999, 0);
    let autoNote = "";
    const hasAuto = (Array.isArray(d.extraMods) ? d.extraMods : []).some(m => m && m.enabled !== false && m.passive && m.passive.autoAttack === true);
    const autoDmg = clampNum(snap.total.damage, 0, FINAL_MAX, 0);
    if (hasAuto && autoDmg > 0) {
        applyDamageToCombatTarget(autoDmg, "被动·自动攻击");
        autoNote = `自动攻击 ${autoDmg}`;
    }
    renderBuffs();
    hpUpdate();
    save();
    const active = d.buffs.filter(b => Number(b.round) > 0).map(b => `${b.name}(${b.round})`);
    buffToast(`⏭ 回合结束${ticks.length ? ` · 结算：${ticks.join("、")}${hpNote ? `（${hpNote}）` : ""}` : ""}${autoNote ? ` · ${autoNote}` : ""}${expired.length ? ` · 已结束：${expired.join("、")}` : ""}${active.length ? ` · 剩余：${active.join("、")}` : ""}`);
}
export function renderBuffs() {
    const el = document.getElementById("buffList");
    if (!Array.isArray(d.buffs)) d.buffs = [];
    if (!d.buffs.length) {
        el.innerHTML = `<div class="empty">暂无状态/Buff记录</div>`;
    } else {
        el.innerHTML = d.buffs.map((b, i) => {
            const nb = normalizeBuff(b);
            const bsum = bonusSummary(parseBonus(nb.bonus || ""));
            const tick = buffTickText(nb);
            const bbar = buffBarText(nb);
            const tickColor = (nb.hpPerRound < 0 || nb.mpPerRound < 0) ? "var(--red)" : "#6dd400";
            const tCn = buffTypeCn[nb.type] || "增益";
            const tColor = buffTypeColor[nb.type] || "var(--gold)";
            return `
<div class="buff-item">
    <div class="buff-info">
        <div class="buff-name">${buffTypeIcon[nb.type] || ""} ${esc(nb.name)}<span style="font-size:12px; font-weight:normal; color:${tColor}; margin-left:6px">${tCn}</span></div>
        <div class="buff-meta">${nb.round > 0 ? "剩余回合：" + nb.round : "永久状态"}</div>
        ${tick ? `<div class="buff-meta" style="color:${tickColor}; font-weight:bold">${esc(tick)}</div>` : ""}
        ${bbar ? `<div class="buff-meta" style="color:var(--blue); font-weight:bold">🔋 ${esc(bbar)}</div>` : ""}
        ${bsum ? `<div class="buff-meta" style="color:var(--gold)">加成：${esc(bsum)}</div>` : ""}
        <div class="buff-desc">${esc(nb.desc)}</div>
    </div>
    <div>
        <button onclick="openEditBuffModal(${i})">编辑</button>
        <button onclick="{d.buffs.splice(${i},1);renderBuffs();hpUpdate();save();}">移除</button>
    </div>
</div>`;
        }).join("");
    }
    renderQuickBuffs();
}
