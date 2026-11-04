// 局域网房间的浏览器传输层：只负责与 room_server.mjs 通信并维护状态，
// 不写任何 DOM。UI 层读取 roomState / roomSnapshot() 后自行渲染。
import { d, charList, activeCharId } from "./state.js";
import { mirrorCharId, saveMirror } from "./mirror.js";

const ROOM_STORE = "jigerpg_room_v1";
/** 上次填写的服务器地址（file:// 双击打开时靠它连局域网服务端） */
const BASE_STORE = "jigerpg_room_base_v1";
const NOTICE_LIMIT = 50;

/** 房间状态：status = idle | connecting | online | error */
export const roomState = {
    code: "",
    snapshot: null,
    status: "idle",
    error: "",
    notice: [],
    /** 玩家待确认的远端角色卡：{ by, char, at }；收到主持人推送后由 UI 提示确认 */
    pendingChar: null
};

/** UI 刷新钩子：由 room_ui.js 的 renderRoomUI 挂载，state 变更后调用 */
export const roomHooks = { onChange: null };

function fireChange() {
    if (roomHooks.onChange) roomHooks.onChange();
}

/* ---------------- WebSocket 传输层状态 ---------------- */
let ws = null;
let wsSeq = 0;
const wsPending = new Map();
let wsRetry = 0;
let wsTimer = 0;
let wsManualClose = false;
/** roomRestore 等「5 秒内是否收到 4001」的等待者 */
let wsGoneWaiters = [];
let wsGone = false;
/** 等连接就绪的等待者（建/进房后立刻推角色卡用） */
let wsOnlineWaiters = [];

function hasLocation() {
    return typeof location !== "undefined" && !!location;
}

/** 当前页面的 http(s) origin；file:// 等环境下返回空串 */
function locOrigin() {
    return hasLocation() && /^https?:$/.test(location.protocol) ? location.origin : "";
}

/** 规整服务器地址：留空 → 当前页面地址；无协议自动补 http://；非法返回 "" */
export function normalizeRoomBase(v) {
    let s = String(v || "").trim();
    if (!s) return locOrigin();
    // 明确写了别的协议（ftp://、ws:// 等）直接拒绝，别把它当主机名补 http://
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return "";
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    try {
        const u = new URL(s);
        if (u.protocol !== "http:" && u.protocol !== "https:") return "";
        let path = u.pathname.replace(/\/+$/, "");
        // 允许直接粘贴页面网址（.../JigeRPG.html）：去掉末尾的页面文件名，只保留服务器根路径
        if (/\/[^/]+\.html?$/i.test(path)) path = path.slice(0, path.lastIndexOf("/"));
        return (u.origin + path).replace(/\/+$/, "");
    } catch {
        return "";
    }
}

/** 当前使用的服务器地址：会话记录 → 上次填写 → 当前页面 */
export function roomBase() {
    const s = roomSession();
    if (s && s.base) {
        const b = normalizeRoomBase(s.base);
        if (b) return b;
    }
    try {
        const v = normalizeRoomBase(localStorage.getItem(BASE_STORE));
        if (v) return v;
    } catch { /* ignore */ }
    return locOrigin();
}

/** 记住服务器地址并刷新 UI，返回规整后的值 */
export function roomSetBase(v) {
    const b = normalizeRoomBase(v);
    let prev = "";
    try { prev = localStorage.getItem(BASE_STORE) || ""; } catch { /* ignore */ }
    try { localStorage.setItem(BASE_STORE, b); } catch { /* ignore */ }
    if (prev !== b) fireChange();
    return b;
}

/** 没有可用的服务器地址（file:// 且从未填过）时需要用户手填 */
export function roomNeedsBase() {
    return !roomBase();
}

/** 浏览器是否支持房间：fetch 与 WebSocket 缺一不可（传输层走 WS，file:// 下允许手填服务器地址） */
export function roomSupported() {
    return typeof fetch !== "undefined" && typeof WebSocket !== "undefined";
}

/* ---------------- 会话存储：按标签页隔离 ---------------- */
/**
 * 房间会话存 sessionStorage：每个标签页独立，刷新/前进后退仍在，关掉标签页即离开。
 * 这样同一浏览器可以一边当主持人、一边当玩家，互不覆盖身份。
 * 没有 sessionStorage 的环境（Node 测试、极老浏览器）整体退回 localStorage，行为与旧版一致。
 */
const SESSION_STORE = typeof sessionStorage !== "undefined" ? sessionStorage : null;

/** 清掉 localStorage 里的旧会话键（旧版遗留 / 迁移完成后） */
function dropLegacyStore() {
    try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(ROOM_STORE);
    } catch { /* 隐私模式可能拒绝，忽略 */ }
}

/** 读原始字符串：sessionStorage 优先，其次把 localStorage 的旧会话迁移过来 */
function readSessionRaw() {
    if (SESSION_STORE) {
        try {
            const raw = SESSION_STORE.getItem(ROOM_STORE);
            if (raw) return raw;
        } catch { /* 读不到就继续看旧键 */ }
        // 老用户迁移：上一次会话停在 localStorage 里，顺手搬到本标签页
        let legacy = null;
        try {
            if (typeof localStorage !== "undefined") legacy = localStorage.getItem(ROOM_STORE);
        } catch { legacy = null; }
        if (legacy) {
            writeSessionRaw(legacy);
            return legacy;
        }
        return null;
    }
    try {
        if (typeof localStorage === "undefined") return null;
        return localStorage.getItem(ROOM_STORE);
    } catch {
        return null;
    }
}

