import { LIMITS, FINAL_MIN, FINAL_MAX, clampNum, clampInt } from "./limits.js";
import { slots, catText, bonusKeys, bonusCn, resistKeys, resistCn } from "./core.js";
import { d, activeCharId } from "./state.js";
import { esc, makeId } from "./util.js";
import { recalcGearBonus, bonusSummary, hasBonusContent, defaultItemWeight, itemStackWeight, renderCarry, roundWeight } from "./display.js";
import { parseBonus, gearCats, normalizeHiddenSlots } from "./bonus.js";
import { read, saveCurrentCharacter, pushHpToOwner, loadRawChar, saveRawChar } from "./persist.js";
import { hpUpdate, renderCustomStats, syncCustomBarLinks } from "./stats_ui.js";
import { adjustCustomBar, itemBarText, barNameOf } from "./bar_link.js";
import { save, closeModal } from "./modal_misc.js";

//【重点】装备栏：内置栏可按角色隐藏；自定义栏可指定可穿戴分类（随从/坐骑也能按需定制，例：马不配盾牌栏）
export function renderGear() {
    const gearEl = document.getElementById("gear");
    if (!gearEl) return;
    const hidden = normalizeHiddenSlots(d.hiddenSlots);
    const builtin = Object.entries(slots).filter(([slotKey]) => !hidden.includes(slotKey)).map(([slotKey, slotMeta]) => {
        const optList = [`<option value="">-- 卸下 --</option>`];
        //筛选：物品category = 当前槽位key
        const fitItems = d.items.filter(it => it.category === slotKey);
        fitItems.forEach(x => {
            optList.push(`<option ${d.gear[slotKey] === x.name ? "selected" : ""} value="${esc(x.name)}">${esc(x.name)}</option>`);
        })
        return `<div class="slot">
    <span class="slot-del" onclick="hideBuiltinSlot('${slotKey}')" title="隐藏此内置装备栏">✖</span>
    <i>${slotMeta[0]}</i>
    <label>${slotMeta[1]}</label>
    <select onchange="d.gear['${slotKey}']=this.value;save();recalcGearBonus();hpUpdate();renderAll();">
        ${optList.join("")}
    </select>
</div>`
    }).join("");
    // 自定义装备栏（每栏自选可穿戴分类）
    const custom = (Array.isArray(d.gearSlots) ? d.gearSlots : []).map((gs, i) => {
        const cat = gs.cat || "special";
        const catOpts = gearCats.map(c => `<option value="${c}"${c === cat ? " selected" : ""}>${catText[c] || c}</option>`).join("");
        const optList = [`<option value="">-- 卸下 --</option>`];
        d.items.filter(it => it.category === cat).forEach(x => {
            optList.push(`<option ${d.gear[gs.id] === x.name ? "selected" : ""} value="${esc(x.name)}">${esc(x.name)}</option>`);
        });
        return `<div class="slot">
    <span class="slot-del" onclick="removeGearSlot(${i})" title="删除装备栏">✖</span>
    <i>${esc(gs.icon || "✨")}</i>
    <input type="text" class="slotname" value="${esc(gs.name)}" onchange="renameGearSlot(${i}, this.value)">
    <select class="slotcat" title="此栏可穿戴的物品分类" onchange="setGearSlotCat(${i}, this.value)">${catOpts}</select>
    <select onchange="d.gear['${esc(gs.id)}']=this.value;save();recalcGearBonus();hpUpdate();renderAll();">
        ${optList.join("")}
    </select>
</div>`;
    }).join("");
    gearEl.innerHTML = builtin + custom;
}

// 隐藏一个内置装备栏（例如马不需要盾牌/武器），已穿戴的自动卸下
export function hideBuiltinSlot(slotKey) {
    if (!slots[slotKey]) return;
    if (!Array.isArray(d.hiddenSlots)) d.hiddenSlots = [];
    if (!d.hiddenSlots.includes(slotKey)) d.hiddenSlots.push(slotKey);
    if (d.gear) d.gear[slotKey] = "";
    renderGear();
    recalcGearBonus();
    hpUpdate();
    save();
}

// 恢复全部内置装备栏
export function restoreBuiltinSlots() {
    d.hiddenSlots = [];
    renderGear();
    recalcGearBonus();
    hpUpdate();
    save();
}

// 修改自定义栏的可穿戴分类：分类变化后旧装备可能不再匹配，自动卸下
export function setGearSlotCat(idx, cat) {
    if (!Array.isArray(d.gearSlots) || !d.gearSlots[idx]) return;
    d.gearSlots[idx].cat = gearCats.includes(cat) ? cat : "special";
    if (d.gear) d.gear[d.gearSlots[idx].id] = "";
    renderGear();
    recalcGearBonus();
    hpUpdate();
    save();
}

export function addGearSlot() {
    if (!Array.isArray(d.gearSlots)) d.gearSlots = [];
    d.gearSlots.push({ id: "cs_" + makeId(), name: "自定义栏" + (d.gearSlots.length + 1), icon: "✨", cat: "special" });
    renderGear();
    save();
}

export function renameGearSlot(idx, name) {
    if (!Array.isArray(d.gearSlots) || !d.gearSlots[idx]) return;
    d.gearSlots[idx].name = String(name || "").trim() || "自定义栏";
    save();
}

export function removeGearSlot(idx) {
    if (!Array.isArray(d.gearSlots) || !d.gearSlots[idx]) return;
    if (!confirm("确定删除这个自定义装备栏吗？栏内已穿戴的装备会自动卸下。")) return;
    const gs = d.gearSlots[idx];
    d.gearSlots.splice(idx, 1);
    if (gs && gs.id) d.gear[gs.id] = "";
    renderGear();
    recalcGearBonus();
    hpUpdate();
    save();
}

