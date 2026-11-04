import { LIMITS, clampNum, clampInt } from "./limits.js";
import { d, charList, activeCharId, setActiveCharId, setCharList } from "./state.js";
import { esc, makeId } from "./util.js";
import { companionModes, companionModeCn, computeCompanion } from "./companion.js";
import { loadRawChar, saveRawChar, saveCharListMeta, renderCharSelect, loadActiveCharacter, page, createCompanion, read, saveCurrentCharacter, pushHpToOwner, pushOwnerWithCompanions } from "./persist.js";
import { recalcGearBonus } from "./display.js";
import { renderDerived, hpUpdate } from "./stats_ui.js";
import { save } from "./modal_misc.js";
import { fill } from "./init.js";

// === 宠物/随从/召唤物界面 ===

// 模式说明文字
export function companionModeNote(mode) {
    if (mode === "hero") return "等级同步主角，属性独立；参战时主角本体不参战";
    if (mode === "growth") return "数值 = 主角最终数值 × 倍率";
    if (mode === "summon") return "固定数值，可复制；勾选后改吃成长倍率";
    return "完全自定义，与主角无联动";
}

// 模式专属控件：成长倍率 / 召唤物勾选与复制 / 形态说明
function modeControlsHTML(c, kind) {
    const isSelf = kind === "self";
    const setter = (field, expr) => isSelf
        ? `setSelfCompanion('${field}', ${expr})`
        : `updateOwnedCompanion('${esc(c.id)}','${field}',${expr})`;
    const scaleVal = clampNum(c.scale, LIMITS.companionScale[0], LIMITS.companionScale[1], 0.6);
    const scaleInput = `<label class="companion-scale">倍率
        <input type="number" step="0.05" min="${LIMITS.companionScale[0]}" max="${LIMITS.companionScale[1]}" value="${scaleVal}" onchange="${setter("scale", "this.value")}">
    </label>`;
    if (c.mode === "growth") {
        return scaleInput;
    }
    if (c.mode === "summon") {
        return `<label class="companion-combat"><input type="checkbox"${c.summonScale ? " checked" : ""} onchange="${setter("summonScale", "this.checked?1:0")}"><span>吃成长倍率</span></label>`
            + (c.summonScale ? scaleInput : "")
            + `<button class="small" onclick="cloneCompanion('${esc(c.id)}')">复制一个</button>`;
    }
    if (c.mode === "hero") {
        return `<span class="companion-tag">主角形态 · 等级同步 Lv ${c.level} · 属性独立</span>`
            + `<label class="companion-combat"><input type="checkbox"${c.hpSync ? " checked" : ""} onchange="${setter("hpSync", "this.checked?1:0")}"><span>血量百分比同步</span></label>`;
    }
    return `<span class="companion-tag">独立角色 · 与主角无联动</span>`;
}
// 面板展开状态按「主人 id」记忆（主角页＝自己，随从页＝它的主人），
// 不读 style.display 反推，避免重画（如创建随从触发 renderCompanions）时被抹掉。
const companionPanelOpen = new Map(); // key: ownerId → boolean（缺省视为展开）

export function isCompanionPanelOpen(ownerId = companionOwnerId()) {
    return companionPanelOpen.has(ownerId) ? companionPanelOpen.get(ownerId) : true;
}

export function setCompanionPanelOpen(open, ownerId = companionOwnerId()) {
    companionPanelOpen.set(ownerId, !!open);
    applyCompanionPanel(ownerId);
}

function applyCompanionPanel(ownerId = companionOwnerId()) {
    const wrapper = document.getElementById("companionWrapper");
    if (!wrapper) return; // 测试桩 / 其它页面：静默跳过
    const isCompanion = d && d.type === "companion";
    // 随从卡页面本来就不显示这个面板；主人页按记忆状态展开/收起
    wrapper.style.display = isCompanion ? "none" : (isCompanionPanelOpen(ownerId) ? "block" : "none");
}

