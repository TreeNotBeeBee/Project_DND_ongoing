// 局域网房间服务：Koa + koa-router。
// 托管 ESM 源码页面 index.html（并静态提供 js/、css/），同时提供内存房间 API + 实时推送
// （WebSocket /ws 为主，SSE /stream 保留兼容）。
// 用法：node room_server.mjs [端口]   （默认 8080；主持人面板在页面顶部切换）
import Koa from "koa";
import Router from "koa-router";
import bodyParser from "koa-bodyparser";
import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const INDEX_PATH = join(ROOT, "index.html");
const PORT = Number(process.argv[2]) || 8080;

// 静态资源：仅允许这两个目录 + 根目录 favicon
const STATIC_DIRS = new Set(["js", "css"]);
const MIME_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".html": "text/html; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8"
};

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_MEMBERS = 12;
const IDLE_MS = 2 * 60 * 60 * 1000;      // 无在线成员 2 小时后可清理
const SWEEP_MS = 10 * 60 * 1000;         // 每 10 分钟扫一次
const MAX_BODY = 1024 * 1024;
const MAX_CHAR_JSON = 256 * 1024;         // 单张完整角色卡上限 256KB
const MAX_GM_STATE_BODY = 200000;         // 主持人面板状态请求体上限
const WS_HEARTBEAT_MS = 30000;             // WebSocket 心跳间隔
const WS_UNAUTHORIZED = 4001;              // 无效成员凭证的关闭码

// 主持人面板状态（广播给客机只读展示）的截断上限
const GM_STATE_LIMIT = { actions: 40, rolls: 80, enemies: 30, log: 40 };
const GM_STATE_STR = 200;
const GM_STATE_NOTE = 2000;

/** code -> room */
const rooms = new Map();

// === 工具 ===
function newCode() {
    let code;
    do {
        code = "";
        const bytes = crypto.randomBytes(6);
        for (let i = 0; i < 6; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    } while (rooms.has(code));
    return code;
}

function newId() {
    return crypto.randomBytes(4).toString("hex");
}

function str(v) {
    return typeof v === "string" ? v : (v === undefined || v === null ? "" : String(v));
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function cleanName(v, fallback = "") {
    const s = str(v).trim().slice(0, 40);
    return s || fallback;
}

const CHAR_STATS_MAX = 20;      // 成员摘要里最多下发的自定义属性条数
const CHAR_COMPANIONS_MAX = 30; // 成员摘要里最多下发的随从条数
const CHAR_COMPANION_BUFFS_MAX = 8; // 每个随从摘要里最多下发的 Buff 条数

/** 自定义属性摘要：只保留展示字段（name/val/max/color），丢弃 gain/shield 等配置字段以控制体积 */
function makeStats(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const item of v) {
        if (out.length >= CHAR_STATS_MAX) break;
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        out.push({
            name: str(item.name).slice(0, 40),
            val: clampNum(item.val),
            max: Math.max(1, num(item.max)),
            color: str(item.color).slice(0, 16)
        });
    }
    return out;
}

/**
 * 随从 Buff 摘要：只保留看板展示需要的 name/rounds/stack。
 * 名字清洗后为空则丢弃；rounds 兼容 rounds/round/duration，stack 兼容 stack/stacks/count。
 */
function makeBuffBriefs(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const item of v) {
        if (out.length >= CHAR_COMPANION_BUFFS_MAX) break;
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const name = str(item.name).trim().slice(0, 40);
        if (!name) continue;
        let rounds = null;
        for (const k of ["rounds", "round", "duration"]) {
            const raw = item[k];
            if (raw === undefined || raw === null || raw === "") continue;
            const n = Number(raw);
            if (Number.isFinite(n)) { rounds = n; break; }
        }
        let stack = null;
        for (const k of ["stack", "stacks", "count"]) {
            const raw = item[k];
            if (raw === undefined || raw === null || raw === "") continue;
            const n = Number(raw);
            if (Number.isFinite(n)) { stack = n; break; }
        }
        out.push({
            name: name,
            rounds: Math.max(0, Math.round(rounds == null ? 0 : rounds)),
            stack: Math.max(1, Math.round(stack == null ? 1 : stack))
        });
    }
    return out;
}

/** 随从摘要：血蓝按上限夹取，与主角卡 makeChar 的处理保持一致 */
function makeCompanions(v) {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const item of v) {
        if (out.length >= CHAR_COMPANIONS_MAX) break;
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const maxHp = Math.max(0, num(item.maxHp));
        const maxMp = Math.max(0, num(item.maxMp));
        let hp = clampNum(item.hp);
        let mp = clampNum(item.mp);
        if (maxHp > 0) hp = Math.min(Math.max(hp, 0), maxHp);
        if (maxMp > 0) mp = Math.min(Math.max(mp, 0), maxMp);
        out.push({
            id: str(item.id).slice(0, 40),
            name: str(item.name).slice(0, 40),
            icon: str(item.icon).slice(0, 16),
            level: Math.max(0, Math.round(num(item.level))),
            hp: hp,
            maxHp: maxHp,
            mp: mp,
            maxMp: maxMp,
            combat: item.combat === true,
            mode: str(item.mode).slice(0, 20),
            ownerId: str(item.ownerId).slice(0, 40),
            buffs: makeBuffBriefs(item.buffs)
        });
    }
    return out;
}

