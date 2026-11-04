// 局域网房间 UI 层：只负责 DOM 渲染与接线；传输层见 room.js
// 所有导出函数均挂到 globalThis，供 index.html 内 inline onclick 调用。
import { d } from "./state.js";
import { esc } from "./util.js";
import { closeModal } from "./modal_misc.js";
import { saveMirror } from "./mirror.js";
import { switchCharacter, loadRawChar } from "./persist.js";
import {
    roomState, roomSession, roomIsGm, roomSnapshot, roomMemberCount,
    roomCreate, roomJoin, roomLeave, roomNotice, roomFetchChar, roomClearPendingChar,
    roomApplyPendingChar, roomLocalCharId,
    roomSupported, roomHooks, roomBase, normalizeRoomBase, roomNeedsBase
} from "./room.js";

const $ = (id) => document.getElementById(id);

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function joined() {
    const s = roomSession();
    return !!s && !!s.code;
}

function codeText() {
    // 刷新后 roomState 可能还没重连，先退回本地会话里的房间码，避免页面显示空白
    const s = roomSession();
    return String(roomState.code || (s && s.code) || '').toUpperCase();
}

function membersList() {
    const s = roomSnapshot();
    if (!s || !Array.isArray(s.members)) return [];
    return s.members;
}

function meEntry() {
    const s = roomSnapshot();
    if (!s || !s.me) return null;
    return membersList().find(m => m.id === s.me.id) || null;
}

function recentNotices() {
    const n = roomState.notice || [];
    return n.slice().reverse().slice(0, 3);
}

function defaultName() {
    return (d && d.name) ? String(d.name) : '玩家';
}

/* ---------- 焦点保护：重建 innerHTML 时不打断正在输入的框 ---------- */
const FOCUS_IDS = ['roomJoinCode', 'roomJoinName', 'roomJoinBase', 'linkCreateName', 'linkCreateBase', 'linkJoinCode', 'linkJoinName', 'linkJoinBase', 'linkNotice'];
function captureFocus() {
    const ae = document.activeElement;
    if (!ae || !ae.id) return null;
    if (!FOCUS_IDS.includes(ae.id)) return null;
    return { id: ae.id, value: ae.value };
}
function restoreFocus(cap) {
    if (!cap) return;
    const el = $(cap.id);
    if (!el) return;
    if (cap.value !== '') {
        try { el.value = cap.value; } catch { /* ignore */ }
    }
    try { el.focus(); } catch { /* ignore */ }
}

/* ---------- 房间码大字 ---------- */
function roomCodeBig(id) {
    return `<span id="${id}" class="room-code-big">${esc(codeText())}</span>`;
}

/* ---------- 成员行 ---------- */
function memberRowHtml(m, canEdit = false) {
    const me = meEntry();
    const online = m.online !== false;
    const isGm = m.role === 'gm';
    const isMe = me && m.id === me.id;
    const char = m.char || {};
    const name = String(m.name || '');
    const roleLabel = isGm ? '主持人' : '玩家';
    const meMark = isMe ? ' （你）' : '';
    const charName = String(char.name || '-');
    const cls = String(char.cls || '');
    const clsPart = cls ? ` <span class="room-cls">${esc(cls)}</span>` : '';
    const hp = num(char.hp), maxHp = num(char.maxHp);
    const mp = num(char.mp), maxMp = num(char.maxMp);
    const title = `${name} · ${roleLabel} · ${charName} HP ${hp}/${maxHp} MP ${mp}/${maxMp}`;
    const btnId = `roomEditMember-${esc(m.id)}`;
    const editBtn = canEdit
        ? `<button id="${btnId}" class="small" onclick="roomUiEditMember('${esc(m.id)}')" title="编辑该玩家的完整角色卡">✏️ 编辑角色卡</button>`
        : '';
    return `
    <div class="room-member" title="${esc(title)}">
        <span class="room-dot" style="color:${online ? 'var(--green)' : 'var(--muted)'}" aria-label="${online ? '在线' : '离线'}">●</span>
        <span class="room-name" title="${esc(name)}">${esc(name)}${esc(meMark)}</span>
        <span class="room-role">${roleLabel}</span>
        <span class="room-char" title="${esc(charName)}">${esc(charName)}${clsPart}</span>
        <span class="room-vitals">HP ${hp}/${maxHp} · MP ${mp}/${maxMp}</span>
        ${editBtn}
    </div>`;
}

