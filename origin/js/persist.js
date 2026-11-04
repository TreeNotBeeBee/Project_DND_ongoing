import { LIMITS, nativeNumLimits, clampNum, clampInt, FINAL_MIN, FINAL_MAX } from "./limits.js";
import { charBase, nativeFields } from "./core.js";
import { d, charList, activeCharId, setD, setCharList, setActiveCharId } from "./state.js";
import { esc, makeId } from "./util.js";
import { normalizeGearSlots, cleanGearRefs } from "./bonus.js";
import { normalizeGrowth, computeSnapshotWithOwner } from "./compute.js";
import { computeCompanion } from "./companion.js";
import { normalizeItem, recalcGearBonus } from "./display.js";
import { sanitizeCharData } from "./sanitize.js";
import { fill, renderAll } from "./init.js";
import { renderCompanions } from "./companion_ui.js";
// room.js 只依赖 state.js，不会反向 import persist，因此这里没有循环依赖
import { roomPushCharTo, roomPushFullChar, roomIsGm, roomSession, roomSaveSession, roomStripMirrorFields } from "./room.js";

/** 镜像角色 id 前缀，与 mirror.js 的 mirrorCharId() 保持一致（此处内联避免 persist ⇄ mirror 循环） */
const MIRROR_PREFIX = "__gm_remote_";

/**
 * 上次成功推送的内容指纹：key 为角色 id（镜像卡用目标成员 id），value 为 JSON 字符串。
 * loadActiveCharacter 与 saveCurrentCharacter 都会调 syncRoomAfterSave，内容没变就不要再上传，
 * 否则「保存 → 上传 → 回声 → 重载 → 再上传」会无限循环。
 */
const lastPushedJson = new Map();

function fingerprint(data) {
    try { return JSON.stringify(data); } catch { return ""; }
}

/**
 * 主角名下随从的上行摘要（最多 30 条）：服务端只存摘要，主持人侧据此显示随从栏。
 * maxHp/maxMp 取 computeCompanion 的最终总值，算不出来时退回基础值。
 */
export function companionsSummary(ownerId) {
    const list = (charList || []).filter(m => m && m.type === "companion" && String(m.ownerId) === String(ownerId));
    return list.slice(0, 30).map(m => {
        const cd = (typeof loadRawChar === "function" ? loadRawChar(m.id) : null) || {};
        const cc = computeCompanion({ ...cd, ownerId: cd.ownerId || m.ownerId || "" });
        return {
            id: String(m.id).slice(0, 40),
            name: String(cd.name || m.name || "随从").slice(0, 40),
            icon: String(cd.icon || m.icon || "").slice(0, 16),
            level: Math.max(0, Math.round(Number(cd.level) || 0)),
            hp: Number(cd.hp) || 0,
            maxHp: Number(cc && (cc.maxHp ?? (cc.total && cc.total.maxHp))) || Number(cd.maxHpBase) || 0,
            mp: Number(cd.mp) || 0,
            maxMp: Number(cc && (cc.maxMp ?? (cc.total && cc.total.maxMp))) || Number(cd.maxMpBase) || 0,
            combat: cc ? cc.combat === true : cd.combat === true,
            mode: String(cd.mode || "").slice(0, 20),
            ownerId: String(m.ownerId || ownerId).slice(0, 40)
        };
    });
}

/**
 * 随从卡变化后立刻把「主人卡」重推给房间（参战开关 / 新建 / 删除 / 改血都走这里）。
 * 房间看板只认主角卡，随从是通过主人卡的 companions 摘要展示的，所以必须重推主人，
 * 否则主机/客机要等主角卡下次被保存才能看到随从变化。
 * companionData 既可以是随从卡对象（读它的 ownerId），也可以直接是 ownerId 字符串。
 * 内容没变（指纹相同）就不重复上行。
 */