function makeChar(c) {
    const src = c && typeof c === "object" ? c : {};
    // 完整卡里血量字段是 maxHpBase / maxMpBase，简卡才是 maxHp / maxMp，两种都要认
    const maxHp = num(src.maxHp != null ? src.maxHp : src.maxHpBase);
    const maxMp = num(src.maxMp != null ? src.maxMp : src.maxMpBase);
    let hp = num(src.hp);
    let mp = num(src.mp);
    if (maxHp > 0) hp = Math.min(Math.max(hp, 0), maxHp);
    if (maxMp > 0) mp = Math.min(Math.max(mp, 0), maxMp);
    return {
        name: cleanName(src.name),
        level: Math.max(0, Math.round(num(src.level))),
        hp: hp,
        maxHp: maxHp,
        mp: mp,
        maxMp: maxMp,
        cls: str(src.cls).slice(0, 40),
        // 参战标记：outOfCombat 为 true 表示已退出战斗（默认在战斗中）；
        // combat 供随从/单位使用，主角卡通常没有该字段，缺省视为不参战。
        outOfCombat: src.outOfCombat === true,
        combat: src.combat === true,
        // 以下三项供其他客户端展示成员摘要：隐藏蓝量 / 自定义属性 / 随从
        hideMp: src.hideMp === true,
        customStats: makeStats(src.customStats),
        companions: makeCompanions(src.companions)
    };
}

function makeMember(name, role, char, token) {
    return {
        token,
        id: newId(),
        name: cleanName(name, role === "gm" ? "主持人" : "玩家"),
        role: role === "gm" ? "gm" : "player",
        char: makeChar(char),
        full: null,          // 完整角色卡（JSON 对象），未上传时为 null
        online: true,
        lastSeen: Date.now()
    };
}

// === 快照 ===
/**
 * 房间级规则字段：目前只有一个 itemUseInCombat（"turn" 按回合 / "free" 自由 / "blocked" 禁用）。
 * 兼容旧客户端：没有 itemUseInCombat 时按 noUseInCombat 布尔换算（false → free，其它 → turn）。
 * 返回值只含 itemUseInCombat，旧字段一律不透传。
 */
const RULE_MODES = new Set(["turn", "free", "blocked"]);
function normalizeRules(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return { itemUseInCombat: "turn" };
    if (RULE_MODES.has(v.itemUseInCombat)) return { itemUseInCombat: v.itemUseInCombat };
    return { itemUseInCombat: v.noUseInCombat === false ? "free" : "turn" };
}

/** 房间的主持人面板状态：老房间/异常数据兜底成空状态 */
function gmStateOf(room) {
    if (!room.gmState || typeof room.gmState !== "object") {
        room.gmState = { rev: 0, actions: [], rolls: [], enemies: [], log: [] };
    }
    const gs = room.gmState;
    for (const key of Object.keys(GM_STATE_LIMIT)) {
        if (!Array.isArray(gs[key])) gs[key] = [];
    }
    gs.rev = Math.max(0, Math.round(num(gs.rev)));
    // 老房间首次访问即补上规则字段，避免各处再做缺省判断
    gs.rules = normalizeRules(gs.rules);
    return gs;
}

/** 单个状态元素的安全拷贝：只收对象，转成纯 JSON，字符串字段截断到 200 字 */
function copyGmItem(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    let copy;
    try {
        copy = JSON.parse(JSON.stringify(v));
    } catch {
        return null;
    }
    if (!copy || typeof copy !== "object" || Array.isArray(copy)) return null;
    for (const key of Object.keys(copy)) {
        if (typeof copy[key] === "string") copy[key] = copy[key].slice(0, GM_STATE_STR);
    }
    return copy;
}

/** 状态数组的安全拷贝 + 只保留最近 limit 条；非数组返回 null（调用方据此忽略） */
function copyGmList(v, limit) {
    if (!Array.isArray(v)) return null;
    const out = [];
    for (const item of v.slice(-limit)) {
        const c = copyGmItem(item);
        if (c) out.push(c);
    }
    return out;
}

/** 日志是纯字符串数组（gm.log），不能按对象过滤，否则会把记录全丢掉 */
function copyGmLog(v, limit) {
    if (!Array.isArray(v)) return null;
    const out = [];
    for (const item of v.slice(-limit)) {
        if (typeof item === "string") out.push(item.slice(0, GM_STATE_STR));
    }
    return out;
}

function snapshot(room, token) {
    const members = [];
    for (const m of room.members.values()) {
        members.push({
            id: m.id,
            name: m.name,
            role: m.role,
            online: !!m.online,
            char: m.char,
            hasFull: m.full != null
        });
    }
    const gs = gmStateOf(room);
    const out = {
        code: room.code,
        name: room.name,
        round: room.round,
        note: room.note,
        members,
        // 主持人面板状态：客机只读展示，rev 用于客户端去重/排序
        state: {
            rev: gs.rev,
            round: room.round,
            note: str(room.note).slice(0, GM_STATE_NOTE),
            rules: normalizeRules(gs.rules),
            actions: gs.actions.slice(-GM_STATE_LIMIT.actions),
            rolls: gs.rolls.slice(-GM_STATE_LIMIT.rolls),
            enemies: gs.enemies.slice(-GM_STATE_LIMIT.enemies),
            log: gs.log.slice(-GM_STATE_LIMIT.log)
        }
    };
    if (token) {
        const me = room.members.get(token);
        if (me) out.me = { token, id: me.id, name: me.name, role: me.role, char: me.char, hasFull: me.full != null };
    }
    return out;
}

function onlineCount(room) {
    let n = 0;
    for (const m of room.members.values()) if (m.online) n++;
    return n;
}