function membersHtml(canEdit = false) {
    const ms = membersList();
    if (!ms.length) return '<div class="room-empty">还没有人加入</div>';
    return ms.map(m => memberRowHtml(m, canEdit)).join('');
}

/* ---------- 公告 ---------- */
function noticeHtml(n) {
    const text = esc(String(n.text || ''));
    const from = esc(String(n.from || ''));
    let at = '';
    if (n.at) {
        try { at = new Date(Number(n.at)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { /* ignore */ }
    }
    return `
    <div class="room-notice">
        <span class="room-notice-from">${from}</span>
        <span class="room-notice-text">${text}</span>
        ${at ? `<span class="room-notice-at">${at}</span>` : ''}
    </div>`;
}

function noticesHtml() {
    const ns = recentNotices();
    if (!ns.length) return '<div class="room-empty">还没有公告</div>';
    return ns.map(n => noticeHtml(n)).join('');
}

/* ---------- 顶部按钮与状态条 ---------- */
export function renderRoomBtn() {
    const btn = $('roomBtn');
    if (!btn) return;
    btn.textContent = joined() ? `🛏 ${codeText()}` : '🚪 房间';
    btn.title = joined() ? '点击查看房间详情' : '加入局域网房间';
}

export function renderRoomBar() {
    const bar = $('roomBar');
    if (!bar) return;
    if (!joined()) {
        bar.classList.add('hide');
        return;
    }
    bar.classList.remove('hide');
    const codeDom = $('roomBarCode');
    const countDom = $('roomBarCount');
    const noticeDom = $('roomBarNotice');
    const noticeTextDom = $('roomBarNoticeText');
    if (codeDom) codeDom.textContent = codeText();
    if (countDom) countDom.textContent = roomMemberCount();
    const ns = recentNotices();
    if (noticeDom && noticeTextDom) {
        if (ns.length) {
            noticeTextDom.textContent = String(ns[0].text || '');
            noticeDom.classList.remove('hide');
        } else {
            noticeDom.classList.add('hide');
        }
    }
}

/* ---------- 弹窗：未加入 ---------- */
function renderJoinModal(inner) {
    const baseHint = roomNeedsBase()
        ? `<div class="small" style="color:var(--gold);margin-bottom:8px">当前没有服务器地址（可能是直接双击打开的本页），请填写主持人给的局域网地址</div>`
        : '';
    inner.innerHTML = `
    <h3>🚪 加入房间</h3>
    <div class="small" style="color:var(--muted);margin-bottom:10px">输入主持人给的房间码</div>
    ${baseHint}
    <div style="margin-bottom:8px">
        <label class="label">服务器地址</label>
        <input id="roomJoinBase" type="text" placeholder="http://192.168.x.x:8080（留空用当前页面）" value="${esc(roomBase())}">
    </div>
    <div style="margin-bottom:8px">
        <label class="label">房间码（6 位）</label>
        <input id="roomJoinCode" type="text" maxlength="6" placeholder="ABC123"
            oninput="this.value=this.value.toUpperCase()">
    </div>
    <div style="margin-bottom:8px">
        <label class="label">昵称</label>
        <input id="roomJoinName" type="text" placeholder="昵称" value="${esc(defaultName())}">
    </div>
    <div id="roomJoinMsg" class="small" style="color:var(--red);margin-bottom:8px;min-height:16px"></div>
    <div class="modal-buttons">
        <button onclick="closeModal('modalRoom')">取消</button>
        <button class="orange" onclick="roomUiJoin()">加入房间</button>
    </div>`;
}

/* ---------- 弹窗：已加入 ---------- */
function renderJoinedModal(inner) {
    const snap = roomSnapshot();
    const ms = membersList();
    const roomName = esc(String((snap && snap.name) || '')) || '未命名房间';
    inner.innerHTML = `
    <h3>🛏 房间详情</h3>
    <div style="margin-bottom:6px">
        <span class="label">房间名</span>
        <span id="modalRoomName" style="font-weight:bold;color:var(--gold)">${roomName}</span>
    </div>
    <div style="margin-bottom:10px">
        <span class="label">房间码</span>
        ${roomCodeBig('modalRoomCode')}
    </div>
    <div class="small" style="color:var(--muted);margin-bottom:8px">服务器：${esc(roomBase())}</div>
    <div style="margin-bottom:8px">
        <span class="small">在线 <span id="modalRoomOnline">${roomMemberCount()}</span> / 总 <span id="modalRoomTotal">${ms.length}</span></span>
    </div>
    <div style="margin-bottom:8px">
        <div class="small" style="color:var(--muted);margin-bottom:4px">成员列表</div>
        <div id="modalRoomMembers" class="room-member-list">${membersHtml(roomIsGm())}</div>
    </div>
    <div style="margin-bottom:10px">
        <div class="small" style="color:var(--muted);margin-bottom:4px">最近公告</div>
        <div id="modalRoomNotices" class="room-notice-list">${noticesHtml()}</div>
    </div>
    <div class="modal-buttons">
        <button onclick="closeModal('modalRoom')">关闭</button>
        <button class="danger" onclick="roomUiLeave()">离开房间</button>
    </div>`;
}

/* ---------- 弹窗：不支持 ---------- */
function renderUnsupportedModal(inner) {
    inner.innerHTML = `
    <h3>🚪 房间</h3>
    <div class="small" style="color:var(--muted);margin-bottom:14px;line-height:1.6">
        直接双击打开时需要填写服务器地址（如 <code style="color:var(--gold)">http://192.168.1.10:8080</code>），
        或先运行 <code style="color:var(--gold)">node room_server.mjs</code> 用局域网地址打开。
    </div>
    <div class="modal-buttons">
        <button onclick="closeModal('modalRoom')">关闭</button>
    </div>`;
}

export function renderRoomModal() {
    const m = $('modalRoom');
    if (!m) return;
    const inner = m.querySelector('.modal');
    if (!inner) return;
    if (!roomSupported()) {
        renderUnsupportedModal(inner);
        return;
    }
    if (joined()) renderJoinedModal(inner);
    else renderJoinModal(inner);
}

/* ---------- 🌐 联机管理面板（#linkRoomPanel，任何身份都可见） ---------- */
function baseHintHtml() {
    if (!roomNeedsBase()) return '';
    return '<div class="small link-hint warn">当前没有服务器地址（可能是直接双击打开的本页），请先填写主持人给的局域网地址。</div>';
}

function renderLinkNotJoined(inner) {
    inner.innerHTML = `
    <h2>🌐 联机管理</h2>
    <div class="small link-lead">在局域网里开一桌：已有房间码就从左边加入，没有房间就在右边创建一个。</div>
    ${baseHintHtml()}
    <div class="link-cols">
        <div class="link-section link-section-join">
            <div class="link-section-title">🚪 加入房间 · 玩家</div>
            <div class="small link-section-sub">已有房间码就加入：填房主给的局域网地址和 6 位房间码。</div>
            <div class="link-field">
                <label class="label" for="linkJoinBase">服务器地址</label>
                <input id="linkJoinBase" type="text" placeholder="http://192.168.x.x:8080（留空用当前页面）" value="${esc(roomBase())}" oninput="roomUiSyncBase(this.value,'join')">
            </div>
            <div class="link-field">
                <label class="label" for="linkJoinCode">房间码（6 位）</label>
                <input id="linkJoinCode" type="text" maxlength="6" placeholder="ABC123"
                    oninput="this.value=this.value.toUpperCase()">
            </div>
            <div class="link-field">
                <label class="label" for="linkJoinName">昵称</label>
                <input id="linkJoinName" type="text" placeholder="昵称" value="${esc(defaultName())}">
            </div>
            <div class="link-actions">
                <button class="orange" onclick="roomUiJoin('link')">加入房间</button>
            </div>
            <div id="linkJoinMsg" class="link-msg"></div>
        </div>
        <div class="link-section link-section-create">
            <div class="link-section-title">🛠 创建房间 · 成为房主</div>
            <div class="small link-section-sub">没有房间就创建，创建后你就是房主。</div>
            <div class="link-field">
                <label class="label" for="linkCreateBase">服务器地址</label>
                <input id="linkCreateBase" type="text" placeholder="http://192.168.x.x:8080（留空用当前页面）" value="${esc(roomBase())}" oninput="roomUiSyncBase(this.value,'create')">
            </div>
            <div class="link-field">
                <label class="label" for="linkCreateName">房间名</label>
                <input id="linkCreateName" type="text" value="我的房间">
            </div>
            <div class="link-actions">
                <button class="orange" onclick="roomUiCreate()">创建房间</button>
            </div>
            <div id="linkCreateMsg" class="link-msg"></div>
            <div class="small link-hint">创建后把房间码和局域网地址发给玩家。</div>
        </div>
    </div>`;
}

function renderLinkJoined(inner) {
    const snap = roomSnapshot();
    const session = roomSession();
    const ms = membersList();
    const gm = roomIsGm();
    const roomName = esc(String((snap && snap.name) || (session && session.roomName) || '')) || '未命名房间';
    const roleLabel = gm ? '👑 房主' : '🎮 玩家';
    const noticeBox = gm
        ? `<div class="link-notice-send">
            <input id="linkNotice" type="text" placeholder="输入公告内容，回车发送" aria-label="公告内容"
                onkeydown="if(event.key==='Enter'){event.preventDefault();roomUiSendNotice();}">
            <button class="small" onclick="roomUiSendNotice()">发送公告</button>
        </div>
        <div id="linkNoticeMsg" class="link-msg"></div>`
        : '<div class="small link-hint">只有房主可以发布公告</div>';
    inner.innerHTML = `
    <h2>🌐 联机管理</h2>
    <div class="link-room-head">
        <div class="link-room-name-wrap">
            <span class="label">房间名</span>
            <span class="link-room-name">${roomName}</span>
        </div>
        <span class="link-role${gm ? ' is-gm' : ''}">${roleLabel}</span>
    </div>
    <div class="link-code-box">
        <span class="label">房间码</span>
        <span id="linkRoomCode" class="room-code-big">${esc(codeText())}</span>
        <button class="small" onclick="roomUiCopyCode()">复制房间码</button>
    </div>
    <div class="link-meta">
        <span class="small">服务器：${esc(roomBase())}</span>
        <span class="small">在线 <b>${roomMemberCount()}</b> / 总 <b>${ms.length}</b></span>
        ${gm ? '<button class="small" onclick="switchView(\'manage\')">📋 角色管理</button>' : ''}
    </div>
    <div class="link-section">
        <div class="link-section-title">📢 公告</div>
        <div id="linkNotices" class="room-notice-list">${noticesHtml()}</div>
        ${noticeBox}
    </div>
    <div class="link-actions link-leave">
        <button class="small" id="roomResyncBtn" onclick="roomUiResync()">🔄 同步我的角色卡</button>
        <button class="danger" onclick="roomUiLeave()">${gm ? '解散房间' : '离开房间'}</button>
    </div>
    <div class="link-hint" id="linkResyncMsg"></div>`;
}

export function renderLinkPanel() {
    const panel = $('linkRoomPanel');
    if (!panel) return;
    if (joined()) renderLinkJoined(panel);
    else renderLinkNotJoined(panel);
}

/** 创建/加入两个地址框同步：一边改动，另一边跟着变 */
export function roomUiSyncBase(value, from) {
    const other = from === 'join' ? $('linkCreateBase') : $('linkJoinBase');
    if (other && other.value !== value) other.value = value;
}

/* ---------- 主持人页签可见性：始终可见；只读/可编辑由 applyGmReadOnly 控制 ---------- */
/* ---------- 「📋 角色管理」页签：默认隐藏，只有成为主机（房主）才显示 ---------- */
function applyGmAccess() {
    globalThis.applyGmReadOnly?.();
    const tab = document.getElementById("viewTabManage");
    const ok = globalThis.canUseCharManage?.() ?? false;
    if (tab) tab.style.display = ok ? "" : "none";
    // 失去主机身份（离开/解散房间）时，若正停在角色管理页，退回角色卡
    if (!ok && document.body.classList.contains("manage-mode") && typeof globalThis.switchView === "function") {
        globalThis.switchView("character");
    }
    applyGmPrivatePanels();
}

/* ---------- 主持人私有面板：玩家身份在房间里时整块隐藏 ---------- */
// 这些面板里的内容是「本地存档 + 主持人视角」的数据，玩家看到会误以为是房主的数据。
const GM_PRIVATE_IDS = ["gmCalcs", "gmBuffTarget", "gmBuffLib", "gmItemTarget", "gmBag", "gmGold", "gmPresetCount"];

function applyGmPrivatePanels() {
    const hide = !!roomSession() && !roomIsGm();
    GM_PRIVATE_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el || typeof el.closest !== "function") return;
        const panel = el.closest(".panel");
        if (!panel) return;
        panel.classList.toggle("gm-private-hidden", hide);
    });
}

