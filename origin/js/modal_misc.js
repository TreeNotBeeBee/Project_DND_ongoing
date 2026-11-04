import { LIMITS, clampNum, clampInt } from "./limits.js";
import { charBase, statKeys, statCn } from "./core.js";
import { d, setD } from "./state.js";
import { esc } from "./util.js";
import { normalizeGrowth, levelTierPct, levelTierRow } from "./compute.js";
import { normalizeGearSlots, cleanGearRefs, parseBonus } from "./bonus.js";
import { normalizeItem, recalcGearBonus, hasBonusContent } from "./display.js";
import { sanitizeCharData, normalizeExtraMod } from "./sanitize.js";
import { saveCurrentCharacter, read, normalizeAvatar, buildAccountPayload, importAccountPayload, normalizeCharForImport, loadCharList } from "./persist.js";
import { fill, renderAll } from "./init.js";
import { hpUpdate } from "./stats_ui.js";
import { renderBonusEditor, readBonusEditor, updateBonusSummaries, bonusEditorHTML } from "./items_gear_ui.js";

export function closeModal(id) { document.getElementById(id).classList.add("hide"); }
export function openResetModal() { document.getElementById("modalReset").classList.remove("hide"); }
export function doReset() {
    setD(JSON.parse(JSON.stringify(charBase)));
    closeModal("modalReset");
    fill(); renderAll(); save();
}

export function save() {
    if (saveCurrentCharacter() === false) return;
    const statusDom = document.getElementById("status");
    statusDom.textContent = "✅已保存 · JigeRPG v0.42";
    setTimeout(() => { statusDom.textContent = "JigeRPG · 本地运行，不需要联网"; }, 3000);
}
export function exportSave() {
    read(); hpUpdate();
    if (saveCurrentCharacter() === false) return;
    // 整包导出：角色列表 + 每个角色/随从的独立存档（随从的 ownerId 归属一起带走）
    const payload = buildAccountPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "JigeRPG-存档.json";
    a.click();
    URL.revokeObjectURL(a.href);
}
export function importSave(e) {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
        try {
            const imported = JSON.parse(r.result);
            if (!imported || typeof imported !== "object") throw new Error("invalid save");
            if (imported.format === "jigerpg-account" && imported.characters) {
                // 整包存档：恢复所有角色与随从，随从仍挂在原主人名下
                const count = importAccountPayload(imported);
                alert(`✅导入存档成功！已恢复 ${count} 个角色/随从，随从仍归原来的主人。`);
            } else {
                // 旧版单角色存档：只恢复当前角色；内含旧式随从时，loadCharList 会迁移成独立角色卡
                normalizeCharForImport(imported);
                fill(); recalcGearBonus(); renderAll(); save();
                loadCharList();
                alert("✅导入存档成功！");
            }
        } catch (err) { alert("❌存档读取失败"); }
        e.target.value = "";
    }
    r.readAsText(f);
}

// ===== 角色头像（本地图片，压缩后存为 dataURL） =====
export function renderAvatar() {
    const box = document.getElementById("avatarBox");
    const img = document.getElementById("avatarImg");
    const reset = document.getElementById("avatarReset");
    if (!box || !img) return;
    const src = d ? normalizeAvatar(d.avatar) : "";
    if (src) {
        img.src = src;
        box.classList.add("has-img");
        if (reset) reset.style.display = "";
    } else {
        img.src = "";
        box.classList.remove("has-img");
        if (reset) reset.style.display = "none";
    }
}

export function pickAvatar() {
    const input = document.getElementById("avatarFile");
    if (input) input.click();
}

export function resetAvatar() {
    if (!d) return;
    d.avatar = "";
    renderAvatar();
    save();
}

export function dropAvatar(ev) {
    ev.preventDefault();
    const box = document.getElementById("avatarBox");
    if (box) box.classList.remove("drag");
    const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (file) processAvatarFile(file);
}

export function handleAvatarFile(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    if (file) processAvatarFile(file);
    input.value = "";
}