export function renderItems() {
    const el = document.getElementById("items");
    if (!d.items.length) {
        el.innerHTML = '<div class="empty">背包是空的。</div>';
    } else {
        el.innerHTML = d.items.map((x, i) => {
            const w = itemStackWeight(x);
            const capPer = clampNum(x.containerCap, 0, LIMITS.weight[1], 0);
            const gearOnly = x.containerMode === "gear";
            const capB = capPer * (gearOnly ? 1 : clampInt(x.qty, LIMITS.qty[0], LIMITS.qty[1], 1));
            const barTxt = itemBarText(x);
            return `
<div class="item">
    <div class="itemtop">
        <span class="itemicon">${esc(x.icon || "📦")}</span>
        <span class="qty">×${esc(x.qty)}</span>
    </div>
    <div class="itemname">${esc(x.name)}</div>
    <div class="itemcat">【${esc(catText[x.category] || "杂物")}】${w > 0 ? `<span class="itemweight">⚖ ${roundWeight(w)} kg</span>` : ""}${capB > 0 ? `<span class="itemcap">🎒 +${roundWeight(capB)} kg${gearOnly ? "·需装备" : "·背包内"}</span>` : ""}${barTxt ? `<span class="itembar">🔋 ${esc(barTxt)}</span>` : ""}</div>
    <div class="itemdesc">${esc(x.desc || "")}</div>
    <div class="actions">
        <button onclick="openEditItemModal(${i})">编辑</button>
        ${x.isConsume === 1 ? `<button class="orange" onclick="useItemDirect(${i})">${x.useEffect ? "使用（选目标）" : "使用"}</button>` : ""}
        <button onclick="removeItem(${i})">丢弃</button>
    </div>
</div>`;
        }).join("");
    }
    renderCarry();
    renderGear();
    renderQuickConsume();
}

// 手动设置基础负重 / 力量加成上限（马车类随从可把基础负重填得很大）
export function setCarryBase(v) {
    d.carryBase = clampNum(v, 0, LIMITS.weight[1], 10);
    renderCarry();
    save();
}
export function setCarryStrCap(v) {
    d.carryStrCap = clampNum(v, 0, LIMITS.weight[1], 60);
    renderCarry();
    save();
}

export function renderQuickConsume() {
    if (!Array.isArray(d.quickConsumeSlots)) d.quickConsumeSlots = [null, null, null, null, null, null];
    // 先把 6 个快捷槽解析成 { idx, item }，两个容器共用同一套槽位下标（useQuickSlot 按槽位取物品）
    const slotsResolved = d.quickConsumeSlots.map((slotItemName, idx) => {
        if (!slotItemName) return { idx, item: null };
        const it = d.items.find(x => x.name === slotItemName);
        if (!it) {
            d.quickConsumeSlots[idx] = null;
            return { idx, item: null };
        }
        return { idx, item: it };
    });

    const bar = document.getElementById("quickConsumeBar");
    if (bar) {
        bar.innerHTML = slotsResolved.map(({ idx, item: it }) => {
            if (!it) {
                return `<div class="quick-slot" onclick="openQuickAssignModal(${idx})">
        <div class="small">空槽<br>点击分配消耗品</div>
    </div>`;
            }
            return `<div class="quick-slot has">
    <div onclick="useQuickSlot(${idx})" style="cursor:pointer">
        <div class="qi">${esc(it.icon)}</div>
        <div class="qn">${esc(it.name)}</div>
        <div class="qq">×${esc(it.qty)}</div>
    </div>
    <div onclick="event.stopPropagation();openQuickAssignModal(${idx})"
         style="font-size:9px;color:var(--gold);cursor:pointer;margin-top:2px">✎ 替换</div>
</div>`;
        }).join("");
    }

    // 「本回合行动」面板里的快捷消耗品条：只显示名字+数量，点一下直接使用（槽位下标与上面一致）
    const paBar = document.getElementById("paQuickConsume");
    if (!paBar) return;
    paBar.innerHTML = slotsResolved.map(({ idx, item: it }) => it
        ? `<span class="buff-chip pa-consume-chip" title="第 ${idx + 1} 个快捷槽 · 点击使用（剩 ${esc(it.qty)}）" onclick="useQuickSlot(${idx})">${esc(it.icon || "🧪")}${esc(it.name)}<b>×${esc(it.qty)}</b></span>`
        : `<span class="buff-chip pa-chip-empty" title="第 ${idx + 1} 个快捷槽 · 在背包页的快捷消耗栏里分配">未设置</span>`
    ).join("");
}

export function openQuickAssignModal(slotIdx) {
    document.getElementById("targetQuickSlotIdx").value = slotIdx;
    const sel = document.getElementById("quickItemSelect");
    const consumeList = d.items.filter(x => x.isConsume === 1 && x.qty > 0);
    sel.innerHTML = consumeList.map(it => `<option value="${esc(it.name)}">${esc(it.name)} ×${it.qty}</option>`).join("");
    document.getElementById("modalQuickAssign").classList.remove("hide");
}
export function confirmAssignQuickSlot() {
    const slotIdx = Number(document.getElementById("targetQuickSlotIdx").value);
    const selVal = document.getElementById("quickItemSelect").value;
    d.quickConsumeSlots[slotIdx] = selVal;
    closeModal("modalQuickAssign");
    renderQuickConsume(); save();
}
export function clearQuickSlot() {
    const slotIdx = Number(document.getElementById("targetQuickSlotIdx").value);
    d.quickConsumeSlots[slotIdx] = null;
    closeModal("modalQuickAssign");
    renderQuickConsume();
    save();
}
export function useQuickSlot(slotIdx) {
    const itemName = d.quickConsumeSlots[slotIdx];
    if (!itemName) return;
    const idx = d.items.findIndex(x => x.name === itemName);
    if (idx === -1) return;
    useItemDirect(idx);
    renderQuickConsume();
    save();
}
// 扣掉一个消耗品；数量归零时从背包移除并清理装备栏/快捷栏（useItemDirect 与 confirmItemUse 共用）
function consumeOne(idx) {
    const it = d.items[idx];
    if (!it) return;
    it.qty = clampInt(it.qty, LIMITS.qty[0], LIMITS.qty[1], 1) - 1;
    if (it.qty <= 0) {
        const name = it.name;
        d.items.splice(idx, 1);
        Object.keys(d.gear || {}).forEach(k => { if (d.gear[k] === name) d.gear[k] = ""; });
        d.quickConsumeSlots = (Array.isArray(d.quickConsumeSlots) ? d.quickConsumeSlots : []).map(n => n === name ? null : n);
    }
}