/* ---------- 总入口（幂等） ---------- */
export function renderRoomUI() {
    // 主持人推送的卡若只有 HP/MP 变化，直接落盘（不打断战斗节奏）；其它字段仍走确认提示条
    autoApplyHpMpPending();
    const cap = captureFocus();
    renderRoomBtn();
    renderRoomBar();
    renderRoomModal();
    renderLinkPanel();
    renderMirrorBar();
    renderPendingBar();
    restoreFocus(cap);
    applyGmAccess();
    // 房间快照变化时，角色管理页（房主专用）跟着刷新
    if (document.body.classList.contains("manage-mode") && typeof globalThis.renderCharManage === "function") {
        globalThis.renderCharManage();
    }
    // 主持人面板的「队伍看板」也要跟着快照刷新：远端成员的角色名/等级/HP/MP 实时更新
    // 房主：先合并玩家上行来的行动/投骰，避免之后保存全量状态时把玩家条目冲掉。
    // 注意：合并不能只在主持人视图做——主机停在角色卡/联机管理页时，任何一次 saveGm() 的整包上行
    // 都会用本地面板状态覆盖服务端，把玩家刚提交的行动/投骰冲掉。
    const gmMode = document.body.classList.contains("gm-mode");
    if (roomIsGm()) globalThis.mergeRemoteGmState?.();
    // 房主：成员加入/离开后重画「派发 Buff / 背包金币 / 伤害计算器」的目标下拉，
    // 否则停在面板上时下拉里只会有本机角色（成员变化不会触发 renderGmPanel）。
    if (roomIsGm()) globalThis.refreshRemoteTargets?.();
    // 客机：不管停在哪一页都先应用主持人广播来的面板状态（回合/备注/行动/投骰/敌人/日志），
    // 否则玩家在「本回合行动」页提交时可能还拿着旧回合号。
    globalThis.applyRemoteGmState?.();
    if (gmMode) {
        globalThis.refreshGmParty?.();
        // 看板重建会生成新按钮，玩家端的只读禁用再套一遍（房主端这里什么都不做）
        globalThis.applyGmReadOnly?.();
    }
}

