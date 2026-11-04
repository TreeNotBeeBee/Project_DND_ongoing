import { LIMITS, clampNum } from "./limits.js";
import { nativeFields } from "./core.js";
import { d } from "./state.js";
import { loadCharList } from "./persist.js";
import { hpUpdate, renderCustomStats, renderCombatToggle, renderMpHidden } from "./stats_ui.js";
import { renderItems, syncItemBonusJson, applyItemBonusJson, updateBonusSummaries } from "./items_gear_ui.js";
import { renderSkills, renderBuffs } from "./skills_buffs.js";
import { renderCompanions } from "./companion_ui.js";
import { handleAvatarFile, updateGrowthPreview, save, renderAvatar } from "./modal_misc.js";
import { roomHooks, roomRestore } from "./room.js";
import { renderRoomUI } from "./room_ui.js";

export function fill() {
    nativeFields.forEach(k => {
        const dom = document.getElementById(k); if (dom) dom.value = d[k] ?? 0;
    });
    document.getElementById("storyNote").value = d.storyNote || "";
    renderAvatar();
    renderCombatToggle();
    renderMpHidden();
    hpUpdate();
}
export function renderAll() {
    renderItems(); renderSkills(); renderBuffs(); renderCustomStats(); renderCompanions();
}

export function init() {
    loadCharList();
    // 物品加成可视化表单：输入即同步 JSON；手动改 JSON 失焦后刷新表单
    const modalItem = document.getElementById("modalItem");
    modalItem.addEventListener("input", (ev) => {
        const t = ev.target;
        if (t.hasAttribute("data-bonus") || ["setName", "setPieces", "condType", "condValue"].includes(t.id)) {
            syncItemBonusJson();
        }
    });
    modalItem.addEventListener("change", (ev) => {
        if (ev.target.id === "itemBonus") applyItemBonusJson();
    });

    // 种族/Buff 弹窗：编辑加成时实时刷新折叠摘要
    ["modalRace", "modalBuff"].forEach(id => {
        const m = document.getElementById(id);
        if (m) m.addEventListener("input", (ev) => {
            const t = ev.target;
            if (t.hasAttribute && t.hasAttribute("data-bonus")) updateBonusSummaries();
        });
    });

    // 等级成长表：编辑时刷新预览（里程碑制，无模式切换）
    const modalLevel = document.getElementById("modalLevel");
    if (modalLevel) {
        const onLevelInput = (ev) => {
            const t = ev.target;
            if (t.getAttribute && t.getAttribute("data-lvlfield")) updateGrowthPreview();
        };
        modalLevel.addEventListener("input", onLevelInput);
        modalLevel.addEventListener("change", onLevelInput);
    }

    document.body.addEventListener("change", (ev) => {
        const t = ev.target;
        if (t.hasAttribute("data-statkey")) {
            const key = t.getAttribute("data-statkey");
            d[key] = clampNum(t.value, LIMITS.stat[0], LIMITS.stat[1], 0);
            if (String(t.value) !== String(d[key])) t.value = d[key];
            hpUpdate(); save();
        }
    });

    document.querySelectorAll("input,textarea,select").forEach(e => {
        if (e.id !== "file" && e.id !== "avatarFile" && e.id != "charSelect" && !e.hasAttribute("data-statkey") && !e.closest(".bonus-form")) {
            e.addEventListener("change", () => { hpUpdate(); save(); });
        }
    });
    const avatarFile = document.getElementById("avatarFile");
    if (avatarFile) avatarFile.addEventListener("change", handleAvatarFile);
    ["hp", "maxHpBase", "mp", "maxMpBase"].forEach(k => {
        document.getElementById(k).addEventListener("input", hpUpdate);
    });

    // 局域网房间 UI：首次渲染，并把 renderRoomUI 挂为 state 变更钩子
    renderRoomUI();
    roomHooks.onChange = renderRoomUI;

    // 刷新页面 / 重新打开后自动回到原房间（会话存在才会连）
    roomRestore().catch(() => { });
}