// ---------- 消耗品撤回账本 ----------
// 客户端「即时生效」的消耗品（老式自用 / 战斗中直接用）在提交行动时已经改了 HP/MP/背包，
// 主持人撤回行动时必须把这些改动回退；账本存 localStorage，跨刷新也能找回。
const REVERT_KEY = "jigerpg_item_revert";
const REVERT_KEEP = 30;

function revertLedgerLoad() {
    try {
        const raw = localStorage.getItem(REVERT_KEY);
        if (!raw) return {};
        const obj = JSON.parse(raw);
        return (obj && typeof obj === "object") ? obj : {};
    } catch (e) {
        return {};
    }
}

function revertLedgerSave(obj) {
    try {
        const src = (obj && typeof obj === "object") ? obj : {};
        const list = Object.keys(src)
            .map(k => [k, src[k]])
            .filter(([, v]) => v && typeof v === "object");
        // 只保留最近 30 条，避免账本无限增长
        list.sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0));
        const out = {};
        list.slice(0, REVERT_KEEP).forEach(([k, v]) => { out[k] = v; });
        localStorage.setItem(REVERT_KEY, JSON.stringify(out));
    } catch (e) { /* 账本写不进去不影响主流程 */ }
}

function recordItemRevert(actionId, entry) {
    const id = String(actionId || "");
    if (!id || !entry || typeof entry !== "object") return false;
    try {
        const led = revertLedgerLoad();
        led[id] = entry;
        revertLedgerSave(led);
        return true;
    } catch (e) {
        return false;
    }
}

// 快捷槽 6 项快照：applySelfUse 内部的 consumeOne 会把归零物品的槽位清空，必须提前取
function snapshotQuickSlots() {
    const arr = Array.isArray(d.quickConsumeSlots) ? d.quickConsumeSlots : [];
    return [0, 1, 2, 3, 4, 5].map(i => (arr[i] === undefined ? null : arr[i]));
}

function customBarVal(name) {
    if (!name) return null;
    const row = (Array.isArray(d.customStats) ? d.customStats : []).find(s => s && s.name === name);
    if (!row) return null;
    const v = Number(row.val);
    return Number.isFinite(v) ? v : 0;
}

// 撤回一次客户端已即时生效的消耗品：还物品、还 HP/MP、回退自定义条、恢复快捷槽
export function revertItemUse(actionId) {
    const id = String(actionId || "");
    if (!id) return false;
    const led = revertLedgerLoad();
    const entry = led[id];
    if (!entry || typeof entry !== "object") return false;
    read();
    // 账本按角色存：切错角色时不能把物品塞进别人背包
    if (String(d.id) !== String(entry.charId)) {
        alert("请先切回使用该物品的角色再撤回");
        return false;
    }
    // 回退 HP/MP（只退当时实际回复量，不会把伤害退成治疗）
    const snap = recalcGearBonus();
    const maxHp = Math.max(1, Number(snap && snap.total ? snap.total.maxHp : 0) || 0);
    const maxMp = Math.max(1, Number(snap && snap.total ? snap.total.maxMp : 0) || 0);
    d.hp = clampNum(d.hp - Math.max(0, Number(entry.hpGain) || 0), 0, maxHp, 0);
    d.mp = clampNum(d.mp - Math.max(0, Number(entry.mpGain) || 0), 0, maxMp, 0);
    // 回退自定义条：加过多少就减多少
    if (entry.bar && entry.bar.name) {
        adjustCustomBar(d, entry.bar.name, -Number(entry.bar.delta || 0));
    }
    // 返还物品：优先叠回同名同分类的现有项，没有就新建一条 qty=1
    const src = (entry.item && typeof entry.item === "object") ? entry.item : null;
    if (src && src.name) {
        const exist = d.items.find(x => x && x.name === src.name && x.category === src.category);
        if (exist) {
            const cur = clampInt(exist.qty, LIMITS.qty[0], LIMITS.qty[1], 1);
            exist.qty = clampInt(cur + 1, LIMITS.qty[0], LIMITS.qty[1], 1);
        } else {
            d.items.push({ ...JSON.parse(JSON.stringify(src)), qty: 1 });
        }
    }
    // 恢复快捷槽：只填空位，不覆盖玩家后来手动换上的物品
    if (Array.isArray(entry.slots)) {
        if (!Array.isArray(d.quickConsumeSlots)) d.quickConsumeSlots = [null, null, null, null, null, null];
        entry.slots.forEach((name, i) => {
            if (i >= 6 || !name) return;
            const cur = d.quickConsumeSlots[i];
            if (cur === null || cur === undefined || cur === "") d.quickConsumeSlots[i] = name;
        });
    }
    // 手刷 HP/MP 显示，避免 hpUpdate 里的 read() 覆盖
    document.getElementById("hp").value = d.hp;
    document.getElementById("hptext").textContent = `${d.hp} / ${maxHp}`;
    document.getElementById("hpfill").style.width = Math.min(100, d.hp / maxHp * 100) + "%";
    document.getElementById("mp").value = d.mp;
    document.getElementById("mptext").textContent = `${d.mp} / ${maxMp}`;
    document.getElementById("mpfill").style.width = Math.min(100, d.mp / maxMp * 100) + "%";
    renderItems();
    try { renderQuickConsume(); } catch (e) { }
    saveCurrentCharacter();
    try {
        delete led[id];
        revertLedgerSave(led);
    } catch (e) { /* ignore */ }
    return true;
}