/* ---------- 打开/关闭弹窗 ---------- */
export function openRoomModal() {
    renderRoomUI();
    const m = $('modalRoom');
    if (m) m.classList.remove('hide');
}
export function closeRoomModal() {
    closeModal('modalRoom');
}

/* ---------- 操作 ---------- */
// source === 'link' 时读写「🌐 联机管理」页里的加入表单，否则读写顶部弹窗里的表单
export async function roomUiJoin(source) {
    const ids = source === 'link'
        ? { code: 'linkJoinCode', name: 'linkJoinName', base: 'linkJoinBase', msg: 'linkJoinMsg' }
        : { code: 'roomJoinCode', name: 'roomJoinName', base: 'roomJoinBase', msg: 'roomJoinMsg' };
    let codeEl = $(ids.code);
    let nameEl = $(ids.name);
    let baseEl = $(ids.base);
    let msgEl = $(ids.msg);
    const code = String(codeEl ? codeEl.value : '').trim();
    const name = String(nameEl ? nameEl.value : '').trim() || defaultName();
    const baseRaw = String(baseEl ? baseEl.value : '').trim();
    const base = normalizeRoomBase(baseRaw);
    if (baseRaw && !base) { if (msgEl) msgEl.textContent = '服务器地址格式不对'; return; }
    if (!code) { if (msgEl) msgEl.textContent = '请输入房间码'; return; }
    if (msgEl) msgEl.textContent = '';
    try {
        await roomJoin(code, name, base);
        closeModal('modalRoom');
        renderRoomUI();
    } catch (e) {
        // roomSetBase 可能触发过重渲染，重新取元素并把用户输入补回去
        codeEl = $(ids.code) || codeEl;
        nameEl = $(ids.name) || nameEl;
        baseEl = $(ids.base) || baseEl;
        if (codeEl) codeEl.value = code;
        if (nameEl) nameEl.value = name;
        if (baseEl) baseEl.value = baseRaw;
        const msg = $(ids.msg) || msgEl;
        if (msg) msg.textContent = String((e && e.message) || roomState.error || '加入失败');
    }
}

