// === 角色管理：房间内玩家成员管理（房主专用） ===
// 只处理「当前房间里的玩家」：查看角色卡概要、接管编辑角色卡。
// 本机角色存档的增删改/导入导出已从本页移出，不再出现在这里。
import { esc } from "./util.js";
import { roomState, roomSession, roomIsGm, roomSnapshot, roomMyMemberId, roomFetchChar } from "./room.js";
import { roomUiEditMember, roomUiCharFromFetch } from "./room_ui.js";

const $ = (id) => document.getElementById(id);

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** 快照里的成员（含主机）；没有快照时为空 */
function membersList() {
    const snap = roomSnapshot();
    if (!snap || !Array.isArray(snap.members)) return [];
    return snap.members.filter(m => m && m.id);
}

/** 房间里的玩家：排除主机（role 与自身成员 id 双保险） */
function playerMembers() {
    const meId = String(roomMyMemberId() || "");
    return membersList().filter(m => {
        if (m.role === "gm") return false;
        if (meId && String(m.id) === meId) return false;
        return true;
    });
}

/** 成员摘要里的角色卡（服务端 makeChar 的瘦身版），没有就是 null */
function charOf(member) {
    const c = member && member.char;
    return (c && typeof c === "object") ? c : null;
}

function maxHpOf(data) {
    return num(data && (data.maxHp !== undefined ? data.maxHp : data.maxHpBase));
}

function maxMpOf(data) {
    return num(data && (data.maxMp !== undefined ? data.maxMp : data.maxMpBase));
}

function emptyHint() {
    if (!roomSnapshot() || !roomIsGm()) {
        return "先在主持人面板创建房间，玩家加入后会出现在这里";
    }
    return "还没有玩家加入，把房间码发给朋友";
}

/* ---------- 列表行 ---------- */
function memberRowHtml(member) {
    const data = charOf(member);
    const online = member.online !== false;
    const id = String(member.id);
    const name = String(member.name || "玩家");
    const charName = data && data.name ? String(data.name) : "";
    const level = data ? (num(data.level) || 1) : 0;
    const hp = data ? num(data.hp) : 0;
    const maxHp = maxHpOf(data);
    const mp = data ? num(data.mp) : 0;
    const maxMp = maxMpOf(data);
    const hasFull = member.hasFull === true;

    // 完整卡徽章：没上传角色卡时只说「未上传」，不叠第二枚徽章
    let badgeHtml = "";
    if (hasFull) badgeHtml = '<span class="cm-badge full">完整卡</span>';
    else if (charName) badgeHtml = '<span class="cm-badge plain">仅摘要</span>';

    const charHtml = charName
        ? `角色：${esc(charName)}`
        : '<span class="cm-none">未上传角色卡</span>';

    const title = `${name} · ${charName || "未上传角色卡"} · ${online ? "在线" : "离线"}`;

    const vitalsHtml = data
        ? `<span class="cm-lv">Lv ${level || 1}</span> · HP ${hp}/${maxHp} · MP ${mp}/${maxMp}`
        : '<span class="cm-none">暂无角色数据</span>';

    return `<div class="cm-row" title="${esc(title)}">
        <span class="cm-icon${online ? " on" : ""}" title="${online ? "在线" : "离线"}">●</span>
        <div class="cm-info">
            <div class="cm-name">${esc(name)}</div>
            <div class="cm-sub">${charHtml}${badgeHtml}</div>
        </div>
        <div class="cm-vitals">${vitalsHtml}</div>
        <div class="cm-actions">
            <button id="cmEditMember-${esc(id)}" class="small" onclick="cmEditMember('${esc(id)}')"
                title="拉取该玩家的完整角色卡并打开编辑">✏️ 编辑角色卡</button>
            <button id="cmViewMember-${esc(id)}" class="small" onclick="cmViewMember('${esc(id)}')"
                title="只读查看该玩家的角色卡概要">👁 查看</button>
        </div>
    </div>`;
}

/* ---------- 页面主渲染（幂等） ---------- */
export function renderCharManage() {
    const listEl = $("cmList");
    if (!listEl) return;
    const wrapEl = $("cmListWrap");
    const emptyEl = $("cmEmpty");
    const statsEl = $("cmStats");
    const roomEl = $("cmRoomLine");

    const snap = roomSnapshot();
    const session = roomSession();
    const inRoom = !!(snap && roomIsGm());
    const code = String((snap && snap.code) || (session && session.code) || "").toUpperCase();

    if (roomEl) {
        roomEl.textContent = inRoom ? `房间 ${code} 的玩家角色` : "还没有创建房间";
    }

    const players = inRoom ? playerMembers() : [];
    const onlineCount = players.filter(m => m.online !== false).length;
    if (statsEl) statsEl.textContent = `玩家 ${players.length} 名 · 在线 ${onlineCount} 名`;

    if (!players.length) {
        listEl.innerHTML = "";
        if (wrapEl) wrapEl.style.display = "none";
        if (emptyEl) {
            emptyEl.style.display = "";
            emptyEl.textContent = emptyHint();
        }
        return;
    }

    if (wrapEl) wrapEl.style.display = "";
    if (emptyEl) emptyEl.style.display = "none";
    listEl.innerHTML = players.map(memberRowHtml).join("");
}