// 老式「对自己即时生效」：回 HP/MP、联动自定义条、扣数量、刷新显示；返回本次实际回复量
function applySelfUse(itemIdx, it) {
    read();
    const snap = recalcGearBonus();
    const totalMaxHp = snap.total.maxHp;
    const totalMaxMp = snap.total.maxMp;
    const beforeHp = d.hp;
    const beforeMp = d.mp;
    d.hp = clampNum(d.hp + clampNum(it.healHp, LIMITS.heal[0], LIMITS.heal[1], 0), 0, totalMaxHp, 0);
    d.mp = clampNum(d.mp + clampNum(it.healMp, LIMITS.heal[0], LIMITS.heal[1], 0), 0, totalMaxMp, 0);
    const barRes = adjustCustomBar(d, it.barName, it.barDelta);
    consumeOne(itemIdx);
    // 手动刷新 HP/MP 显示，避免 hpUpdate 里的 read() 覆盖
    document.getElementById("hp").value = d.hp;
    document.getElementById("hptext").textContent = `${d.hp} / ${totalMaxHp}`;
    document.getElementById("hpfill").style.width = Math.min(100, d.hp / totalMaxHp * 100) + "%";
    document.getElementById("mp").value = d.mp;
    document.getElementById("mptext").textContent = `${d.mp} / ${totalMaxMp}`;
    document.getElementById("mpfill").style.width = Math.min(100, d.mp / totalMaxMp * 100) + "%";
    renderItems();
    if (barRes) {
        syncCustomBarLinks();
        renderCustomStats();
        const st = document.getElementById("status");
        if (st) st.textContent = `🔋 ${barRes.name} ${barRes.delta > 0 ? "+" : ""}${barRes.delta} → ${barRes.after}`;
    }
    // 主角形态开了「血量百分比同步」：吃药回血也写回主角
    if (d.type === "companion") pushHpToOwner(d);
    return { hpGain: Math.max(0, d.hp - beforeHp), mpGain: Math.max(0, d.mp - beforeMp) };
}

// 战斗中「对目标生效」物品的待确认状态：{ itemIdx, itemName, effect, amount, targets }
let itemUsePending = null;

export function closeItemUseModal() {
    itemUsePending = null;
    const m = document.getElementById("modalItemUse");
    if (m) {
        m.style.display = "none";
        m.classList.add("hide");
    }
}

export function useItemDirect(itemIdx) {
    const it = d.items[itemIdx];
    if (!it || it.isConsume !== 1 || it.qty < 1) { alert("该物品不能使用或数量不足"); return; }
    // 战斗中禁用消耗品：由房主（主持人面板）下发开关；单机/测试环境没有这个函数时按可用处理
    if (typeof globalThis.gmCanUseConsumable === "function" && globalThis.gmCanUseConsumable() === false) {
        alert("战斗中不能使用消耗品（房主已开启限制）");
        return;
    }
    const mode = (typeof globalThis.gmConsumableMode === "function") ? globalThis.gmConsumableMode() : "free";
    const inCombat = (typeof globalThis.gmUnitInCombat === "function") ? !!globalThis.gmUnitInCombat(d.id) : false;
    const effect = it.useEffect;
    const targeted = effect === "damage" || effect === "heal";
    // 战斗中按回合结算：本回合已经提交过行动时不允许再用
    if (inCombat && mode === "turn" && typeof globalThis.gmCanAct === "function" && globalThis.gmCanAct() === false) {
        alert("本回合已经提交过行动了，无法再使用消耗品");
        return;
    }
    // 扣数量后物品可能被 splice 出数组，名字先存下来
    const itemName = it.name;

    // ---------- 非战斗 ----------
    if (!inCombat) {
        if (targeted) { alert("战斗外没有可选目标，无法使用这类物品"); return; }
        applySelfUse(itemIdx, it);
        saveCurrentCharacter();
        return;
    }

    // ---------- 战斗中：老式「对自己即时生效」 ----------
    if (!targeted) {
        // 撤回账本：物品副本与快捷槽快照必须在 applySelfUse（内部 consumeOne 会清槽）之前取
        const itemCopy = JSON.parse(JSON.stringify(it));
        if (itemCopy && typeof itemCopy === "object") itemCopy.qty = 1;
        const slotsCopy = snapshotQuickSlots();
        const barKey = it.barName ? String(it.barName) : "";
        const beforeBar = barKey ? customBarVal(barKey) : null;
        const gain = applySelfUse(itemIdx, it);
        // 自定义条的实际变化量（可能是负数），为 0 时不记
        let bar = null;
        if (barKey) {
            const afterBar = customBarVal(barKey);
            if (beforeBar !== null && afterBar !== null) {
                const delta = afterBar - beforeBar;
                if (delta !== 0) bar = { name: barKey, delta };
            }
        }
        // 回合制下也要占掉本回合的行动
        if (mode === "turn") {
            const aid = globalThis.gmSubmitItemAction?.({
                type: "item",
                itemName,
                effect: "heal",
                amount: gain.hpGain + gain.mpGain,
                targetId: d.id,
                target: d.id,
                targetName: d.name,
                text: `使用 ${itemName}（自己）`,
                // 客户端已经即时生效，主持人结算时不要再加一次
                preApplied: true
            });
            recordItemRevert(aid, {
                item: itemCopy, hpGain: gain.hpGain, mpGain: gain.mpGain, bar,
                slots: slotsCopy, charId: d.id, charName: d.name, at: Date.now()
            });
        }
        saveCurrentCharacter();
        return;
    }

    // ---------- 战斗中：对目标生效（先选目标，确认后才扣数量） ----------
    const all = (typeof globalThis.gmActionTargets === "function") ? (globalThis.gmActionTargets() || []) : [];
    const targets = all.filter(t => t && (effect === "damage" ? t.kind === "enemy" : t.kind === "ally"));
    if (!targets.length) { alert("没有可选目标"); return; }
    const amount = clampInt(it.useAmount, 0, 999999, 0);
    itemUsePending = { itemIdx, itemName, effect, amount, targets };
    const sel = document.getElementById("itemUseTargetSel");
    if (sel) {
        sel.innerHTML = targets.map(t => {
            const hpTxt = (t.hp === undefined || t.hp === null)
                ? ""
                : `（${t.hp}/${(t.maxHp === undefined || t.maxHp === null) ? "?" : t.maxHp}）`;
            return `<option value="${esc(t.id)}">${esc(t.name)}${hpTxt}</option>`;
        }).join("");
    }
    const titleEl = document.getElementById("modalItemUseTitle");
    if (titleEl) titleEl.innerText = `使用 ${itemName}`;
    const infoEl = document.getElementById("itemUseInfo");
    if (infoEl) infoEl.innerText = `将对目标${effect === "damage" ? "造成" : "恢复"} ${amount}`;
    const modalEl = document.getElementById("modalItemUse");
    if (modalEl) {
        modalEl.classList.remove("hide");
        modalEl.style.display = "flex";
    }
}