export async function roomUiCreate() {
    let nameEl = $('linkCreateName');
    let baseEl = $('linkCreateBase');
    let msgEl = $('linkCreateMsg');
    const name = String(nameEl ? nameEl.value : '').trim() || '我的房间';
    const baseRaw = String(baseEl ? baseEl.value : '').trim();
    const base = normalizeRoomBase(baseRaw);
    if (baseRaw && !base) { if (msgEl) msgEl.textContent = '服务器地址格式不对'; return; }
    if (msgEl) msgEl.textContent = '';
    try {
        await roomCreate(name, defaultName(), base);
        renderRoomUI();
    } catch (e) {
        nameEl = $('linkCreateName') || nameEl;
        baseEl = $('linkCreateBase') || baseEl;
        if (nameEl) nameEl.value = name;
        if (baseEl) baseEl.value = baseRaw;
        const msg = $('linkCreateMsg') || msgEl;
        if (msg) msg.textContent = String((e && e.message) || roomState.error || '创建失败');
    }
}

export async function roomUiLeave() {
    const gm = roomIsGm();
    const ok = confirm(gm ? '确定解散房间吗？所有成员将被断开连接。' : '确定离开房间吗？');
    if (!ok) return;
    try {
        await roomLeave();
        closeModal('modalRoom');
        renderRoomUI();
    } catch (e) {
        alert(String(e.message || '离开失败'));
    }
}