export function toggleCompanionPanel() {
    const ownerId = companionOwnerId();
    companionPanelOpen.set(ownerId, !isCompanionPanelOpen(ownerId));
    applyCompanionPanel(ownerId);
}

// 当前上下文的「主人」ID：主角页＝主角自己；随从页＝它的主人（随从不再嵌套随从）
export function companionOwnerId() {
    if (d && d.type === "companion") return d.ownerId || activeCharId || "";
    return activeCharId || "";
}

// 当前主人名下的随从（charList 里 type=companion 且 ownerId=主人）
export function ownedCompanions() {
    const ownerId = companionOwnerId();
    return (charList || []).filter(c => c && c.type === "companion" && (c.ownerId || "") === ownerId);
}

// 读取一个随从角色的完整存档
export function companionData(id) {
    return loadRawChar(id) || { type: "companion", ownerId: "" };
}

// 更新一个随从角色的字段/数值并保存
export function updateOwnedCompanion(id, field, value) {
    const data = companionData(id);
    if (!data) return;
    if (field === "name") data.name = String(value || "").trim().slice(0, 40) || "新随从";
    else if (field === "icon") data.icon = String(value || "").trim().slice(0, 4) || "🐾";
    else if (field === "species") data.species = String(value || "").trim().slice(0, 40);
    else if (field === "mode") data.mode = companionModes.includes(value) ? value : (data.mode || "own");
    else if (field === "combat") data.combat = Number(value) === 1;
    else if (field === "scale" || field === "heroCoeff") data[field] = clampNum(value, LIMITS.companionScale[0], LIMITS.companionScale[1], 0.6);
    else if (field === "summonScale") data.summonScale = Number(value) === 1;
    else if (field === "hpSync") data.hpSync = Number(value) === 1;
    else data[field] = value;
    // 主角形态＝同一个「人」：等级对齐主角（属性不同步，也不强制参战）
    if (data.mode === "hero") {
        const owner = data.ownerId ? loadRawChar(data.ownerId) : null;
        if (owner) data.level = clampInt(owner.level, LIMITS.level[0], LIMITS.level[1], 1);
    }
    saveRawChar(id, data);
    // 随从参战/属性变化：立刻重推主人卡，房间看板马上更新
    try { pushOwnerWithCompanions(data); } catch (e) { }
    // 如果改的就是当前正在查看的角色，实时同步内存，避免随后 save() 把旧值写回去
    if (id === activeCharId && d) {
        ["name", "icon", "species", "mode", "combat", "scale", "heroCoeff", "summonScale", "hpSync", "level"].forEach(k => { d[k] = data[k]; });
    }
    const meta = charList.find(x => x.id === id);
    if (meta) { meta.name = data.name || "新随从"; meta.icon = data.icon || "🐾"; saveCharListMeta(); renderCharSelect(); }
    renderCompanions();
}

// 复制一个随从/召唤物（临时招募一次拉出多个同款时用）
export function cloneCompanion(id) {
    const src = loadRawChar(id);
    if (!src || typeof src !== "object") return null;
    const newId = makeId();
    const data = JSON.parse(JSON.stringify(src));
    data.id = newId;
    data.type = "companion";
    data.name = String(data.name || "随从").trim().slice(0, 34) + "·副本";
    charList.push({
        id: newId,
        name: data.name,
        icon: data.icon || "🐾",
        type: "companion",
        ownerId: data.ownerId || companionOwnerId()
    });
    saveCharListMeta();
    saveRawChar(newId, data);
    // 复制出来的随从也要立刻出现在房间看板上
    try { pushOwnerWithCompanions(data); } catch (e) { }
    renderCharSelect();
    renderCompanions();
    return newId;
}

// 打开某个随从的角色总览
export function openCompanionOverview(id) {
    setActiveCharId(id);
    loadActiveCharacter();
    const tab = document.querySelector('.tab[onclick*="character"]');
    if (tab) page("character", tab);
}