export function confirmItemUse() {
    const p = itemUsePending;
    if (!p) { alert("没有待使用的物品"); return; }
    const sel = document.getElementById("itemUseTargetSel");
    const targetId = sel ? String(sel.value || "") : "";
    const t = p.targets.find(x => String(x.id) === targetId);
    if (!t) { alert("请选择有效目标"); closeItemUseModal(); return; }
    // 弹窗打开期间回合可能已经结束，提交前再校验一次
    if (typeof globalThis.gmCanAct === "function" && globalThis.gmCanAct() === false) {
        alert("本回合已经提交过行动了，无法再使用消耗品");
        closeItemUseModal();
        return;
    }
    // 期间背包可能变化：重新按「名字 + useEffect」定位
    const idx = d.items.findIndex(x => x && x.name === p.itemName && x.useEffect === p.effect);
    if (idx === -1 || d.items[idx].isConsume !== 1 || d.items[idx].qty < 1) {
        alert("物品已不存在或数量不足");
        closeItemUseModal();
        return;
    }
    // 撤回账本：物品副本与快捷槽快照必须在 consumeOne 之前取
    const itemCopy = JSON.parse(JSON.stringify(d.items[idx]));
    if (itemCopy && typeof itemCopy === "object") itemCopy.qty = 1;
    const slotsCopy = snapshotQuickSlots();
    consumeOne(idx);
    const aid = globalThis.gmSubmitItemAction?.({
        type: "item",
        itemName: p.itemName,
        effect: p.effect,
        amount: p.amount,
        targetId: t.id,
        target: t.id,
        targetName: t.name,
        text: `使用 ${p.itemName} → ${t.name}（${p.effect === "damage" ? "造成" : "恢复"} ${p.amount}）`
    });
    recordItemRevert(aid, {
        item: itemCopy, hpGain: 0, mpGain: 0, bar: null,
        slots: slotsCopy, charId: d.id, charName: d.name, at: Date.now()
    });
    renderItems();
    saveCurrentCharacter();
    closeItemUseModal();
}

// === 物品加成可视化编辑器（主加成/套装/条件/Buff 复用） ===
export function bonusEditorHTML(prefix, b, opts) {
    const flat = (b && b.flat) || {};
    const pct = (b && b.pct) || {};
    const resist = (b && b.resist) || {};
    const perLevel = (b && b.perLevel) || {};
    const perLevelPct = (b && b.perLevelPct) || {};
    const pctVal = v => { const n = Number(v) || 0; return Math.round(n * 1000) / 10; };
    // 某些场景（如“其他修正”职业被动）不提供每级成长，只留固定数值
    const showPer = !(opts && opts.noPerLevel);
    const perLevelFixedHTML = showPer ? `
        <label class="label" style="margin-top:4px;color:var(--accent)">每级固定（×当前等级）</label>
        <div class="small" style="color:var(--muted);margin:2px 0">例如填 1，等级5时自动获得 +5</div>
        <div class="bonus-form">
            ${bonusKeys.map(k => `<div><label class="label">${bonusCn[k]}</label><input type="number" data-bonus="${prefix}|perLevel|${k}" value="${Number(perLevel[k]) || 0}"></div>`).join("")}
        </div>` : "";
    const perLevelPctHTML = showPer ? `
        <label class="label" style="margin-top:4px;color:var(--accent)">每级百分比（% ×当前等级）</label>
        <div class="small" style="color:var(--muted);margin:2px 0">例如填 10，等级5时自动获得 +50%</div>
        <div class="bonus-form">
            ${bonusKeys.map(k => `<div><label class="label">${bonusCn[k]}</label><input type="number" step="0.1" data-bonus="${prefix}|perLevelPct|${k}" value="${pctVal(perLevelPct[k])}"></div>`).join("")}
        </div>` : "";
    return `
    <details class="bonus-section bonus-group">
        <summary>固定加成<span class="bonus-sum" id="sum2_${prefix}_flat"></span></summary>
        <label class="label" style="margin-top:4px">固定值（不随等级变化）</label>
        <div class="bonus-form">
            ${bonusKeys.map(k => `<div><label class="label">${bonusCn[k]}</label><input type="number" data-bonus="${prefix}|flat|${k}" value="${Number(flat[k]) || 0}"></div>`).join("")}
        </div>${perLevelFixedHTML}
    </details>
    <details class="bonus-section bonus-group">
        <summary>百分比加成<span class="bonus-sum" id="sum2_${prefix}_pct"></span></summary>
        <label class="label" style="margin-top:4px">百分比（不随等级变化，%）</label>
        <div class="bonus-form">
            ${bonusKeys.map(k => `<div><label class="label">${bonusCn[k]}</label><input type="number" data-bonus="${prefix}|pct|${k}" value="${pctVal(pct[k])}"></div>`).join("")}
        </div>${perLevelPctHTML}
    </details>
    <details class="bonus-section bonus-group">
        <summary>抗性（%）<span class="bonus-sum" id="sum2_${prefix}_resist"></span></summary>
        <div class="bonus-form">
            ${resistKeys.map(k => `<div><label class="label">${resistCn[k]}</label><input type="number" data-bonus="${prefix}|resist|${k}" value="${pctVal(resist[k])}"></div>`).join("")}
        </div>
    </details>`;
}