/** 写原始字符串：只写本标签页，同时删掉 localStorage 旧键，避免新标签页继承上一次的会话 */
function writeSessionRaw(v) {
    if (SESSION_STORE) {
        try {
            SESSION_STORE.setItem(ROOM_STORE, v);
        } catch { /* 隐私模式可能写不进去，忽略 */ }
        dropLegacyStore();
        return;
    }
    try {
        if (typeof localStorage !== "undefined") localStorage.setItem(ROOM_STORE, v);
    } catch {
        /* ignore */
    }
}

/** 两边都清：退出房间/会话失效时不留残影 */
function removeSessionRaw() {
    if (SESSION_STORE) {
        try { SESSION_STORE.removeItem(ROOM_STORE); } catch { /* ignore */ }
    }
    dropLegacyStore();
}

/** 读取本地会话；容错返回 null（坏数据顺手清掉） */
export function roomSession() {
    try {
        const raw = readSessionRaw();
        if (!raw) return null;
        let s = null;
        try {
            s = JSON.parse(raw);
        } catch {
            removeSessionRaw();
            return null;
        }
        if (!s || typeof s !== "object") {
            removeSessionRaw();
            return null;
        }
        if (!s.code || !s.token) return null;
        return {
            code: String(s.code),
            token: String(s.token),
            gm: s.gm === true,
            memberId: typeof s.memberId === "string" ? s.memberId : "",
            memberName: typeof s.memberName === "string" ? s.memberName : "",
            roomName: typeof s.roomName === "string" ? s.roomName : "",
            base: typeof s.base === "string" ? s.base : "",
            /** 进房时绑定的本地角色 id（玩家收到远端的卡要落回这张） */
            localCharId: typeof s.localCharId === "string" ? s.localCharId : ""
        };
    } catch {
        return null;
    }
}

export function roomSaveSession(s) {
    if (!s) return;
    let raw = "";
    try {
        raw = JSON.stringify(s);
    } catch {
        return; // 循环引用等无法序列化，静默放弃
    }
    if (!raw) return;
    writeSessionRaw(raw);
}

export function roomClearSession() {
    try {
        removeSessionRaw();
    } catch {
        /* ignore */
    }
}

export function roomIsGm() {
    const s = roomSession();
    return !!s && s.gm === true;
}

/** 记住自己的服务端成员 id（加入房间的响应里带，创建房间靠快照 me.id 补） */
function rememberMemberId(id) {
    const s = roomSession();
    const v = String(id || "");
    if (!s || !v || s.memberId === v) return;
    roomSaveSession({ ...s, memberId: v });
}

/** 当前连接对应的成员 id：会话记录优先，其次用最近快照里的 me.id */
export function roomMyMemberId() {
    const s = roomSession();
    if (s && s.memberId) return s.memberId;
    const snap = roomState.snapshot;
    return (snap && snap.me && snap.me.id) ? String(snap.me.id) : "";
}

/** 清空待确认的远端角色卡（玩家确认/忽略后调用） */
export function roomClearPendingChar() {
    if (roomState.pendingChar === null) {
        fireChange();
        return;
    }
    roomState.pendingChar = null;
    fireChange();
}

/**
 * 复制一份可上行的角色卡：剥掉只属于本地镜像记录的 remoteMirror；
 * dropId = true 时连 id 一起剥（镜像 id 只对主持人本地有意义，玩家端拿到会写错存档 key）。
 * 返回 null 表示不是可用的对象。
 */
export function roomStripMirrorFields(char, dropId = false) {
    if (!char || typeof char !== "object") return null;
    let out;
    try {
        out = JSON.parse(JSON.stringify(char));
    } catch {
        return null;
    }
    if (!out || typeof out !== "object") return null;
    delete out.remoteMirror;
    if (dropId) delete out.id;
    return out;
}

/**
 * 当前要落地的本地角色 id：优先当前激活角色，其次会话里进房时记录的 localCharId。
 * 只认会话值会让玩家切换角色后，远端物品/改血落回进房时那张旧卡。
 */
export function roomLocalCharId() {
    const s = roomSession();
    const cur = typeof activeCharId !== "undefined" && activeCharId ? String(activeCharId) : "";
    if (cur) return cur;
    return s && s.localCharId ? String(s.localCharId) : "";
}

/** 角色列表元信息落盘：模块版有全局 saveCharListMeta 就复用，否则直写同一个 key（避免 room ⇄ persist 循环 import） */
function persistCharListMeta() {
    if (typeof globalThis.saveCharListMeta === "function") {
        try { globalThis.saveCharListMeta(); return; } catch { /* 退回直写 */ }
    }
    try { localStorage.setItem("jigerpg_charlist_v04", JSON.stringify(charList)); } catch { /* 隐私模式忽略 */ }
}

/** 刷新当前角色界面：persist 已经 import room，这里不能静态 import 回去，优先用全局挂载的实现 */
function reloadActiveCharacter() {
    if (typeof globalThis.loadActiveCharacter === "function") {
        try { globalThis.loadActiveCharacter(); return; } catch { /* 忽略渲染异常 */ }
    }
    // 单文件版把模块拼在同一作用域里，函数声明可直接访问
    if (typeof loadActiveCharacter === "function") {
        try { loadActiveCharacter(); } catch { /* ignore */ }
    }
}