/** 请求体（koa-bodyparser 只在 JSON 类型下填充，缺失时按空对象处理） */
function bodyOf(ctx) {
    const b = ctx.request.body;
    return b && typeof b === "object" ? b : {};
}

/** 查询参数（重复参数取第一个，与 URLSearchParams.get 一致） */
function queryValue(ctx, name) {
    const raw = ctx.query ? ctx.query[name] : "";
    return Array.isArray(raw) ? str(raw[0]) : str(raw);
}

function queryToken(ctx) {
    return queryValue(ctx, "token");
}

// === HTTP 响应（Koa ctx） ===
const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
};

function setCors(ctx) {
    for (const key of Object.keys(CORS)) ctx.set(key, CORS[key]);
}

function json(ctx, status, obj) {
    ctx.status = status;
    ctx.set("cache-control", "no-store");
    ctx.type = "application/json; charset=utf-8";
    ctx.body = obj;
}

function text(ctx, status, body) {
    ctx.status = status;
    ctx.set("cache-control", "no-store");
    ctx.type = "text/plain; charset=utf-8";
    ctx.body = body;
}

/** 把 coreXxx() 的 { status, data } 原样写回 HTTP（保持既有状态码/响应体） */
function reply(ctx, result) {
    return json(ctx, result.status, result.data);
}

// === 实时连接（SSE / WebSocket 统一客户端集合） ===
// 每条实时连接注册一个 Client：{ token, memberId, send(event, data), close() }。
// SSE 与 WS 只是 send/close 的实现不同，广播、定向推送、在线状态清理都走同一套逻辑。
function sseSend(res, event, data) {
    try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
        /* 断开的连接由 close 事件清理 */
    }
}

function broadcast(room, event, data, excludeToken) {
    for (const client of room.clients) {
        if (excludeToken && client.token === excludeToken) continue;
        client.send(event, data);
    }
}

function anyClientFor(room, token) {
    for (const client of room.clients) {
        if (client.token === token) return true;
    }
    return false;
}

/** 注册连接：入集合、置在线、首帧 snapshot、其他人收到 member 广播 */
function attachClient(room, member, client) {
    room.clients.add(client);
    const wasOnline = member.online;
    member.online = true;
    member.lastSeen = Date.now();
    room.lastActive = Date.now();

    client.send("snapshot", snapshot(room, member.token));
    if (!wasOnline) broadcast(room, "member", snapshot(room), member.token);
}

/** 注销连接：若该成员已无任何连接则置下线并广播（SSE / WS 共用） */
function detachClient(room, client) {
    if (!room.clients.delete(client)) return false;
    const member = room.members.get(client.token);
    if (!member || anyClientFor(room, client.token)) return false;
    if (!member.online) return false;

    member.online = false;
    member.lastSeen = Date.now();
    if (onlineCount(room) === 0) room.lastActive = Date.now();
    broadcast(room, "member", snapshot(room));
    return true;
}

// === 业务 ===
/** 按成员 id（不是 token）查找 */
function memberById(room, id) {
    const wanted = str(id);
    if (!wanted) return null;
    for (const m of room.members.values()) if (m.id === wanted) return m;
    return null;
}

function isGmToken(room, token) {
    const m = room.members.get(token);
    return !!m && m.role === "gm";
}

/**
 * char 事件只投递给主持人连接 + 目标成员自己的连接，避免角色卡泄露给其他玩家。
 * skipToken：发起本次写入的连接 token，用于跳过发起者自己（否则客户端会自激循环）。
 */
function sendCharEvent(room, target, char, byRole, mode, skipToken) {
    const payload = { memberId: target.id, char, by: byRole, mode: mode === "edit" ? "edit" : "hp" };
    for (const client of room.clients) {
        if (skipToken && client.token === skipToken) continue;
        if (client.token !== target.token && !isGmToken(room, client.token)) continue;
        client.send("char", payload);
    }
}

/**
 * 写入完整角色卡的核心逻辑（本人，或主持人代写任意成员）。
 * REST POST /char 与 WS `char.put` 共用，返回 { status, data }。
 */
function corePutChar(room, actor, body) {
    if (!actor) return { status: 403, data: { error: "无权修改该房间" } };

    let target = actor;
    const wantedId = str(body.memberId);
    if (wantedId && wantedId !== actor.id) {
        const found = memberById(room, wantedId);
        if (!found) return { status: 404, data: { error: "成员不存在" } };
        if (actor.role !== "gm") return { status: 403, data: { error: "只有主持人可以修改他人的角色卡" } };
        target = found;
    }

    const raw = body.char;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { status: 400, data: { error: "角色卡数据无效" } };
    }
    let serialized;
    try {
        serialized = JSON.stringify(raw);
    } catch {
        return { status: 400, data: { error: "角色卡数据无效" } };
    }
    if (typeof serialized !== "string") return { status: 400, data: { error: "角色卡数据无效" } };
    if (serialized.length > MAX_CHAR_JSON) return { status: 400, data: { error: "角色卡数据过大" } };

    // 局部上传（看板改血、改名等）不带 companions 键时，沿用上一次的随从列表，
    // 否则随从会从房间快照里整批消失；显式传空数组才表示“没有随从了”。
    const prevComps = (target.full && Array.isArray(target.full.companions))
        ? target.full.companions
        : ((target.char && Array.isArray(target.char.companions) && target.char.companions.length)
            ? target.char.companions
            : null);
    target.full = JSON.parse(serialized); // 存副本，避免请求体对象被外部改动
    if (prevComps && !Object.prototype.hasOwnProperty.call(target.full, "companions")) {
        target.full.companions = prevComps;
    }
    target.char = makeChar(target.full);  // 同步成员摘要，供其他客户端的成员列表展示
    target.lastSeen = Date.now();
    room.lastActive = Date.now();
    // 来源标记：hp = 看板血蓝类操作（自动生效），edit = 主持人手动编辑（玩家端需确认）
    const mode = body.mode === "edit" ? "edit" : "hp";
    // 跳过发起者（actor.token 在 REST 与 WS 两条路径上都是调用者本人的 token）
    sendCharEvent(room, target, target.full, actor.role, mode, actor.token);
    broadcast(room, "room", snapshot(room)); // 所有人刷新成员摘要（HP/名称/等级等）
    return { status: 200, data: { ok: true } };
}