/** 手动补推当前角色卡：房间内别人看不到自己时点这个按钮 */
export async function roomUiResync() {
    const btn = document.getElementById("roomResyncBtn");
    const msg = document.getElementById("linkResyncMsg");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ 同步中…"; }
    try {
        const res = await (globalThis.resyncMyChar?.() || Promise.resolve({ ok: false, error: "同步不可用" }));
        if (msg) msg.textContent = res && res.ok
            ? `已上传角色卡：${(globalThis.d && globalThis.d.name) || "当前角色"}`
            : `上传失败：${(res && res.error) || "未知原因"}`;
    } catch (e) {
        if (msg) msg.textContent = "上传失败：" + (e && e.message ? e.message : "未知错误");
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "🔄 同步我的角色卡"; }
    }
}

export async function roomUiSendNotice() {
    const el = $('linkNotice');
    const msgEl = $('linkNoticeMsg');
    const text = String(el ? el.value : '').trim();
    if (!text) { if (msgEl) msgEl.textContent = '公告内容不能为空'; return; }
    if (msgEl) msgEl.textContent = '';
    try {
        await roomNotice(text);
        // roomNotice 会触发 fireChange 重建面板：重新取一次输入框再清空，避免公告发完还留在框里
        const cur = $('linkNotice');
        if (cur) cur.value = '';
        renderRoomUI();
    } catch (e) {
        const msg = $('linkNoticeMsg') || msgEl;
        if (msg) msg.textContent = String(e.message || '发送失败');
    }
}

export async function roomUiCopyCode() {
    const code = codeText();
    if (!code) return;
    try {
        await navigator.clipboard.writeText(code);
        const status = $('status');
        if (status) {
            const old = status.textContent;
            status.textContent = '✅ 房间码已复制';
            setTimeout(() => { status.textContent = old; }, 1500);
        }
    } catch {
        const el = $('linkRoomCode') || $('modalRoomCode');
        if (el) {
            try {
                const sel = window.getSelection();
                sel.removeAllRanges();
                const range = document.createRange();
                range.selectNodeContents(el);
                sel.addRange(range);
            } catch { /* ignore */ }
        }
        alert('已选中房间码，请手动复制（Ctrl+C）');
    }
}

/* ---------- 主持人编辑玩家角色卡（镜像） ---------- */

/** 点击成员行的「编辑角色卡」：拉取完整卡 → 存镜像 → 切到该角色卡页面 */
/** roomFetchChar 返回的就是角色卡本身；兼容服务端包一层的 {memberId,char} 形态 */
export function roomUiCharFromFetch(res) {
    if (!res || typeof res !== "object") return null;
    if ("char" in res) return (res.char && typeof res.char === "object") ? res.char : null;
    return Object.keys(res).length ? res : null;
}