export function processAvatarFile(file) {
    if (!file || !/^image\//.test(file.type || "")) {
        alert("请选择图片文件（png / jpg / webp 等）");
        return;
    }
    if (file.size > 8 * 1024 * 1024) {
        alert("图片太大，请选择 8MB 以内的图片");
        return;
    }
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            try {
                // 居中裁成正方形，缩到 256×256，避免把大图塞进 localStorage
                const iw = img.naturalWidth || img.width;
                const ih = img.naturalHeight || img.height;
                if (!iw || !ih) { alert("这张图片无法读取尺寸，请换一张试试"); return; }
                const size = 256;
                const canvas = document.createElement("canvas");
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext("2d");
                const side = Math.min(iw, ih);
                const sx = (iw - side) / 2;
                const sy = (ih - side) / 2;
                ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
                let data = canvas.toDataURL("image/webp", 0.9);
                if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/png");
                d.avatar = data;
                renderAvatar();
                save();
            } catch (e) {
                alert("头像处理失败，请换一张图片试试");
            }
        };
        img.onerror = () => alert("图片读取失败，请换一张图片试试");
        img.src = reader.result;
    };
    reader.onerror = () => alert("图片读取失败，请换一张图片试试");
    reader.readAsDataURL(file);
}

// ===== 种族 / 等级成长弹窗（两个独立系统） =====
export let growthDraft = [];

export function pctCellInput(v) {
    const n = Math.round(clampNum(v, LIMITS.growthPct[0], LIMITS.growthPct[1], 0) * 1000) / 10;
    return n === 0 ? "" : n;
}

export function renderLevelTable() {
    const body = document.getElementById("levelTableBody");
    if (!body) return;
    body.innerHTML = growthDraft.map((row, idx) => `<tr>
        <td><input type="number" min="1" value="${clampInt(row.level, LIMITS.level[0], LIMITS.level[1], 1)}" data-lvlrow="${idx}" data-lvlfield="level"></td>
        ${statKeys.map(k => `<td><input type="number" step="0.1" value="${pctCellInput(row.pct[k])}" data-lvlrow="${idx}" data-lvlfield="${esc(k)}" placeholder="0"></td>`).join("")}
        <td><button class="danger" onclick="removeLevelRow(${idx})" title="删除该等级">✕</button></td>
    </tr>`).join("");
}

export function readLevelTable() {
    const rows = [];
    const body = document.getElementById("levelTableBody");
    if (!body) return rows;
    body.querySelectorAll("tr").forEach(tr => {
        const levelInput = tr.querySelector('input[data-lvlfield="level"]');
        if (!levelInput) return;
        const row = { level: clampInt(levelInput.value, LIMITS.level[0], LIMITS.level[1], 1), pct: {} };
        statKeys.forEach(k => {
            const inp = tr.querySelector(`input[data-lvlfield="${k}"]`);
            const pct = clampNum((Number(inp && inp.value) || 0) / 100, LIMITS.growthPct[0], LIMITS.growthPct[1], 0);
            if (pct) row.pct[k] = pct;
        });
        rows.push(row);
    });
    return rows;
}

export function updateGrowthPreview() {
    const level = clampInt(document.getElementById("level") && document.getElementById("level").value, LIMITS.level[0], LIMITS.level[1], 1);
    const rows = normalizeGrowth(readLevelTable());
    const pct = levelTierPct(level, rows);
    const active = levelTierRow(level, rows);
    const parts = statKeys
        .filter(k => Math.abs(pct[k] || 0) > 1e-9)
        .map(k => `${statCn[k]}${pct[k] >= 0 ? "+" : ""}${Math.round(pct[k] * 1000) / 10}%`);
    const lvlEl = document.getElementById("growthLevelPreview");
    if (lvlEl) lvlEl.textContent = level;
    const pre = document.getElementById("growthPreview");
    if (pre) pre.textContent = parts.length
        ? `${active ? `${active.level}级档 ` : ""}${parts.join("，")}`
        : "无（当前等级没有生效档位）";
}

// ===== 种族弹窗 =====
export function openRaceModal() {
    document.getElementById("raceName").value = String(d.race || "");
    renderBonusEditor("raceBonusFields", "race", parseBonus(d.raceBonus));
    updateBonusSummaries();
    document.getElementById("modalRace").classList.remove("hide");
}