/**
 * 读取完整角色卡的核心逻辑（本人，或主持人读任意成员）。
 * REST GET /char 与 WS `char.get` 共用。
 */
function coreGetChar(room, actor, body) {
    if (!actor) return { status: 403, data: { error: "无权访问该房间" } };

    let target = actor;
    const wantedId = str(body.memberId);
    if (wantedId && wantedId !== actor.id) {
        const found = memberById(room, wantedId);
        if (!found) return { status: 404, data: { error: "成员不存在" } };
        if (actor.role !== "gm") return { status: 403, data: { error: "只有主持人可以查看他人的角色卡" } };
        target = found;
    }
    return { status: 200, data: { memberId: target.id, char: target.full ?? null } };
}

/** POST /api/rooms/:code/char：写入完整角色卡（本人，或主持人代写任意成员） */
function putFullChar(ctx, room) {
    const body = bodyOf(ctx);
    const actor = room.members.get(str(body.token)) || null;
    return reply(ctx, corePutChar(room, actor, body));
}

/** GET /api/rooms/:code/char：读取完整角色卡（本人，或主持人读任意成员） */
function getFullChar(ctx, room) {
    const actor = room.members.get(queryToken(ctx)) || null;
    const body = { memberId: queryValue(ctx, "memberId") };
    return reply(ctx, coreGetChar(room, actor, body));
}

function createRoom(ctx) {
    const body = bodyOf(ctx);
    const char = makeChar(body.char);
    const room = {
        code: newCode(),
        name: cleanName(body.name, "未命名房间"),
        createdAt: Date.now(),
        gmToken: crypto.randomUUID(),
        round: 1,
        note: "",
        // 主持人面板状态（回合/备注之外的行动、投骰、敌人、日志），随快照广播给客机
        gmState: { rev: 0, actions: [], rolls: [], enemies: [], log: [], rules: { itemUseInCombat: "turn" } },
        members: new Map(),
        clients: new Set(),
        lastActive: Date.now()
    };
    const gmName = cleanName(body.memberName) || char.name || "主持人";
    const gm = makeMember(gmName, "gm", char, room.gmToken);
    gm.online = false; // 等实时连接（SSE / WS）建立后再置 online
    room.members.set(room.gmToken, gm);
    rooms.set(room.code, room);
    json(ctx, 200, { code: room.code, gmToken: room.gmToken, name: room.name, url: "/" });
}

function joinRoom(ctx, room) {
    if (room.members.size >= MAX_MEMBERS) {
        return json(ctx, 409, { error: "房间已满（最多 12 人）" });
    }
    const body = bodyOf(ctx);
    // 权限：加入者一律是 player（忽略 body.role）。role:"gm" 只能由 createRoom 产生，
    // 所以房间里永远不会出现第二个 gm 成员。
    const token = crypto.randomUUID();
    const member = makeMember(body.name, "player", body.char, token);
    room.members.set(token, member);
    member.online = false; // 以实时连接（SSE / WS）为准
    room.lastActive = Date.now();
    broadcast(room, "room", snapshot(room));
    json(ctx, 200, { token, memberId: member.id, room: snapshot(room, token) });
}

/** 面板状态整包上行：先卡体积，避免一次请求塞爆内存/带宽（REST 与 WS 共用） */
function bodyTooLarge(body) {
    let bodySize = 0;
    try { bodySize = JSON.stringify(body).length; } catch { bodySize = 0; }
    return bodySize > MAX_GM_STATE_BODY;
}

/**
 * 更新房间状态的核心逻辑。REST POST /update 与 WS `update` 共用。
 * body 可以是 { token, patch }（REST）或直接是 patch 字段的顶层对象（WS payload）。
 */