export function pushOwnerWithCompanions(companionData) {
    const c = (companionData && typeof companionData === "object") ? companionData : { ownerId: companionData };
    const ownerId = String(c.ownerId || "");
    if (!ownerId) return false;
    // 只同步本机自己的主角：没有本地角色记录 / 是随从 / 是远端镜像卡都不推
    const ownerMeta = (charList || []).find(m => m && m.id === ownerId);
    if (!ownerMeta || ownerMeta.type === "companion" || ownerMeta.remoteMirror) return false;
    const s = roomSession();
    if (!s) return false; // 没进房间就不用上行
    const owner = loadRawChar(ownerId);
    if (!owner || typeof owner !== "object" || owner.ok === false) return false;
    const comps = companionsSummary(ownerId);
    // 与主角卡上行共用同一把指纹 key，随从摘要一起算进去，保证 combat/血量/增删能改变指纹
    const fp = fingerprint(owner) + "|" + JSON.stringify(comps);
    if (fp && lastPushedJson.get(ownerId) === fp) return false;
    lastPushedJson.set(ownerId, fp);
    roomPushFullChar(owner, comps);
    return true;
}

/**
 * 存盘后把完整角色卡同步到房间：
 * - 主持人正在编辑镜像角色 → 推回该成员头上；
 * - 任何人（含房主）保存自己的当前角色 → 推自己的完整卡；
 * - 保存随从卡 → 不冒名顶替主角，但会立刻重推它主人的卡（看板的随从栏即时刷新）。
 * 上行前要剥掉只属于本地镜像记录的 id / remoteMirror：否则玩家端会按镜像 id 落到错误的存档 key。
 * 失败只写 roomState.error，不打断存盘。
 */
function syncRoomAfterSave(data) {
    if (!data || typeof data !== "object") return false;
    // 随从卡不是「我的角色」：它不能顶替主角上报，否则新建随从后主机看到我变成随从。
    // 但随从变化必须立刻反映到主人的卡上（看板靠 companions 摘要显示随从）。
    if (data.type === "companion") {
        const ownerId = String(data.ownerId || "");
        const selfId = String(data.id || "");
        const activeId = String(activeCharId || "");
        // 仅当主人是当前激活角色，或正在查看这张随从卡本身（本机随从）时才代主人上行
        if (ownerId && (ownerId === activeId || selfId === activeId)) {
            try { pushOwnerWithCompanions(data); } catch (e) { }
        }
        return false;
    }
    const mirror = (data.remoteMirror && typeof data.remoteMirror === "object") ? data.remoteMirror : null;
    if (mirror) {
        // 镜像卡只有主持人能推回原主；玩家手里出现镜像卡属异常数据，不上传
        if (!roomIsGm()) return false;
        const target = String(mirror.memberId || "");
        if (!target) return false;
        const payload = roomStripMirrorFields(data, true);
        if (!payload) return false;
        // 镜像分支用自己的 key（目标成员 id），与玩家自己的卡分开去重
        const mirrorKey = "mirror:" + target;
        const mirrorFp = fingerprint(payload);
        if (mirrorFp && lastPushedJson.get(mirrorKey) === mirrorFp) return false;
        lastPushedJson.set(mirrorKey, mirrorFp);
        roomPushCharTo(target, payload, "edit");
        return true;
    }
    const id = String(data.id || activeCharId || "");
    if (!id || id !== activeCharId) return false; // 只同步当前角色，后台写别的卡不推
    if (id.startsWith(MIRROR_PREFIX)) return false; // 残留的镜像数据，不当成自己的卡
    const s = roomSession();
    if (!s) return false; // 没进房间就不用上行
    const comps = companionsSummary(id);
    // 内容没变就不重复上传（roomPushFullChar 是异步的，指纹在调用前同步写好，避免并发重复）
    // 随从列表变化（combat/血量/增删）也要触发上传，所以把随从摘要一起算进指纹
    const fp = fingerprint(data) + "|" + JSON.stringify(comps);
    if (fp && lastPushedJson.get(id) === fp) return false;
    lastPushedJson.set(id, fp);
    // 房主也要上传自己的卡，否则成员列表里房主一栏不会随改名/改血更新
    roomPushFullChar(data, comps); // roomPushFullChar 内部还会再剥一次 remoteMirror（幂等）
    return true;
}

export function page(id, b) {
    document.querySelectorAll(".page").forEach(x => x.classList.toggle("active", x.id === id));
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    if (b) b.classList.add("active");
}