export function saveRaceModal() {
    d.race = document.getElementById("raceName").value.trim();
    const rb = readBonusEditor("race");
    d.raceBonus = hasBonusContent(rb) ? JSON.stringify(rb) : "";
    closeModal("modalRace");
    hpUpdate();
    save();
}

// ===== 其他修正弹窗（职业/血脉/灵根等：不成长的数值 + 小被动） =====
let extraDraft = [];

// 把当前 DOM 里未失焦的输入收回草稿，避免重渲染时丢编辑
function syncExtraDraftFromDOM() {
    extraDraft.forEach((m, i) => {
        const nameEl = document.getElementById("extraName" + i);
        if (nameEl) m.name = nameEl.value;
        const iconEl = document.getElementById("extraIcon" + i);
        if (iconEl) m.icon = iconEl.value;
        const noteEl = document.getElementById("extraNote" + i);
        if (noteEl) m.note = noteEl.value;
        const rb = readBonusEditor("extra" + i);
        m.bonus = hasBonusContent(rb) ? JSON.stringify(rb) : "";
    });
}

export function renderExtraMods() {
    const el = document.getElementById("extraModList");
    if (!el) return;
    if (!extraDraft.length) {
        el.innerHTML = '<div class="small" style="text-align:center;color:var(--muted)">暂无修正 · 点下方「＋ 添加修正」</div>';
        return;
    }
    el.innerHTML = extraDraft.map((m, i) => {
        const p = m.passive || {};
        return `
        <div class="extra-mod-card">
            <div class="extra-mod-head">
                <input type="text" id="extraIcon${i}" class="extra-mod-icon" value="${esc(m.icon || "✨")}" title="图标" onchange="setExtraField(${i},'icon',this.value)">
                <input type="text" id="extraName${i}" class="extra-mod-name" value="${esc(m.name)}" placeholder="名称（如：死灵法师）" onchange="setExtraField(${i},'name',this.value)">
                <label class="extra-mod-enabled"><input type="checkbox" ${m.enabled !== false ? "checked" : ""} onchange="toggleExtraMod(${i}, this.checked)"><span>启用</span></label>
                <span class="extra-mod-remove" onclick="removeExtraMod(${i})" title="删除">✖</span>
            </div>
            <input type="text" id="extraNote${i}" class="extra-mod-note" value="${esc(m.note || "")}" placeholder="备注（如：火系灵根 / 复合职业）" onchange="setExtraField(${i},'note',this.value)">
            <details class="cs-detail">
                <summary>数值加成（不随等级成长）</summary>
                <div id="extraBonus${i}">${bonusEditorHTML("extra" + i, parseBonus(m.bonus), { noPerLevel: true })}</div>
            </details>
            <details class="cs-detail extra-mod-passive">
                <summary>小被动</summary>
                <div class="bonus-form">
                    <div><label class="label">每回合回血</label><input type="number" value="${Number(p.hpPerRound) || 0}" min="${LIMITS.buffTick[0]}" max="${LIMITS.buffTick[1]}" onchange="setExtraPassive(${i},'hpPerRound',this.value)"></div>
                    <div><label class="label">每回合回蓝</label><input type="number" value="${Number(p.mpPerRound) || 0}" min="${LIMITS.buffTick[0]}" max="${LIMITS.buffTick[1]}" onchange="setExtraPassive(${i},'mpPerRound',this.value)"></div>
                    <div><label class="label">每回合自动攻击</label><label class="small"><input type="checkbox" ${p.autoAttack ? "checked" : ""} onchange="setExtraPassive(${i},'autoAttack',this.checked?1:0)"> 结算时打一下当前目标</label></div>
                    <div><label class="label">血量越低伤害越高（最高 +%）</label><input type="number" value="${Number(p.lowHpDamage) || 0}" min="0" max="500" onchange="setExtraPassive(${i},'lowHpDamage',this.value)"></div>
                    <div><label class="label">触发阈值（HP%）</label><input type="number" value="${Number(p.lowHpThreshold) || 50}" min="1" max="100" onchange="setExtraPassive(${i},'lowHpThreshold',this.value)"></div>
                    <div><label class="label">每 N 回合百分百闪避（0=关）</label><input type="number" value="${Number(p.dodgeEvery) || 0}" min="0" max="999" onchange="setExtraPassive(${i},'dodgeEvery',this.value)"></div>
                    <div><label class="label">每次放技能消耗生命（最大 HP %）</label><input type="number" value="${Number(p.skillHpPct) || 0}" min="0" max="100" onchange="setExtraPassive(${i},'skillHpPct',this.value)" title="烧血施法：每次发动技能固定扣最大生命的这个百分比，和技能本身的消耗叠加"></div>
                </div>
            </details>
        </div>`;
    }).join("");
}