function coreUpdate(room, member, body) {
    if (bodyTooLarge(body)) return { status: 413, data: { error: "状态过大" } };
    if (!member) return { status: 403, data: { error: "无权修改该房间" } };

    const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
    // 兼容两种写法：老调用放在 patch 里，主持人状态同步直接放顶层（也可以放 patch 里）
    const pick = (key) => (patch[key] !== undefined ? patch[key] : body[key]);
    if (member.role !== "gm" && (patch.round !== undefined || patch.note !== undefined || body.round !== undefined || body.note !== undefined
        || patch.rules !== undefined || body.rules !== undefined)) {
        return { status: 403, data: { error: "只有主持人可以修改轮次和备注" } };
    }

    if (member.role === "gm") {
        const gs = gmStateOf(room);
        // rules 也参与比较：只改规则时 rev 必须推进，否则客机会按下行 rev 丢弃快照
        const before = JSON.stringify({ round: room.round, note: room.note, rules: normalizeRules(gs.rules), actions: gs.actions, rolls: gs.rolls, enemies: gs.enemies, log: gs.log });
        if (pick("round") !== undefined) {
            const r = Math.round(num(pick("round")));
            if (Number.isFinite(r)) room.round = Math.max(1, Math.min(9999, r));
        }
        if (pick("note") !== undefined) room.note = str(pick("note")).slice(0, GM_STATE_NOTE);
        // 非数组一律忽略；数组元素必须是对象，做安全拷贝并截断长度/字符串
        for (const key of Object.keys(GM_STATE_LIMIT)) {
            const src = pick(key);
            const list = key === "log" ? copyGmLog(src, GM_STATE_LIMIT[key]) : copyGmList(src, GM_STATE_LIMIT[key]);
            if (list) gs[key] = list;
        }
        // 规则是白名单字段，不走上面的数组循环；认 itemUseInCombat（新）或 noUseInCombat（旧客户端）
        const rulesSrc = pick("rules");
        if (rulesSrc && typeof rulesSrc === "object" && !Array.isArray(rulesSrc)
            && ("itemUseInCombat" in rulesSrc || "noUseInCombat" in rulesSrc)) {
            gs.rules = normalizeRules(rulesSrc);
        }
        const after = JSON.stringify({ round: room.round, note: room.note, rules: normalizeRules(gs.rules), actions: gs.actions, rolls: gs.rolls, enemies: gs.enemies, log: gs.log });
        if (before !== after) gs.rev += 1; // 实质变化才推进版本，客户端据此去重
    }
    if (patch.char !== undefined) member.char = makeChar(patch.char);

    member.lastSeen = Date.now();
    room.lastActive = Date.now();
    const snap = snapshot(room);
    broadcast(room, "room", snap);
    return { status: 200, data: { ok: true, room: snap } };
}

function updateRoom(ctx, room) {
    const body = bodyOf(ctx);
    const member = room.members.get(str(body.token)) || null;
    return reply(ctx, coreUpdate(room, member, body));
}

/** 发通知的核心逻辑（仅主持人）。REST POST /notice 与 WS `notice` 共用。 */
function coreNotice(room, member, body) {
    if (!member || member.role !== "gm") return { status: 403, data: { error: "只有主持人可以发通知" } };
    const textValue = str(body.text).trim().slice(0, 200);
    if (!textValue) return { status: 400, data: { error: "通知内容为空" } };

    member.lastSeen = Date.now();
    room.lastActive = Date.now();
    const payload = { text: textValue, from: member.name, at: Date.now() };
    broadcast(room, "notice", payload);
    return { status: 200, data: { ok: true, notice: payload } };
}

function noticeRoom(ctx, room) {
    const body = bodyOf(ctx);
    const member = room.members.get(str(body.token)) || null;
    return reply(ctx, coreNotice(room, member, body));
}

/** 成员上报允许的结算效果 */
const SUBMIT_EFFECTS = new Set(["damage", "heal", "buff", ""]);
const SUBMIT_NUM_MAX = 1e12;

/** 轮次：缺省用 fallback，夹取到 1..999999 */
function clampRound(v, fallback) {
    const missing = v === undefined || v === null || v === "";
    const n = Math.round(num(missing ? fallback : v));
    return Math.max(1, Math.min(999999, Number.isFinite(n) ? n : 1));
}

/** 数值：夹取到 ±1e12 */
function clampNum(v) {
    const n = num(v);
    return Math.max(-SUBMIT_NUM_MAX, Math.min(SUBMIT_NUM_MAX, n));
}

/** 时间戳：缺省当前时间，非负整数 */
function clampAt(v) {
    if (v === undefined || v === null || v === "") return Date.now();
    const n = Math.round(num(v));
    return Number.isFinite(n) && n >= 0 ? n : Date.now();
}

/** 上报项 id：≤32 字符，空则新生成 */
function submitId(v) {
    return str(v).trim().slice(0, 32) || newId();
}

/** 按 id upsert：同 id 覆盖，否则追加；超过 limit 只保留最近 limit 条 */
function upsertSubmitItem(list, item, limit) {
    const idx = list.findIndex((x) => x && typeof x === "object" && x.id === item.id);
    if (idx >= 0) list[idx] = item;
    else list.push(item);
    if (list.length > limit) list.splice(0, list.length - limit);
}

/**
 * 成员上报的核心逻辑：身份完全由 member（token 推导）决定，忽略 body 里的 memberId / 角色。
 * REST POST /submit 与 WS `submit` 共用。
 */