export function renderBonusEditor(containerId, prefix, b, opts) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = bonusEditorHTML(prefix, b || {}, opts);
}

export function readBonusEditor(prefix) {
    const out = { flat: {}, pct: {}, resist: {}, perLevel: {}, perLevelPct: {} };
    // 不用 CSS 属性选择器（管道符在部分浏览器有兼容问题），改遍历匹配
    const all = document.querySelectorAll("input[data-bonus]");
    for (let i = 0; i < all.length; i++) {
        const inp = all[i];
        const attr = inp.getAttribute && inp.getAttribute("data-bonus") || "";
        if (attr.indexOf(prefix + "|") !== 0) continue;
        const parts = attr.split("|");
        const layer = parts[1], key = parts[2];
        let raw = clampNum(inp.value, FINAL_MIN, FINAL_MAX, 0);
        if (layer === "pct" || layer === "perLevelPct") {
            raw = clampNum(raw, LIMITS.bonusPct[0] * 100, LIMITS.bonusPct[1] * 100, 0);
        } else if (layer === "resist") {
            raw = clampNum(raw, LIMITS.bonusResist[0] * 100, LIMITS.bonusResist[1] * 100, 0);
        } else if (layer === "flat") {
            raw = clampNum(raw, LIMITS.bonusFlat[0], LIMITS.bonusFlat[1], 0);
        } else if (layer === "perLevel") {
            raw = clampNum(raw, LIMITS.bonusPerLevel[0], LIMITS.bonusPerLevel[1], 0);
        }
        let v = raw;
        if (layer === "pct" || layer === "resist" || layer === "perLevelPct") v = v / 100;
        if (v !== 0 && layer && key && out[layer]) out[layer][key] = v;
    }
    return out;
}

export function collectItemBonus() {
    const main = readBonusEditor("itemMain");
    const set = readBonusEditor("itemSet");
    const cond = readBonusEditor("itemCond");
    const obj = { flat: main.flat, pct: main.pct, resist: main.resist, perLevel: main.perLevel, perLevelPct: main.perLevelPct };
    const setName = document.getElementById("setName").value.trim();
    if (setName) {
        obj.set = {
            name: setName,
            pieces: clampInt(document.getElementById("setPieces").value, 0, 999, 0),
            flat: set.flat, pct: set.pct, resist: set.resist
        };
    }
    const condType = document.getElementById("condType").value;
    if (condType) {
        obj.condition = {
            type: condType,
            value: document.getElementById("condValue").value.trim().slice(0, 100),
            flat: cond.flat, pct: cond.pct, resist: cond.resist
        };
    }
    return obj;
}

export function updateBonusSummaries() {
    const gv = id => {
        const e = document.getElementById(id);
        return (e && e.value != null) ? String(e.value) : "";
    };
    const setTxt = (id, txt) => {
        const e = document.getElementById(id);
        if (e) e.textContent = txt ? " · " + txt : " · 未设置";
    };
    // 组内摘要：固定组（固定+每级固定）/ 百分比组（百分比+每级百分比）/ 抗性组
    const updInner = (prefix, b) => {
        setTxt("sum2_" + prefix + "_flat", bonusSummary({ flat: b.flat, perLevel: b.perLevel }));
        setTxt("sum2_" + prefix + "_pct", bonusSummary({ pct: b.pct, perLevelPct: b.perLevelPct }));
        setTxt("sum2_" + prefix + "_resist", bonusSummary({ resist: b.resist }));
    };
    const bMain = readBonusEditor("itemMain");
    setTxt("sumItemMain", bonusSummary(bMain));
    updInner("itemMain", bMain);

    const bSet = readBonusEditor("itemSet");
    const setNm = gv("setName").trim();
    const setPc = clampInt(gv("setPieces"), 0, 999, 0);
    const setSum = bonusSummary(bSet);
    {
        const e = document.getElementById("sumItemSet");
        if (e) e.textContent = setNm ? ` · ${setNm}(${setPc}件)${setSum ? "：" + setSum : ""}` : " · 未设置";
    }
    updInner("itemSet", bSet);

    const bCond = readBonusEditor("itemCond");
    const ct = gv("condType"), cv = gv("condValue").trim();
    const condMap = { hpBelow: "HP低于" + cv + "%", hpAbove: "HP高于" + cv + "%", enemyType: "敌人=" + cv };
    const condSum = bonusSummary(bCond);
    {
        const e = document.getElementById("sumItemCond");
        if (e) e.textContent = ct ? ` · ${condMap[ct] || ct}${condSum ? "：" + condSum : ""}` : " · 未设置";
    }
    updInner("itemCond", bCond);

    const bBuff = readBonusEditor("buff");
    setTxt("sumBuff", bonusSummary(bBuff));
    updInner("buff", bBuff);

    const bRace = readBonusEditor("race");
    setTxt("sumRace", bonusSummary(bRace));
    updInner("race", bRace);
}

export function syncItemBonusJson() {
    const obj = collectItemBonus();
    const meaningful = hasBonusContent({
        ...obj,
        set: obj.set || { name: "", pieces: 0 },
        condition: obj.condition || { type: "" }
    });
    document.getElementById("itemBonus").value = meaningful ? JSON.stringify(obj) : "";
    updateBonusSummaries();
}

export function fillItemBonusForm(b) {
    const n = parseBonus(b);
    renderBonusEditor("itemBonusMain", "itemMain", n);
    renderBonusEditor("itemBonusSet", "itemSet", n.set);
    renderBonusEditor("itemBonusCond", "itemCond", n.condition);
    document.getElementById("setName").value = n.set.name || "";
    document.getElementById("setPieces").value = n.set.pieces || 2;
    document.getElementById("condType").value = n.condition.type || "";
    document.getElementById("condValue").value = n.condition.value ?? "";
    updateBonusSummaries();
}