export function removeCompanion(id) {
    if (!confirm("确定删除这个随从？数据不可恢复！")) return;
    const ownerId = String((charList.find(x => x && x.id === id) || {}).ownerId || "");
    localStorage.removeItem("jigerpg_char_" + id);
    setCharList(charList.filter(x => x.id !== id));
    saveCharListMeta();
    // 删除随从：立刻重推主人卡，房间看板随从栏马上少一条
    try { pushOwnerWithCompanions(ownerId); } catch (e) { }
    renderCharSelect();
    renderCompanions();
}

// 随从身份设置（当前激活的角色本身是随从时，显示在总览的身份条里）
export function setSelfCompanion(field, value) {
    if (!d) return;
    if (field === "icon") d.icon = String(value || "").slice(0, 4);
    else if (field === "species") d.species = String(value || "").trim().slice(0, 40);
    else if (field === "combat") d.combat = Number(value) === 1;
    else if (field === "name") d.name = String(value || "").trim().slice(0, 40) || "新随从";
    else if (field === "scale" || field === "heroCoeff") d[field] = clampNum(value, LIMITS.companionScale[0], LIMITS.companionScale[1], 0.6);
    else if (field === "summonScale") d.summonScale = Number(value) === 1;
    else if (field === "hpSync") d.hpSync = Number(value) === 1;
    else d[field] = value;
    // 需要重算的字段先刷新（会同步 #hp 等输入框），再保存，避免存下旧数值
    if (field === "scale" || field === "heroCoeff" || field === "summonScale" || field === "hpSync") hpUpdate();
    save();
    const meta = charList.find(x => x.id === activeCharId);
    if (meta) { meta.name = d.name || "新随从"; meta.icon = d.icon || "🐾"; saveCharListMeta(); renderCharSelect(); }
    renderCompanions();
    // 随从卡页改参战/属性：save() 里随从卡被早退拦下，这里显式重推主人卡（指纹去重）
    try { pushOwnerWithCompanions(d.ownerId || ""); } catch (e) { }
}
export function setSelfCompanionMode(mode) {
    if (!d) return;
    d.mode = companionModes.includes(mode) ? mode : "own";
    // 主角形态：只同步等级，属性保持自己的；参战与否由用户自己勾选
    if (d.mode === "hero") {
        const owner = d.ownerId ? loadRawChar(d.ownerId) : null;
        if (owner) d.level = clampInt(owner.level, LIMITS.level[0], LIMITS.level[1], 1);
    }
    // 先刷新输入框再保存：save() 里的 read() 会用输入框旧值覆盖刚同步的等级
    fill();
    save();
    hpUpdate();
    renderCompanions();
}