// 头像只接受本地图片 dataURL 或 http(s) 图片地址，并限制体积，避免写满 localStorage
export function normalizeAvatar(v) {
    if (typeof v !== "string") return "";
    if (!/^(data:image\/|https?:\/\/)/i.test(v)) return "";
    if (v.length > 2000000) return "";
    return v;
}
export function saveCharListMeta() { localStorage.setItem("jigerpg_charlist_v04", JSON.stringify(charList)); }

// === 整包存档：角色列表 + 每个角色/随从的独立存档 ===
// 随从虽然独立建卡，但用 ownerId 记录归属；导出/导入时整包带走，导入后仍挂在主人名下
export function buildAccountPayload() {
    const characters = {};
    (charList || []).forEach(meta => {
        if (!meta || !meta.id) return;
        const data = loadRawChar(meta.id);
        if (data) characters[meta.id] = data;
    });
    return {
        format: "jigerpg-account",
        version: 1,
        exportedAt: new Date().toISOString(),
        activeId: activeCharId,
        charList: (charList || []).map(m => ({ ...m })),
        characters
    };
}

// 把一份角色数据规范化（旧版单角色存档与整包存档里的每个角色都走这里）
export function normalizeCharForImport(imported) {
    setD({ ...JSON.parse(JSON.stringify(charBase)), ...imported });
    d.avatar = normalizeAvatar(imported.avatar);
    d.race = String(imported.race || "");
    d.raceBonus = typeof imported.raceBonus === "string" ? imported.raceBonus : (imported.raceBonus ? JSON.stringify(imported.raceBonus) : "");
    d.levelMode = imported.levelMode === "single" ? "single" : "cumulative";
    d.levelGrowth = normalizeGrowth(imported.levelGrowth);
    d.gear = { ...charBase.gear, ...(imported.gear || {}) };
    d.gearSlots = normalizeGearSlots(imported.gearSlots);
    d.items = Array.isArray(imported.items) ? imported.items.slice(0, 5000).map(normalizeItem) : JSON.parse(JSON.stringify(charBase.items));
    d.skills = (Array.isArray(imported.skills) ? imported.skills.slice(0, 1000) : []).map(s => typeof s === "string" ? { name: s, desc: "" } : { name: "", desc: "", ...s });
    d.buffs = Array.isArray(imported.buffs) ? imported.buffs : [];
    d.customStats = Array.isArray(imported.customStats) ? imported.customStats.slice(0, 100).filter(cs => cs && typeof cs === "object") : [];
    d.quickConsumeSlots = (Array.isArray(imported.quickConsumeSlots) && imported.quickConsumeSlots.length === 6)
        ? imported.quickConsumeSlots.slice()
        : [null, null, null, null, null, null];
    sanitizeCharData();
    cleanGearRefs();
    d.quickConsumeSlots = d.quickConsumeSlots.map(n => (n && d.items.some(it => it.name === n && it.isConsume === 1)) ? n : null);
    return d;
}

// 导入整包存档：按角色 id 合并（同 id 覆盖），随从的 type/ownerId 原样恢复
export function importAccountPayload(payload) {
    const chars = (payload && payload.characters && typeof payload.characters === "object") ? payload.characters : {};
    const ids = Object.keys(chars).filter(id => chars[id] && typeof chars[id] === "object");
    if (!ids.length) throw new Error("empty account");
    const records = ids.map(key => {
        const raw = chars[key];
        const data = normalizeCharForImport(raw);
        const id = String(raw.id || key);
        data.id = id;
        data.type = raw.type === "companion" ? "companion" : "hero";
        if (data.type === "companion") data.ownerId = String(raw.ownerId || "");
        else delete data.ownerId;
        return { id, data };
    });
    const merged = (charList || []).slice();
    records.forEach(r => {
        const meta = { id: r.id, name: r.data.name || "无名", type: r.data.type };
        if (r.data.type === "companion") {
            meta.icon = r.data.icon || "🐾";
            meta.ownerId = r.data.ownerId;
        }
        const at = merged.findIndex(m => m && m.id === r.id);
        if (at >= 0) merged[at] = { ...merged[at], ...meta };
        else merged.push(meta);
    });
    // 至少保证有一个主角（随从不算），否则列表里全是附庸
    if (!merged.some(m => m && m.type !== "companion")) {
        const newId = makeId();
        merged.push({ id: newId, name: charBase.name, type: "hero" });
        try { localStorage.setItem("jigerpg_char_" + newId, JSON.stringify(charBase)); } catch (e) { }
    }
    setCharList(merged);
    records.forEach(r => saveRawChar(r.id, r.data));
    saveCharListMeta();
    const fallback = merged.find(m => m && m.type !== "companion") || merged[0];
    const wanted = (payload.activeId && merged.some(m => m && m.id === payload.activeId)) ? payload.activeId : fallback.id;
    setActiveCharId(wanted);
    loadActiveCharacter();
    return records.length;
}