export async function roomUiEditMember(memberId) {
    const btn = $(`roomEditMember-${esc(memberId)}`);
    const snap = roomSnapshot();
    const member = snap && Array.isArray(snap.members) ? snap.members.find(m => m.id === memberId) : null;

    // 读取中：禁用按钮、改文案
    if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }

    try {
        const res = await roomFetchChar(memberId);
        const char = roomUiCharFromFetch(res);
        if (!char) {
            alert("读取角色卡失败：" + (roomState.error || "玩家可能还没上传角色卡，让他先打开一次页面"));
            return;
        }
        const name = member ? String(member.name || '') : '';
        const session = roomSession();
        const mid = saveMirror(session ? session.code : '', memberId, name, char);
        if (!mid) {
            alert("读取角色卡失败：保存镜像失败");
            return;
        }
        switchCharacter(mid);
        globalThis.switchView("character");
        renderMirrorBar();
    } catch (e) {
        alert("读取角色卡失败：" + (roomState.error || String(e && e.message || "玩家可能还没上传")));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✏️ 编辑角色卡'; }
    }
}

/** 镜像编辑中提示条：d.remoteMirror 为真时显示 */
export function renderMirrorBar() {
    const bar = $('mirrorBar');
    const textDom = $('mirrorBarText');
    if (!bar) return;
    const show = !!(d && d.remoteMirror);
    if (!show) { bar.classList.add('hide'); return; }
    const remote = (d.remoteMirror && typeof d.remoteMirror === 'object') ? d.remoteMirror : null;
    const name = (remote && remote.name) ? String(remote.name) : (d && d.name ? String(d.name) : '玩家');
    if (textDom) textDom.textContent = `🎭 正在编辑玩家「${esc(name)}」的角色卡 · 保存后会自动同步给玩家`;
    bar.classList.remove('hide');
}

/* ---------- HP/MP 自动应用：主持人改数值不必让玩家点「应用」 ---------- */

/** 允许自动落盘的字段（只认当前数值，装备/技能/物品/等级/名字/状态等仍要玩家确认） */
const HP_MP_ONLY_KEYS = ["hp", "mp"];

/**
 * 主持人主动「派发」的字段：物品 / Buff / 金币（外加看板上的血蓝操作）。
 * 这些是礼包性质的单向修改，玩家不需要再手点「应用」；其余字段（技能/装备/名字/等级等）仍走确认。
 */
const AUTO_APPLY_KEYS = ["hp", "mp", "items", "buffs", "gold"];

/**
 * 比较差异时直接忽略的字段：这些不是玩家的真实存档字段，而是服务端回填的摘要/补丁。
 * 例如 `companions`：服务端 corePutChar 会把旧随从摘要塞回推送的卡里，而客机本地卡
 * 从不存这个摘要（本地恒为 []），若参与比较，任何一次推送都会「有变化」→ 白名单必然失配。
 */
const AUTO_IGNORE_KEYS = ["companions", "companionPatch"];

/**
 * 比较远端卡与本地卡的自有可枚举顶层字段，返回取值不同的 key 数组。
 * 数组/对象用 JSON.stringify 比较（值相同即不算不同）；远端或本地不是对象时按「全有变化」处理。
 * AUTO_IGNORE_KEYS 里的键先剔除（浅拷贝，不动入参）。
 */
function pendingChangedKeys(remote, local) {
    if (!remote || typeof remote !== "object") return [];
    if (!local || typeof local !== "object") return Object.keys(remote).filter(k => !AUTO_IGNORE_KEYS.includes(k));
    const r = { ...remote };
    const l = { ...local };
    AUTO_IGNORE_KEYS.forEach(k => { delete r[k]; delete l[k]; });
    const keys = new Set([...Object.keys(r), ...Object.keys(l)]);
    const out = [];
    for (const k of keys) {
        if (JSON.stringify(r[k]) !== JSON.stringify(l[k])) out.push(k);
    }
    return out;
}

/**
 * 判断远端卡与本地卡是否「只有 HP/MP 不同」。
 * 其它任何字段不一致（含远端缺字段 → undefined vs 值）都返回 false，走确认流程：
 * 宁可多问一次，也不要悄悄覆盖玩家的装备/技能/物品。
 */