export function openExtraModal() {
    extraDraft = (Array.isArray(d.extraMods) ? d.extraMods : []).map(m => JSON.parse(JSON.stringify(normalizeExtraMod(m))));
    renderExtraMods();
    document.getElementById("modalExtra").classList.remove("hide");
}

export function addExtraMod() {
    syncExtraDraftFromDOM();
    extraDraft.push(normalizeExtraMod({ name: "新修正" }));
    renderExtraMods();
}

export function removeExtraMod(idx) {
    if (!confirm("确定删除这条修正吗？")) return;
    syncExtraDraftFromDOM();
    extraDraft.splice(idx, 1);
    renderExtraMods();
}

export function toggleExtraMod(idx, on) {
    if (!extraDraft[idx]) return;
    extraDraft[idx].enabled = on === true || Number(on) === 1;
}

export function setExtraField(idx, field, value) {
    const m = extraDraft[idx];
    if (!m) return;
    if (field === "name") m.name = String(value || "").trim().slice(0, 40) || "其他修正";
    else if (field === "icon") m.icon = String(value || "").trim().slice(0, 4) || "✨";
    else if (field === "note") m.note = String(value || "").slice(0, 300);
}

export function setExtraPassive(idx, key, value) {
    const m = extraDraft[idx];
    if (!m) return;
    if (!m.passive) m.passive = {};
    if (key === "autoAttack") m.passive.autoAttack = Number(value) === 1;
    else if (key === "lowHpThreshold") m.passive.lowHpThreshold = clampNum(value, 1, 100, 50);
    else if (key === "lowHpDamage") m.passive.lowHpDamage = clampNum(value, 0, 500, 0);
    else if (key === "dodgeEvery") m.passive.dodgeEvery = clampInt(value, 0, 999, 0);
    else if (key === "skillHpPct") m.passive.skillHpPct = clampNum(value, 0, 100, 0);
    else m.passive[key] = clampInt(value, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
}

export function saveExtraModal() {
    syncExtraDraftFromDOM();
    d.extraMods = extraDraft.map(normalizeExtraMod);
    closeModal("modalExtra");
    hpUpdate();
    save();
}

// ===== 等级成长弹窗（里程碑制） =====
export function openLevelModal() {
    growthDraft = normalizeGrowth(d.levelGrowth).map(r => ({ level: r.level, pct: { ...r.pct } }));
    renderLevelTable();
    updateGrowthPreview();
    document.getElementById("modalLevel").classList.remove("hide");
}

export function addLevelRow() {
    const domRows = readLevelTable();
    if (domRows.length) growthDraft = domRows;
    const maxLvl = growthDraft.reduce((m, r) => Math.max(m, r.level), 0);
    growthDraft.push({ level: maxLvl + 1, pct: {} });
    renderLevelTable();
    updateGrowthPreview();
}

export function removeLevelRow(idx) {
    const domRows = readLevelTable();
    if (domRows.length) growthDraft = domRows;
    growthDraft.splice(idx, 1);
    renderLevelTable();
    updateGrowthPreview();
}

export function clearLevelRows() {
    growthDraft = [];
    renderLevelTable();
    updateGrowthPreview();
}

export function saveLevelModal() {
    const domRows = readLevelTable();
    d.levelGrowth = normalizeGrowth(domRows.length ? domRows : growthDraft);
    closeModal("modalLevel");
    hpUpdate();
    save();
}