function coreSubmit(room, member, body) {
    try {
        if (bodyTooLarge(body)) return { status: 413, data: { error: "状态过大" } };
        if (!member) return { status: 403, data: { error: "无效的成员凭证" } };

        const kind = str(body.kind).trim();
        if (kind !== "action" && kind !== "roll" && kind !== "remove") return { status: 400, data: { error: "只支持 action / roll / remove" } };

        const raw = body.item && typeof body.item === "object" && !Array.isArray(body.item) ? body.item : {};
        // 角色名一律取服务端成员身份，忽略客户端传值
        const charName = (cleanName(member.char && member.char.name) || member.name || "").slice(0, 40);
        // 角色卡 id 只接受成员自己指向的（不给客户端指定他人 id 的余地）
        const allowedCharId = str(raw.charId).trim().slice(0, 64);

        const gs = gmStateOf(room);
        let saved;
        if (kind === "remove") {
            // 撤回/移除：按 id 删掉一条自己（主持人可删任意）上报的条目
            const listName = str(raw.list).trim();
            if (listName !== "actions" && listName !== "rolls") return { status: 400, data: { error: "列表名必须是 actions 或 rolls" } };
            const targetId = str(raw.id).trim().slice(0, 32);
            if (!targetId) return { status: 400, data: { error: "缺少条目 id" } };

            const arr = gs[listName];
            const idx = arr.findIndex((x) => x && typeof x === "object" && x.id === targetId);
            // 找不到就当已经删掉：幂等，不报错
            if (idx < 0) return { status: 200, data: { ok: true, removed: false } };

            const entry = arr[idx];
            if (member.role !== "gm" && (!entry || entry.memberId !== member.id)) {
                return { status: 403, data: { error: "无权删除他人条目" } };
            }

            arr.splice(idx, 1);
            member.lastSeen = Date.now();
            room.lastActive = Date.now();
            gs.rev += 1;
            broadcast(room, "room", snapshot(room));
            return { status: 200, data: { ok: true, removed: true } };
        }
        if (kind === "action") {
            const effect = str(raw.effect).trim();
            saved = {
                id: submitId(raw.id),
                // 回合号一律以服务端为准：客户端本地回合同步落后时，条目仍挂在当前回合，其他人才能看到
                round: room.round,
                charId: allowedCharId,
                charName,
                type: str(raw.type).trim().slice(0, 16),
                skillName: str(raw.skillName).trim().slice(0, 60),
                itemName: str(raw.itemName).trim().slice(0, 60),
                target: str(raw.target).trim().slice(0, 64),
                targetId: str(raw.targetId).trim().slice(0, 64),
                text: str(raw.text).trim().slice(0, 200),
                effect: SUBMIT_EFFECTS.has(effect) ? effect : "",
                amount: clampNum(raw.amount),
                at: clampAt(raw.at),
                settled: false,
                buff: raw.buff && typeof raw.buff === "object" && !Array.isArray(raw.buff) ? { ...raw.buff } : null,
                memberId: member.id
            };
            upsertSubmitItem(gs.actions, saved, GM_STATE_LIMIT.actions);
        } else {
            saved = {
                id: submitId(raw.id),
                // 同上：掷骰回合号强制取服务端当前回合
                round: room.round,
                charId: allowedCharId,
                charName,
                kind: str(raw.kind !== undefined ? raw.kind : raw.type).trim().slice(0, 16),
                detail: str(raw.detail).trim().slice(0, 120),
                total: clampNum(raw.total),
                at: clampAt(raw.at),
                memberId: member.id
            };
            upsertSubmitItem(gs.rolls, saved, GM_STATE_LIMIT.rolls);
        }

        member.lastSeen = Date.now();
        room.lastActive = Date.now();
        gs.rev += 1;
        broadcast(room, "room", snapshot(room));
        return { status: 200, data: { ok: true, id: saved.id, rev: gs.rev } };
    } catch {
        return { status: 400, data: { error: "上报失败" } };
    }
}

function submitMember(ctx, room) {
    const body = bodyOf(ctx);
    const member = room.members.get(str(body.token).trim()) || null;
    return reply(ctx, coreSubmit(room, member, body));
}

/**
 * 离开房间的核心逻辑（gm 解散 / 成员离开）。REST POST /leave 与 WS `leave` 共用。
 * except：发起本次离开的 WS 连接，由调用方先回响应再关闭，避免响应发不出去。
 */
function coreLeave(room, member, except) {
    if (!member) return { status: 404, data: { error: "成员不存在" } };

    const token = member.token;
    // 关闭该成员所有实时连接（SSE / WS），并立刻从集合里移除
    for (const client of [...room.clients]) {
        if (client.token !== token || client === except) continue;
        room.clients.delete(client);
        try { client.close(); } catch { /* ignore */ }
    }

    room.members.delete(token);
    member.online = false;
    room.lastActive = Date.now();
    broadcast(room, "room", snapshot(room));
    return { status: 200, data: { ok: true } };
}

function leaveRoom(ctx, room) {
    const body = bodyOf(ctx);
    const member = room.members.get(str(body.token)) || null;
    return reply(ctx, coreLeave(room, member));
}

// SSE：绕过 Koa 的 body 缓冲，直接写原生 res。
function streamRoom(ctx, room) {
    const token = queryToken(ctx);
    const member = room.members.get(token);
    if (!member) return json(ctx, 403, { error: "无权访问该房间" });

    const res = ctx.res;
    const req = ctx.req;

    ctx.respond = false; // 交给原生 res：长连接不能被 Koa 缓冲/关闭
    res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
        ...CORS
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    // SSE 适配器：与 WS 客户端共用同一套在线/广播逻辑
    const client = {
        token,
        memberId: member.id,
        send: (event, data) => sseSend(res, event, data),
        close: () => { try { res.end(); } catch { /* ignore */ } }
    };

    // 1) 立即给自己的快照（含 me）
    // 2) 让其他人知道这个成员上线了
    attachClient(room, member, client);

    const ping = setInterval(() => {
        try { res.write(": ping\n\n"); } catch { /* ignore */ }
    }, 15000);
    if (typeof ping.unref === "function") ping.unref();

    let closed = false;
    const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        detachClient(room, client);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    req.on("aborted", cleanup);
}

// === 路由 ===
async function serveHtml(ctx) {
    let html;
    try {
        html = await readFile(INDEX_PATH);
    } catch {
        return text(ctx, 500, "index.html 不存在，请检查源码目录");
    }
    ctx.status = 200;
    ctx.set("cache-control", "no-store, no-cache, must-revalidate");
    ctx.set("content-type", "text/html; charset=utf-8");
    ctx.body = html;
}