/**
 * 把待确认的远端角色卡落到玩家自己的本地存档：
 * 深拷贝 → 应用随从补丁 → 去掉 remoteMirror/远端 id → 换成 localCharId → 写 jigerpg_char_<id> →
 * 同步角色列表里的显示名 → 若是当前角色就重新载入界面 → 清 pending。
 * 没有 pending 或没有 localCharId 时返回 false（不写任何存档）。
 */

/** 本地随从存档读写：room.js 不能静态 import persist.js（persist 反向 import 本文件），
 *  优先用 bridge 挂到 globalThis 的实现，单文件/测试环境会退回直接读 localStorage。 */
function rawLoadChar(id) {
    if (!id) return null;
    try {
        if (typeof globalThis.loadRawChar === "function") {
            const data = globalThis.loadRawChar(id);
            return (data && typeof data === "object") ? data : null;
        }
    } catch { /* 退回 localStorage */ }
    try {
        const raw = localStorage.getItem("jigerpg_char_" + id);
        const data = raw ? JSON.parse(raw) : null;
        return (data && typeof data === "object") ? data : null;
    } catch { return null; }
}

function rawSaveChar(id, data) {
    if (!id || !data || typeof data !== "object") return false;
    try {
        if (typeof globalThis.saveRawChar === "function") return globalThis.saveRawChar(id, data) !== false;
    } catch { /* 退回 localStorage */ }
    try {
        localStorage.setItem("jigerpg_char_" + id, JSON.stringify(data));
        return true;
    } catch { return false; }
}

function clampRange(v, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n)) return lo;
    return Math.min(Math.max(n, lo), hi);
}

/**
 * 应用主持人改远端随从留下的 companionPatch：
 * 服务端只有主人卡里的 companions 摘要，随从完整卡在客机本地，
 * 所以按 cid 找到本地随从存档，改 hp/mp/buffs；读不到就跳过这一条（不是我的随从）。
 */
function applyCompanionPatch(data) {
    const patched = new Set();
    const ops = (data && data.companionPatch && Array.isArray(data.companionPatch.ops))
        ? data.companionPatch.ops
        : null;
    if (!ops) return patched;
    for (const op of ops) {
        if (!op || !op.cid) continue;
        try {
            const cd = rawLoadChar(String(op.cid));
            if (!cd || typeof cd !== "object") continue;
            const cc = (typeof globalThis.computeCompanion === "function") ? globalThis.computeCompanion(cd) : null;
            const maxHp = Math.max(0, Number(cc && cc.maxHp !== undefined ? cc.maxHp : (op.maxHp !== undefined ? op.maxHp : cd.maxHp)) || 0);
            const maxMp = Math.max(0, Number(cc && cc.maxMp !== undefined ? cc.maxMp : (op.maxMp !== undefined ? op.maxMp : cd.maxMp)) || 0);
            // 上限拿不到（旧卡没 maxHp）时退回旧值，避免把血条清成 0
            const hpCap = maxHp > 0 ? maxHp : Math.max(0, Number(cd.hp) || 0);
            const mpCap = maxMp > 0 ? maxMp : Math.max(0, Number(cd.mp) || 0);
            if (op.hp !== undefined) cd.hp = hpCap > 0 ? clampRange(op.hp, 0, hpCap) : 0;
            if (op.mp !== undefined) cd.mp = mpCap > 0 ? clampRange(op.mp, 0, mpCap) : 0;
            if (Array.isArray(op.buffs)) {
                cd.buffs = op.buffs.slice(0, 8).map(b => {
                    const s = (b && typeof b === "object") ? b : {};
                    const name = String(s.name || "").trim().slice(0, 60);
                    if (!name) return null;
                    return {
                        name,
                        // 本地卡 Buff 的字段名是 round（不是 rounds），这里按本地 schema 落地
                        round: Math.max(0, Math.round(Number(s.rounds !== undefined ? s.rounds : s.round) || 0)),
                        stack: Math.max(1, Math.round(Number(s.stack) || 1))
                    };
                }).filter(Boolean);
            }
            if (rawSaveChar(String(op.cid), cd)) patched.add(String(op.cid));
        } catch { /* 单条失败只跳过，不影响主人卡写盘 */ }
    }
    return patched;
}

export async function roomApplyPendingChar() {
    const pending = roomState.pendingChar;
    const src = pending && pending.char;
    if (!src || typeof src !== "object") return false;
    const id = roomLocalCharId();
    if (!id) return false;
    let data;
    try {
        data = JSON.parse(JSON.stringify(src));
    } catch {
        return false;
    }
    if (!data || typeof data !== "object") return false;
    // 先落随从补丁：补丁里的 cid 是客机本地的随从 id，读不到就跳过
    const patchedIds = applyCompanionPatch(data);
    delete data.companionPatch;
    // 主人卡上的 companions 只是上行摘要，不是本地存档的一部分（本地卡自己就带随从列表）
    delete data.companions;
    delete data.remoteMirror;
    data.id = id;
    if (typeof localStorage === "undefined") return false;
    try {
        localStorage.setItem("jigerpg_char_" + id, JSON.stringify(data));
    } catch {
        roomState.error = "远端角色卡写入本地失败（本地存储空间不足？）";
        fireChange();
        return false;
    }
    // 服务端卡改了名字时，角色列表里的显示名跟着更新
    const meta = (Array.isArray(charList) ? charList : []).find((m) => m && m.id === id);
    if (meta) {
        const name = String(data.name || "").trim();
        if (name && meta.name !== name) {
            meta.name = name;
            persistCharListMeta();
        }
    }
    // 当前角色就是被改的随从时也要重载（它的 hp/buffs 刚落到本地存档）
    const activePatched = !!(activeCharId && patchedIds.has(String(activeCharId)));
    if (id === activeCharId || activePatched) reloadActiveCharacter();
    if (typeof globalThis.renderCompanions === "function") {
        try { globalThis.renderCompanions(); } catch { /* 忽略渲染异常 */ }
    }
    roomClearPendingChar();
    return true;
}