// 读取任意角色/随从的原始存档（不切换当前角色）
export function loadRawChar(id) {
    if (!id) return null;
    try {
        const raw = localStorage.getItem("jigerpg_char_" + id);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return (data && typeof data === "object") ? data : null;
    } catch (e) { return null; }
}
// 写入任意角色/随从的原始存档，并同步角色列表里的显示名/图标
export function saveRawChar(id, data) {
    if (!id || !data || typeof data !== "object") return false;
    try {
        localStorage.setItem("jigerpg_char_" + id, JSON.stringify(data));
        const meta = charList.find(c => c && c.id === id);
        if (meta) {
            meta.name = data.name || meta.name || "无名";
            if (data.icon) meta.icon = data.icon;
            saveCharListMeta();
        }
        return true;
    } catch (e) { return false; }
}

// 主角形态（hpSync）与主角共用一个血条：把形态当前 HP 百分比写回主人
export function pushHpToOwner(charData) {
    if (!charData || charData.type !== "companion" || charData.mode !== "hero" || !charData.hpSync || !charData.ownerId) return false;
    const owner = loadRawChar(charData.ownerId);
    if (!owner || typeof owner !== "object") return false;
    const selfSnap = computeSnapshotWithOwner(JSON.parse(JSON.stringify({ ...charBase, ...charData })));
    const ownerSnap = computeSnapshotWithOwner(JSON.parse(JSON.stringify({ ...charBase, ...owner })));
    if (!selfSnap || !ownerSnap) return false;
    const selfMax = selfSnap.total.maxHp;
    const ownerMax = ownerSnap.total.maxHp;
    if (!(selfMax > 0) || !(ownerMax > 0)) return false;
    const pct = clampNum(charData.hp, 0, selfMax, 0) / selfMax;
    owner.hp = clampNum(Math.round(pct * ownerMax), 0, ownerMax, 0);
    return saveRawChar(charData.ownerId, owner);
}

// 旧存档把随从存在主角数据的 d.companions 里；这里把它们迁成独立角色记录
export function migrateHeroCompanions() {
    if (!Array.isArray(charList)) return;
    charList.filter(m => m && m.type !== "companion").forEach(meta => {
        if (!meta || !meta.id) return;
        const data = loadRawChar(meta.id);
        if (!data || !Array.isArray(data.companions) || data.companions.length === 0) return;
        const created = [];
        data.companions.forEach(c => {
            if (!c || typeof c !== "object") return;
            const cid = String(c.id || "") || makeId();
            if (charList.some(x => x && x.id === cid)) return;
            const full = {
                ...JSON.parse(JSON.stringify(charBase)),
                ...c,
                id: cid,
                type: "companion",
                ownerId: meta.id,
                name: String(c.name || "随从").trim().slice(0, 40) || "随从",
                icon: String(c.icon || "🐾").trim().slice(0, 4) || "🐾"
            };
            try {
                localStorage.setItem("jigerpg_char_" + cid, JSON.stringify(full));
            } catch (e) { return; }
            charList.push({ id: cid, name: full.name, icon: full.icon, type: "companion", ownerId: meta.id });
            created.push(cid);
        });
        if (created.length) {
            data.companions = [];
            try { localStorage.setItem("jigerpg_char_" + meta.id, JSON.stringify(data)); } catch (e) { }
        }
    });
}