export function pendingIsHpMpOnly(remote, local) {
    if (!remote || typeof remote !== "object" || !local || typeof local !== "object") return false;
    const keys = new Set([...Object.keys(remote), ...Object.keys(local)]);
    for (const k of keys) {
        if (HP_MP_ONLY_KEYS.includes(k)) continue;
        if (JSON.stringify(remote[k]) !== JSON.stringify(local[k])) return false;
    }
    const hpChanged = Number(remote.hp || 0) !== Number(local.hp || 0);
    const mpChanged = Number(remote.mp || 0) !== Number(local.mp || 0);
    return hpChanged || mpChanged;   // 必须有实际 HP/MP 变化才自动应用
}

/** 读本地角色卡原始存档；优先用全局桥接版（便于测试替换），退回模块导入版 */
function readLocalCharRaw(id) {
    const load = (typeof globalThis.loadRawChar === "function") ? globalThis.loadRawChar : loadRawChar;
    if (typeof load !== "function") return null;
    try { return load(id); } catch { return null; }
}

/**
 * 待应用卡是否可以不经玩家确认直接落盘。
 * 主判据是来源标记 mode：`"edit"` = 主持人手动编辑角色卡 → 需要玩家确认；
 * 其余（`"hp"` = 队伍看板上的受伤/治疗/结算等血蓝操作，或缺省）→ 直接应用。
 * 兜底：即使是 `"edit"`，只要变化字段全部落在白名单（hp/mp/items/buffs/gold）内，也直接应用
 * （主持人派发物品/Buff/金币、看板补血都不打扰玩家）；技能/装备/名字/等级等仍要玩家确认。
 */
export function autoApplyHpMpPending() {
    const p = roomState.pendingChar;
    if (!p || !roomSession() || roomIsGm()) return false;
    if (p.mode === "edit") {
        const local = readLocalCharRaw(roomLocalCharId());
        if (!local || typeof local !== "object") return false;
        const changed = pendingChangedKeys(p.char, local);
        // 没有任何实际变化（changed 为空）：不写盘、保留 pending，避免空广播把提示条吞掉
        if (changed.length === 0) return false;
        if (!changed.every(k => AUTO_APPLY_KEYS.includes(k))) return false;
    }
    let r = false;
    try { r = roomApplyPendingChar(); } catch { return false; }
    if (r === false) return false;
    // roomApplyPendingChar 是 async 的（内部无 await，写盘同步完成）：pending 被清掉即代表成功
    if (roomState.pendingChar !== null) return false;
    // 不弹 alert、不写 error 文案：角色页的 HP/MP 条会随存档重载自然刷新
    return true;
}

/** 待应用角色卡提示条：非 GM 且 roomState.pendingChar 存在时显示 */
export function renderPendingBar() {
    const bar = $('pendingBar');
    const textDom = $('pendingBarText');
    if (!bar) return;
    const show = !roomIsGm() && !!roomState.pendingChar;
    if (!show) { bar.classList.add('hide'); return; }
    const pending = roomState.pendingChar || {};
    const char = (pending.char && typeof pending.char === 'object') ? pending.char : {};
    const charName = char.name ? String(char.name) : '该角色';
    if (textDom) textDom.textContent = `📝 主持人修改了你的角色卡（角色：${esc(charName)}）`;
    bar.classList.remove('hide');
}

/** 玩家端：应用主持人推送的角色卡修改 */
export async function roomUiApplyPending() {
    const apply = globalThis.roomApplyPendingChar;
    if (typeof apply !== "function") {
        alert("应用失败：数据层函数未就绪");
        renderPendingBar();
        return;
    }
    let ok = false;
    try { ok = await apply(); } catch { ok = false; }
    if (ok) {
        alert("已应用");
    } else {
        alert("应用失败：没有找到对应的本地角色");
    }
    renderPendingBar();
    renderMirrorBar();
}

/** 玩家端：忽略待应用的角色卡修改 */
export function roomUiClearPending() {
    roomClearPendingChar();
    renderPendingBar();
}

/* ---------- 页面可见性兜底：从后台切回时刷新提示条显隐 ---------- */
if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === 'visible') {
            renderMirrorBar();
            renderPendingBar();
        }
    });
}