export function roomSnapshot() {
    return roomState.snapshot;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** 取当前角色快照（d 的实际字段有 maxHpBase / job，这里做兼容回退） */
function charSnapshot() {
    const s = d || {};
    const snap = {
        name: String(s.name ?? ""),
        level: num(s.level),
        hp: num(s.hp),
        maxHp: num(s.maxHp !== undefined ? s.maxHp : s.maxHpBase),
        mp: num(s.mp),
        maxMp: num(s.maxMp !== undefined ? s.maxMp : s.maxMpBase),
        cls: String(s.cls ?? s.job ?? ""),
        hideMp: s.hideMp === true
    };
    // 自定义数值只上行摘要字段（最多 20 条）；随从不在这里算，进房后由 char.put 补齐
    if (Array.isArray(s.customStats)) {
        snap.customStats = s.customStats.slice(0, 20)
            .filter(cs => cs && typeof cs === "object")
            .map(cs => ({
                name: String(cs.name ?? ""),
                val: num(cs.val),
                max: num(cs.max),
                color: String(cs.color ?? "")
            }));
    }
    return snap;
}

async function api(path, body, base) {
    const method = body === undefined ? "GET" : "POST";
    const b = base === undefined ? roomBase() : base;
    const url = (b || "") + path;
    let res;
    try {
        res = await fetch(url, {
            method,
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new Error("连不上服务器：" + (b || "当前页面地址（请先填服务器地址）"));
    }
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    if (!res.ok) {
        if (res.status === 404) {
            throw new Error("服务器没有房间接口（404）：请填 node room_server.mjs 的地址，而不是静态服务器或 /JigeRPG.html");
        }
        throw new Error((data && data.error) || String(res.status));
    }
    return data;
}

/** 追加一条公告（与 SSE 回显去重，避免主持人自己发两遍） */
function pushNotice(n) {
    if (!n || typeof n !== "object" || !n.text) return;
    const last = roomState.notice[roomState.notice.length - 1];
    if (last && last.text === n.text && last.at === n.at && last.from === n.from) return;
    roomState.notice.push(n);
    if (roomState.notice.length > NOTICE_LIMIT) {
        roomState.notice.splice(0, roomState.notice.length - NOTICE_LIMIT);
    }
}

function applySnapshot(data) {
    if (!data || typeof data !== "object") return;
    // 按 rev 幂等：服务端主动推 + 客户端补拉 snapshot 可能重复到达，旧 rev 直接丢弃
    const incoming = Number(data.rev);
    const current = roomState.snapshot ? Number(roomState.snapshot.rev) : NaN;
    if (Number.isFinite(incoming) && Number.isFinite(current) && incoming < current) return;
    roomState.snapshot = data;
    if (data.code) roomState.code = data.code;
    // 快照里带了自己的成员 id 就补进会话，后面判断「char 事件是不是发给我」要用
    if (data.me && data.me.id) rememberMemberId(data.me.id);
}

/** 把拒绝原因（{error:{code,message}} 或 Error）转成给人看的字符串 */
function errText(e) {
    if (!e) return "请求失败";
    if (e.error && typeof e.error === "object") return String(e.error.message || e.error.code || "请求失败");
    if (e.message) return String(e.message);
    return String(e);
}

/* ================= WebSocket 客户端 ================= */

/** http(s)://host/path → ws(s)://host/path/ws?token=... */
function wsUrl(s) {
    const b = roomBase();
    const secure = /^https:\/\//i.test(b);
    const host = b.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    return (secure ? "wss://" : "ws://") + host + "/ws?token=" + encodeURIComponent(s ? s.token : "");
}

/** 连接断在 4001（鉴权失败/房间失效）时通知 roomRestore 的等待者 */
function notifyGone() {
    wsGone = true;
    const list = wsGoneWaiters;
    wsGoneWaiters = [];
    for (const fn of list) {
        try { fn(); } catch { /* ignore */ }
    }
}

/** 唤醒所有「等连接就绪」的等待者 */
function flushOnlineWaiters(ok) {
    const list = wsOnlineWaiters;
    wsOnlineWaiters = [];
    for (const w of list) {
        try { w(ok === true); } catch { /* ignore */ }
    }
}

/** 等连接就绪（最多 ms 毫秒）：已在线立即 true，超时/断开为 false */
function wsWaitOnline(ms) {
    if (ws && ws.readyState === 1 && roomState.status === "online") return Promise.resolve(true);
    return new Promise((resolve) => {
        let timer = 0;
        const waiter = (ok) => {
            const i = wsOnlineWaiters.indexOf(waiter);
            if (i >= 0) wsOnlineWaiters.splice(i, 1);
            if (timer) clearTimeout(timer);
            resolve(ok === true);
        };
        wsOnlineWaiters.push(waiter);
        timer = setTimeout(() => waiter(false), ms);
    });
}

/** 服务端主动推送：snapshot / room / member / notice / char */
function wsHandlePush(type, data) {
    if (!data || typeof data !== "object") return;
    if (type === "snapshot") {
        applySnapshot(data);
        roomState.status = "online";
        fireChange();
        return;
    }
    if (type === "room" || type === "member") {
        applySnapshot(data);
        fireChange();
        return;
    }
    if (type === "notice") {
        pushNotice(data);
        fireChange();
        return;
    }
    if (type === "char") {
        // 主持人这边只刷新 UI：GM 可能正在编辑镜像角色，自动覆盖会打断他的编辑
        if (roomIsGm()) {
            // 主持人若已经为这个成员建过镜像，顺手把镜像存档更新到最新（不切换当前角色、不打断编辑）
            try {
                const s = roomSession();
                const mid = s ? mirrorCharId(s.code, String(data.memberId || "")) : "";
                // 只有镜像存在、且当前不在编辑它时才覆盖
                if (mid && typeof localStorage !== "undefined" && localStorage.getItem("jigerpg_char_" + mid) && mid !== activeCharId) {
                    const fresh = roomStripMirrorFields(data.char, true);
                    if (fresh) saveMirror(s.code, String(data.memberId || ""), fresh.name || "玩家", fresh);
                }
            } catch { /* 镜像刷新失败不影响主流程 */ }
            fireChange();
            return;
        }
        // 兜底：自己刚推上去的卡被服务端回推时，不要当成「别人改的」写进 pending
        // （服务端现在不回推给发起者，这里再挡一层，避免 保存→回声→重载→再上传 的循环）
        if (String(data.by || "") === "player" && String(data.memberId || "") === roomMyMemberId()) {
            fireChange();
            return;
        }
        // 只处理发给自己的卡（服务端也只投递给目标成员与 GM，这里再兜一层）
        if (String(data.memberId || "") === roomMyMemberId()) {
            roomState.pendingChar = {
                by: String(data.by || "主持人"),
                char: data.char,
                at: Date.now(),
                mode: data.mode === "edit" ? "edit" : "hp"
            };
        }
        fireChange();
    }
}

/** 分发一条已解析的 WS 消息（请求响应 / 主动推送 / 错误 / pong） */
function wsHandleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.id !== undefined && msg.id !== null) {
        const p = wsPending.get(msg.id);
        if (!p) return;
        wsPending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data === undefined ? null : msg.data);
        else p.reject({ error: msg.error && typeof msg.error === "object" ? msg.error : { code: "error", message: "请求失败" } });
        return;
    }
    const type = String(msg.type || "");
    if (type === "pong") return;
    if (type === "error") {
        const e = msg.error && typeof msg.error === "object" ? msg.error : null;
        roomState.error = String((e && (e.message || e.code)) || "房间连接出错");
        fireChange();
        return;
    }
    if (type === "snapshot" || type === "room" || type === "member" || type === "notice" || type === "char") {
        try { wsHandlePush(type, msg.data); } catch { /* 单条坏消息不能中断连接 */ }
    }
}