export function renderCompanions() {
    const el = document.getElementById("companionPanel");
    const selfBar = document.getElementById("companionSelfBar");
    const isCompanion = d && d.type === "companion";

    // 随从不是 "主人页面的面板"：随从卡页隐藏；主人页恢复用户上次的展开/收起（默认展开）
    applyCompanionPanel();

    // 随从身份设置条
    if (selfBar) {
        if (isCompanion) {
            selfBar.style.display = "block";
            const modeOptions = companionModes.map(m => `<option value="${m}"${m === d.mode ? " selected" : ""}>${companionModeCn[m]}</option>`).join("");
            const ownerMeta = (charList || []).find(x => x.id === d.ownerId);
            selfBar.innerHTML = `<div class="companion-selfbar">
    <div class="companion-selfbar-title">🐾 随从身份设置（主人：${esc(ownerMeta ? ownerMeta.name : "无主")}）</div>
    <div class="companion-head">
        <input type="text" class="companion-icon" value="${esc(d.icon || "🐾")}" title="图标" onchange="setSelfCompanion('icon', this.value)">
        <input type="text" class="companion-name" value="${esc(d.name || "")}" onchange="setSelfCompanion('name', this.value)">
        <input type="text" class="companion-species" value="${esc(d.species || "")}" placeholder="物种" onchange="setSelfCompanion('species', this.value)">
        <select style="width:auto" onchange="setSelfCompanionMode(this.value)">${modeOptions}</select>
        <label class="companion-combat">
            <input type="checkbox" ${d.combat ? "checked" : ""} onchange="setSelfCompanion('combat', this.checked ? 1 : 0)">
            <span class="companion-status${d.combat ? " on" : ""}">参战</span>
        </label>
    </div>
    <div class="companion-controls">${modeControlsHTML({ ...d, id: d.id || activeCharId }, "self")}</div>
    <div class="companion-note" style="margin-top:5px">${companionModeCn[d.mode] || "独立"}：${companionModeNote(d.mode)}</div>
</div>`;
        } else {
            selfBar.style.display = "none";
            selfBar.innerHTML = "";
        }
    }

    if (!el) { renderCombatTargets(); return; }
    const owned = ownedCompanions();
    const ownerMeta = (charList || []).find(x => x && x.id === companionOwnerId());
    const listHint = isCompanion
        ? `<div class="companion-list-hint">这是主人 <b>${esc(ownerMeta ? ownerMeta.name : "无主")}</b> 的随从列表 · 随从不再拥有随从</div>`
        : "";
    if (owned.length === 0) {
        el.innerHTML = listHint + `<div class="empty">${isCompanion
            ? "主人名下暂无其他随从 · 点下方「新建随从」会直接归到主人名下"
            : "暂无随从 · 点下方「+ 添加」创建（会立刻打开它的角色总览）"}</div>`;
        renderCombatTargets();
        return;
    }
    el.innerHTML = listHint + owned.map(meta => {
        const isSelf = meta.id === activeCharId;
        const cdata = companionData(meta.id);
        if (!cdata || typeof cdata !== "object") return "";
        const cc = computeCompanion({ ...cdata, ownerId: meta.ownerId || cdata.ownerId || "" });
        const modeOptions = companionModes.map(m => `<option value="${m}"${m === cc.mode ? " selected" : ""}>${companionModeCn[m]}</option>`).join("");
        return `
        <div class="companion-card">
            <div class="companion-head">
                <input type="text" class="companion-icon" value="${esc(cc.icon || "🐾")}" title="图标" onchange="updateOwnedCompanion('${esc(meta.id)}','icon',this.value)">
                <input type="text" class="companion-name" value="${esc(cc.name)}" onchange="updateOwnedCompanion('${esc(meta.id)}','name',this.value)">
                <input type="text" class="companion-species" value="${esc(cc.species)}" title="物种" placeholder="物种" onchange="updateOwnedCompanion('${esc(meta.id)}','species',this.value)">
                <select style="width:auto" onchange="updateOwnedCompanion('${esc(meta.id)}','mode',this.value)">${modeOptions}</select>
                <div class="companion-actions">
                    <label class="companion-combat">
                        <input type="checkbox" ${cc.combat ? "checked" : ""} onchange="updateOwnedCompanion('${esc(meta.id)}','combat',this.checked?1:0)">
                        <span class="companion-status${cc.combat ? " on" : ""}">参战</span>
                    </label>
                    <button class="small" onclick="openCompanionOverview('${esc(meta.id)}')"${isSelf ? ' style="display:none"' : ""}>打开总览</button>
                    ${isSelf ? '<span class="companion-tag">当前</span>' : ""}
                    <span class="companion-remove" onclick="removeCompanion('${esc(meta.id)}')" title="删除">✖</span>
                </div>
            </div>
            <div class="companion-controls">${modeControlsHTML({ ...cc, id: meta.id })}</div>
            <div class="companion-meta">${esc(cc.icon || "🐾")} ${esc(cc.species || "未知物种")} · 等级 ${cc.level}</div>
            <div class="companion-vitals">
                <span class="companion-chip"><b>HP</b> ${cc.hp}/${cc.maxHp}</span>
                <span class="companion-chip"><b>MP</b> ${cc.mp}/${cc.maxMp}</span>
                <span class="companion-chip"><b>护甲</b> ${cc.armor}</span>
                <span class="companion-chip"><b>速度</b> ${cc.speed}</span>
                <span class="companion-chip"><b>伤害</b> ${cc.damage}</span>
            </div>
            <div class="companion-note">${companionModeCn[cc.mode]}：${companionModeNote(cc.mode)}</div>
        </div>`;
    }).join("");
    renderCombatTargets();
}