export function applyItemBonusJson() {
    fillItemBonusForm(document.getElementById("itemBonus").value.trim());
}

// 主持人给其他角色发物品时，复用同一个「添加物品」弹窗：临时记住目标存档
let itemModalTargetId = "";
let itemModalOnSaved = null;
// 主持人给远端玩家发物品时，目标卡不来自本地存档，而是主持人拉取的完整卡
let itemModalRemoteData = null;

function fillItemBarOptions(data) {
    const list = document.getElementById("gmBarOptions");
    if (!list) return;
    const bars = (data && Array.isArray(data.customStats)) ? data.customStats : [];
    list.innerHTML = bars.map(cs => `<option value="${esc(barNameOf(cs.name))}"></option>`).join("");
}

// 联动「战斗中使用效果 → 目标类型」。
// change 事件会传入 evt（强制按效果推荐目标）；打开弹窗回填时无参数，
// 只在「无 useEffect」时同步 target，避免覆盖已保存的目标类型。
export function syncItemUseFields(evt) {
    const effEl = document.getElementById("itemUseEffect");
    const tgtEl = document.getElementById("itemUseTarget");
    if (!effEl || !tgtEl) return;
    const eff = effEl.value;
    const force = !!evt;
    if (eff === "damage") {
        if (force) tgtEl.value = "enemy";
    } else if (eff === "heal") {
        if (force) tgtEl.value = "ally";
    } else {
        tgtEl.value = "self";
    }
}

if (typeof document !== "undefined") {
    document.getElementById("itemUseEffect")?.addEventListener("change", syncItemUseFields);
}

export function openAddItemModal() {
    itemModalTargetId = "";
    itemModalOnSaved = null;
    document.getElementById("editItemIndex").value = "-1";
    document.getElementById("modalItemTitle").innerText = "添加物品";
    document.getElementById("itemName").value = "";
    document.getElementById("itemCategory").value = "misc";
    document.getElementById("itemQty").value = 1;
    document.getElementById("itemWeight").value = defaultItemWeight("misc");
    document.getElementById("itemContainerCap").value = 0;
    document.getElementById("itemContainerMode").value = "bag";
    document.getElementById("itemIcon").value = "📦";
    document.getElementById("itemDesc").value = "";
    document.getElementById("itemIsConsume").value = "0";
    document.getElementById("consumeHealHp").value = 0;
    document.getElementById("consumeHealMp").value = 0;
    const barNameEl = document.getElementById("consumeBarName");
    if (barNameEl) barNameEl.value = "";
    const barDeltaEl = document.getElementById("consumeBarDelta");
    if (barDeltaEl) barDeltaEl.value = 0;
    const useEffectEl = document.getElementById("itemUseEffect");
    if (useEffectEl) useEffectEl.value = "";
    const useTargetEl = document.getElementById("itemUseTarget");
    if (useTargetEl) useTargetEl.value = "self";
    const useAmountEl = document.getElementById("itemUseAmount");
    if (useAmountEl) useAmountEl.value = 0;
    fillItemBarOptions(d);
    document.getElementById("itemBonus").value = "";
    fillItemBonusForm("");
    // 「存入预设库」只对主持人发物品有意义，普通新增时隐藏
    const presetRow = document.getElementById("itemPresetRow");
    if (presetRow) presetRow.style.display = "none";
    const presetChk = document.getElementById("itemSaveToPreset");
    if (presetChk) presetChk.checked = false;
    syncItemUseFields();
    document.getElementById("modalItem").classList.remove("hide");
}
export function openEditItemModal(idx) {
    itemModalTargetId = "";
    itemModalOnSaved = null;
    const presetRowEdit = document.getElementById("itemPresetRow");
    if (presetRowEdit) presetRowEdit.style.display = "none";
    const x = d.items[idx];
    document.getElementById("editItemIndex").value = String(idx);
    document.getElementById("modalItemTitle").innerText = "编辑物品";
    document.getElementById("itemName").value = x.name || "";
    document.getElementById("itemCategory").value = x.category || "misc";
    document.getElementById("itemQty").value = x.qty || 1;
    document.getElementById("itemWeight").value = (x.weight === undefined || x.weight === null)
        ? defaultItemWeight(x.category || "misc") : x.weight;
    document.getElementById("itemContainerCap").value = x.containerCap || 0;
    document.getElementById("itemContainerMode").value = x.containerMode === "gear" ? "gear" : "bag";
    document.getElementById("itemIcon").value = x.icon || "📦";
    document.getElementById("itemDesc").value = x.desc || "";
    document.getElementById("itemIsConsume").value = x.isConsume || 0;
    document.getElementById("consumeHealHp").value = x.healHp || 0;
    document.getElementById("consumeHealMp").value = x.healMp || 0;
    const barNameEl = document.getElementById("consumeBarName");
    if (barNameEl) barNameEl.value = barNameOf(x.barName);
    const barDeltaEl = document.getElementById("consumeBarDelta");
    if (barDeltaEl) barDeltaEl.value = clampInt(x.barDelta, LIMITS.customVal[0], LIMITS.customVal[1], 0);
    const useEffectEl = document.getElementById("itemUseEffect");
    if (useEffectEl) useEffectEl.value = x.useEffect || "";
    const useTargetEl = document.getElementById("itemUseTarget");
    if (useTargetEl) useTargetEl.value = x.useTarget || "self";
    const useAmountEl = document.getElementById("itemUseAmount");
    if (useAmountEl) useAmountEl.value = x.useAmount || 0;
    fillItemBarOptions(d);
    document.getElementById("itemBonus").value = x.bonus || "";
    fillItemBonusForm(x.bonus || "");
    syncItemUseFields();
    document.getElementById("modalItem").classList.remove("hide");
}