/** 建立（或重建）WebSocket 连接 */
function wsOpen() {
    const s = roomSession();
    if (!s) {
        roomState.status = "error";
        roomState.error = "尚未加入房间";
        fireChange();
        return;
    }
    if (typeof WebSocket === "undefined") {
        roomState.status = "error";
        roomState.error = "当前环境不支持实时连接";
        fireChange();
        return;
    }

    // 换连接：旧 socket 的 onclose 会因为 sock !== ws 直接返回，不影响新的重连计数
    if (ws) {
        const old = ws;
        ws = null;
        try { old.close(); } catch { /* ignore */ }
    }
    if (wsTimer) { clearTimeout(wsTimer); wsTimer = 0; }
    wsManualClose = false;
    wsGone = false;

    roomState.code = s.code;
    roomState.status = "connecting";
    fireChange();

    let sock;
    try {
        sock = new WebSocket(wsUrl(s));
    } catch (e) {
        roomState.status = "error";
        roomState.error = errText(e);
        fireChange();
        return;
    }
    ws = sock;

    sock.onopen = () => {
        if (sock !== ws) return;
        wsRetry = 0;
        roomState.status = "online";
        roomState.error = "";
        fireChange();
        flushOnlineWaiters(true);
        // 兜底补拉一次快照（服务端连上也会主动推，applySnapshot 按 rev 幂等）
        wsRequest("snapshot").then((data) => {
            if (data && typeof data === "object" && data.code) {
                applySnapshot(data);
                fireChange();
            }
        }).catch(() => { /* 已由服务端主动推送兜底 */ });
    };

    sock.onmessage = (ev) => {
        if (sock !== ws) return;
        let msg = null;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }
        try { wsHandleMessage(msg); } catch { /* 单条坏消息不能中断连接 */ }
    };

    sock.onerror = () => {
        // 统一交给 onclose 处理（状态与重连）
    };

    sock.onclose = (ev) => {
        if (sock !== ws) return;
        ws = null;
        // 主动断开（离开房间 / 页面关闭）：不重连
        if (wsManualClose) return;
        // 挂起的请求全部失败，避免业务函数一直等
        for (const [id, p] of wsPending) {
            if (p.timer) clearTimeout(p.timer);
            try { p.reject({ error: { code: "closed", message: "连接已断开" } }); } catch { /* ignore */ }
            wsPending.delete(id);
        }
        flushOnlineWaiters(false);
        const code = ev && typeof ev.code === "number" ? ev.code : 0;
        if (code === 4001) {
            wsManualClose = true;
            roomClearSession();
            roomState.code = "";
            roomState.snapshot = null;
            roomState.notice = [];
            roomState.pendingChar = null;
            roomState.status = "error";
            roomState.error = "房间已失效（服务器可能重启过或被解散），请重新创建或加入";
            fireChange();
            notifyGone();
            return;
        }
        roomState.status = "connecting";
        fireChange();
        wsRetry++;
        const delay = Math.min(1000 * Math.pow(2, wsRetry - 1), 10000);
        if (wsTimer) clearTimeout(wsTimer);
        wsTimer = setTimeout(() => {
            wsTimer = 0;
            try { wsOpen(); } catch { /* 下一轮再试 */ }
        }, delay);
    };
}