/* ---------- 编辑：完全复用房间面板那一份实现（拉完整卡 → 存镜像 → 切角色卡视图） ---------- */
export async function cmEditMember(memberId) {
    const id = String(memberId || "");
    if (!id) return;
    const btn = $("cmEditMember-" + id);
    if (btn) { btn.disabled = true; btn.textContent = "读取中…"; }
    try {
        await roomUiEditMember(id);
    } finally {
        // 视图已切走也把按钮还原，回到本页时不会停在「读取中」
        if (btn && btn.isConnected) {
            btn.disabled = false;
            btn.textContent = "✏️ 编辑角色卡";
        }
    }
}

/* ---------- 查看：只读弹窗，展示角色卡概要 ---------- */
function barColor(c) {
    const v = String(c || "");
    return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ? v : "var(--blue)";
}

function viewRowHtml(k, v) {
    return `<div class="cm-view-row"><span class="cm-view-k">${k}</span><span class="cm-view-v">${v}</span></div>`;
}

function viewBarsHtml(data) {
    const bars = Array.isArray(data.customStats) ? data.customStats : [];
    if (!bars.length) return "";
    const rows = bars.map(cs => {
        const label = String((cs && cs.name) || "机制");
        const max = Math.max(1, num(cs && cs.max) || 1);
        const val = num(cs && cs.val);
        const pct = Math.max(0, Math.min(100, val / max * 100));
        return `<div class="cm-view-bar">
            <span class="cm-view-bar-name" title="${esc(label)}">${esc(label)}</span>
            <span class="cm-view-bar-track"><span style="width:${pct.toFixed(1)}%;background:${barColor(cs && cs.color)}"></span></span>
            <span class="cm-view-bar-val">${val}/${max}</span>
        </div>`;
    }).join("");
    return `<div class="cm-view-section">自定义条</div>${rows}`;
}

function viewBodyHtml(data, member) {
    const name = String(data.name || "无名");
    const icon = String(data.icon || "🧙");
    const level = num(data.level) || 1;
    const hp = num(data.hp);
    const mp = num(data.mp);
    const gold = num(data.gold);
    const items = Array.isArray(data.items) ? data.items.length : 0;
    const skills = Array.isArray(data.skills) ? data.skills.length : 0;
    const buffs = Array.isArray(data.buffs) ? data.buffs.length : 0;
    const cls = String(data.cls || data.job || "");

    const subParts = [];
    if (member) subParts.push(`玩家：${String(member.name || "玩家")}`);
    if (cls) subParts.push(`职业：${cls}`);
    const sub = subParts.join(" · ");

    return `<h3>👁 角色卡</h3>
    <div class="cm-view-top">
        <span class="cm-view-icon">${esc(icon)}</span>
        <div class="cm-view-head">
            <div class="cm-view-name">${esc(name)}</div>
            ${sub ? `<div class="cm-sub">${esc(sub)}</div>` : ""}
        </div>
    </div>
    <div class="cm-view-list">
        ${viewRowHtml("等级", `Lv ${level}`)}
        ${viewRowHtml("生命", `HP ${hp} / ${maxHpOf(data)}`)}
        ${viewRowHtml("法力", `MP ${mp} / ${maxMpOf(data)}`)}
        ${viewRowHtml("金币", `💰 ${gold}`)}
        ${viewRowHtml("物品", `🎒 ${items} 件`)}
        ${viewRowHtml("技能", `✨ ${skills} 个`)}
        ${viewRowHtml("状态", `🌀 ${buffs} 个`)}
    </div>
    ${viewBarsHtml(data)}`;
}

function openViewModal(data, member) {
    const wrap = $("modalCmView");
    const body = $("cmViewBody");
    if (!wrap || !body) return;
    body.innerHTML = viewBodyHtml(data, member);
    wrap.classList.remove("hide");
}

export async function cmViewMember(memberId) {
    const id = String(memberId || "");
    if (!id) return;
    const member = membersList().find(m => String(m.id) === id) || null;
    const btn = $("cmViewMember-" + id);
    if (btn) { btn.disabled = true; btn.textContent = "读取中…"; }
    try {
        const res = await roomFetchChar(id);
        const char = roomUiCharFromFetch(res);
        if (!char) {
            alert("读取角色卡失败：" + (roomState.error || "玩家还没有上传角色卡"));
            return;
        }
        openViewModal(char, member);
    } catch (e) {
        alert("读取角色卡失败：" + (roomState.error || String((e && e.message) || "玩家还没有上传角色卡")));
    } finally {
        if (btn && btn.isConnected) {
            btn.disabled = false;
            btn.textContent = "👁 查看";
        }
    }
}

/* ---------- 刷新：重新读一遍快照并闪一下统计栏做反馈 ---------- */
export function cmRefresh() {
    renderCharManage();
    const statsEl = $("cmStats");
    if (statsEl && statsEl.classList) {
        statsEl.classList.add("flash");
        setTimeout(() => statsEl.classList.remove("flash"), 700);
    }
}

// 挂到全局，供 index.html 与模块生成的内联 onclick 调用
Object.assign(globalThis, {
    renderCharManage, cmEditMember, cmViewMember, cmRefresh
});