function mimeOf(file) {
    const name = String(file || "").toLowerCase();
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "";
    return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * 把请求路径映射成磁盘文件；任何不合法/越界请求返回 null（调用方按 404 处理）。
 * 只允许 /js/<名字>、/css/<名字> 与 /favicon.ico，不接受子目录、反斜杠、上跳或绝对路径。
 */
function safeStaticPath(rawPath) {
    const raw = str(rawPath);
    if (!raw || raw.length > 512) return null;
    // 原始路径里出现编码/转义痕迹直接拒绝，避免 %2e%2e、%5c 之类绕过
    if (raw.includes("\\") || raw.includes("\0")) return null;

    let decoded;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null;
    }
    // 解码后再校验一次（挡住 %2e%2e / %5c / %2f 编码绕过）
    if (!decoded.startsWith("/")) return null;
    if (decoded.includes("\\") || decoded.includes("\0") || decoded.includes("%")) return null;

    const parts = decoded.slice(1).split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) return null;

    if (parts.length === 1) {
        if (parts[0] !== "favicon.ico") return null;
        return insideRoot(join(ROOT, "favicon.ico"));
    }
    if (parts.length !== 2 || !STATIC_DIRS.has(parts[0])) return null;

    const name = parts[1];
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return null;
    return insideRoot(join(ROOT, parts[0], name));
}

/** 解析后必须仍在项目根目录内 */
function insideRoot(full) {
    const abs = resolve(full);
    const root = resolve(ROOT);
    const prefix = root.endsWith(sep) ? root : root + sep;
    return abs.startsWith(prefix) ? abs : null;
}

const STATIC_RE = /^\/(?:js|css)\/[^/]+\/?$|^\/favicon\.ico$/;

async function serveStatic(ctx, file) {
    let data;
    try {
        data = await readFile(file);
    } catch {
        return text(ctx, 404, "404 Not Found");
    }
    ctx.status = 200;
    ctx.set("cache-control", "no-store");
    ctx.set("content-type", mimeOf(file));
    ctx.body = data;
}

// 校验 :code，取房间；失败时已写好响应并返回 null
function lookupRoom(ctx) {
    const raw = str(ctx.params.code);
    if (!/^[A-Za-z0-9]+$/.test(raw)) {
        json(ctx, 404, { error: "接口不存在" });
        return null;
    }
    const room = rooms.get(raw.toUpperCase());
    if (!room) {
        json(ctx, 404, { error: "房间不存在" });
        return null;
    }
    return room;
}

const router = new Router({ sensitive: true });

router.get("/", serveHtml);
router.head("/", serveHtml);
router.all("/", (ctx) => text(ctx, 405, "405 Method Not Allowed"));

router.all("/api/rooms", (ctx) => {
    if (ctx.method === "POST") return createRoom(ctx);
    return json(ctx, 405, { error: "方法不支持" });
});

router.all("/api/rooms/:code", (ctx) => {
    const room = lookupRoom(ctx);
    if (!room) return;
    if (ctx.method !== "GET") return json(ctx, 405, { error: "方法不支持" });
    return json(ctx, 200, snapshot(room));
});

router.all("/api/rooms/:code/:action", (ctx) => {
    const room = lookupRoom(ctx);
    if (!room) return;
    switch (ctx.params.action) {
        case "join":
            if (ctx.method === "POST") return joinRoom(ctx, room);
            break;
        case "update":
            if (ctx.method === "POST") return updateRoom(ctx, room);
            break;
        case "notice":
            if (ctx.method === "POST") return noticeRoom(ctx, room);
            break;
        case "submit":
            if (ctx.method === "POST") return submitMember(ctx, room);
            break;
        case "char":
            if (ctx.method === "POST") return putFullChar(ctx, room);
            if (ctx.method === "GET") return getFullChar(ctx, room);
            break;
        case "leave":
            if (ctx.method === "POST") return leaveRoom(ctx, room);
            break;
        case "stream":
            if (ctx.method === "GET") return streamRoom(ctx, room);
            break;
        default:
            break;
    }
    return json(ctx, 404, { error: "接口不存在" });
});

// === 应用 ===
const app = new Koa();

// 统一错误处理：路由内已设置的状态码保持不变，抛出的错误转成 JSON
app.use(async (ctx, next) => {
    try {
        await next();
    } catch (e) {
        if (ctx.res.headersSent || ctx.respond === false) return;
        const status = Number(e && e.status) || 500;
        if (status >= 400 && status < 500) {
            const msg = str(e && e.message);
            const tooLarge = Number(e && e.status) === 413 || /too large|entity\.too\.large/i.test(msg);
            return json(ctx, 400, { error: tooLarge ? "请求体过大" : "JSON 解析失败" });
        }
        return json(ctx, 500, { error: str(e && e.message) || "服务器内部错误" });
    }
});

// 全局 CORS + OPTIONS 预检直接 204
app.use(async (ctx, next) => {
    setCors(ctx);
    if (ctx.method === "OPTIONS") {
        ctx.status = 204;
        return;
    }
    await next();
});

app.use(bodyParser({ enableTypes: ["json"], jsonLimit: MAX_BODY }));

// 静态资源：仅 js/、css/ 与根 favicon.ico；其余路径交给路由/兜底 404
app.use(async (ctx, next) => {
    if (ctx.method !== "GET" && ctx.method !== "HEAD") return next();
    if (!STATIC_RE.test(ctx.path)) return next();
    const file = safeStaticPath(ctx.path);
    if (!file) return text(ctx, 404, "404 Not Found");
    await serveStatic(ctx, file);
});

app.use(router.routes());