/** 发一条请求并等响应：{id,type,payload} → {ok:true,data} / {ok:false,error} */
function wsRequest(type, payload) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== 1) {
            reject({ error: { code: "offline", message: "未连接到房间服务器" } });
            return;
        }
        const id = "r" + (++wsSeq);
        const msg = { id, type };
        if (payload !== undefined) msg.payload = payload;
        const timer = setTimeout(() => {
            if (!wsPending.has(id)) return;
            wsPending.delete(id);
            reject({ error: { code: "timeout", message: "请求超时" } });
        }, 10000);
        wsPending.set(id, { resolve, reject, timer });
        try {
            ws.send(JSON.stringify(msg));
        } catch (e) {
            clearTimeout(timer);
            wsPending.delete(id);
            reject({ error: { code: "offline", message: errText(e) } });
        }
    });
}

/** 主动关闭：不再重连，挂起请求全部失败 */
function wsClose() {
    wsManualClose = true;
    if (wsTimer) { clearTimeout(wsTimer); wsTimer = 0; }
    for (const [id, p] of wsPending) {
        if (p.timer) clearTimeout(p.timer);
        try { p.reject({ error: { code: "closed", message: "连接已关闭" } }); } catch { /* ignore */ }
        wsPending.delete(id);
    }
    flushOnlineWaiters(false);
    const sock = ws;
    ws = null;
    wsRetry = 0;
    if (sock) {
        try { sock.close(); } catch { /* ignore */ }
    }
}

/** 建立（或重建）房间连接 */
export async function roomConnect() {
    wsOpen();
}

export function roomDisconnect() {
    // 页面关闭/主动断开时不要在 onclose 里触发重连
    wsManualClose = true;
    wsClose();
    roomState.status = "idle";
    fireChange();
}

/**
 * 刷新页面 / 重新打开后恢复房间：有会话就直接重连 WebSocket。
 * 房间已不存在（服务器重启过、或被解散）时由服务端 close code 4001 判定，
 * 这里等 5 秒看是否收到 4001，收到就返回 gone（错误提示已由 onclose 写入）。
 */
export async function roomRestore() {
    const s = roomSession();
    if (!s) return { ok: false, reason: "none" };

    roomState.code = s.code;
    roomState.status = "connecting";
    roomState.error = "";
    fireChange();

    // 环境不支持 WS 时没得等，直接返回
    if (typeof WebSocket === "undefined") {
        wsOpen(); // 由它写 status = error
        return { ok: false, reason: "none" };
    }

    wsGone = false;
    const gone = new Promise((resolve) => {
        wsGoneWaiters.push(() => resolve({ ok: false, reason: "gone" }));
    });
    wsOpen();
    // 极端情况下（连接在 wsOpen 内同步失败并已 4001）立即返回
    if (wsGone) return { ok: false, reason: "gone" };
    const timeout = new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true }), 5000);
    });
    const r = await Promise.race([gone, timeout]);
    if (r && r.ok === false) return r;
    return { ok: true };
}

/** 创建房间（GM）。失败会 throw 给 UI 提示 */
export async function roomCreate(roomName, memberName, base) {
    const name = String(roomName || "").trim() || "未命名房间";
    const who = String(memberName || "").trim() || String((d && d.name) || "") || "主持人";
    const b = roomSetBase(base);
    let data;
    try {
        data = await api("/api/rooms", { name, memberName: who, char: charSnapshot() }, b);
    } catch (e) {
        roomState.status = "error";
        roomState.error = e.message;
        throw e;
    }
    roomSaveSession({
        code: data.code,
        token: data.gmToken,
        gm: true,
        memberName: who,
        roomName: data.name || name,
        base: b,
        localCharId: String(activeCharId || "")
    });
    roomState.code = data.code;
    roomState.snapshot = null;
    roomState.notice = [];
    roomState.pendingChar = null;
    roomState.error = "";
    await roomConnect();
    // WS 刚建连时还没 online，等握手完成再推（最多 3 秒，失败不影响进入）
    await wsWaitOnline(3000);
    // 进房后把完整角色卡同步给服务端（否则 GM 只能看到摘要）；内部自吞错误返回 boolean，不会抛
    if (d && !d.remoteMirror) await roomPushFullChar(d);
    fireChange();
    return { code: data.code };
}