// 主持人发放物品：打开同一个「添加物品」弹窗，保存时写进目标角色的存档
export function openGmItemModal(targetId, onSaved, opts) {
    const id = String(targetId || "");
    const remote = !!(opts && opts.remote);
    const data = remote ? (opts.data || null) : (id ? loadRawChar(id) : null);
    if (!data) { alert("目标角色不存在"); return; }
    openAddItemModal();
    itemModalTargetId = id;
    itemModalRemoteData = remote ? data : null;
    itemModalOnSaved = (typeof onSaved === "function") ? onSaved : null;
    fillItemBarOptions(data);
    // 主持人发物品默认勾上「存入预设库」（商人反复卖同一种药水）
    const presetRow = document.getElementById("itemPresetRow");
    if (presetRow) presetRow.style.display = "";
    const presetChk = document.getElementById("itemSaveToPreset");
    if (presetChk) presetChk.checked = true;
    const titleEl = document.getElementById("modalItemTitle");
    if (titleEl) titleEl.innerText = `给 ${data.name || "角色"} 添加物品`;
}
export function saveItemModal() {
    const idx = Number(document.getElementById("editItemIndex").value);
    const name = document.getElementById("itemName").value.trim();
    const category = document.getElementById("itemCategory").value;
    const qty = clampInt(document.getElementById("itemQty").value, LIMITS.qty[0], LIMITS.qty[1], 1);
    const wRaw = document.getElementById("itemWeight").value;
    const weight = (String(wRaw == null ? "" : wRaw).trim() === "")
        ? defaultItemWeight(category)
        : clampNum(wRaw, LIMITS.weight[0], LIMITS.weight[1], defaultItemWeight(category));
    const containerCap = clampNum(document.getElementById("itemContainerCap").value, 0, LIMITS.weight[1], 0);
    const containerMode = document.getElementById("itemContainerMode").value === "gear" ? "gear" : "bag";
    const icon = document.getElementById("itemIcon").value.trim() || "📦";
    const desc = document.getElementById("itemDesc").value.trim();
    const isConsume = Number(document.getElementById("itemIsConsume").value);
    const healHp = clampNum(document.getElementById("consumeHealHp").value, LIMITS.heal[0], LIMITS.heal[1], 0);
    const healMp = clampNum(document.getElementById("consumeHealMp").value, LIMITS.heal[0], LIMITS.heal[1], 0);
    const barNameEl = document.getElementById("consumeBarName");
    const barName = barNameOf(barNameEl ? barNameEl.value : "");
    const barDeltaEl = document.getElementById("consumeBarDelta");
    const barDelta = barName
        ? clampInt(barDeltaEl ? barDeltaEl.value : 0, LIMITS.customVal[0], LIMITS.customVal[1], 0)
        : 0;
    let bonusRaw = document.getElementById("itemBonus").value.trim();

    const useEffectEl = document.getElementById("itemUseEffect");
    const useEff = (useEffectEl && (useEffectEl.value === "damage" || useEffectEl.value === "heal"))
        ? useEffectEl.value : "";
    const useTargetEl = document.getElementById("itemUseTarget");
    const useTarget = (useTargetEl && (useTargetEl.value === "enemy" || useTargetEl.value === "ally"))
        ? useTargetEl.value : "self";
    const useAmountEl = document.getElementById("itemUseAmount");
    const useAmount = clampInt(useAmountEl ? useAmountEl.value : 0, 0, 999999, 0);

    if (!name) { alert("物品名称不能为空"); return; }
    if (!bonusRaw) {
        const obj = collectItemBonus();
        if (hasBonusContent({
            ...obj,
            set: obj.set || { name: "", pieces: 0 },
            condition: obj.condition || { type: "" }
        })) bonusRaw = JSON.stringify(obj);
    }
    if (bonusRaw) {
        try { JSON.parse(bonusRaw); } catch (e) { alert("装备加成JSON格式错误！"); return; }
    }

    const obj = { category, name, qty, weight, containerCap, containerMode, icon, desc, isConsume, healHp, healMp, barName, barDelta, useEffect: useEff, useTarget, useAmount, bonus: bonusRaw };

    // 主持人发物品时可顺便把这一件存进预设库
    const presetChk = document.getElementById("itemSaveToPreset");
    const saveToPreset = !!(itemModalTargetId && presetChk && presetChk.checked);

    // 主持人发放时目标是别人的存档：直接写进去，不动当前玩家的 d
    // 远端玩家：数据是主持人拉取的完整卡，保存后由回调推回房间，不写本地存档
    const remoteData = itemModalRemoteData;
    const isRemoteTarget = !!remoteData;
    const isActive = !isRemoteTarget && (!itemModalTargetId || itemModalTargetId === activeCharId);
    const target = isRemoteTarget
        ? remoteData
        : (itemModalTargetId ? (isActive ? d : loadRawChar(itemModalTargetId)) : d);
    if (!target || typeof target !== "object") { alert("目标角色不存在"); return; }
    if (!Array.isArray(target.items)) target.items = [];
    if (idx === -1) {
        target.items.push(obj);
    } else {
        target.items[idx] = obj;
    }
    const onSaved = itemModalOnSaved;
    const savedTargetId = itemModalTargetId;
    itemModalTargetId = "";
    itemModalOnSaved = null;
    itemModalRemoteData = null;
    closeModal("modalItem");
    if (isRemoteTarget) {
        // 远端目标：本地不落盘，交给主持人侧回调推回房间
        if (onSaved) { try { onSaved(obj, target, saveToPreset); } catch (e) { } }
        return;
    }
    if (savedTargetId && !isActive) {
        saveRawChar(savedTargetId, target);
    } else {
        renderItems();
        recalcGearBonus(); hpUpdate();
        save();
    }
    if (onSaved) { try { onSaved(obj, target, saveToPreset); } catch (e) { } }
}

export function removeItem(i) {
    if (!confirm(`确定丢弃 ${d.items[i].name}？`)) return;
    const n = d.items[i].name;
    d.items.splice(i, 1);
    Object.keys(d.gear).forEach(k => { if (d.gear[k] === n) d.gear[k] = ""; });
    d.quickConsumeSlots = d.quickConsumeSlots.map(x => x === n ? null : x);
    renderItems(); recalcGearBonus(); hpUpdate(); save();
}