// 战斗页：把参战的随从填充到「攻击目标」下拉
export function renderCombatTargets() {
    const sel = document.getElementById("combatTarget");
    if (!sel) return;
    const prev = sel.value;
    // 无论当前打开的是主角还是某个随从，战斗目标都按「主人名下的随从」来列
    const heroId = companionOwnerId();
    const owned = (charList || []).filter(x => x && x.type === "companion" && (x.ownerId || "") === heroId);
    // 主角形态：主角本体不参战，战斗目标里用该形态顶替「主角」
    const heroFormMeta = owned.find(meta => {
        const cd = companionData(meta.id);
        return !!cd && cd.mode === "hero" && cd.combat === true;
    });
    const opts = [];
    if (heroFormMeta) {
        const fd = companionData(heroFormMeta.id) || {};
        opts.push(`<option value="hero">${esc(fd.icon || "🐾")} ${esc(fd.name || "主角形态")}（主角形态）</option>`);
    } else {
        opts.push('<option value="hero">主角</option>');
    }
    owned.forEach(meta => {
        const cdata = companionData(meta.id);
        if (!cdata || typeof cdata !== "object" || cdata.combat !== true) return;
        if (cdata.mode === "hero") return; // 已作为主角形态出战
        const cc = computeCompanion({ ...cdata, ownerId: meta.ownerId || cdata.ownerId || "" });
        opts.push(`<option value="companion_${esc(meta.id)}">${esc(cdata.icon || "🐾")} ${esc(cdata.name || "")} (HP ${cc.hp}/${cc.maxHp})</option>`);
    });
    sel.innerHTML = opts.join("");
    // 尽量保留之前选中的目标；若已失效则回落到主角
    if (sel.options && sel.options.length) {
        let keep = false;
        for (let i = 0; i < sel.options.length; i++) { if (sel.options[i].value === prev) { keep = true; break; } }
        sel.value = keep ? prev : "hero";
    } else {
        sel.value = prev || "hero";
    }
}

export function addCompanion() {
    createCompanion();
}

export function applyHpDelta(sign) {
    read();
    const delta = clampNum(document.getElementById("hpDelta").value, 0, LIMITS.hpMp[1], 0);
    // 先算上限（hpSync 时这步会把 HP 拉回主角百分比），再叠加本次变化，避免变化被覆盖
    const snap = recalcGearBonus();
    d.hp = clampNum(d.hp + sign * delta, 0, snap.total.maxHp, 0);
    document.getElementById("hp").value = d.hp;
    document.getElementById("hptext").textContent = `${d.hp} / ${snap.total.maxHp}`;
    document.getElementById("hpfill").style.width = Math.min(100, d.hp / snap.total.maxHp * 100) + "%";
    renderDerived(snap);
    // 主角形态开了「血量百分比同步」：加血/扣血也写回主角
    if (d.type === "companion") pushHpToOwner(d);
    saveCurrentCharacter();
}
export function applyMpDelta(sign) {
    read();
    const delta = clampNum(document.getElementById("mpDelta").value, 0, LIMITS.hpMp[1], 0);
    d.mp += sign * delta;
    const snap = recalcGearBonus();
    d.mp = clampNum(d.mp, 0, snap.total.maxMp, 0);
    document.getElementById("mp").value = d.mp;
    document.getElementById("mptext").textContent = `${d.mp} / ${snap.total.maxMp}`;
    document.getElementById("mpfill").style.width = Math.min(100, d.mp / snap.total.maxMp * 100) + "%";
    renderDerived(snap);
    saveCurrentCharacter();
}