/** 加入房间（玩家）。失败会 throw 给 UI 提示 */
export async function roomJoin(code, memberName, base) {
    const c = String(code || "").trim().toUpperCase();
    const who = String(memberName || "").trim() || String((d && d.name) || "") || "玩家";
    if (!c) {
        const err = new Error("请输入房间码");
        roomState.error = err.message;
        throw err;
    }
    const b = roomSetBase(base);
    let data;
    try {
        data = await api(`/api/rooms/${encodeURIComponent(c)}/join`, {
            name: who,
            role: "player",
            char: charSnapshot()
        }, b);
    } catch (e) {
        roomState.status = "error";
        roomState.error = e.message;
        throw e;
    }
    roomSaveSession({
        code: c,
        token: data.token,
        gm: false,
        memberId: typeof data.memberId === "string" ? data.memberId : "",
        memberName: who,
        roomName: (data.room && data.room.name) || "",
        base: b,
        localCharId: String(activeCharId || "")
    });
    roomState.code = c;
    roomState.snapshot = data.room || null;
    roomState.notice = [];
    roomState.pendingChar = null;
    roomState.error = "";
    await roomConnect();
    // WS 刚建连时还没 online，等握手完成再推（最多 3 秒，失败不影响进入）
    await wsWaitOnline(3000);
    // 进房后把完整角色卡同步给服务端（否则 GM 只能看到摘要）；内部自吞错误返回 boolean，不会抛
    if (d && !d.remoteMirror) await roomPushFullChar(d);
    fireChange();
    return { code: c };
}

/** 离开房间：通知服务端 → 断开 WS → 清本地会话与状态 */
export async function roomLeave() {
    const s = roomSession();
    if (s) {
        try {
            await wsRequest("leave");
        } catch {
            /* 离开失败忽略，本地照样清理 */
        }
    }
    wsClose();
    roomClearSession();
    roomState.code = "";
    roomState.snapshot = null;
    roomState.status = "idle";
    roomState.error = "";
    roomState.notice = [];
    roomState.pendingChar = null;
    fireChange();
}

/** 把当前角色（HP/MP/等级/名字等）推给房间，成员与 GM 都可用（保留旧实现，内部改走 WS） */
export async function roomPushChar() {
    const s = roomSession();
    if (!s || roomState.status !== "online") return;
    try {
        await wsRequest("update", { char: charSnapshot() });
    } catch (e) {
        roomState.error = errText(e);
        fireChange();
    }
}

/** 主持人面板状态上行（客机只读展示）：失败静默，不影响本地操作 */
export async function roomPushGmState(state) {
    const s = roomSession();
    if (!s) return { ok: false };
    const st = (state && typeof state === "object") ? state : {};
    try {
        const payload = {
            round: st.round,
            note: st.note,
            actions: st.actions,
            rolls: st.rolls,
            enemies: st.enemies,
            log: st.log
        };
        // 规则只在有值时上行，避免把单机/未初始化的场景写成关闭。
        // 形状固定为 { itemUseInCombat: "turn"|"free"|"blocked" }，非法值回退 "turn"（与 booleans 时代不同，这里只发新字段）。
        if (st.rules && typeof st.rules === "object") {
            const mode = st.rules.itemUseInCombat;
            payload.rules = {
                itemUseInCombat: (mode === "free" || mode === "blocked" || mode === "turn") ? mode : "turn"
            };
        }
        await wsRequest("update", payload);
        return { ok: true };
    } catch {
        // 实时展示是增强功能：断网/超时不该打断主持人的本地操作
        return { ok: false };
    }
}

/**
 * 上传自己的完整角色卡（含物品/技能/自定义数值）；失败只记 error，不抛。
 * companions 可选：随从摘要数组，浅拷贝附在卡上一起上行（服务端存进 target.full 再生成摘要）。
 */
export async function roomPushFullChar(char, companions) {
    const s = roomSession();
    if (!s) return false;
    // 幂等剥离：万一玩家手里的卡带着镜像标注，也不要把它传上服务端
    const base = roomStripMirrorFields(char, false);
    if (!base) return false;
    // 总是带 companions（可为空数组）：空数组表示“确实没有随从”，
    // 缺省键则表示这是一次局部上传（如看板改血），服务端会沿用上次的随从列表。
    const payload = { ...base, companions: Array.isArray(companions) ? companions : [] };
    const body = { char: payload };
    if (s.memberId) body.memberId = s.memberId; // 缺省=自己，带上更明确
    try {
        await wsRequest("char.put", body);
        return true;
    } catch (e) {
        roomState.error = errText(e);
        fireChange();
        return false;
    }
}

/** 手动补推一次当前角色卡给房间（房间内其他人看不到自己时用）；返回 { ok, error } */
export async function resyncMyChar() {
    const s = roomSession();
    if (!s) return { ok: false, error: "尚未加入房间" };
    if (!d || !String(d.name || "").trim()) return { ok: false, error: "当前没有打开的角色卡" };
    // 必须带上主人的随从摘要：roomPushFullChar 缺省会把 companions 强制成空数组，
    // 只推卡不推摘要会把房间里已有的随从列表清空。
    // room.js 不能反向 import persist.js（persist 已 import 本文件，会成环），
    // 由 bridge.js 把 persist 导出挂到 globalThis 上，这里按需取用。
    const ownerId = String((d && d.type === "companion" ? d.ownerId : "") || activeCharId || roomLocalCharId() || "");
    const comps = (ownerId && typeof globalThis.companionsSummary === "function")
        ? globalThis.companionsSummary(ownerId)
        : null;
    const ok = Array.isArray(comps) ? await roomPushFullChar(d, comps) : await roomPushFullChar(d);
    return ok ? { ok: true } : { ok: false, error: "同步失败，请检查服务器连接" };
}