// 兼容旧数据：随从不能再「拥有随从」，统一拍平到最终的主人（主角）名下
export function flattenCompanionOwners() {
    if (!Array.isArray(charList)) return;
    const byId = new Map(charList.filter(m => m && m.id).map(m => [m.id, m]));
    const firstHero = charList.find(m => m && m.type !== "companion");
    let changed = false;
    charList.forEach(meta => {
        if (!meta || meta.type !== "companion") return;
        let ownerId = meta.ownerId || "";
        let guard = 0;
        while (ownerId && guard++ < 20) {
            const owner = byId.get(ownerId);
            if (!owner) { ownerId = ""; break; }
            if (owner.type !== "companion") break;
            ownerId = owner.ownerId || "";
        }
        if (!ownerId && firstHero) ownerId = firstHero.id;
        if (ownerId !== (meta.ownerId || "")) { meta.ownerId = ownerId; changed = true; }
    });
    if (changed) saveCharListMeta();
}

//多角色
export function loadCharList() {
    const raw = localStorage.getItem("jigerpg_charlist_v04");
    let list;
    try { list = raw ? JSON.parse(raw) : []; } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    setCharList(list);
    migrateHeroCompanions();
    flattenCompanionOwners();
    // 至少保证有一个主角存在（随从不算）
    if (!charList.some(c => c && c.type !== "companion")) {
        const newId = makeId();
        charList.push({ id: newId, name: charBase.name, type: "hero" });
    }
    saveCharListMeta();
    renderCharSelect();
    if (!activeCharId || !charList.find(c => c.id === activeCharId)) setActiveCharId(charList[0].id);
    loadActiveCharacter();
}
// ==== 卡片式角色选择器：主角列表 + 可折叠的随从分组 ====
const expandedOwners = new Set();
let pickerListenerAttached = false;

function charRowHTML(meta, active, isCompanion, clickable = true) {
    return `<div class="char-row${active ? " active" : ""}${isCompanion ? " sub" : ""}"${clickable ? ` onclick="switchCharacter('${esc(meta.id)}')"` : ""}>
        <span class="char-row-icon">${isCompanion ? (meta.icon || "🐾") : "⚔"}</span>
        <span class="char-row-name">${esc(meta.name)}</span>
    </div>`;
}

// 一张「主人卡」：主人一行 + 折叠在卡内的随从，视觉上同属一张卡，角色记录仍是各自独立
// 展开/收起随从列表时阻止事件冒泡，避免触发「点击面板外收起」把角色选择窗一起关掉
function charCardHTML(owner, owned, activeId, clickable = true) {
    const open = expandedOwners.has(owner.id);
    const active = !!(owner && owner.id === activeId);
    return `<div class="char-card${active ? " active" : ""}">
        ${charRowHTML(owner, active, false, clickable)}
        ${owned.length ? `<div class="char-sub-toggle" onclick="event.stopPropagation();toggleCompanionGroup('${esc(owner.id)}')">
            <span class="char-caret">${open ? "▾" : "▸"}</span> 🐾 随从 <b>${owned.length}</b>
        </div>` : ""}
        ${open ? `<div class="char-sub">${owned.map(c => charRowHTML(c, c.id === activeId, true)).join("")}</div>` : ""}
    </div>`;
}

export function toggleCompanionGroup(ownerId) {
    if (expandedOwners.has(ownerId)) expandedOwners.delete(ownerId);
    else expandedOwners.add(ownerId);
    renderCharSelect();
}

export function toggleCharPicker() {
    const menu = document.getElementById("charPickerMenu");
    if (!menu) return;
    const show = menu.classList.contains("hide");
    renderCharSelect();
    menu.classList.toggle("hide", !show);
}

export function closeCharPicker() {
    const menu = document.getElementById("charPickerMenu");
    if (menu) menu.classList.add("hide");
}

export function switchCharacter(id) {
    if (!id) return;
    setActiveCharId(id);
    loadActiveCharacter();
    closeCharPicker();
    // 会话里的 localCharId 跟着当前角色走：否则远端物品/改血会落回切换前的旧卡
    const s = roomSession();
    if (s) roomSaveSession({ ...s, localCharId: String(id) });
}

/** 角色列表项是否是「主持人镜像卡」：它只能从房间成员行进入，不该出现在自己的角色选择器里 */
function isMirrorListItem(meta) {
    if (!meta || typeof meta !== "object") return false;
    if (meta.remoteMirror && typeof meta.remoteMirror === "object") return true;
    return String(meta.id || "").startsWith(MIRROR_PREFIX);
}