// 兜底：/api/* 统一 JSON 404，其余路径纯文本 404
app.use(async (ctx) => {
    if (ctx.path === "/api" || ctx.path.startsWith("/api/")) {
        return json(ctx, 404, { error: "接口不存在" });
    }
    return text(ctx, 404, "404 Not Found");
});

// === WebSocket 实时通道 ===
// 地址：ws(s)://<host>/ws?token=<memberToken>；只接受 pathname === "/ws" 的 upgrade。
/** token 全局唯一，按 token 反查房间与成员（WS 地址只带 token，不带房间码） */
function findByToken(token) {
    const wanted = str(token).trim();
    if (!wanted) return null;
    for (const room of rooms.values()) {
        const member = room.members.get(wanted);
        if (member) return { room, member };
    }
    return null;
}

function tokenOfRequest(req) {
    try {
        return str(new URL(req.url || "/", "http://localhost").searchParams.get("token")).trim();
    } catch {
        return "";
    }
}

function wsSendJson(ws, obj) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* 断线由 close 事件清理 */ }
}

/** REST 状态码 → WS 错误码（与现有语义一致） */
function wsErrorCode(status) {
    if (status === 403) return "forbidden";
    if (status === 404) return "not_found";
    if (status === 413) return "too_large";
    if (status === 500) return "internal";
    return "bad_request";
}

/** 请求/响应：同一 id 回 {id, ok:true, data} 或 {id, ok:false, error} */
function wsReply(ws, id, result) {
    const ok = result.status >= 200 && result.status < 300;
    if (ok) return wsSendJson(ws, { id, ok: true, data: result.data });
    const message = str(result.data && result.data.error) || "请求失败";
    return wsSendJson(ws, { id, ok: false, error: { code: wsErrorCode(result.status), message } });
}

/** WS 请求分发：全部复用 REST 的 coreXxx()，不出现第二套规则 */
function wsDispatch(room, member, type, payload, client) {
    switch (type) {
        case "snapshot": return { status: 200, data: snapshot(room, member.token) };
        case "update": return coreUpdate(room, member, payload);
        case "submit": return coreSubmit(room, member, payload);
        case "notice": return coreNotice(room, member, payload);
        case "char.put": return corePutChar(room, member, payload);
        case "char.get": return coreGetChar(room, member, payload);
        case "leave": return coreLeave(room, member, client);
        default: return { status: 400, data: { error: "不支持的消息类型" } };
    }
}

const server = http.createServer(app.callback());
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
        pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
        pathname = "";
    }
    if (pathname !== "/ws") {
        // 非 /ws 的 upgrade 一律拒绝
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});

wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    const token = tokenOfRequest(req);
    const found = findByToken(token);
    if (!found) {
        // 先发错误帧，再以 4001 关闭
        wsSendJson(ws, { type: "error", error: { code: "unauthorized", message: "无效的成员凭证" } });
        try { ws.close(WS_UNAUTHORIZED, "unauthorized"); } catch { /* ignore */ }
        return;
    }

    const { room, member } = found;
    const client = {
        token,
        memberId: member.id,
        send: (event, data) => wsSendJson(ws, { type: event, data }),
        close: () => { try { ws.close(); } catch { /* ignore */ } }
    };

    // 首帧 snapshot + 置在线 + member 广播（与 SSE 完全一致）
    attachClient(room, member, client);
    console.log(`[ws] 已连接 ${member.name}（房间 ${room.code}，在线 ${onlineCount(room)}）`);

    ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
            msg = JSON.parse(String(raw));
        } catch {
            wsSendJson(ws, { type: "error", error: { code: "bad_request", message: "消息格式错误" } });
            return;
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
            wsSendJson(ws, { type: "error", error: { code: "bad_request", message: "消息格式错误" } });
            return;
        }
        const id = str(msg.id);
        if (!id) return; // 客户端主动推送/心跳类消息没有请求 id，忽略
        const type = str(msg.type);
        const payload = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? msg.payload : {};

        const result = wsDispatch(room, member, type, payload, client);
        wsReply(ws, id, result);

        if (type === "leave" && result.status === 200) {
            detachClient(room, client); // 成员已删除，这里只把自己移出集合
            try { ws.close(1000, "left"); } catch { /* ignore */ }
        }
    });

    ws.on("close", () => {
        detachClient(room, client);
        console.log(`[ws] 已断开 ${member.name}（房间 ${room.code}，在线 ${onlineCount(room)}）`);
    });
    ws.on("error", () => { /* 由 close 清理 */ });
});

// 心跳：30s ping，未回 pong 的连接直接终止
const wsHeartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch { ws.terminate(); }
    }
}, WS_HEARTBEAT_MS);
if (typeof wsHeartbeat.unref === "function") wsHeartbeat.unref();

// 空闲房间清理
const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
        if (onlineCount(room) === 0 && now - (room.lastActive || room.createdAt) > IDLE_MS) {
            for (const client of [...room.clients]) {
                room.clients.delete(client);
                try { client.close(); } catch { /* ignore */ }
            }
            rooms.delete(code);
        }
    }
}, SWEEP_MS);
if (typeof sweep.unref === "function") sweep.unref();

server.listen(PORT, "0.0.0.0", () => {
    const lines = [`房间服务已启动，监听 0.0.0.0:${PORT}`];
    lines.push(`本机地址：http://localhost:${PORT}`);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const n of nets[name] || []) {
            if (n.family === "IPv4" && !n.internal) lines.push(`局域网地址：http://${n.address}:${PORT}`);
        }
    }
    lines.push("手机/其他电脑用局域网地址打开，主持人面板在页面顶部切换");
    console.log(lines.join("\n"));
});