/** 读取完整角色卡（主持人可读任意成员，玩家只能读自己）；失败返回 null */
export async function roomFetchChar(memberId) {
    const s = roomSession();
    if (!s) return null;
    const payload = {};
    if (memberId) payload.memberId = String(memberId);
    try {
        const data = await wsRequest("char.get", payload);
        const c = data && data.char;
        return (c && typeof c === "object") ? c : null;
    } catch (e) {
        roomState.error = errText(e);
        fireChange();
        return null;
    }
}

/** 把完整角色卡写到指定成员头上（仅主持人可用，服务端会再校验一次）。mode: "hp" | "edit" */
export async function roomPushCharTo(memberId, char, mode) {
    const s = roomSession();
    const m = String(memberId || "");
    if (!s || !m) return false;
    if (!char || typeof char !== "object") return false;
    const src = mode === "edit" ? "edit" : "hp";
    try {
        await wsRequest("char.put", { memberId: m, char, mode: src });
        return true;
    } catch (e) {
        roomState.error = errText(e);
        fireChange();
        return false;
    }
}

/** 主持人发通知 */
export async function roomNotice(text) {
    if (!roomIsGm()) return;
    const s = roomSession();
    const t = String(text || "").trim();
    if (!s || !t) return;
    try {
        const data = await wsRequest("notice", { text: t });
        // 服务端会把公告广播给所有连接（包括自己）；这里先本地回显一次，
        // 保证主持人点完立刻看到，WS 回显由 pushNotice 去重。
        if (data && data.notice) {
            pushNotice(data.notice);
            fireChange();
        }
        return data;
    } catch (e) {
        roomState.error = errText(e);
        fireChange();
    }
}

/** 玩家上报一条行动给主持人：失败静默，避免打断本地操作 */
export async function roomSubmitAction(action) {
    const s = roomSession();
    if (!s) return { ok: false };
    const a = action && typeof action === "object" ? action : {};
    // 白名单字段：buff 只做浅拷贝，其余深结构一概不传
    const item = {
        charId: String(a.charId || "").slice(0, 64),
        charName: String(s.memberName || "").slice(0, 40),
        type: String(a.type || "").slice(0, 16),
        skillName: String(a.skillName || "").slice(0, 60),
        // type:"item" 的行动名（消耗品/道具），与 skillName 同长度上限
        itemName: String(a.itemName || "").slice(0, 60),
        target: String(a.target || "").slice(0, 64),
        targetId: String(a.targetId || "").slice(0, 64),
        text: String(a.text || "").trim().slice(0, 200),
        effect: String(a.effect || ""),
        amount: Number(a.amount) || 0,
        at: Number(a.at) || Date.now()
    };
    const id = String(a.id || "").slice(0, 32);
    if (id) item.id = id;
    if (Number.isFinite(Number(a.round)) && Number(a.round) > 0) item.round = Number(a.round);
    if (a.buff && typeof a.buff === "object" && !Array.isArray(a.buff)) item.buff = { ...a.buff };
    try {
        const data = await wsRequest("submit", { kind: "action", item });
        if (!data || data.ok !== true) return { ok: false };
        return { ok: true, id: data.id, rev: data.rev };
    } catch {
        return { ok: false };
    }
}

/** 玩家上报一条掷骰给主持人：失败静默，避免打断本地操作 */
export async function roomSubmitRoll(roll) {
    const s = roomSession();
    if (!s) return { ok: false };
    const r = roll && typeof roll === "object" ? roll : {};
    // 白名单字段：detail 是纯文本，total 是最终点数
    const item = {
        charId: String(r.charId || "").slice(0, 64),
        charName: String(s.memberName || "").slice(0, 40),
        kind: String(r.kind || "").slice(0, 16),
        detail: String(r.detail || "").trim().slice(0, 120),
        total: Number(r.total) || 0,
        at: Number(r.at) || Date.now()
    };
    const id = String(r.id || "").slice(0, 32);
    if (id) item.id = id;
    if (Number.isFinite(Number(r.round)) && Number(r.round) > 0) item.round = Number(r.round);
    try {
        const data = await wsRequest("submit", { kind: "roll", item });
        if (!data || data.ok !== true) return { ok: false };
        return { ok: true, id: data.id, rev: data.rev };
    } catch {
        return { ok: false };
    }
}

/** 玩家撤回/移除自己上报的条目（actions / rolls）：失败静默，避免打断本地操作 */
export async function roomRemoveSubmit(list, id) {
    const s = roomSession();
    if (!s) return { ok: false };
    const listName = String(list || "").trim();
    const itemId = String(id || "").trim().slice(0, 32);
    if (!listName || !itemId) return { ok: false };
    try {
        const data = await wsRequest("submit", {
            kind: "remove",
            item: { list: listName, id: itemId }
        });
        if (!data || data.ok !== true) return { ok: false };
        return { ok: true, removed: data.removed === true };
    } catch {
        return { ok: false };
    }
}

/** 快照里在线成员数 */
export function roomMemberCount() {
    const snap = roomState.snapshot;
    if (!snap || !Array.isArray(snap.members)) return 0;
    return snap.members.filter((m) => m && m.online).length;
}