export function renderCharSelect() {
    const all = Array.isArray(charList) ? charList : [];
    // 镜像卡污染选择器：主持人会误把自己的角色切成别人的镜像卡
    const list = all.filter(c => c && !isMirrorListItem(c));
    const heroes = list.filter(c => c && c.type !== "companion");
    const companions = list.filter(c => c && c.type === "companion");

    // 隐藏的原生 select：保留分组选项，供其它逻辑读取当前值
    const sel = document.getElementById("charSelect");
    if (sel) {
        const parts = [];
        heroes.forEach(h => {
            parts.push(`<option value="${esc(h.id)}">${esc(h.name)}</option>`);
            const owned = companions.filter(c => c.ownerId === h.id);
            if (owned.length) {
                parts.push(`<optgroup label="🐾 ${esc(h.name)} 的随从 (${owned.length})">`);
                owned.forEach(c => parts.push(`<option value="${esc(c.id)}">${c.icon || "🐾"} ${esc(c.name)}</option>`));
                parts.push("</optgroup>");
            }
        });
        const orphans = companions.filter(c => !heroes.some(h => h.id === c.ownerId));
        if (orphans.length) {
            parts.push(`<optgroup label="🐾 无主随从 (${orphans.length})">`);
            orphans.forEach(c => parts.push(`<option value="${esc(c.id)}">${c.icon || "🐾"} ${esc(c.name)}</option>`));
            parts.push("</optgroup>");
        }
        sel.innerHTML = parts.join("");
        // activeCharId 可能是被过滤掉的镜像卡，别把隐藏 select 设成不存在的值
        sel.value = list.some(c => c && c.id === activeCharId)
            ? activeCharId
            : (heroes[0] ? heroes[0].id : (list[0] ? list[0].id : ""));
        sel.onchange = () => { setActiveCharId(sel.value); loadActiveCharacter(); };
    }

    // 可见的卡片式选择器：顶层只列主角，随从默认折叠
    const btn = document.getElementById("charPickerBtn");
    const menu = document.getElementById("charPickerMenu");
    if (!btn || !menu) return;
    const activeMeta = list.find(c => c && c.id === activeCharId) || heroes[0] || list[0] || null;
    if (activeMeta) {
        const owner = activeMeta.type === "companion" ? heroes.find(h => h.id === activeMeta.ownerId) : null;
        btn.innerHTML = `${activeMeta.type === "companion" ? (activeMeta.icon || "🐾") + " " : ""}${esc(activeMeta.name)}${owner ? ` <span class="char-picker-owner">· ${esc(owner.name)} 的随从</span>` : ""} <span class="char-picker-caret">▾</span>`;
    } else {
        btn.textContent = "选择角色 ▾";
    }

    const rows = [];
    heroes.forEach(h => {
        rows.push(charCardHTML(h, companions.filter(c => c.ownerId === h.id), activeCharId));
    });
    const orphans = companions.filter(c => !heroes.some(h => h.id === c.ownerId));
    if (orphans.length) {
        rows.push(charCardHTML({ id: "__orphans__", name: "无主随从", icon: "🐾" }, orphans, activeCharId, false));
    }
    menu.innerHTML = rows.join("");

    // 点击面板外收起（只挂一次）
    if (!pickerListenerAttached && typeof document !== "undefined" && document.addEventListener) {
        document.addEventListener("click", (ev) => {
            const p = document.getElementById("charPicker");
            if (!p) return;
            // 按钮/菜单重绘会让被点的子节点脱离文档，单看 ev.target 会误判成「点在外面」
            // composedPath 在事件派发时就已确定，重绘后依然能判断点击是否发生在选择器内
            const path = (typeof ev.composedPath === "function") ? ev.composedPath() : null;
            const inside = (path && path.length)
                ? path.indexOf(p) !== -1
                : (typeof p.contains === "function" && p.contains(ev.target));
            if (!inside) closeCharPicker();
        });
        pickerListenerAttached = true;
    }
}
export function loadActiveCharacter() {
    const meta = charList.find(x => x.id === activeCharId);
    if (!meta) return;
    const key = "jigerpg_char_" + activeCharId;
    const raw = localStorage.getItem(key);
    let data;
    try { data = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(charBase)); } catch (e) { data = JSON.parse(JSON.stringify(charBase)); }
    if (!data || typeof data !== "object") data = JSON.parse(JSON.stringify(charBase));
    setD({ ...JSON.parse(JSON.stringify(charBase)), ...data });
    d.avatar = normalizeAvatar(d.avatar);
    d.race = String(d.race || "");
    d.raceBonus = typeof d.raceBonus === "string" ? d.raceBonus : (d.raceBonus ? JSON.stringify(d.raceBonus) : "");
    d.levelMode = d.levelMode === "single" ? "single" : "cumulative";
    d.levelGrowth = normalizeGrowth(d.levelGrowth);
    d.gear = { ...charBase.gear, ...(d.gear || {}) };
    d.gearSlots = normalizeGearSlots(d.gearSlots);
    if (!Array.isArray(d.items)) d.items = JSON.parse(JSON.stringify(charBase.items));
    d.items = d.items.slice(0, 5000).map(normalizeItem);
    // 清理 gear 挪到这里
    cleanGearRefs();
    if (!Array.isArray(d.skills)) d.skills = [...charBase.skills];
    if (!Array.isArray(d.buffs)) d.buffs = [];
    if (!Array.isArray(d.quickConsumeSlots) || d.quickConsumeSlots.length !== 6) d.quickConsumeSlots = [null, null, null, null, null, null];
    if (!Array.isArray(d.customStats)) d.customStats = [];
    d.customStats = d.customStats.slice(0, 100).filter(cs => cs && typeof cs === "object");
    d.skills = d.skills.slice(0, 1000).map(s => typeof s === "string" ? { name: s, desc: "" } : { name: "", desc: "", ...s });
    // 主角形态：等级始终等同主角（以主人存档为准，避免各存各的等级）
    if (d.type === "companion" && d.mode === "hero" && d.ownerId) {
        const owner = loadRawChar(d.ownerId);
        if (owner) d.level = clampInt(owner.level, LIMITS.level[0], LIMITS.level[1], 1);
    }
    sanitizeCharData();
    fill();
    renderAll();
    meta.name = d.name || "无名";
    if (d.icon) meta.icon = d.icon;
    saveCharListMeta();
    renderCharSelect();
    // 房间同步：载入/切换角色后把当前卡推给房间，避免没点保存时别人看不到
    try { syncRoomAfterSave(d); } catch (e) { }
    // 角色卡里的「本回合行动」面板跟随当前角色刷新（gm_ui 在 bridge 里挂到全局）
    if (typeof globalThis.renderPlayerActionPanel === "function") {
        try { globalThis.renderPlayerActionPanel(); } catch (e) { }
    }
}
export function saveCurrentCharacter() {
    if (!activeCharId) return false;
    read(); recalcGearBonus();
    sanitizeCharData();
    const key = "jigerpg_char_" + activeCharId;
    try {
        localStorage.setItem(key, JSON.stringify(d));
    } catch (e) {
        alert("保存失败：本地存储空间不足。请换一张更小的头像，或清理不需要的角色。");
        return false;
    }
    const meta = charList.find(x => x.id === activeCharId);
    if (meta) {
        meta.name = d.name || "无名";
        meta.type = d.type === "companion" ? "companion" : "hero";
        meta.ownerId = d.type === "companion" ? (d.ownerId || "") : "";
        if (d.icon) meta.icon = d.icon;
        saveCharListMeta();
        renderCharSelect();
    }
    // 主角血量变化时，开了「血量百分比同步」的随从卡片要立刻跟着刷新
    if (d.type !== "companion") {
        try { renderCompanions(); } catch (e) { }
    }
    // 房间同步：主持人改镜像 → 推回成员；玩家改自己 → 推完整卡（失败不影响存盘）
    try { syncRoomAfterSave(d); } catch (e) { }
    return true;
}
export function newCharacter() {
    const newId = makeId();
    charList.push({ id: newId, name: "新角色", type: "hero" });
    saveCharListMeta();
    setActiveCharId(newId);
    setD(JSON.parse(JSON.stringify(charBase)));
    d.name = "新角色";
    d.type = "hero";
    d.ownerId = "";
    // 先把新角色模板写进界面，否则 saveCurrentCharacter() 里的 read() 会把旧角色的输入值写进新角色
    fill();
    saveCurrentCharacter();
    loadActiveCharacter();
}
// 新建随从：作为独立角色记录保存，归当前主角所有，并立刻打开它的总览
export function createCompanion() {
    const ownerId = (d && d.type === "companion") ? (d.ownerId || activeCharId || "") : (activeCharId || "");
    const id = makeId();
    const base = JSON.parse(JSON.stringify(charBase));
    const data = {
        ...base,
        id,
        type: "companion",
        ownerId,
        name: "新随从",
        icon: "🐾",
        species: "",
        desc: "",
        mode: "growth",
        combat: false,
        scale: 0.6,
        heroCoeff: 0.6,
        summonScale: false,
        hpSync: false,
        level: 1,
        hp: 20, maxHpBase: 20,
        mp: 10, maxMpBase: 10,
        strength: 10, dexterity: 10, constitution: 10,
        intelligence: 10, wisdom: 10, charisma: 10,
        gold: 0, armorBase: 0, speed: 30,
        items: [],
        gear: { ...charBase.gear },
        gearSlots: [],
        hiddenSlots: [],
        skills: [], buffs: [], buffLib: [],
        quickConsumeSlots: [null, null, null, null, null, null],
        customStats: [], companions: [], storyNote: ""
    };
    charList.push({ id, name: data.name, icon: data.icon, type: "companion", ownerId });
    saveCharListMeta();
    saveRawChar(id, data);
    // 新建随从：立刻把主人卡（带新随从摘要）推给房间看板
    try { pushOwnerWithCompanions(data); } catch (e) { }
    setActiveCharId(id);
    loadActiveCharacter();
    const tab = document.querySelector('.tab[onclick*="character"]');
    if (tab) page("character", tab);
    return id;
}
export function deleteCharacter() {
    const isCompanion = !!(d && d.type === "companion");
    if (!isCompanion && charList.filter(c => c.type !== "companion").length <= 1) {
        alert("至少保留一个角色！");
        return;
    }
    if (!confirm("确定删除此角色，数据不可恢复！")) return;
    // 删除主角时，一并删除它名下的随从
    const ownedIds = isCompanion ? [] : charList.filter(c => c.type === "companion" && c.ownerId === activeCharId).map(c => c.id);
    const companionOwnerId = isCompanion ? String(d.ownerId || "") : "";
    localStorage.removeItem("jigerpg_char_" + activeCharId);
    ownedIds.forEach(cid => localStorage.removeItem("jigerpg_char_" + cid));
    setCharList(charList.filter(c => c.id !== activeCharId && !ownedIds.includes(c.id)));
    saveCharListMeta();
    // 删除随从：立刻重推主人卡，看板随从栏马上少一条
    if (companionOwnerId) { try { pushOwnerWithCompanions(companionOwnerId); } catch (e) { } }
    setActiveCharId(charList[0].id);
    loadActiveCharacter();
}

export function read() {
    nativeFields.forEach(k => {
        const e = document.getElementById(k);
        if (!e) return;
        if (e.type === "number") {
            const lim = nativeNumLimits[k] || [FINAL_MIN, FINAL_MAX];
            d[k] = k === "level"
                ? clampInt(e.value, lim[0], lim[1], 1)
                : clampNum(e.value, lim[0], lim[1], 0);
            if (String(e.value) !== String(d[k])) e.value = d[k];
        } else {
            d[k] = e.value;
        }
    });
    d.storyNote = document.getElementById("storyNote").value || "";
    // 主角形态的等级永远跟着主角走，手改输入框也会被拉回
    if (d.type === "companion" && d.mode === "hero" && d.ownerId) {
        const owner = loadRawChar(d.ownerId);
        if (owner) {
            d.level = clampInt(owner.level, LIMITS.level[0], LIMITS.level[1], 1);
            const lvlEl = document.getElementById("level");
            if (lvlEl) lvlEl.value = d.level;
        }
    }
}

// 基础属性面板：合计值（大号）+ 原生输入框 + 分层公式
// 属性公式行：原生 ×等级档位 +固定 ×百分比 = 中间 ×种族% +种族固定 = 合计