// === 主持人面板 ===
// 独立于所有角色卡：数据单独存在 localStorage（jigerpg_gm_v1），不占用角色列表。
// 目前是单机版：队伍看板 / 遭遇管理 / 主持人骰子 / 场景回合。
// 以后加联机时，这里的 gm 数据可以直接作为房间状态同步。
import { LIMITS, FINAL_MIN, FINAL_MAX, clampNum, clampInt } from "./limits.js";
import { charList, activeCharId } from "./state.js";
import { esc, makeId, rollOne } from "./util.js";
import { loadRawChar, saveRawChar, switchCharacter, page, pushHpToOwner, loadActiveCharacter } from "./persist.js";
import { roomSession, roomSnapshot, roomMyMemberId, roomIsGm, roomPushGmState, roomPushCharTo } from "./room.js";
import { computeSnapshotWithOwner } from "./compute.js";
import { computeCompanion } from "./companion.js";
import { normalizeBuff } from "./core.js";
import { barNameOf, adjustCustomBar, syncBarLinks, applyBarGain, absorbShields } from "./bar_link.js";
import { openGmBuffModal } from "./skills_buffs.js";
import { openGmItemModal } from "./items_gear_ui.js";
import { parseDiceExpr } from "./combat_dice.js";

const GM_KEY = "jigerpg_gm_v1";
const VIEW_KEY = "jigerpg_view_v1";

function defaultGm() {
    // rules：房间规则。itemUseInCombat 三档 = 战斗中消耗品算一回合 / 自由使用 / 禁止使用，
    // 上行字段名固定为 rules（旧版 noUseInCombat 只在 loadGm/applyRemoteGmState 里做兼容）
    return {
        enemies: [], round: 1, note: "", log: [], actions: [], calcs: [], rolls: [],
        itemPresets: [], buffPresets: [],
        rules: { itemUseInCombat: "turn" }
    };
}

// 玩家每回合提交一次行动。放在主持人数据里 = 房间状态：以后联机时玩家提交、主持人结算，
// 换成本地单机也只是同一条链路。
const ACTION_TYPES = { attack: "⚔ 攻击", skill: "✨ 技能", item: "🧪 使用物品", defend: "🛡 防御", move: "🏃 移动", other: "🌀 其他" };

function normalizeAction(a) {
    const s = (a && typeof a === "object") ? a : {};
    const effect = s.effect === "damage" || s.effect === "heal" || s.effect === "buff" ? s.effect : "";
    return {
        id: String(s.id || "") || makeId(),
        round: clampInt(s.round, 1, 999999, 1),
        charId: String(s.charId || "").slice(0, 64),
        charName: String(s.charName || "").trim().slice(0, 40) || "角色",
        type: Object.prototype.hasOwnProperty.call(ACTION_TYPES, s.type) ? s.type : "other",
        target: String(s.target || "").slice(0, 64),
        text: String(s.text || "").trim().slice(0, 200),
        at: clampInt(s.at, 0, 9999999999999, 0),
        // 技能行动：带公式掷出的结果，主持人可以一键结算
        skillName: String(s.skillName || "").slice(0, 60),
        // 物品行动：客户端 #modalItem 的 useEffect/useAmount/useTarget 带过来的字段快照
        itemName: String(s.itemName || "").trim().slice(0, 60),
        effect,
        targetId: String(s.targetId || "").slice(0, 64),
        amount: clampInt(s.amount, 0, LIMITS.hpMp[1], 0),
        settled: s.settled === true,
        // 客户端已经即时生效（老式自用消耗品）：主持人只需标记结算，不能再加一次
        preApplied: s.preApplied === true,
        // 服务端写入的提交人：必须原样保留，否则主持人全量回推会冲掉归属，玩家撤回自己的行动会被 403
        memberId: String(s.memberId || "").slice(0, 32),
        // 施加状态类技能：把模板快照一起带过来，主持人不需要读施法者的库
        buff: (s.buff && typeof s.buff === "object") ? normalizeBuff(s.buff) : null
    };
}

let gm = defaultGm();

// 主持人面板状态实时同步：saveGm → 400ms 防抖上行；appliedGmRev 是客机端已应用的最高版本
let gmPushTimer = 0;
let appliedGmRev = -1;
// 换房/服务器重启后 rev 会从小数字重新开始：记住已应用的房间码，换房时把 rev 归零重来
let appliedGmRevCode = "";
// 每次进入新房间后至少推一次全量状态：否则客机要等主持人下一次操作才看到已有面板数据
let gmPushedCode = "";

// ---------- 本地角色卡改动 → 推回房间 ----------
// 队伍看板改 HP / 挂状态 / 结算技能都只写 localStorage，客机看不到主持人自己角色的变化。
// 主持人在房间里时，写盘后按角色 id 防抖 250ms 把完整卡推回自己名下（服务端允许主持人写自己）。
const roomSyncTimers = new Map();

function syncLocalCharToRoom(id, data) {
    if (!data || typeof data !== "object") return;
    if (!roomSession() || !roomIsGm()) return;
    // 镜像角色由“编辑角色卡”链路单独处理，这里推全会顶掉主持人自己的卡
    if (data.remoteMirror) return;
    // 随从（带 ownerId）不是主持人自己的角色卡，推上去会把主人顶成随从数据
    if (data.ownerId) return;
    // 只同步“当前激活的主角色”：副角色/备用卡也不能借用主持人自己的卡位
    if (String(id) !== String(activeCharId)) return;
    // 额外保险：该 id 必须真的是 charList 里的角色卡
    if (!Array.isArray(charList) || !charList.some(c => c && String(c.id) === String(id))) return;
    const mid = roomMyMemberId();
    if (!mid) return;
    clearTimeout(roomSyncTimers.get(id));
    roomSyncTimers.set(id, setTimeout(() => {
        roomSyncTimers.delete(id);
        // 桥接层把 roomPushCharTo 挂到 globalThis；单测里可能只有模块导出，故两者取其一
        const push = globalThis.roomPushCharTo || roomPushCharTo;
        Promise.resolve(push?.(mid, data, "hp")).catch(() => { });
    }, 250));
}

function saveCharAndSync(id, data) {
    saveRawChar(id, data);
    syncLocalCharToRoom(id, data);
}

// 随从 HP 归零 → 直接退出参战（主角的 outOfCombat 不动）。
// 返回是否修改了数据，方便调用方判断 eslint/写回；不改动传入对象以外的任何东西。
function dropDeadCompanion(data) {
    if (!data || data.type !== "companion") return false;
    if (!(Number(data.hp) <= 0)) return false;
    if (data.combat === false) return false;
    data.combat = false;
    return true;
}

function normalizeEnemy(e) {
    const s = (e && typeof e === "object") ? e : {};
    const maxHp = clampNum(s.maxHp, LIMITS.enemyHp[0] + 1, LIMITS.enemyHp[1], 10);
    return {
        id: String(s.id || "") || makeId(),
        name: String(s.name || "").trim().slice(0, 40) || "敌人",
        icon: String(s.icon || "").trim().slice(0, 4) || "👹",
        hp: clampNum(s.hp, 0, maxHp, maxHp),
        maxHp,
        ac: clampNum(s.ac, LIMITS.enemyAc[0], LIMITS.enemyAc[1], 10),
        init: clampNum(s.init, -999, 9999, 0),
        note: String(s.note || "").slice(0, 200)
    };
}

// 伤害计算器条目：一条 = 一种攻击（很多怪就多加几条），公式存在 GM 存档里，不用反复填
function normalizeCalc(c) {
    const s = (c && typeof c === "object") ? c : {};
    return {
        id: String(s.id || "") || makeId(),
        name: String(s.name || "").trim().slice(0, 40) || "攻击",
        formula: String(s.formula || "").trim().slice(0, 40) || "1d6",
        times: clampInt(s.times, 1, 50, 1),
        targetId: String(s.targetId || "").slice(0, 64),
        // 命中：怪物/陷阱攻击玩家时，先掷 d20+命中加值 vs 目标 AC，未命中不结算伤害
        hit: s.hit === true,
        atkMod: clampInt(s.atkMod, LIMITS.diceMod[0], LIMITS.diceMod[1], 0)
    };
}

// 投骰审计：玩家每次投骰都记一条，主持人能看见本回合投了多少次、投出什么，
// 防止「一直重摇直到出大数字」。存在 GM 数据里 = 将来联机的房间状态。
const ROLL_KINDS = { dice: "🎲 投掷", adv: "⬆ 优势", dis: "⬇ 劣势", check: "🎯 检定", attack: "⚔ 攻击骰", damage: "💥 伤害", skill: "✨ 技能" };
const ROLL_SHOW = 20;

function normalizeRoll(r) {
    const s = (r && typeof r === "object") ? r : {};
    return {
        id: String(s.id || "") || makeId(),
        round: clampInt(s.round, 1, 999999, 1),
        charId: String(s.charId || "").slice(0, 64),
        charName: String(s.charName || "").trim().slice(0, 40) || "角色",
        kind: Object.prototype.hasOwnProperty.call(ROLL_KINDS, s.kind) ? s.kind : "dice",
        detail: String(s.detail || "").trim().slice(0, 120),
        total: clampNum(s.total, FINAL_MIN, FINAL_MAX, 0),
        at: clampInt(s.at, 0, 9999999999999, 0),
        // 同 action：保留服务端写入的提交人，避免回推时归属被冲掉
        memberId: String(s.memberId || "").slice(0, 32)
    };
}

export function loadGm() {
    try {
        const raw = localStorage.getItem(GM_KEY);
        const data = raw ? JSON.parse(raw) : null;
        gm = { ...defaultGm(), ...(data && typeof data === "object" ? data : {}) };
    } catch (e) { gm = defaultGm(); }
    if (!Array.isArray(gm.enemies)) gm.enemies = [];
    if (!Array.isArray(gm.log)) gm.log = [];
    gm.enemies = gm.enemies.slice(0, 60).filter(e => e && typeof e === "object").map(normalizeEnemy);
    gm.log = gm.log.slice(-60).map(x => String(x).slice(0, 200));
    gm.round = clampInt(gm.round, 1, 999999, 1);
    gm.note = String(gm.note || "").slice(0, 20000);
    if (!Array.isArray(gm.actions)) gm.actions = [];
    // 只保留当前回合的行动：旧回合的行动说明主持人已经结算过了
    gm.actions = gm.actions.slice(-80)
        .filter(a => a && typeof a === "object")
        .map(normalizeAction)
        .filter(a => a.round === gm.round);
    if (!Array.isArray(gm.calcs)) gm.calcs = [];
    gm.calcs = gm.calcs.slice(-24).filter(c => c && typeof c === "object").map(normalizeCalc);
    if (!Array.isArray(gm.rolls)) gm.rolls = [];
    // 只保留当前回合的投骰记录：新回合开始时主持人已看过上一回合
    gm.rolls = gm.rolls.slice(-200)
        .filter(r => r && typeof r === "object")
        .map(normalizeRoll)
        .filter(r => r.round === gm.round);
    // 预设物品库：主持人（商人/NPC）反复发放同一种物品，不用每次重填
    if (!Array.isArray(gm.itemPresets)) gm.itemPresets = [];
    gm.itemPresets = gm.itemPresets.slice(-100)
        .filter(p => p && typeof p === "object")
        .map(normalizeItemPreset);
    // 派发 Buff 的公共库：主持人建的模板对所有角色可用，不再绑在某个角色身上
    if (!Array.isArray(gm.buffPresets)) gm.buffPresets = [];
    gm.buffPresets = gm.buffPresets.slice(-200)
        .filter(p => p && typeof p === "object")
        .map(normalizeBuffPreset);
    // 房间规则：三档 itemUseInCombat；旧存档的 noUseInCombat=false 兼容成 free，其余按 turn
    {
        const r = (gm.rules && typeof gm.rules === "object") ? gm.rules : {};
        gm.rules = {
            itemUseInCombat: r.itemUseInCombat === "free" || r.itemUseInCombat === "blocked"
                ? r.itemUseInCombat
                : (r.noUseInCombat === false ? "free" : "turn")
        };
    }
    return gm;
}

export function saveGm() {
    try { localStorage.setItem(GM_KEY, JSON.stringify(gm)); } catch (e) { }
    queueGmStateSync();
}

// ---------- 主持人面板状态实时广播 ----------
// 只同步客机需要看的展示字段；calcs / itemPresets / buffPresets / 背包等主持人私有数据不上行。
// 一次操作往往连续调用 saveGm（例如 gmLog + 业务保存），用 400ms 防抖合并成一次请求。
function queueGmStateSync() {
    if (!roomIsGm() || !roomSession()) return;
    if (gmPushTimer) clearTimeout(gmPushTimer);
    gmPushTimer = setTimeout(() => {
        gmPushTimer = 0;
        roomPushGmState({
            round: gm.round,
            note: gm.note,
            actions: gm.actions,
            rolls: gm.rolls,
            enemies: gm.enemies,
            log: gm.log,
            rules: gm.rules
        }).catch(() => { });
    }, 400);
}

// 刚提交、服务端快照还没回显的条目最多保留这么久（见 applyRemoteGmState）
const LOCAL_PENDING_MS = 20000;

/**
 * 客机端：把主持人广播来的面板状态写进内存里的 gm 并重画（绝不写 localStorage）。
 * rev 去重，重复/过期的快照直接跳过；异常不能冒到 SSE 回调里。
 * 离开房间/断线时不清空 gm：保留最后一次看到的战场状态。
 * 刚上行、服务端快照尚未回显的本地条目（20 秒内）要保留，否则玩家提交完立刻被旧快照抹掉。
 */
export function applyRemoteGmState() {
    try {
        // 房间码变了（换房 / 服务器重启后重新入房）→ 服务端 rev 从头开始，必须重置已应用版本
        const code = String((roomSession() || {}).code || "");
        if (code !== appliedGmRevCode) { appliedGmRevCode = code; appliedGmRev = -1; }
        if (roomIsGm() || !roomSession()) return;
        const st = (roomSnapshot() || {}).state;
        if (!st || !(st.rev > appliedGmRev)) return;
        appliedGmRev = st.rev;
        gm.round = clampInt(st.round, 1, 999999, 1);
        gm.note = String(st.note || "").slice(0, 20000);
        const now = Date.now();
        const serverActions = (Array.isArray(st.actions) ? st.actions : [])
            .filter(a => a && typeof a === "object")
            .map(normalizeAction)
            .filter(a => a.round === gm.round);
        const actionIds = new Set(serverActions.map(a => a && a.id));
        (Array.isArray(gm.actions) ? gm.actions : []).forEach(raw => {
            if (!raw || typeof raw !== "object") return;
            const a = normalizeAction(raw);
            if (!a || actionIds.has(a.id)) return;
            if (now - (a.at || 0) >= LOCAL_PENDING_MS) return;
            actionIds.add(a.id);
            serverActions.push(a);
        });
        serverActions.sort((x, y) => (x.at || 0) - (y.at || 0));
        gm.actions = serverActions.slice(-80);
        const serverRolls = (Array.isArray(st.rolls) ? st.rolls : [])
            .filter(r => r && typeof r === "object")
            .map(normalizeRoll);
        const rollIds = new Set(serverRolls.map(r => r && r.id));
        (Array.isArray(gm.rolls) ? gm.rolls : []).forEach(raw => {
            if (!raw || typeof raw !== "object") return;
            const r = normalizeRoll(raw);
            if (!r || rollIds.has(r.id)) return;
            if (now - (r.at || 0) >= LOCAL_PENDING_MS) return;
            rollIds.add(r.id);
            serverRolls.push(r);
        });
        serverRolls.sort((x, y) => (x.at || 0) - (y.at || 0));
        gm.rolls = serverRolls.slice(-200);
        gm.enemies = (Array.isArray(st.enemies) ? st.enemies : [])
            .filter(e => e && typeof e === "object")
            .map(normalizeEnemy);
        gm.log = (Array.isArray(st.log) ? st.log : []).slice(-60).map(x => String(x).slice(0, 200));
        // 房间规则同步：三档 itemUseInCombat（旧房间状态只有 noUseInCombat 时按 free/turn 兼容）
        {
            const r = (st.rules && typeof st.rules === "object") ? st.rules : {};
            gm.rules = {
                itemUseInCombat: r.itemUseInCombat === "free" || r.itemUseInCombat === "blocked"
                    ? r.itemUseInCombat
                    : (r.noUseInCombat === false ? "free" : "turn")
            };
        }
        renderGmPanel();
        // 重画后新生成的控件还没套只读：顺序必须是先渲染再禁用
        applyGmReadOnly();
    } catch { /* 实时展示失败不能影响房间主流程 */ }
}

/**
 * 主持人端：把玩家上行到服务端的行动/投骰合并进本机的 gm。
 * 主持人保存时推的是全量 actions/rolls，不先合并就会把玩家的条目冲掉。
 * 只补本机没有的 id，只有确实新增时才落盘+重画（避免每次快照都写盘、也避免触发的上行循环）。
 */
export function mergeRemoteGmState() {
    try {
        if (!roomIsGm()) return false;
        const st = (roomSnapshot() || {}).state;
        if (!st) return false;
        let added = false;
        if (Array.isArray(st.actions)) {
            if (!Array.isArray(gm.actions)) gm.actions = [];
            const ids = new Set(gm.actions.filter(a => a && a.id).map(a => a.id));
            let hit = false;
            st.actions.forEach(raw => {
                if (!raw || typeof raw !== "object") return;
                const a = normalizeAction(raw);
                if (a.round !== gm.round || ids.has(a.id)) return;
                ids.add(a.id);
                gm.actions.push(a);
                hit = true;
            });
            if (hit) {
                gm.actions.sort((x, y) => (x.at || 0) - (y.at || 0));
                if (gm.actions.length > 80) gm.actions = gm.actions.slice(-80);
                added = true;
            }
        }
        if (Array.isArray(st.rolls)) {
            if (!Array.isArray(gm.rolls)) gm.rolls = [];
            const ids = new Set(gm.rolls.filter(r => r && r.id).map(r => r.id));
            let hit = false;
            st.rolls.forEach(raw => {
                if (!raw || typeof raw !== "object") return;
                const r = normalizeRoll(raw);
                if (ids.has(r.id)) return;
                ids.add(r.id);
                gm.rolls.push(r);
                hit = true;
            });
            if (hit) {
                // 投骰不按 round 过滤：renderGmRolls 自己只看本回合
                gm.rolls.sort((x, y) => (x.at || 0) - (y.at || 0));
                if (gm.rolls.length > 200) gm.rolls = gm.rolls.slice(-200);
                added = true;
            }
        }
        if (!added) return false;
        saveGm();
        renderGmPanel();
        return true;
    } catch {
        return false;
    }
}

// 一个单位是否参战：随从看 combat===true，主角默认参战（旧存档没有该字段）
// 主角若被「主角形态」接管，本体不算参战（否则会与形态重复上场）
function unitInCombat(id) {
    const data = loadRawChar(id);
    if (!data) return false;
    if (data.type === "companion") return data.combat === true;
    return data.outOfCombat !== true && !isReplacedOwner(id);
}

// 主持人编辑远端角色卡时会建一份本地镜像（meta.remoteMirror）。
// 镜像不是本机角色，看板/目标/随从列表都不该把它当成第二个自己，只在「角色管理」和编辑流程里出现。
function isRemoteMirror(meta) {
    return !!(meta && meta.remoteMirror && typeof meta.remoteMirror === "object");
}

function heroes() {
    return (charList || []).filter(c => c && c.type !== "companion" && !isRemoteMirror(c) && unitInCombat(c.id));
}

function heroSnapshot(id) {
    const data = loadRawChar(id);
    if (!data) return null;
    const snap = computeSnapshotWithOwner(data);
    return { data, snap };
}

// 所有随从的实时状态（读存档 + computeCompanion），主持人的队伍/结算/Buff 都基于它
function companionUnits() {
    const out = [];
    (charList || []).forEach(meta => {
        if (!meta || meta.type !== "companion" || !meta.id || isRemoteMirror(meta)) return;
        const data = loadRawChar(meta.id);
        if (!data) return;
        const cc = computeCompanion({ ...data, ownerId: data.ownerId || meta.ownerId || "" });
        out.push({ meta, data, cc });
    });
    return out;
}

// 「主角形态」接管本体：mode==="hero" 的随从只要参战，就当成本体变身/分裂了
// 本体在看板、回合结算、行动、目标列表里全部让位，只留下形态（可以有多个 = 分裂）
function formTakeovers() {
    const map = new Map();
    companionUnits().forEach(u => {
        if (!u.cc || u.cc.mode !== "hero" || u.cc.combat !== true) return;
        const ownerId = u.meta.ownerId || u.data.ownerId || "";
        if (!ownerId) return;
        if (!map.has(ownerId)) map.set(ownerId, []);
        map.get(ownerId).push(u);
    });
    return map;
}

function isReplacedOwner(id) {
    if (!id) return false;
    return formTakeovers().has(id);
}

function actionLabel(a) {
    return ACTION_TYPES[a && a.type] || ACTION_TYPES.other;
}

function actionText(a) {
    const foe = a && a.target ? gm.enemies.find(e => e.id === a.target) : null;
    return `${actionLabel(a)}${foe ? " → " + foe.name : ""}${a && a.text ? "：" + a.text : ""}`;
}

export function gmLog(text) {
    gm.log.push(String(text || "").slice(0, 200));
    if (gm.log.length > 60) gm.log = gm.log.slice(-60);
    saveGm();
    renderGmLog();
}

function renderGmLog() {
    const el = document.getElementById("gmLog");
    if (!el) return;
    el.innerHTML = gm.log.length
        ? gm.log.slice().reverse().map(x => `<div class="dice-line">${esc(x)}</div>`).join("")
        : '<div class="small" style="text-align:center;color:var(--muted)">还没有记录</div>';
}

// ---------- 投骰审计 ----------
// 玩家侧（骰子页 / 战斗计算器 / 技能发动）每次投骰都走这里，记进 GM 数据。
// 用 globalThis 调用：combat_dice / skills_buffs 不反向 import gm_ui，避免循环依赖。
export function gmLogRoll(payload) {
    const p = (payload && typeof payload === "object") ? payload : {};
    const charId = String(p.charId || activeCharId || "").slice(0, 64);
    if (!charId) return null;
    const data = loadRawChar(charId);
    if (!data) return null;
    const roll = normalizeRoll({
        round: gm.round,
        charId,
        charName: data.name || "角色",
        kind: p.kind,
        detail: p.detail,
        total: p.total,
        at: Date.now()
    });
    if (!Array.isArray(gm.rolls)) gm.rolls = [];
    gm.rolls.push(roll);
    if (gm.rolls.length > 200) gm.rolls = gm.rolls.slice(-200);
    saveGm();
    // 玩家端把这次投骰上行给主持人；主持人端靠 saveGm 全量同步即可
    if (!roomIsGm() && roomSession()) {
        Promise.resolve(globalThis.roomSubmitRoll?.(roll)).catch(() => { });
    }
    renderGmRolls();
    renderParty();
    renderDiceRollCount();
    return roll;
}

function rollCountOf(charId) {
    if (!charId) return 0;
    return gm.rolls.filter(r => r && r.round === gm.round && r.charId === charId).length;
}

// 队伍看板徽章：本回合这个人投了几次骰子，5 次以上标红提醒
function rollFlagHtml(charId) {
    const n = rollCountOf(charId);
    if (!n) return "";
    return `<span class="gm-roll-flag${n >= 5 ? " warn" : ""}" title="本回合已投骰 ${n} 次">🎲 ${n}</span>`;
}

function renderGmRolls() {
    const el = document.getElementById("gmRolls");
    if (!el) return;
    const all = gm.rolls.filter(r => r && r.round === gm.round);
    if (!all.length) {
        el.innerHTML = '<div class="empty">本回合还没有人投骰子</div>';
        return;
    }
    // 只渲染最近 ROLL_SHOW 条，其余靠列表内部滚动/计数，避免把整个面板拉长
    const list = all.slice(-ROLL_SHOW).reverse();
    el.innerHTML = `<div class="gm-roll-summary">共 ${all.length} 条${all.length > ROLL_SHOW ? ` · 只显示最近 ${ROLL_SHOW} 条` : ""}</div>
<div class="gm-roll-list">${list.map(r => `<div class="gm-row gm-roll-row">
    <span class="gm-name">${esc(r.charName)}</span>
    <span class="gm-badge">${esc(ROLL_KINDS[r.kind] || "🎲 投掷")}</span>
    <span class="gm-action-text">${esc(r.detail || "—")}</span>
    <span class="gm-hp">${r.total}</span>
</div>`).join("")}</div>`;
}

// 玩家骰子页的计数提示：让玩家知道主持人看得见
export function renderDiceRollCount() {
    const el = document.getElementById("diceRollCount");
    if (!el) return;
    const n = rollCountOf(activeCharId);
    el.innerText = n > 0
        ? `🎲 本回合已投 ${n} 次（主持人可见）`
        : "🎲 本回合还没有投骰子（主持人可见）";
    el.classList.toggle("warn", n >= 5);
}

export function gmClearRolls() {
    if (!gm.rolls.length) return;
    if (!confirm("清空本回合投掷记录？")) return;
    gm.rolls = [];
    saveGm();
    renderGmPanel();
}

// ---------- 血条 / 蓝条 / 自定义条（主持人看板与玩家行动页共用） ----------
function barLine(label, value, max, color, allowNeg) {
    const mx = Math.max(1, clampNum(max, 1, allowNeg ? LIMITS.customMax[1] : LIMITS.hpMp[1], 1));
    const raw = clampNum(value, allowNeg ? LIMITS.customVal[0] : 0, mx, 0);
    const v = Math.max(0, raw);
    const pct = Math.max(0, Math.min(100, v / mx * 100));
    const bg = color ? `;background:${esc(color)}` : "";
    return `<div class="gm-bar-line${raw < 0 ? " gm-bar-neg" : ""}">
        <span class="gm-bar-label" title="${esc(label)}">${esc(label)}</span>
        <div class="gm-hpbar"><div style="width:${pct.toFixed(1)}%${bg}"></div></div>
        <span class="gm-hp">${raw}/${mx}</span>
    </div>`;
}

function customBarLines(data) {
    const list = (data && Array.isArray(data.customStats)) ? data.customStats : [];
    return list.map(cs => {
        const max = Math.max(1, clampNum(cs.max, LIMITS.customMax[0], LIMITS.customMax[1], 100));
        const val = clampNum(cs.val, LIMITS.customVal[0], LIMITS.customVal[1], 0);
        return barLine(cs.name || "机制", val, max, cs.color || "#63a8e0", true);
    }).join("");
}

// 一个单位的完整条组：HP（绿）+ MP（蓝，可隐藏）+ 自定义机制条
function unitBarsHtml(hp, maxHp, mp, maxMp, data) {
    const hpColor = (data && /^#[0-9a-fA-F]{6}$/.test(String(data.hpColor || ""))) ? data.hpColor : "";
    const mpLine = (data && data.hideMp === true) ? "" : barLine("MP", mp, maxMp, "var(--blue)");
    return `<div class="gm-bars">${barLine("HP", hp, maxHp, hpColor)}${mpLine}${customBarLines(data)}</div>`;
}

function companionRowHtml(cm, ownerName) {
    const cc = cm.cc;
    const cmax = Math.max(1, cc.maxHp);
    const chp = clampNum(cc.hp, 0, cmax, 0);
    const cmaxMp = Math.max(1, cc.maxMp);
    const cacted = gm.actions.some(a => a && a.charId === cm.meta.id && a.round === gm.round);
    const isForm = cc.mode === "hero";
    // 主角形态是「变身」特例：不缩进、不套随从的蓝边，用金色边框表示接管本体
    return `<div class="gm-row gm-companion-row gm-unit${isForm ? " gm-form-row" : ""}">
    <div class="gm-head">
        <span class="gm-name">${esc(cc.icon || "🐾")} ${esc(cc.name || "随从")}</span>
        <span class="gm-sub">${isForm ? `主角形态 · 接管 ${esc(ownerName)}` : `随从 · 主人 ${esc(ownerName)}`}</span>
        <span class="gm-act-flag${cacted ? " done" : ""}">${cacted ? "已提交" : "待行动"}</span>
        ${rollFlagHtml(cm.meta.id)}
        <div class="gm-row-actions">
            <button class="small" onclick="gmDamageParty('${esc(cm.meta.id)}')">受伤</button>
            <button class="small" onclick="gmHealParty('${esc(cm.meta.id)}')">治疗</button>
            <button class="small" onclick="gmOpenCharacter('${esc(cm.meta.id)}')">查看</button>
            ${isForm ? `<button class="small" onclick="gmEndForm('${esc(cm.meta.id)}')" title="结束形态，本体重新上场">🧬 结束变身</button>` : ""}
        </div>
    </div>
    ${unitBarsHtml(chp, cmax, cc.mp, cmaxMp, cm.data)}
</div>`;
}

// ---------- 远端玩家行：房间快照 → 只读看板 ----------
// 看板要看到房间里每个玩家的角色。数据来自 roomSnapshot 的成员摘要（服务端瘦身版角色卡）。
// 自己这台用本地角色卡渲染，所以在快照里跳过自己的成员 id，避免同一角色出现两遍。
function remoteMembers() {
    if (!roomSession()) return [];
    const snap = roomSnapshot();
    if (!snap || !Array.isArray(snap.members)) return [];
    const meId = String(roomMyMemberId() || "");
    // 看板是「全队队伍表」：只要有角色卡摘要就上板，参战/未参战只做标记，不再隐藏。
    // 参战了就该所有人看得见（联机目的是一起玩）；没上传卡的成员只在「📋 角色管理」里出现。
    return snap.members.filter(m => {
        if (!(m && m.id) || String(m.id) === meId) return false;
        const c = remoteCharOf(m);
        if (!c) return false;
        return true;
    });
}

// 服务端快照里的 char 是瘦身摘要，即使玩家没传卡也会给一个空壳（名字空、血量 0），
// 所以「有没有角色数据」要看内容，不能只看对象存不存在。
function remoteCharOf(m) {
    const c = (m && m.char && typeof m.char === "object") ? m.char : null;
    if (!c) return null;
    const maxHp = clampNum(c.maxHp !== undefined ? c.maxHp : c.maxHpBase, 0, LIMITS.hpMp[1], 0);
    const level = clampNum(c.level, 0, LIMITS.level[1], 0);
    const named = String(c.name || "").trim();
    return (named || maxHp > 0 || level > 0) ? c : null;
}

function remoteMemberBarsHtml(char) {
    const maxHp = clampNum(char.maxHp !== undefined ? char.maxHp : char.maxHpBase, 0, LIMITS.hpMp[1], 0);
    const maxMp = clampNum(char.maxMp !== undefined ? char.maxMp : char.maxMpBase, 0, LIMITS.hpMp[1], 0);
    // 只有名字、还没有血量数据时不画空条（服务端空壳成员）
    if (maxHp <= 0 && maxMp <= 0) return '<div class="gm-sub">等待该玩家上传角色卡</div>';
    // 条组统一走 unitBarsHtml：隐藏 MP（hideMp）和自定义机制条都由它处理，
    // 摘要里 maxMp=0 表示这名角色没有蓝量，按「隐藏 MP」处理，避免画出 0/1 的空条。
    const data = (maxMp > 0 || (char && char.hideMp === true)) ? char : Object.assign({}, char, { hideMp: true });
    return unitBarsHtml(char.hp, maxHp, char.mp, maxMp, data);
}

// 远端成员的随从摘要 Buff 标签（只读）：最多两个「名字×层数」，超出用 +N 收起
function remoteCompBuffTagsHtml(c) {
    const buffs = (c && Array.isArray(c.buffs) ? c.buffs : [])
        .filter(b => b && String(b.name || "").trim());
    if (!buffs.length) return "";
    const tags = buffs.slice(0, 2).map(b => {
        const n = String(b.name || "").trim();
        const stack = Math.max(1, Math.round(Number(b.stack) || 1));
        const txt = `${n}×${stack}`;
        return `<span class="gm-tag" title="${esc(txt)}">${esc(txt)}</span>`;
    }).join("");
    const more = buffs.length > 2
        ? `<span class="gm-tag" title="还有 ${buffs.length - 2} 个状态">+${buffs.length - 2}</span>`
        : "";
    return tags + more;
}

// 远端成员的参战随从：只读展示 + 主持人可改血（写回主人卡的 companionPatch，客机落盘时按 cid 应用）
function remoteCompanionRowHtml(m, c) {
    const online = m.online !== false;
    const dotTitle = online ? "在线" : "离线";
    const whoName = String(m.name || "").trim() || "玩家";
    const icon = String(c.icon || "").trim();
    const name = String(c.name || "").trim() || "随从";
    const lvl = clampInt(c.level, LIMITS.level[0], LIMITS.level[1], 1) || 1;
    const maxHp = clampNum(c.maxHp !== undefined ? c.maxHp : c.maxHpBase, 0, LIMITS.hpMp[1], 0);
    const maxMp = clampNum(c.maxMp !== undefined ? c.maxMp : c.maxMpBase, 0, LIMITS.hpMp[1], 0);
    // 没有血量数据的随从退化成「只有名字」，不画空条
    const bars = maxHp > 0 ? unitBarsHtml(c.hp, maxHp, c.mp, maxMp, c) : "";
    const mid = String(m.id);
    const cid = String(c.id);
    const compKey = `${mid}:${cid}`;
    // 改血只给主持人：写回走 editRemoteCompanion（companionPatch），按钮用 data-remote-comp-hp 做 busy 定位
    const hpActions = (roomIsGm() && maxHp > 0)
        ? `<div class="gm-row-actions">
        <button class="small" data-remote-comp-hp="${esc(compKey)}" onclick="gmDamageRemoteCompanion('${esc(mid)}','${esc(cid)}')" title="对该随从造成伤害（同步给所有人）">受伤</button>
        <button class="small" data-remote-comp-hp="${esc(compKey)}" onclick="gmHealRemoteCompanion('${esc(mid)}','${esc(cid)}')" title="为该随从恢复 HP（同步给所有人）">治疗</button>
    </div>`
        : "";
    return `<div class="gm-row gm-unit gm-companion-row gm-remote-comp" title="${esc(`${whoName} 的随从 · ${dotTitle}`)}">
    <div class="gm-head">
        <span class="gm-dot${online ? " online" : ""}" title="${dotTitle}" aria-label="${dotTitle}"></span>
        <span class="gm-name">${icon ? `${esc(icon)} ` : ""}${esc(name)}</span>
        ${remoteCompBuffTagsHtml(c)}
        <span class="gm-sub">随从 · Lv ${lvl}</span>
        ${hpActions}
    </div>
    ${bars}
</div>`;
}

// 远端成员本回合是否已提交行动：远端摘要没有本机 charId，只能按 memberId 或 charName 匹配
function remoteActed(m, char) {
    const mid = String((m && m.id) || "");
    const name = char && char.name ? String(char.name) : "";
    const list = Array.isArray(gm.actions) ? gm.actions : [];
    return list.some(a => a && a.round === gm.round
        && (String(a.memberId || "") === mid || (name && a.charName === name)));
}

function remoteMemberRowHtml(m) {
    const id = String(m.id);
    const online = m.online !== false;
    const char = remoteCharOf(m);
    const whoName = String(m.name || "").trim() || "玩家";
    const charName = char ? String(char.name || "").trim() : "";
    const lvl = char ? (clampInt(char.level, LIMITS.level[0], LIMITS.level[1], 1) || 1) : 0;
    const roleLabel = m.role === "gm" ? "主持人" : "玩家";
    const dotTitle = online ? "在线" : "离线";
    const comps = (char && Array.isArray(char.companions)) ? char.companions : [];
    // 变身形态：mode=hero 且参战的随从接管了本体，看板主行要显示形态而不是主人卡
    const heroComp = comps.find(c => c && c.mode === "hero" && c.combat === true) || null;
    // 编辑/查看走成员 id（形态没有独立成员），两种情况都保留
    const editActions = `<button class="small" onclick="roomUiEditMember('${esc(id)}')" title="拉取该玩家的完整角色卡并编辑">✏️ 编辑</button>
            <button class="small" onclick="cmViewMember('${esc(id)}')" title="只读查看该玩家的角色卡">👁 查看</button>`;
    // 本回合提交状态：按 memberId / 角色名匹配（远端摘要没有本机 charId），玩家端也显示（只读）
    const acted = remoteActed(m, char);
    const actFlag = `<span class="gm-act-flag${acted ? " done" : ""}">${acted ? "已提交" : "待行动"}</span>`;

    let row;
    if (heroComp) {
        // 形态接管：名字/等级/血蓝都用形态数据，主人卡的 HP/MP 不再是看板上的那一管
        const formName = String(heroComp.name || "").trim() || "主角形态";
        const formIcon = String(heroComp.icon || "").trim();
        const formLvl = clampInt(heroComp.level, LIMITS.level[0], LIMITS.level[1], 1) || 1;
        const formMaxHp = clampNum(heroComp.maxHp !== undefined ? heroComp.maxHp : heroComp.maxHpBase, 0, LIMITS.hpMp[1], 0);
        const formMaxMp = clampNum(heroComp.maxMp !== undefined ? heroComp.maxMp : heroComp.maxMpBase, 0, LIMITS.hpMp[1], 0);
        const ownerName = charName || whoName;
        const formTitle = `${whoName} · ${formName} · 主角形态 · Lv ${formLvl} · ${dotTitle}`;
        // 摘要里没有血量数据时退化成提示，和成员行保持一致
        const formBars = formMaxHp > 0
            ? unitBarsHtml(heroComp.hp, formMaxHp, heroComp.mp, formMaxMp, { hideMp: !!(char && char.hideMp === true) })
            : '<div class="gm-sub">等待该玩家上传角色卡</div>';
        // 形态行也能改血：写回走随从补丁（companionPatch）按 heroComp.id 落到玩家本机的形态卡上
        const formHpActions = (roomIsGm() && formMaxHp > 0)
            ? `<button class="small" data-remote-comp-hp="${esc(`${id}:${String(heroComp.id)}`)}" onclick="gmDamageRemoteCompanion('${esc(id)}','${esc(String(heroComp.id))}')" title="对该形态造成伤害（同步给所有人）">受伤</button>
            <button class="small" data-remote-comp-hp="${esc(`${id}:${String(heroComp.id)}`)}" onclick="gmHealRemoteCompanion('${esc(id)}','${esc(String(heroComp.id))}')" title="为该形态恢复 HP（同步给所有人）">治疗</button>`
            : "";
        row = `<div class="gm-row gm-unit gm-remote-row gm-form-row" title="${esc(formTitle)}">
    <div class="gm-head">
        <span class="gm-dot${online ? " online" : ""}" title="${dotTitle}" aria-label="${dotTitle}"></span>
        <span class="gm-name">${formIcon ? `${esc(formIcon)} ` : ""}${esc(formName)}</span>
        <span class="gm-sub">${roleLabel} · 主角形态</span>
        <span class="gm-tag" title="${esc(`接管 ${ownerName}`)}">接管 ${esc(ownerName)}</span>
        ${actFlag}
        <div class="gm-row-actions">
            ${formHpActions}
            ${editActions}
        </div>
    </div>
    ${formBars}
</div>`;
    } else {
        const title = `${whoName} · ${charName || "未上传角色卡"} · ${dotTitle}${char && char.outOfCombat === true ? " · 未参战" : ""}`;
        // 未参战不隐藏，只打浅灰标记；主持人仍可正常受伤/治疗（参战与否都能改）
        const offTag = (char && char.outOfCombat === true) ? '<span class="gm-tag off" title="该角色当前未参战">未参战</span>' : "";
        // 受伤/治疗要写回别人的卡：只给主持人渲染，玩家端连按钮都不出现（不需要只读禁用态）
        // 摘要里没有可用血量（maxHp<=0）就不渲染改血按钮，避免点了才 alert
        const canHp = roomIsGm() && !!(char && char.maxHp > 0);
        const hpActions = canHp
            ? `<button class="small" data-remote-hp="${esc(id)}" onclick="gmDamageRemote('${esc(id)}')" title="对这名玩家造成伤害（同步给所有人）">受伤</button>
            <button class="small" data-remote-hp="${esc(id)}" onclick="gmHealRemote('${esc(id)}')" title="为这名玩家恢复 HP（同步给所有人）">治疗</button>`
            : "";
        // 远端行要「拉取完整卡 → 改血量 / 镜像编辑 / 只读查看」，改血量走 gmDamageRemote/gmHealRemote 服务端写回
        row = `<div class="gm-row gm-unit gm-remote-row" title="${esc(title)}">
    <div class="gm-head">
        <span class="gm-dot${online ? " online" : ""}" title="${dotTitle}" aria-label="${dotTitle}"></span>
        <span class="gm-name">${esc(charName || whoName)}</span>
        <span class="gm-sub">${char ? `${roleLabel} · Lv ${lvl}` : roleLabel}</span>
        ${offTag}
        ${actFlag}
        <div class="gm-row-actions">
            ${hpActions}
            ${editActions}
        </div>
    </div>
    ${char ? remoteMemberBarsHtml(char) : '<div class="gm-sub">等待该玩家上传角色卡</div>'}
</div>`;
    }
    // 成员行下面紧跟该成员的参战随从：由 renderParty 统一产出并按 rank 稳定排序，
    // 这里只返回成员主行（形态主行已占用，随从列表里排除它）。
    return row;
}

// 看板排序 rank：0 = 参战且 HP>0，1 = 未参战，2 = HP<=0（战败）。
// 只影响展示顺序，不改数据；同 rank 内保持原有相对顺序（稳定排序）。
function partyRank(hp, inCombat) {
    if (Number(hp) <= 0) return 2;
    return inCombat ? 0 : 1;
}

// 本地主角行：这里要包含「未参战」的角色（heroes() 只返回参战单位），
// 才能把未参战排到中间；被形态接管的本体仍由 formTakeovers 单独处理。
function localPartyHeroes() {
    return (charList || []).filter(c => c && c.type !== "companion" && !isRemoteMirror(c) && !isReplacedOwner(c.id));
}

function renderParty() {
    const el = document.getElementById("gmParty");
    if (!el) return;
    const rows = [];
    localPartyHeroes().forEach(meta => {
        const hs = heroSnapshot(meta.id);
        if (!hs) return;
        const maxHp = Math.max(1, hs.snap.total.maxHp);
        const hp = clampNum(hs.data.hp, 0, maxHp, 0);
        const maxMp = Math.max(1, hs.snap.total.maxMp);
        const comps = companionUnits().filter(c => c.meta.ownerId === meta.id).length;
        const acted = gm.actions.some(a => a && a.charId === meta.id && a.round === gm.round);
        const off = hs.data.outOfCombat === true;
        const rank = partyRank(hp, !off);
        rows.push({
            rank,
            html: `<div class="gm-row gm-unit">
    <div class="gm-head">
        <span class="gm-name">${esc(hs.data.name || meta.name || "无名")}</span>
        <span class="gm-sub">Lv ${hs.snap.lvl}${comps ? ` · 随从 ${comps}` : ""}</span>
        ${off ? '<span class="gm-tag off" title="该角色当前未参战">未参战</span>' : ""}
        <span class="gm-act-flag${acted ? " done" : ""}">${acted ? "已提交" : "待行动"}</span>
        ${rollFlagHtml(meta.id)}
        <div class="gm-row-actions">
            <button class="small" onclick="gmDamageParty('${esc(meta.id)}')">受伤</button>
            <button class="small" onclick="gmHealParty('${esc(meta.id)}')">治疗</button>
            <button class="small" onclick="gmOpenCharacter('${esc(meta.id)}')">查看</button>
        </div>
    </div>
    ${unitBarsHtml(hp, maxHp, hs.data.mp, maxMp, hs.data)}
</div>`
        });
        const ownerName = hs.data.name || "无名";
        companionUnits()
            .filter(cm => (cm.meta.ownerId || cm.data.ownerId) === meta.id && cm.cc.combat === true)
            .forEach(cm => rows.push({
                rank: Number(cm.cc.hp) <= 0 ? 2 : rank,
                html: companionRowHtml(cm, ownerName)
            }));
    });
    // 被形态接管的本体不在 localPartyHeroes() 里，这里把它的参战单位（形态 + 随从）单独补出来
    formTakeovers().forEach((units, ownerId) => {
        const hs = heroSnapshot(ownerId);
        const ownerName = (hs && hs.data.name) || "本体";
        companionUnits()
            .filter(cm => (cm.meta.ownerId || cm.data.ownerId) === ownerId && cm.cc.combat === true)
            .forEach(cm => rows.push({
                rank: Number(cm.cc.hp) <= 0 ? 2 : 0,
                html: companionRowHtml(cm, ownerName)
            }));
    });
    // 最后补房间里的其他成员；远端随从跟随主人行（同一 rank 组内保持主人→随从顺序）
    remoteMembers().forEach(m => {
        const char = remoteCharOf(m);
        const hero = heroFormInChar(char);
        let rank = 1;
        if (hero) {
            rank = Number(hero.hp) <= 0 ? 2 : 0;
        } else if (char) {
            const maxHp = clampNum(char.maxHp !== undefined ? char.maxHp : char.maxHpBase, 0, LIMITS.hpMp[1], 0);
            rank = (maxHp > 0 && Number(char.hp) <= 0)
                ? 2
                : (char.outOfCombat === true ? 1 : 0);
        }
        rows.push({ rank, html: remoteMemberRowHtml(m) });
        const comps = (char && Array.isArray(char.companions)) ? char.companions : [];
        comps
            .filter(c => c && c.combat === true && c !== hero)
            // 远端随从 0 血 = 直接退出参战：看板上不再显示
            .filter(c => !(Number(c.hp) <= 0))
            .forEach(c => rows.push({ rank, html: remoteCompanionRowHtml(m, c) }));
    });
    // 稳定排序（显式带插入序号，避免依赖运行时 sort 的稳定性承诺）
    rows.forEach((r, i) => { r._i = i; });
    rows.sort((a, b) => (a.rank - b.rank) || (a._i - b._i));
    el.innerHTML = rows.length ? rows.map(r => r.html).join("") : '<div class="empty">还没有参战角色</div>';
}

// 房间快照/成员变化时由 room_ui 调用：只重画看板，不整块重渲染主持人面板
export function refreshGmParty() {
    renderParty();
}

function renderEnemies() {
    const el = document.getElementById("gmEnemies");
    if (!el) return;
    // 玩家端（在房间里但不是房主）：遭遇区只读，不渲染任何破坏性按钮。
    // 面板标题栏的「添加/清空」不在 #gmEnemies 里，也一并隐藏；房主/单机时恢复。
    const playerView = !!roomSession() && !roomIsGm();
    const panel = (typeof el.closest === "function") ? el.closest(".panel") : null;
    if (panel && typeof panel.querySelectorAll === "function") {
        panel.querySelectorAll('button[onclick="addEnemy()"],button[onclick="clearEnemies()"]').forEach(btn => {
            if (btn && btn.style) btn.style.display = playerView ? "none" : "";
        });
    }
    if (!gm.enemies.length) {
        el.innerHTML = playerView
            ? '<div class="empty">暂无敌人</div>'
            : '<div class="empty">暂无敌人 · 点上方「＋ 添加敌人」</div>';
        return;
    }
    el.innerHTML = `<div class="gm-scroll-list">${gm.enemies.map(e => {
        const pct = Math.max(0, Math.min(100, e.hp / Math.max(1, e.maxHp) * 100));
        return `<div class="gm-row gm-enemy${e.hp <= 0 ? " dead" : ""}">
    <div class="gm-head">
        <input class="gm-icon" value="${esc(e.icon)}" title="图标" onchange="setEnemyField('${esc(e.id)}','icon',this.value)">
        <input class="gm-name-input" value="${esc(e.name)}" onchange="setEnemyField('${esc(e.id)}','name',this.value)">
        <span class="gm-sub">先攻</span>
        <input type="number" value="${e.init}" onchange="setEnemyField('${esc(e.id)}','init',this.value)">
        <span class="gm-sub">AC</span>
        <input type="number" value="${e.ac}" onchange="setEnemyField('${esc(e.id)}','ac',this.value)">
        ${playerView ? "" : `<span class="gm-remove" onclick="removeEnemy('${esc(e.id)}')" title="删除">✖</span>`}
    </div>
    <div class="gm-hpbar"><div style="width:${pct.toFixed(1)}%;background:var(--red)"></div></div>
    <div class="gm-head">
        <span class="gm-hp">${e.hp}/${e.maxHp}</span>
        <input type="number" value="${e.hp}" onchange="setEnemyField('${esc(e.id)}','hp',this.value)">
        <input type="number" value="${e.maxHp}" onchange="setEnemyField('${esc(e.id)}','maxHp',this.value)">
        <div class="gm-row-actions">
            ${playerView ? "" : `<button class="small" onclick="damageEnemy('${esc(e.id)}')">扣血</button>
            <button class="small" onclick="healEnemy('${esc(e.id)}')">治疗</button>`}
        </div>
    </div>
    ${e.note ? `<div class="gm-enemy-note">${esc(e.note)}</div>` : ""}
</div>`;
    }).join("")}</div>`;
}

export function renderGmPanel() {
    const roundEl = document.getElementById("gmRound");
    if (roundEl) roundEl.value = gm.round;
    const noteEl = document.getElementById("gmNote");
    if (noteEl && noteEl.value !== gm.note) noteEl.value = gm.note;
    ensureGmRuleToggle();
    renderParty();
    renderEnemies();
    renderGmCalcs();
    renderGmActions();
    renderGmLog();
    gmRenderBuffTargets();
    gmRenderItemTargets();
    renderGmItemPresets();
    renderPlayerActionPanel();
    renderGmRolls();
    renderDiceRollCount();
    applyGmReadOnly();
}

// 主持人面板只读判定：已加入房间且非房主 → 只读
let gmRoApplied = false;
export function gmReadOnlyNow() {
    try {
        if (typeof globalThis.roomSession !== "function") return false;
        const s = globalThis.roomSession();
        return !!(s && s.code && s.gm !== true);
    } catch (e) { return false; }
}

export function applyGmReadOnly() {
    const view = document.getElementById("gmView");
    if (!view) return;
    const ro = gmReadOnlyNow();
    if (!ro && gmRoApplied) { gmRoApplied = false; renderGmPanel(); return; }
    view.classList.toggle("gm-readonly", ro);
    const bar = document.getElementById("gmReadOnlyBar");
    if (bar) bar.style.display = ro ? "" : "none";
    if (!ro) return;
    gmRoApplied = true;
    view.querySelectorAll("input, select, textarea, button").forEach(el => { el.disabled = true; });
}

// ---------- 房间规则 ----------
// gm.rules = { itemUseInCombat }：战斗中消耗品三档（turn / free / blocked）。
// 字段名固定为 rules，与 room.js 上行（payload.rules）及服务端快照保持一致。
// 旧值 noUseInCombat 只在 loadGm / applyRemoteGmState 里做一次兼容，运行时不再读。
const ITEM_USE_MODES = ["turn", "free", "blocked"];

/** 当前战斗中消耗品规则：非法/缺失一律按 "turn" */
export function gmConsumableMode() {
    const v = gm && gm.rules ? gm.rules.itemUseInCombat : "";
    return (v === "free" || v === "blocked") ? v : "turn";
}

/** 兼容旧调用：只剩 blocked 才算「完全禁用」（turn 只是算一回合，并不禁止） */
export function gmRuleNoUseInCombat() {
    return gmConsumableMode() === "blocked";
}

/** 主持人改规则：只接受 itemUseInCombat，值非法一律回落 turn */
export function gmSetRule(key, val) {
    if (String(key) !== "itemUseInCombat") return false;
    if (!gm.rules || typeof gm.rules !== "object") gm.rules = { itemUseInCombat: "turn" };
    gm.rules.itemUseInCombat = ITEM_USE_MODES.includes(val) ? val : "turn";
    saveGm();
    renderGmPanel();
    return true;
}

/** 单位是否参战（异常 → false）：其它 lane 通过 globalThis 调用，必须保留导出 */
export function gmUnitInCombat(id) {
    try { return unitInCombat(id); } catch (e) { return false; }
}

/**
 * 消耗品能否使用：无房间/无激活角色 → true（单机不受房间规则影响）。
 * free → 恒 true；blocked → 只有「未参战」可用；turn → true（由行动类型消耗回合）。
 * 任何异常都放行，避免规则数据坏掉把单机玩法挡死。
 */
export function gmCanUseConsumable() {
    try {
        if (!roomSession()) return true;
        if (!activeCharId) return true;
        if (gmConsumableMode() !== "blocked") return true;
        return !unitInCombat(activeCharId);
    } catch (e) { return true; }
}

// 场景/回合面板里的规则下拉：index.html 没有这个控件，首次渲染时动态插到 #gmNote 之后。
// 玩家端由 applyGmReadOnly() 统一 disabled（这里也顺手禁用一次，因为新节点可能晚于只读态生成）。
function ensureGmRuleToggle() {
    try {
        // 旧版 checkbox（noUseInCombat）残留节点先清掉，避免同一规则出现两个控件
        const legacy = document.getElementById("gmRuleNoUseInCombat");
        if (legacy) {
            const oldWrap = legacy.parentNode || null;
            if (oldWrap && typeof oldWrap.removeChild === "function") oldWrap.removeChild(legacy);
            else if (typeof legacy.remove === "function") legacy.remove();
        }
        let sel = document.getElementById("gmItemUseMode");
        if (!sel) {
            const noteEl = document.getElementById("gmNote");
            const parent = noteEl && noteEl.parentNode;
            if (!parent || typeof parent.insertBefore !== "function") return;
            if (typeof document.createElement !== "function") return;
            const wrap = document.createElement("label");
            wrap.className = "gm-rule-toggle";
            wrap.textContent = "⚔ 战斗中消耗品";
            sel = document.createElement("select");
            sel.id = "gmItemUseMode";
            sel.setAttribute("onchange", "gmSetRule('itemUseInCombat', this.value)");
            sel.setAttribute("title", "战斗中角色使用消耗品时：算一回合 / 自由使用 / 禁止使用");
            [["turn", "算一回合"], ["free", "自由使用"], ["blocked", "禁止使用"]].forEach(([value, label]) => {
                const opt = document.createElement("option");
                opt.value = value;
                opt.textContent = label;
                if (typeof sel.appendChild === "function") sel.appendChild(opt);
            });
            if (typeof wrap.appendChild === "function") wrap.appendChild(sel);
            parent.insertBefore(wrap, noteEl.nextSibling);
        }
        sel.value = gmConsumableMode();
        if (roomSession() && !roomIsGm()) sel.disabled = true;
    } catch (e) { /* 纯 UI 增强，失败不影响面板渲染 */ }
}

/** 「📋 角色管理」默认隐藏，只有成为主机（房主）后才显示 */
export function canUseCharManage() {
    const s = roomSession();
    return !!(s && s.code && s.gm === true);
}

// ---------- 视图切换 ----------
export function switchView(view) {
    // 权限拦截：非房主不得进入角色管理页，拦回角色卡
    if (view === "manage" && !canUseCharManage()) {
        view = "character";
    }
    const isGm = view === "gm";
    const isManage = view === "manage";
    const isLink = view === "link";
    document.body.classList.toggle("gm-mode", isGm);
    document.body.classList.toggle("manage-mode", isManage);
    document.body.classList.toggle("link-mode", isLink);
    const tabC = document.getElementById("viewTabCharacter");
    const tabG = document.getElementById("viewTabGm");
    const tabM = document.getElementById("viewTabManage");
    const tabL = document.getElementById("viewTabLink");
    if (tabC) tabC.classList.toggle("active", view === "character");
    if (tabG) tabG.classList.toggle("active", isGm);
    if (tabM) tabM.classList.toggle("active", isManage);
    if (tabL) tabL.classList.toggle("active", isLink);
    if (isGm) {
        // 客机：每次进主持人面板都先应用最新广播（不在 gm-mode 时 renderRoomUI 不会刷新这块）
        applyRemoteGmState();
        renderGmPanel();
        // 房主刚进/刚建新房间时补一次全量上行，让客机立刻看到已存在的面板状态
        const rs = roomIsGm() ? roomSession() : null;
        if (rs && rs.code && rs.code !== gmPushedCode) {
            gmPushedCode = rs.code;
            queueGmStateSync();
        }
    }
    else if (isManage) {
        // 进入角色管理页：渲染列表，不触碰 gm-view 只读逻辑
        if (typeof globalThis.renderCharManage === "function") globalThis.renderCharManage();
    } else if (isLink) {
        // 联机管理页：房间状态随时可能变化，进来时先按当前快照重画一次
        if (typeof globalThis.renderRoomUI === "function") globalThis.renderRoomUI();
    } else {
        loadActiveCharacter(); renderPlayerActionPanel(); renderDiceRollCount(); // 从主持人面板改过血量/Buff 后，回到角色卡立刻看到最新存档
    }
    try { localStorage.setItem(VIEW_KEY, isGm ? "gm" : (isManage ? "manage" : (isLink ? "link" : "character"))); } catch (e) { }
}

export function initGmPanel() {
    loadGm();
    renderGmPanel();
    let view = "character";
    try { view = localStorage.getItem(VIEW_KEY) || "character"; } catch (e) { }
    // 若存档是 "manage" 但当前无权限，回退 "character"
    if (view === "manage" && !canUseCharManage()) view = "character";
    switchView(view === "gm" ? "gm" : view === "manage" ? "manage" : view === "link" ? "link" : "character");
}

// ---------- 队伍 ----------
export function gmOpenCharacter(id) {
    switchCharacter(id);
    switchView("character");
    page("character", null);
}

// 结束形态：形态退场，本体重新出现（勾了血量同步时先把当前 HP% 写回本体）
export function gmEndForm(id) {
    const data = loadRawChar(id);
    if (!data || data.type !== "companion" || data.mode !== "hero") return;
    if (data.hpSync) pushHpToOwner(data);
    data.combat = false;
    saveCharAndSync(id, data);
    if (data.ownerId && data.ownerId === activeCharId) loadActiveCharacter();
    gmLog(`🧬 ${data.name || "形态"} 结束变身，本体重新上场`);
    renderGmPanel();
}

// 队伍目标解析：主角走快照，随从走 computeCompanion
function partyTarget(id) {
    const cm = (charList || []).find(c => c && c.type === "companion" && c.id === id);
    if (cm) {
        const data = loadRawChar(id);
        if (!data) return null;
        const cc = computeCompanion({ ...data, ownerId: data.ownerId || cm.ownerId || "" });
        return { data, isComp: true, maxHp: Math.max(1, cc.maxHp), maxMp: Math.max(1, cc.maxMp), hp: cc.hp, mp: cc.mp, ac: Math.max(0, Math.round(clampNum(cc.armor, 0, FINAL_MAX, 0))) };
    }
    const hs = heroSnapshot(id);
    if (!hs) return null;
    return {
        data: hs.data, isComp: false,
        maxHp: Math.max(1, hs.snap.total.maxHp), maxMp: Math.max(1, hs.snap.total.maxMp),
        hp: hs.data.hp, mp: hs.data.mp,
        ac: Math.max(0, Math.round(clampNum(hs.snap.total.armor, 0, FINAL_MAX, 0)))
    };
}

export function gmDamageParty(id) {
    const t = partyTarget(id);
    if (!t) return;
    const dmg = clampNum(prompt("对 " + (t.data.name || "角色") + " 造成多少伤害？", "5"), 0, LIMITS.hpMp[1], 0);
    const shield = absorbShields(t.data, dmg);
    t.data.hp = clampNum(Math.max(0, clampNum(t.hp, 0, t.maxHp, 0) - shield.rest), 0, t.maxHp, 0);
    if (t.isComp) dropDeadCompanion(t.data);
    saveCharAndSync(id, t.data);
    if (t.isComp) pushHpToOwner(t.data);
    gmLog(`${t.data.name || "角色"}${t.isComp ? "（随从）" : ""} 受到 ${dmg} 伤害${shield.saved ? `（减伤 ${shield.saved}）` : ""}${shield.absorbed ? `（🛡 护盾吸收 ${shield.absorbed}${shield.charges ? ` · 挡下 ${shield.charges} 击` : ""}）` : ""}，剩余 HP ${t.data.hp}/${t.maxHp}`);
    renderGmPanel();
}

export function gmHealParty(id) {
    const t = partyTarget(id);
    if (!t) return;
    const heal = clampNum(prompt("为 " + (t.data.name || "角色") + " 恢复多少 HP？", "5"), 0, LIMITS.hpMp[1], 0);
    t.data.hp = clampNum(Math.min(t.maxHp, clampNum(t.hp, 0, t.maxHp, 0) + heal), 0, t.maxHp, 0);
    saveCharAndSync(id, t.data);
    if (t.isComp) pushHpToOwner(t.data);
    gmLog(`${t.data.name || "角色"}${t.isComp ? "（随从）" : ""} 恢复 ${heal} HP，当前 ${t.data.hp}/${t.maxHp}`);
    renderGmPanel();
}

// ---------- 远端玩家受伤 / 治疗（主持人专用，写回服务端并广播给所有人） ----------
// 看板上的远端行只有摘要（瘦身卡），改血量必须：拉完整卡 → 改 hp → 推回服务端。
// 服务端 POST /char 成功后会广播 room 快照，所以所有客户端都会看到新血量。
const remoteHpBusy = new Set();

function remoteMemberById(memberId) {
    const id = String(memberId || "");
    if (!id) return null;
    return remoteMembers().find(x => String(x.id) === id) || null;
}

function setRemoteHpBusy(memberId, busy) {
    const id = String(memberId || "");
    if (busy) remoteHpBusy.add(id); else remoteHpBusy.delete(id);
    try {
        document.querySelectorAll("[data-remote-hp]").forEach(btn => {
            if (String(btn.getAttribute("data-remote-hp") || "") !== id) return;
            btn.disabled = !!busy;
        });
    } catch { /* 纯 UI 修饰，失败无所谓 */ }
}

// mode: "damage" 扣血 / "heal" 回血；两者共用同一条写回链路
async function remoteHpChange(memberId, mode) {
    const id = String(memberId || "");
    if (remoteHpBusy.has(id)) return;
    const m = remoteMemberById(id);
    if (!m) return;
    const sum = remoteCharOf(m);
    if (!sum) return;
    const maxHp = clampNum(sum.maxHp !== undefined ? sum.maxHp : sum.maxHpBase, 0, LIMITS.hpMp[1], 0);
    if (maxHp <= 0) { alert("该玩家还没有上传可用的角色卡"); return; }
    const hp = clampNum(sum.hp, 0, maxHp, 0);
    const whoName = String(sum.name || "").trim() || "玩家";
    const isHeal = mode === "heal";
    const raw = prompt(isHeal ? `为 ${whoName} 恢复多少 HP？` : `对 ${whoName} 造成多少伤害？`, "5");
    if (raw === null) return;
    const amount = clampNum(raw, 0, LIMITS.hpMp[1], 0);
    if (!amount) return;
    setRemoteHpBusy(id, true);
    try {
        // 拉完整卡：摘要可能已过期，血量以完整卡为准；只改 hp，其它字段原样带回去
        const full = await (globalThis.roomFetchChar?.(id) || Promise.resolve(null));
        if (!full || typeof full !== "object") {
            alert("读取该玩家角色卡失败，可能还没上传完整角色卡");
            return;
        }
        const fullMax = clampNum(full.maxHp !== undefined ? full.maxHp : full.maxHpBase, 0, LIMITS.hpMp[1], maxHp);
        const cap = fullMax > 0 ? fullMax : maxHp;
        const curHp = clampNum(full.hp !== undefined ? full.hp : hp, 0, cap, 0);
        const newHp = isHeal
            ? clampNum(Math.min(cap, curHp + amount), 0, cap, 0)
            : clampNum(Math.max(0, curHp - amount), 0, cap, 0);
        // 用实际变化量：满血治疗 / 0 血再受伤都不写回、不广播
        const delta = isHeal ? newHp - curHp : curHp - newHp;
        if (delta <= 0) {
            alert(isHeal ? "HP 已满，未恢复" : "HP 已为 0");
            return;
        }
        full.hp = newHp;
        const ok = await (globalThis.roomPushCharTo?.(id, full, "hp") || Promise.resolve(false));
        if (!ok) {
            alert("同步失败，请检查服务器连接");
            return;
        }
        gmLog(isHeal
            ? `${whoName} 恢复 ${delta} HP，当前 ${newHp}/${cap}`
            : `${whoName} 受到 ${delta} 伤害，剩余 HP ${newHp}/${cap}`);
        saveGm();
        renderGmPanel();
    } catch (e) {
        alert("操作失败：" + (e && e.message ? e.message : String(e)));
    } finally {
        setRemoteHpBusy(id, false);
    }
}

/** 主持人：对房间里的某名远端玩家造成伤害（写回服务端，所有人可见） */
export function gmDamageRemote(memberId) {
    return remoteHpChange(memberId, "damage");
}

/** 主持人：为房间里的某名远端玩家恢复 HP（写回服务端，所有人可见） */
export function gmHealRemote(memberId) {
    return remoteHpChange(memberId, "heal");
}

// ---------- 远端随从 / 主角形态受伤 · 治疗 ----------
// 随从的血量存在玩家的主人卡 companions 摘要里，服务端只有摘要，
// 所以写回走 editRemoteCompanion：拉完整卡 → 写 full.companionPatch（按 cid 落盘）→ 推 "hp"。
const remoteCompHpBusy = new Set();

function setRemoteCompHpBusy(memberId, companionId, busy) {
    const key = `${String(memberId || "")}:${String(companionId || "")}`;
    if (busy) remoteCompHpBusy.add(key); else remoteCompHpBusy.delete(key);
    try {
        document.querySelectorAll("[data-remote-comp-hp]").forEach(btn => {
            if (String(btn.getAttribute("data-remote-comp-hp") || "") !== key) return;
            btn.disabled = !!busy;
        });
    } catch { /* 纯 UI 修饰，失败无所谓 */ }
}

// mode: "damage" 扣血 / "heal" 回血；hp 夹在 [0, maxHp]，满血治疗 / 0 血受伤不推送
async function remoteCompanionHpChange(memberId, companionId, mode) {
    const mid = String(memberId || "");
    const cid = String(companionId || "");
    if (!mid || !cid) return;
    if (remoteCompHpBusy.has(`${mid}:${cid}`)) return;
    const m = remoteMemberById(mid);
    if (!m) return;
    const char = remoteCharOf(m);
    const comps = (char && Array.isArray(char.companions)) ? char.companions : [];
    const c = comps.find(x => x && String(x.id) === cid) || null;
    if (!c) return;
    const maxHp = clampNum(c.maxHp !== undefined ? c.maxHp : c.maxHpBase, 0, LIMITS.hpMp[1], 0);
    const isHeal = mode === "heal";
    if (maxHp <= 0) { alert("该随从没有可用的生命值数据"); return; }
    const whoName = String(c.name || "").trim() || "随从";
    const raw = prompt(isHeal ? `为 ${whoName} 恢复多少 HP？` : `对 ${whoName} 造成多少伤害？`, "5");
    if (raw === null) return;
    const amount = clampNum(raw, 0, LIMITS.hpMp[1], 0);
    if (!amount) return;
    let cap = maxHp;
    let after = 0;
    let delta = 0;
    let skip = "";
    setRemoteCompHpBusy(mid, cid, true);
    try {
        const ok = await editRemoteCompanion(mid, cid, (copy) => {
            cap = clampNum(copy.maxHp, 0, LIMITS.hpMp[1], 0);
            if (cap <= 0) { skip = "该随从没有可用的生命值数据"; return false; }
            const cur = clampNum(copy.hp, 0, cap, 0);
            const next = isHeal
                ? clampNum(Math.min(cap, cur + amount), 0, cap, 0)
                : clampNum(Math.max(0, cur - amount), 0, cap, 0);
            // 用实际变化量判断：满血治疗 / 0 血再受伤都不写回、不广播
            delta = isHeal ? next - cur : cur - next;
            if (delta <= 0) { skip = isHeal ? "HP 已满，未恢复" : "HP 已为 0"; return false; }
            copy.hp = next;
            after = next;
            return true;
        }, () => (isHeal
            ? `${whoName}（随从）恢复 ${delta} HP，剩余 HP ${after}/${cap}`
            : `${whoName}（随从）受到 ${delta} 伤害，剩余 HP ${after}/${cap}`));
        if (!ok) { if (skip) alert(skip); return; }
        saveGm();
        renderGmPanel();
    } catch (e) {
        alert("操作失败：" + (e && e.message ? e.message : String(e)));
    } finally {
        setRemoteCompHpBusy(mid, cid, false);
    }
}

/** 主持人：对远端玩家的某只随从（或主角形态）造成伤害 */
export function gmDamageRemoteCompanion(memberId, companionId) {
    return remoteCompanionHpChange(memberId, companionId, "damage");
}

/** 主持人：为远端玩家的某只随从（或主角形态）恢复 HP */
export function gmHealRemoteCompanion(memberId, companionId) {
    return remoteCompanionHpChange(memberId, companionId, "heal");
}

// ---------- 遭遇 ----------
export function addEnemy() {
    if (roomSession() && !roomIsGm()) return;
    gm.enemies.push(normalizeEnemy({ name: "新敌人", icon: "👹", maxHp: 10, hp: 10, ac: 10, init: 0 }));
    saveGm();
    renderGmPanel();
}

export function removeEnemy(id) {
    if (roomSession() && !roomIsGm()) return;
    gm.enemies = gm.enemies.filter(e => e.id !== id);
    saveGm();
    renderGmPanel();
}

export function clearEnemies() {
    if (roomSession() && !roomIsGm()) return;
    if (!gm.enemies.length) return;
    if (!confirm("清空所有敌人？")) return;
    gm.enemies = [];
    saveGm();
    renderGmPanel();
}

export function setEnemyField(id, field, value) {
    const e = gm.enemies.find(x => x.id === id);
    if (!e) return;
    if (field === "name") e.name = String(value || "").trim().slice(0, 40) || "敌人";
    else if (field === "icon") e.icon = String(value || "").trim().slice(0, 4) || "👹";
    else if (field === "note") e.note = String(value || "").slice(0, 200);
    else if (field === "maxHp") {
        e.maxHp = clampNum(value, 1, LIMITS.enemyHp[1], 1);
        e.hp = clampNum(e.hp, 0, e.maxHp, e.maxHp);
    } else if (field === "hp") {
        e.hp = clampNum(value, 0, Math.max(1, e.maxHp), 0);
    } else if (field === "ac") e.ac = clampNum(value, LIMITS.enemyAc[0], LIMITS.enemyAc[1], 10);
    else if (field === "init") e.init = clampNum(value, -999, 9999, 0);
    saveGm();
    renderGmPanel();
}

export function damageEnemy(id) {
    const e = gm.enemies.find(x => x.id === id);
    if (!e) return;
    const dmg = clampNum(prompt("对 " + e.name + " 造成多少伤害？", "5"), 0, LIMITS.enemyHp[1], 0);
    e.hp = clampNum(Math.max(0, e.hp - dmg), 0, Math.max(1, e.maxHp), 0);
    saveGm();
    gmLog(`${e.name} 受到 ${dmg} 伤害，剩余 HP ${e.hp}/${e.maxHp}`);
    renderGmPanel();
}

export function healEnemy(id) {
    const e = gm.enemies.find(x => x.id === id);
    if (!e) return;
    const heal = clampNum(prompt("为 " + e.name + " 恢复多少 HP？", "5"), 0, LIMITS.enemyHp[1], 0);
    e.hp = clampNum(Math.min(e.maxHp, e.hp + heal), 0, Math.max(1, e.maxHp), 0);
    saveGm();
    gmLog(`${e.name} 恢复 ${heal} HP，当前 ${e.hp}/${e.maxHp}`);
    renderGmPanel();
}

// ---------- 伤害计算器（怪物 / 陷阱） ----------
// 一条 = 一种攻击公式。怪多就多加几条；×N 模拟一群同种怪。公式存在 GM 存档里，不用反复填。
let calcCache = {};

function calcTargets() {
    const out = [];
    heroes().forEach(h => {
        const hs = heroSnapshot(h.id);
        if (!hs) return;
        out.push({
            id: h.id,
            name: hs.data.name || h.name || "角色",
            hp: clampNum(hs.data.hp, 0, Math.max(1, hs.snap.total.maxHp), 0),
            maxHp: Math.max(1, hs.snap.total.maxHp),
            ac: Math.max(0, Math.round(clampNum(hs.snap.total.armor, 0, FINAL_MAX, 0)))
        });
    });
    companionUnits().forEach(u => {
        if (u.cc.combat !== true) return;
        out.push({
            id: u.meta.id,
            name: `${u.cc.icon || "🐾"} ${u.cc.name || "随从"}`,
            hp: clampNum(u.cc.hp, 0, Math.max(1, u.cc.maxHp), 0),
            maxHp: Math.max(1, u.cc.maxHp),
            ac: Math.max(0, Math.round(clampNum(u.cc.armor, 0, FINAL_MAX, 0)))
        });
    });
    // 远端成员（房间里其他玩家）：有卡的用摘要血量；没上传卡的也列出来，选中结算时给明确提示
    if (roomSession()) {
        const meId = String(roomMyMemberId() || "");
        const members = ((roomSnapshot() || {}).members || []).filter(m => m && m.id && String(m.id) !== meId);
        members.forEach(m => {
            const c = remoteCharOf(m);
            const pname = String(m.name || "").trim() || "玩家";
            if (!c) {
                out.push({
                    id: "remote:" + m.id,
                    name: "（未上传角色卡）",
                    player: pname,
                    hp: 0,
                    maxHp: 0,
                    ac: null,
                    remote: true,
                    hasChar: false,
                    online: m.online !== false
                });
                return;
            }
            const maxHp = clampNum(c.maxHp !== undefined ? c.maxHp : c.maxHpBase, 0, LIMITS.hpMp[1], 0);
            const hero = remoteHeroFormOf(m);
            // 主角形态接管：本体卡不再进目标列表（否则可绕过变身打主角），只列形态。
            if (hero) {
                const hmax = clampNum(hero.maxHp !== undefined ? hero.maxHp : hero.maxHpBase, 0, LIMITS.hpMp[1], 0);
                out.push({
                    id: `remote:${m.id}:${hero.id}`,
                    name: `${String(hero.icon || "").trim() ? String(hero.icon).trim() + " " : ""}${String(hero.name || "").trim() || "主角形态"}`,
                    player: pname,
                    hp: clampNum(hero.hp, 0, Math.max(1, hmax), 0),
                    maxHp: hmax,
                    ac: null,
                    remote: true,
                    companion: true,
                    form: true,
                    hasChar: true,
                    online: m.online !== false
                });
            } else {
                out.push({
                    id: "remote:" + m.id,
                    name: String(c.name || "").trim() || "角色",
                    player: pname,
                    hp: clampNum(c.hp, 0, Math.max(1, maxHp), 0),
                    maxHp,
                    ac: null,
                    remote: true,
                    hasChar: true,
                    online: m.online !== false
                });
            }
            // 该玩家的参战随从也能当承伤目标（摘要里有 hp/maxHp；AC 摘要里没有 → 显示 AC ?）
            (Array.isArray(c.companions) ? c.companions : []).forEach(cc => {
                if (!cc || !cc.id || cc.combat !== true) return;
                if (hero && String(cc.id) === String(hero.id)) return; // 形态已单独输出
                const cmax = clampNum(cc.maxHp !== undefined ? cc.maxHp : cc.maxHpBase, 0, LIMITS.hpMp[1], 0);
                const cname = String(cc.name || "").trim() || "随从";
                out.push({
                    id: `remote:${m.id}:${cc.id}`,
                    name: `${String(cc.icon || "").trim() ? String(cc.icon).trim() + " " : ""}${cname}`,
                    player: pname,
                    hp: clampNum(cc.hp, 0, Math.max(1, cmax), 0),
                    maxHp: cmax,
                    ac: null,
                    remote: true,
                    companion: true,
                    hasChar: true,
                    online: m.online !== false
                });
            });
        });
    }
    return out;
}

function calcTargetOptions(selected) {
    const opts = ['<option value="">（选择承伤目标）</option>'];
    calcTargets().forEach(t => {
        if (t.remote) {
            const dot = t.online === false ? "⚪" : "🟢";
            const player = t.player || "玩家";
            const who = t.companion ? `玩家 ${player} 的随从` : `玩家 ${player}`;
            const label = t.hasChar === false
                ? `玩家 ${player}（未上传角色卡）`
                : (t.form
                    ? `${t.name}（玩家 ${player} · 主角形态 · ${t.hp}/${t.maxHp} · ${t.ac == null ? "AC ?" : "AC " + t.ac}）`
                    : `${t.name}（${who} · ${t.hp}/${t.maxHp} · ${t.ac == null ? "AC ?" : "AC " + t.ac}）`);
            opts.push(`<option value="${esc(t.id)}"${t.id === selected ? " selected" : ""}>${dot} ${esc(label)}</option>`);
            return;
        }
        opts.push(`<option value="${esc(t.id)}"${t.id === selected ? " selected" : ""}>${esc(t.name)}（${t.hp}/${t.maxHp} · AC ${t.ac}）</option>`);
    });
    return opts.join("");
}

// 承伤目标的 AC（未选目标时为 null）。本地目标同步返回；远端目标只有完整卡在服务端，
// 这里返回 Promise<number|null>，调用方 gmRollCalc 会识别并 await，本地路径保持同步行为。
function calcTargetAc(c) {
    const id = c && c.targetId ? c.targetId : "";
    if (!id) return null;
    if (isRemoteTargetId(id)) return remoteTargetAc(id);
    const t = partyTarget(id);
    return t ? t.ac : null;
}

async function remoteTargetAc(targetId) {
    const parsed = parseRemoteTargetId(targetId);
    const mid = parsed ? parsed.memberId : String(targetId || "").replace(/^remote:/, "");
    if (!mid) return null;
    // 随从的 AC 不在成员摘要里，也没有「随从完整卡」可拉 → 按未知处理（下拉显示 AC ?）
    if (parsed && parsed.companionId) return null;
    try {
        const full = await (globalThis.roomFetchChar?.(mid) || Promise.resolve(null));
        if (!full || typeof full !== "object") return null;
        const snap = computeSnapshotWithOwner(full);
        const armor = snap && snap.total ? snap.total.armor : null;
        if (armor === null || armor === undefined) return null;
        return Math.max(0, Math.round(clampNum(armor, 0, FINAL_MAX, 0)));
    } catch { return null; }
}

// 掷 times 次，返回逐次结果与总和（公式非法时按 0 计）
// 开了「需命中」时，每次攻击再掷 d20+命中加值 vs AC，只有命中的那一击计伤害
function rollCalcValues(c, ac) {
    const times = clampInt(c.times, 1, 50, 1);
    const rolls = [];
    let total = 0;
    for (let i = 0; i < times; i++) {
        const r = parseDiceExpr(c.formula);
        const v = Math.max(0, Math.floor(clampNum(r && r.total, 0, LIMITS.hpMp[1], 0)));
        rolls.push(v);
        total = clampNum(total + v, 0, LIMITS.hpMp[1], 0);
    }
    const atk = [];
    let hitTotal = total;
    if (c.hit) {
        hitTotal = 0;
        for (let i = 0; i < times; i++) {
            const d20 = rollOne(20);
            const at = d20 + clampInt(c.atkMod, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
            // 20 必中、1 必失；没有目标时无法判定命中
            const hit = ac == null ? false : (d20 === 20 ? true : (d20 === 1 ? false : at >= ac));
            atk.push({ d20, total: at, hit });
            if (hit) hitTotal = clampNum(hitTotal + rolls[i], 0, LIMITS.hpMp[1], 0);
        }
    }
    return { total, hitTotal, rolls, atk };
}

function renderGmCalcs() {
    const el = document.getElementById("gmCalcs");
    if (!el) return;
    if (!gm.calcs.length) {
        el.innerHTML = '<div class="empty">还没有伤害公式 · 点上方「＋ 添加一条」</div>';
        return;
    }
    el.innerHTML = `<div class="gm-scroll-list">${gm.calcs.map(c => {
        const cache = calcCache[c.id];
        const rollTxt = `🎲 ${cache && cache.rolls.length > 1 ? cache.rolls.join(" + ") + " = " : ""}<b>${cache ? cache.total : ""}</b>`;
        let result = cache ? rollTxt : "";
        if (cache && c.hit && Array.isArray(cache.atk) && cache.atk.length) {
            const hits = cache.atk.filter(a => a.hit).length;
            const acTxt = cache.ac == null ? "未选目标" : `AC ${cache.ac}`;
            const atkTxt = cache.atk.length > 1
                ? `命中 ${hits}/${cache.atk.length} · 实伤 ${cache.hitTotal}${cache.ac == null ? " · 未选目标" : ""}`
                : `d20(${cache.atk[0].d20})${c.atkMod >= 0 ? "+" : ""}${c.atkMod} = ${cache.atk[0].total} vs ${acTxt} · ${cache.atk[0].hit ? "✅ 命中" : "❌ 未命中"}`;
            result += `<span class="gm-calc-hitres ${hits ? "ok" : "bad"}">${esc(atkTxt)}</span>`;
        }
        return `<div class="gm-row gm-calc-row">
    <div class="gm-head">
        <input class="gm-name-input" value="${esc(c.name)}" title="这条攻击叫什么" onchange="gmSetCalcField('${esc(c.id)}','name',this.value)">
        <input class="gm-formula" value="${esc(c.formula)}" placeholder="如 2d6+3" title="伤害公式" onchange="gmSetCalcField('${esc(c.id)}','formula',this.value)">
        <span class="gm-sub">×</span>
        <input class="gm-times" type="number" min="1" max="50" value="${c.times}" title="掷几次（一群怪）" onchange="gmSetCalcField('${esc(c.id)}','times',this.value)">
        <label class="gm-calc-hit" title="先掷 d20 + 命中加值，对抗目标 AC，未命中不结算伤害">
            <input type="checkbox" ${c.hit ? "checked" : ""} onchange="gmSetCalcField('${esc(c.id)}','hit',this.checked ? 1 : 0)"> 需命中
        </label>
        <input class="gm-times" type="number" value="${c.atkMod}" title="命中加值（d20 + 此值 vs 目标 AC）" onchange="gmSetCalcField('${esc(c.id)}','atkMod',this.value)">
        <span class="gm-remove" onclick="gmRemoveCalc('${esc(c.id)}')" title="删除这条">✖</span>
    </div>
    <div class="gm-head">
        <select class="gm-calc-target" onchange="gmSetCalcField('${esc(c.id)}','targetId',this.value)">${calcTargetOptions(c.targetId)}</select>
        <button class="small" onclick="void gmRollCalc('${esc(c.id)}')">🎲 投掷</button>
        <button class="small" onclick="void gmApplyCalc('${esc(c.id)}')">⚔ 施加伤害</button>
        <span class="gm-calc-result">${result}</span>
    </div>
</div>`;
    }).join("")}</div>`;
}

export function gmAddCalc() {
    gm.calcs.push(normalizeCalc({ name: "攻击", formula: "1d6+2", times: 1 }));
    if (gm.calcs.length > 24) gm.calcs = gm.calcs.slice(-24);
    saveGm();
    renderGmPanel();
}

export function gmRemoveCalc(id) {
    gm.calcs = gm.calcs.filter(c => c.id !== id);
    delete calcCache[id];
    saveGm();
    renderGmPanel();
}

export function gmClearCalcs() {
    if (!gm.calcs.length) return;
    if (!confirm("清空所有伤害公式？")) return;
    gm.calcs = [];
    calcCache = {};
    saveGm();
    renderGmPanel();
}

export function gmSetCalcField(id, field, value) {
    const c = gm.calcs.find(x => x.id === id);
    if (!c) return;
    if (field === "name") c.name = String(value || "").trim().slice(0, 40) || "攻击";
    else if (field === "formula") c.formula = String(value || "").trim().slice(0, 40) || "1d6";
    else if (field === "times") c.times = clampInt(value, 1, 50, 1);
    else if (field === "targetId") c.targetId = String(value || "").slice(0, 64);
    else if (field === "hit") c.hit = Number(value) === 1 || value === true;
    else if (field === "atkMod") c.atkMod = clampInt(value, LIMITS.diceMod[0], LIMITS.diceMod[1], 0);
    delete calcCache[id]; // 公式/次数/目标/命中设置变了，旧结果作废
    saveGm();
    renderGmPanel();
}

export async function gmRollCalc(id) {
    const c = gm.calcs.find(x => x.id === id);
    if (!c) return;
    // 远端目标的 AC 要等完整卡拉回来：只有这一条分支 await，本地目标维持同步完成
    const acRaw = calcTargetAc(c);
    const ac = (acRaw && typeof acRaw.then === "function") ? await acRaw : acRaw;
    const r = rollCalcValues(c, ac);
    calcCache[id] = { ...r, times: c.times, ac };
    if (c.hit) {
        const hits = r.atk.filter(a => a.hit).length;
        const acTxt = ac == null ? "未选目标" : `AC ${ac}`;
        gmLog(`🎯 ${c.name} ${c.formula}${c.times > 1 ? ` ×${c.times}` : ""} → 命中 ${hits}/${c.times}（${acTxt}），伤害 ${r.hitTotal}`);
    } else {
        gmLog(`💥 ${c.name} ${c.formula}${c.times > 1 ? ` ×${c.times}` : ""} → ${r.total}`);
    }
    renderGmPanel();
}

export async function gmApplyCalc(id) {
    const c = gm.calcs.find(x => x.id === id);
    if (!c) return;
    if (!calcCache[id]) {
        // 本地投掷是同步完成的（返回时 calcCache 已就绪）；远端目标要等拉卡算 AC，才需要 await
        const pending = gmRollCalc(id);
        if (isRemoteTargetId(c.targetId) && pending && typeof pending.then === "function") await pending;
    }
    const cache = calcCache[id];
    if (!cache) return;

    // 远端玩家：完整卡在服务端，只能「拉取 → 改 hp → 推回」，本地存档里没有这张卡
    if (isRemoteTargetId(c.targetId)) {
        const parsed = parseRemoteTargetId(c.targetId) || {};
        const memberId = parsed.memberId || "";
        const companionId = parsed.companionId || "";
        const m = ((roomSnapshot() || {}).members || []).find(x => x && String(x.id) === memberId) || null;
        if (!m || !remoteCharOf(m)) {
            alert("该玩家还没有上传可用的角色卡，无法结算伤害（请对方先上传角色卡）");
            return;
        }
        // 随从目标：完整卡不在服务端，走「主人卡 companionPatch」通道，只改摘要里的 hp
        if (companionId) {
            const dmgC = c.hit ? clampNum(cache.hitTotal, 0, LIMITS.hpMp[1], 0) : cache.total;
            const nameTxtC = remoteTargetLabel(c.targetId);
            if (c.hit && dmgC <= 0) {
                gmLog(`🎯 ${c.name} 未命中 ${nameTxtC}，本次不造成伤害`);
                renderGmPanel();
                return;
            }
            const hitTxtC = c.hit ? `（命中 ${cache.atk.filter(a => a.hit).length}/${cache.atk.length}）` : "";
            let afterHpC = 0;
            let afterMaxC = 1;
            await editRemoteCompanion(memberId, companionId, comp => {
                const maxHp = Math.max(1, Math.round(clampNum(comp.maxHp, 1, LIMITS.hpMp[1], 1)));
                afterMaxC = maxHp;
                const curHp = clampNum(comp.hp, 0, maxHp, 0);
                comp.hp = clampNum(Math.max(0, curHp - dmgC), 0, maxHp, 0);
                afterHpC = comp.hp;
                return true;
            }, () => `💥 ${c.name} 对 ${nameTxtC} 造成 ${dmgC} 伤害${hitTxtC}，剩余 HP ${afterHpC}/${afterMaxC}`);
            return;
        }
        const dmg = c.hit ? clampNum(cache.hitTotal, 0, LIMITS.hpMp[1], 0) : cache.total;
        const nameTxt = remoteTargetLabel(c.targetId);
        if (c.hit && dmg <= 0) {
            gmLog(`🎯 ${c.name} 未命中 ${nameTxt}，本次不造成伤害`);
            renderGmPanel();
            return;
        }
        const hitTxt = c.hit ? `（命中 ${cache.atk.filter(a => a.hit).length}/${cache.atk.length}）` : "";
        let afterHp = 0;
        let afterMax = 1;
        // 失败提示由 editRemoteChar 内部 alert 负责
        await editRemoteChar(memberId, full => {
            const snap = computeSnapshotWithOwner(full);
            const maxHp = Math.max(1, Math.round(clampNum(snap && snap.total ? snap.total.maxHp : full.maxHp, 1, LIMITS.hpMp[1], 1)));
            afterMax = maxHp;
            const curHp = clampNum(full.hp, 0, maxHp, 0);
            full.hp = clampNum(Math.max(0, curHp - dmg), 0, maxHp, 0);
            afterHp = full.hp;
            return true;
        }, () => `💥 ${c.name} 对 ${nameTxt} 造成 ${dmg} 伤害${hitTxt}，剩余 HP ${afterHp}/${afterMax}`, "hp");
        return;
    }

    const t = c.targetId ? partyTarget(c.targetId) : null;
    if (!t) { alert("先给这条攻击选择一个承伤目标"); return; }
    const dmg = c.hit ? clampNum(cache.hitTotal, 0, LIMITS.hpMp[1], 0) : cache.total;
    const nameTxt = `${t.data.name || "角色"}${t.isComp ? "（随从）" : ""}`;
    if (c.hit && dmg <= 0) {
        gmLog(`🎯 ${c.name} 未命中 ${nameTxt}，本次不造成伤害`);
        renderGmPanel();
        return;
    }
    t.data.hp = clampNum(Math.max(0, clampNum(t.hp, 0, t.maxHp, 0) - dmg), 0, t.maxHp, 0);
    if (t.isComp) dropDeadCompanion(t.data);
    saveCharAndSync(c.targetId, t.data);
    if (t.isComp) pushHpToOwner(t.data);
    const hitTxt = c.hit ? `（命中 ${cache.atk.filter(a => a.hit).length}/${cache.atk.length}）` : "";
    gmLog(`💥 ${c.name} 对 ${nameTxt} 造成 ${dmg} 伤害${hitTxt}，剩余 HP ${t.data.hp}/${t.maxHp}`);
    renderGmPanel();
}

// ---------- 骰子 ----------
export function gmRoll(sides) {
    const s = clampInt(sides, 2, LIMITS.diceSides[1], 20);
    const v = rollOne(s);
    // 主持人的投骰也记进「本回合投掷记录」，客机才看得到（以前只写日志）
    const roll = normalizeRoll({
        round: gm.round,
        charId: "",
        charName: "主持人",
        kind: "dice",
        detail: `d${s}`,
        total: v,
        at: Date.now()
    });
    if (!Array.isArray(gm.rolls)) gm.rolls = [];
    gm.rolls.push(roll);
    if (gm.rolls.length > 200) gm.rolls = gm.rolls.slice(-200);
    // gmLog 内部会 saveGm()：日志和投掷记录一次上行，不重复触发
    gmLog(`🎲 d${s} → ${v}`);
    renderGmRolls();
}

// ---------- 远端玩家目标：把 Buff / 物品 / 金币派发给房间里的其他玩家 ----------
// 远端玩家只有「完整卡」在服务端，改它必须：roomFetchChar → 改 → roomPushCharTo。
function isRemoteTargetId(id) {
    return String(id || "").startsWith("remote:");
}

// 远端目标 id：成员是 `remote:<memberId>`；随从扩展成 `remote:<memberId>:<companionId>`。
// 解析失败（前缀不对 / 缺成员 id）返回 null，调用方据此回退到原来的成员路径。
function parseRemoteTargetId(id) {
    const s = String(id || "");
    if (!s.startsWith("remote:")) return null;
    const rest = s.slice("remote:".length);
    if (!rest) return null;
    const i = rest.indexOf(":");
    if (i < 0) return { memberId: rest, companionId: "" };
    const memberId = rest.slice(0, i);
    const companionId = rest.slice(i + 1);
    return memberId ? { memberId, companionId } : null;
}

// 远端成员「主角形态」：mode=hero 且参战的随从接管了本体。
// 变身期间本体卡不再作为伤害/Buff 目标，改由形态承接，避免绕过变身打主角。
function heroFormInChar(char) {
    const comps = (char && Array.isArray(char.companions)) ? char.companions : [];
    return comps.find(c => c && c.mode === "hero" && c.combat === true) || null;
}

function remoteHeroFormOf(m) {
    if (!roomIsGm()) return null;
    return heroFormInChar(m && m.char);
}

// 一条远端成员的随从选项：Buff 看全部随从，伤害计算器只看参战随从。
// skipId 用于排除已经作为「主角形态」单独输出的那一项，避免同一个随从出现两遍。
function remoteCompanionOptionsHtml(m, combatOnly, skipId) {
    const membersComps = (m && m.char && Array.isArray(m.char.companions)) ? m.char.companions : [];
    const charName = String((m && m.char && m.char.name) || m && m.name || "").trim() || String(m && m.name || "").trim() || "玩家";
    return membersComps
        .filter(c => c && c.id && (!combatOnly || c.combat === true) && String(c.id) !== String(skipId || ""))
        .map(c => {
            const cname = String(c.name || "").trim() || "随从";
            const label = `🔹 ${cname}（${charName} 的随从）`;
            return `<option value="remote:${esc(String(m.id))}:${esc(String(c.id))}">${esc(label)}</option>`;
        })
        .join("");
}

// 下拉里的远端成员选项：只给主持人、只列别人（自己那台用本地角色卡）
// opts.companions === false 时不追加随从项（背包/金币只认成员卡）；combatOnly 只列参战随从
function remoteTargetOptions(opts = {}) {
    if (!roomSession() || !roomIsGm()) return "";
    const withComps = opts.companions !== false;
    const combatOnly = opts.combatOnly === true;
    const me = String(roomMyMemberId() || "");
    const members = (roomSnapshot()?.members || []).filter(m => m && m.id && String(m.id) !== me);
    return members.map(m => {
        const dot = m.online ? "🟢" : "⚪";
        const pname = String(m.name || "").trim() || "玩家";
        const cname = String((m.char && m.char.name) || "").trim();
        const label = cname ? `${cname}（玩家 ${pname}）` : `玩家 ${pname}（未上传角色卡）`;
        const hero = remoteHeroFormOf(m);
        const compOpts = withComps ? remoteCompanionOptionsHtml(m, combatOnly, hero && hero.id) : "";
        // 主角形态接管时，成员卡不再可选（否则可以绕过变身直接改本体）；
        // 目标改为形态（remote:<mid>:<heroCid>），走 editRemoteCompanion 改形态的 HP/Buff。
        // 背包/金币（companions:false）仍按成员卡处理：它们不碰 HP，也不存在绕变身。
        if (hero && withComps) {
            const formName = String(hero.name || "").trim() || "主角形态";
            return `<option value="remote:${esc(String(m.id))}:${esc(String(hero.id))}">${dot} 🐉 ${esc(formName)}（${esc(pname)} · 主角形态）</option>` + compOpts;
        }
        return `<option value="remote:${esc(String(m.id))}">${dot} ${esc(label)}</option>` + compOpts;
    }).join("");
}

// 远端目标的「成员签名」：成员加入/离开/改名/换角色卡都会变
function remoteTargetSignature() {
    if (!roomSession() || !roomIsGm()) return "";
    const me = String(roomMyMemberId() || "");
    return (roomSnapshot()?.members || [])
        .filter(m => m && m.id && String(m.id) !== me)
        .map(m => {
            const comps = (m.char && Array.isArray(m.char.companions)) ? m.char.companions : [];
            const compSig = comps.map(c => `${c && c.id}:${c && c.combat ? 1 : 0}`).join(",");
            return `${m.id}|${m.online ? 1 : 0}|${m.name || ""}|${(m.char && m.char.name) || ""}|${compSig}`;
        })
        .join(";");
}

let remoteTargetSig = null;
// 房间成员变化后重画三个目标下拉（派发 Buff / 背包金币 / 伤害计算器）。
// 否则主持人停在面板上、玩家中途加入时，下拉里永远只有本机角色（成员变化不会触发 renderGmPanel）。
export function refreshRemoteTargets() {
    const sig = remoteTargetSignature();
    if (sig === remoteTargetSig) return;
    const first = remoteTargetSig === null;
    remoteTargetSig = sig;
    if (first && !sig) return; // 首次且没有远端成员：保持现有渲染，避免无谓重画
    gmRenderBuffTargets();
    gmRenderItemTargets();
    renderGmCalcs();
}

// 日志里要写清楚是哪个玩家：角色名（玩家名），没上传卡就只写玩家名
// 随从目标写成「随从名（角色名的随从）」，和下拉文案保持一致
function remoteTargetLabel(targetId) {
    const parsed = parseRemoteTargetId(targetId);
    const mid = parsed ? parsed.memberId : String(targetId || "").replace(/^remote:/, "");
    const m = (roomSnapshot()?.members || []).find(x => x && String(x.id) === mid);
    const pname = String((m && m.name) || "").trim() || mid;
    const cname = String((m && m.char && m.char.name) || "").trim();
    if (parsed && parsed.companionId) {
        const comps = (m && m.char && Array.isArray(m.char.companions)) ? m.char.companions : [];
        const c = comps.find(x => x && String(x.id) === parsed.companionId);
        const compName = String((c && c.name) || parsed.companionId).trim() || "随从";
        if (c && c.mode === "hero") return `${compName}（玩家 ${pname} · 主角形态）`;
        return `${compName}（${cname || pname || "角色"} 的随从）`;
    }
    return cname ? `${cname}（玩家 ${pname}）` : `玩家 ${pname}`;
}

// 远端背包缓存：主持人看玩家背包/金币时避免每次重画都去拉一次完整卡
const remoteBagCache = new Map();

// 统一远端写卡：拉完整卡 → mutate → 推回。mutate 返回 false 表示放弃（不写回）。
// logText 可以是字符串，也可以是回调（需要 mutate 里算出来的名字/数量）。
// mode：战斗/资源类改动（伤害、Buff、物品、金币、行动/回合结算）传 "hp"，客机会静默自动应用；
// 只有真正「改卡」的操作（名字/技能/装备等）才留默认 "edit"，走玩家的确认条。
async function editRemoteChar(memberId, mutate, logText, mode = "edit") {
    const parsed = parseRemoteTargetId(memberId);
    const mid = parsed ? parsed.memberId : String(memberId || "").replace(/^remote:/, "");
    if (!mid) return false;
    try {
        const full = await (globalThis.roomFetchChar?.(mid));
        if (!full || typeof full !== "object") { alert("读取该玩家角色卡失败，可能还没上传完整角色卡"); return false; }
        let changed;
        try { changed = mutate(full); } catch (e) { alert("操作失败：" + (e && e.message ? e.message : "未知错误")); return false; }
        if (changed === false) return false;
        const ok = await (globalThis.roomPushCharTo?.(mid, full, mode === "hp" ? "hp" : "edit"));
        if (!ok) { alert("同步失败，请检查服务器连接"); return false; }
        remoteBagCache.set(mid, { data: full, at: Date.now() });
        if (logText) gmLog(typeof logText === "function" ? logText() : logText);
        renderGmPanel();
        return true;
    } catch (e) {
        alert("操作失败：" + (e && e.message ? e.message : "未知错误"));
        return false;
    }
}

// 远端随从写回：随从完整卡在玩家本机，服务端只有主人卡里的 companions 摘要。
// 所以这里不改服务端的摘要本身，而是给主人卡挂一个 companionPatch，
// 客机应用主人卡时按 cid 落到自己的随从存档（见 roomApplyPendingChar）。
async function editRemoteCompanion(memberId, companionId, mutate, logText) {
    const parsed = parseRemoteTargetId(memberId);
    const mid = parsed ? parsed.memberId : String(memberId || "").replace(/^remote:/, "");
    const cid = String(companionId || "").trim();
    if (!mid || !cid) return false;
    try {
        const full = await (globalThis.roomFetchChar?.(mid));
        if (!full || typeof full !== "object") { alert("读取该玩家角色卡失败，可能还没上传完整角色卡"); return false; }
        const comps = Array.isArray(full.companions) ? full.companions : [];
        const found = comps.find(c => c && String(c.id) === cid);
        if (!found) { alert("读取该玩家角色卡失败，可能还没上传完整角色卡"); return false; }
        // 基于摘要项构造可改副本；摘要里没有的字段不臆造，mutate 只碰 hp/mp/buffs/name
        const copy = {
            name: String(found.name || "随从"),
            hp: Math.max(0, Number(found.hp) || 0),
            maxHp: Math.max(0, Number(found.maxHp) || 0),
            mp: Math.max(0, Number(found.mp) || 0),
            maxMp: Math.max(0, Number(found.maxMp) || 0),
            buffs: Array.isArray(found.buffs) ? JSON.parse(JSON.stringify(found.buffs)) : []
        };
        let changed;
        try { changed = mutate(copy); } catch (e) { alert("操作失败：" + (e && e.message ? e.message : "未知错误")); return false; }
        if (changed === false) return false;
        const maxHp = Math.max(0, Number(copy.maxHp) || 0);
        const maxMp = Math.max(0, Number(copy.maxMp) || 0);
        let hp = Math.max(0, Number(copy.hp) || 0);
        let mp = Math.max(0, Number(copy.mp) || 0);
        if (maxHp > 0) hp = Math.min(hp, maxHp);
        if (maxMp > 0) mp = Math.min(mp, maxMp);
        full.companionPatch = {
            ops: [{ cid, hp, mp, buffs: Array.isArray(copy.buffs) ? copy.buffs : [] }],
            at: Date.now()
        };
        const ok = await (globalThis.roomPushCharTo?.(mid, full, "hp"));
        if (!ok) { alert("同步失败，请检查服务器连接"); return false; }
        remoteBagCache.set(mid, { data: full, at: Date.now() });
        if (logText) gmLog(typeof logText === "function" ? logText() : logText);
        renderGmPanel();
        return true;
    } catch (e) {
        alert("操作失败：" + (e && e.message ? e.message : "未知错误"));
        return false;
    }
}

// ---------- 派发 Buff ----------
function buffTargets() {
    const out = [];
    heroes().forEach(h => out.push({ id: h.id, name: h.name || "无名", kind: "hero" }));
    companionUnits().forEach(u => {
        out.push({
            id: u.meta.id,
            name: u.cc.name || u.meta.name || "随从",
            kind: "companion",
            icon: u.cc.icon || u.meta.icon || "🐾",
            combat: u.cc.combat === true
        });
    });
    return out;
}

export function gmRenderBuffTargets() {
    const sel = document.getElementById("gmBuffTarget");
    if (!sel) return;
    const prev = sel.value;
    const list = buffTargets();
    sel.innerHTML = list.map(t => `<option value="${esc(t.id)}">${t.kind === "companion" ? esc(t.icon) + " " : "🧙 "}${esc(t.name)}${t.kind === "companion" ? (t.combat ? "（随从·参战）" : "（随从）") : ""}</option>`).join("") + remoteTargetOptions();
    // 远端选项不在 list 里，用实际渲染出的 option 判断，避免重画后掉回第一个角色
    if (prev && Array.from(sel.options || []).some(o => o.value === prev)) sel.value = prev;
    gmRenderBuffLib();
}

// ---------- 派发 Buff：公共库 + 所有角色的模板 ----------
// 以前模板只存在于「目标角色」自己的 buffLib 里，于是 A 的 Buff 没法发给 B。
// 现在主持人维护一个公共库，同时把各角色已有的模板也并进来，任何目标都能收到。
function normalizeBuffPreset(p) {
    const s = (p && typeof p === "object") ? p : {};
    const nb = normalizeBuff({
        name: String(s.name || "").trim().slice(0, 60),
        round: s.round,
        desc: s.desc,
        bonus: s.bonus,
        type: s.type,
        hpPerRound: s.hpPerRound,
        mpPerRound: s.mpPerRound,
        barName: s.barName,
        barPerRound: s.barPerRound,
        barOnApply: s.barOnApply,
        reqBar: s.reqBar,
        reqMin: s.reqMin
    });
    return {
        id: String(s.id || "") || makeId(),
        name: String(nb.name || "").trim().slice(0, 60) || "状态",
        round: clampInt(nb.round, LIMITS.round[0], LIMITS.round[1], 0),
        desc: String(nb.desc || "").slice(0, 300),
        bonus: typeof nb.bonus === "string" ? nb.bonus : (nb.bonus ? JSON.stringify(nb.bonus) : ""),
        type: nb.type,
        hpPerRound: clampInt(nb.hpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0),
        mpPerRound: clampInt(nb.mpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0),
        barName: barNameOf(nb.barName),
        barPerRound: clampInt(nb.barPerRound, LIMITS.customVal[0], LIMITS.customVal[1], 0),
        barOnApply: clampInt(nb.barOnApply, LIMITS.customVal[0], LIMITS.customVal[1], 0),
        reqBar: barNameOf(nb.reqBar),
        reqMin: clampInt(nb.reqMin, LIMITS.customVal[0], LIMITS.customVal[1], 0)
    };
}

// 下拉里能选的全部模板：公共库在前，然后是每个角色自己的快速施加库
function gmBuffTemplates() {
    const out = [];
    const push = (t, src) => {
        const p = normalizeBuffPreset(t);
        if (!p.name) return;
        if (out.some(x => x.id === p.id)) p.id = makeId();
        p.src = src;
        out.push(p);
    };
    (Array.isArray(gm.buffPresets) ? gm.buffPresets : []).forEach(t => push(t, "公共"));
    (charList || []).forEach(c => {
        if (!c || !c.id) return;
        const data = loadRawChar(c.id);
        if (!data) return;
        (Array.isArray(data.buffLib) ? data.buffLib : []).forEach(t => push(t, data.name || "角色"));
    });
    const count = {};
    out.forEach(p => { count[p.name] = (count[p.name] || 0) + 1; });
    out.forEach(p => { p.dup = count[p.name] > 1; });
    return out;
}

// 用过的模板收进公共库：原角色被删掉也不影响继续派发
function upsertGmBuffPreset(b) {
    if (!Array.isArray(gm.buffPresets)) gm.buffPresets = [];
    const p = normalizeBuffPreset(b);
    if (!p.name) return null;
    const exist = gm.buffPresets.find(x => x && x.name === p.name);
    if (exist) {
        const id = String(exist.id || "") || p.id;
        Object.assign(exist, p, { id });
        return exist;
    }
    p.id = makeId();
    gm.buffPresets.push(p);
    if (gm.buffPresets.length > 200) gm.buffPresets = gm.buffPresets.slice(-200);
    return p;
}

export function gmRenderBuffLib() {
    const sel = document.getElementById("gmBuffLib");
    if (!sel) return;
    const list = gmBuffTemplates();
    const prev = sel.value;
    sel.innerHTML = list.length
        ? list.map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.round ? `（${t.round} 回合）` : "（永久）"}${t.dup ? ` · ${esc(t.src)}` : ""}</option>`).join("")
        : '<option value="">还没有 Buff 模板 · 点下面「＋ 新增状态」建一个</option>';
    if (prev && list.some(t => t.id === prev)) sel.value = prev;
}

function buffTargetData() {
    const sel = document.getElementById("gmBuffTarget");
    const id = sel ? sel.value : "";
    if (!id) { alert("先选一个目标角色"); return null; }
    const data = loadRawChar(id);
    if (!data) { alert("目标角色不存在"); return null; }
    return { id, data };
}

export function gmApplyBuffTemplate() {
    const sel = document.getElementById("gmBuffTarget");
    const targetId = sel ? sel.value : "";
    if (!targetId) { alert("先选一个目标角色"); return; }
    const libSel = document.getElementById("gmBuffLib");
    const bid = libSel ? libSel.value : "";
    const list = gmBuffTemplates();
    const tpl = list.find(x => x.id === bid) || list.find(x => x.name === bid);
    if (!tpl) { alert("没有可派发的模板，可用下面「＋ 新增状态（完整编辑）」建一个"); return; }
    const round = clampInt(tpl.round, LIMITS.round[0], LIMITS.round[1], 0);
    // 施加逻辑只依赖目标卡，本地/远端共用同一份，字段形状完全一致
    const applyTo = data => {
        if (!Array.isArray(data.buffs)) data.buffs = [];
        const exist = data.buffs.find(b => b && b.name === tpl.name);
        if (exist) {
            // 同名只刷新回合，保留角色自己改过的数值
            exist.round = round;
        } else {
            const nb = normalizeBuff({
                name: tpl.name, round, desc: tpl.desc, bonus: tpl.bonus, type: tpl.type,
                hpPerRound: tpl.hpPerRound, mpPerRound: tpl.mpPerRound,
                barName: tpl.barName, barPerRound: tpl.barPerRound, barOnApply: tpl.barOnApply,
                reqBar: tpl.reqBar, reqMin: tpl.reqMin
            });
            data.buffs.push(nb);
            // 施加时立即改条，和角色卡里保存状态的行为一致
            if (nb.barName && nb.barOnApply) adjustCustomBar(data, nb.barName, nb.barOnApply);
            syncBarLinks(data);
        }
    };
    const buffTxt = `「${tpl.name || "未命名"}」${round > 0 ? `（${round} 回合）` : "（永久）"}`;
    if (isRemoteTargetId(targetId)) {
        const parsed = parseRemoteTargetId(targetId) || {};
        if (parsed.companionId) {
            // 远端随从：把 Buff 写进主人卡的 companionPatch，客机落到随从本地存档
            void editRemoteCompanion(parsed.memberId, parsed.companionId, comp => {
                if (!Array.isArray(comp.buffs)) comp.buffs = [];
                const exist = comp.buffs.find(b => b && b.name === tpl.name);
                if (exist) {
                    // 同名只刷新回合，保留角色自己改过的数值
                    exist.rounds = round;
                } else if (comp.buffs.length < 8) {
                    comp.buffs.push({ name: tpl.name, rounds: round, stack: 1 });
                }
                upsertGmBuffPreset(tpl);
                saveGm();
            }, `🎁 给 ${remoteTargetLabel(targetId)} 派发 Buff${buffTxt}`);
            return;
        }
        void editRemoteChar(targetId, full => {
            applyTo(full);
            upsertGmBuffPreset(tpl);
            saveGm();
        }, `🎁 给 ${remoteTargetLabel(targetId)} 派发 Buff${buffTxt}`, "hp");
        return;
    }
    const t = buffTargetData();
    if (!t) return;
    applyTo(t.data);
    upsertGmBuffPreset(tpl);
    saveGm();
    saveCharAndSync(t.id, t.data);
    gmLog(`🎁 给 ${t.data.name || "角色"} 派发 Buff${buffTxt}`);
    renderGmPanel();
}

// 复用角色卡里的「新增状态/Buff」弹窗（属性加成、类型、每回合 HP/MP 都能用）
export function gmOpenAddBuff() {
    const t = buffTargetData();
    if (!t) return;
    openGmBuffModal(t.id, (buff, data) => {
        // 主持人新建的状态自动进公共库，之后可以发给任何角色
        upsertGmBuffPreset(buff);
        saveGm();
        gmLog(`🎁 给 ${data.name || "角色"} 派发状态「${buff.name}」${buff.round > 0 ? `（${buff.round} 回合）` : "（永久）"}`);
        renderGmPanel();
    });
}

// ---------- 背包 / 金币 ----------
// 主持人可以直接看玩家背包、发放/删除物品、加减金币。金币不是物品，单独一条通道。
const BAG_CATS = {
    weapon: "⚔ 武器", armor: "🛡 盔甲", shield: "🔰 盾牌", helmet: "⛑ 头盔",
    ring: "💍 戒指", accessory: "📿 饰品", special: "✨ 特殊", consumable: "🧪 消耗", misc: "📦 杂物"
};

// 背包目标 = 所有主角（含未参战）+ 所有随从（发东西/看背包跟参战无关）
function bagTargets() {
    const out = [];
    (charList || []).forEach(c => {
        if (!c || !c.id || isRemoteMirror(c)) return;
        if (c.type === "companion") out.push({ id: c.id, name: c.name || "随从", kind: "companion", icon: c.icon || "🐾" });
    });
    (charList || []).forEach(c => {
        if (!c || !c.id || c.type === "companion" || isRemoteMirror(c)) return;
        out.unshift({ id: c.id, name: c.name || "无名", kind: "hero" });
    });
    return out;
}

export function gmRenderItemTargets() {
    const sel = document.getElementById("gmItemTarget");
    if (!sel) return;
    const prev = sel.value;
    const list = bagTargets();
    sel.innerHTML = list.map(t => `<option value="${esc(t.id)}">${t.kind === "companion" ? esc(t.icon) + " " : "🧙 "}${esc(t.name)}${t.kind === "companion" ? "（随从）" : ""}</option>`).join("") + remoteTargetOptions({ companions: false });
    // 远端选项不在 list 里，用实际渲染出的 option 判断，避免重画后掉回第一个角色
    if (prev && Array.from(sel.options || []).some(o => o.value === prev)) sel.value = prev;
    gmRenderBag();
}

function renderBagItems(el, data) {
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
        el.innerHTML = '<div class="empty">背包是空的 · 点上方「＋ 添加物品」</div>';
        return;
    }
    el.innerHTML = `<div class="gm-list-count">共 ${items.length} 种 · 列表内部滚动</div>
<div class="gm-scroll-list gm-bag-list">${items.map((it, i) => `<div class="gm-row gm-bag-row">
    <span class="gm-bag-icon">${esc(it.icon || "📦")}</span>
    <span class="gm-name">${esc(it.name || "物品")}</span>
    <span class="gm-sub">${esc(BAG_CATS[it.category] || "📦 杂物")}</span>
    <input class="gm-qty-input" type="number" min="1" max="${LIMITS.qty[1]}" value="${clampInt(it.qty, LIMITS.qty[0], LIMITS.qty[1], 1)}" title="直接输入数量" onchange="gmSetItemQty(${i},this.value)">
    <span class="gm-remove" onclick="gmRemoveItem(${i})" title="删除这个物品">✖</span>
</div>`).join("")}</div>`;
}

function renderRemoteBag(targetId, el, goldEl) {
    const mid = String(targetId).replace(/^remote:/, "");
    const hit = remoteBagCache.get(mid);
    const cached = (hit && Date.now() - hit.at < 15000) ? hit.data : null;
    if (cached) {
        if (goldEl) goldEl.innerText = String(clampNum(cached.gold, LIMITS.gold[0], LIMITS.gold[1], 0));
        renderBagItems(el, cached);
        return;
    }
    if (goldEl) goldEl.innerText = "…";
    el.innerHTML = '<div class="empty">正在读取该玩家的角色卡…</div>';
    const label = remoteTargetLabel(targetId);
    void (async () => {
        const full = await globalThis.roomFetchChar?.(mid);
        if (full && typeof full === "object") remoteBagCache.set(mid, { data: full, at: Date.now() });
        const sel = document.getElementById("gmItemTarget");
        if (sel && sel.value === targetId) gmRenderBag();
        else if (!full) gmLog(`读取 ${label} 的角色卡失败（可能还没上传完整角色卡）`);
    })();
}

export function gmRenderBag() {
    const sel = document.getElementById("gmItemTarget");
    const goldEl = document.getElementById("gmGold");
    const el = document.getElementById("gmBag");
    if (!el) return;
    const id = sel ? sel.value : "";
    if (isRemoteTargetId(id)) { renderRemoteBag(id, el, goldEl); return; }
    const data = id ? loadRawChar(id) : null;
    if (!data) {
        if (goldEl) goldEl.innerText = "—";
        el.innerHTML = '<div class="empty">先选择一个角色</div>';
        return;
    }
    if (goldEl) goldEl.innerText = String(clampNum(data.gold, LIMITS.gold[0], LIMITS.gold[1], 0));
    renderBagItems(el, data);
}

function bagTargetData() {
    const sel = document.getElementById("gmItemTarget");
    const id = sel ? sel.value : "";
    if (!id) { alert("先选一个目标角色"); return null; }
    const data = loadRawChar(id);
    if (!data) { alert("目标角色不存在"); return null; }
    return { id, data };
}

// 复用角色卡「添加物品」弹窗，直接写进目标存档
export async function gmOpenItemModal() {
    const sel = document.getElementById("gmItemTarget");
    const targetId = sel ? sel.value : "";
    if (!targetId) { alert("先选一个目标角色"); return; }
    // 远端玩家：完整卡在服务器上，先拉下来再用同一套弹窗编辑，保存后整卡推回
    if (isRemoteTargetId(targetId)) {
        const mid = String(targetId).replace(/^remote:/, "");
        const full = await globalThis.roomFetchChar?.(mid);
        if (!full || typeof full !== "object") { alert("读取该玩家角色卡失败，可能还没上传完整角色卡"); return; }
        remoteBagCache.set(mid, { data: full, at: Date.now() });
        openGmItemModal(targetId, (item, data, saveToPreset) => {
            if (saveToPreset) gmSaveItemPreset(item);
            remoteBagCache.set(mid, { data: data, at: Date.now() });
            const label = remoteTargetLabel(targetId);
            void (async () => {
                const ok = await globalThis.roomPushCharTo?.(mid, data, "hp");
                if (!ok) { alert("同步失败，请检查服务器连接"); return; }
                gmLog(`🎒 给 ${label} 发放物品「${item.name}」×${clampInt(item.qty, LIMITS.qty[0], LIMITS.qty[1], 1)}`);
                renderGmPanel();
            })();
        }, { data: full, remote: true });
        return;
    }
    const t = bagTargetData();
    if (!t) return;
    openGmItemModal(t.id, (item, data, saveToPreset) => {
        if (saveToPreset) gmSaveItemPreset(item);
        gmLog(`🎒 给 ${data.name || "角色"} 发放物品「${item.name}」×${clampInt(item.qty, LIMITS.qty[0], LIMITS.qty[1], 1)}`);
        renderGmPanel();
    });
}

// ---------- 预设物品库 ----------
// 商人/NPC 反复卖同一种药水：存一次，之后一键发给任意角色
function normalizeItemPreset(p) {
    const s = (p && typeof p === "object") ? p : {};
    const cat = BAG_CATS[s.category] ? s.category : "misc";
    return {
        id: String(s.id || "") || makeId(),
        name: String(s.name || "").trim().slice(0, 60) || "物品",
        icon: String(s.icon || "").trim().slice(0, 4) || "📦",
        category: cat,
        qty: clampInt(s.qty, LIMITS.qty[0], LIMITS.qty[1], 1),
        weight: clampNum(s.weight, LIMITS.weight[0], LIMITS.weight[1], 0),
        containerCap: clampNum(s.containerCap, 0, LIMITS.weight[1], 0),
        containerMode: s.containerMode === "gear" ? "gear" : "bag",
        desc: String(s.desc || "").slice(0, 300),
        isConsume: Number(s.isConsume) ? 1 : 0,
        healHp: clampNum(s.healHp, LIMITS.heal[0], LIMITS.heal[1], 0),
        healMp: clampNum(s.healMp, LIMITS.heal[0], LIMITS.heal[1], 0),
        barName: barNameOf(s.barName),
        barDelta: clampInt(s.barDelta, LIMITS.customVal[0], LIMITS.customVal[1], 0),
        bonus: String(s.bonus || "").slice(0, 4000),
        // 使用效果：与物品对象字段保持一致，否则主持人发放的预设会丢效果
        useEffect: s.useEffect === "damage" || s.useEffect === "heal" ? s.useEffect : "",
        useAmount: clampInt(s.useAmount, 0, 999999, 0),
        useTarget: s.useTarget === "ally" || s.useTarget === "enemy" ? s.useTarget : "self"
    };
}

function presetToItem(p) {
    return {
        category: p.category, name: p.name, qty: p.qty, weight: p.weight,
        containerCap: p.containerCap, containerMode: p.containerMode,
        icon: p.icon, desc: p.desc, isConsume: p.isConsume,
        healHp: p.healHp, healMp: p.healMp, barName: p.barName, barDelta: p.barDelta, bonus: p.bonus,
        useEffect: p.useEffect, useAmount: p.useAmount, useTarget: p.useTarget
    };
}

// 同名同分类的堆叠，避免背包里出现一列同名药水
function addItemToData(data, item) {
    if (!Array.isArray(data.items)) data.items = [];
    const qty = clampInt(item.qty, LIMITS.qty[0], LIMITS.qty[1], 1);
    const exist = data.items.find(x => x && x.name === item.name && (x.category || "misc") === (item.category || "misc"));
    if (exist) {
        exist.qty = clampInt((Number(exist.qty) || 0) + qty, LIMITS.qty[0], LIMITS.qty[1], qty);
        return exist;
    }
    data.items.push({ ...item });
    return data.items[data.items.length - 1];
}

export function gmSaveItemPreset(item) {
    if (!item || !item.name) return null;
    const preset = normalizeItemPreset(item);
    const exist = gm.itemPresets.find(p => p.name === preset.name && p.category === preset.category);
    if (exist) {
        exist.icon = preset.icon;
        exist.qty = preset.qty;
        exist.weight = preset.weight;
        exist.containerCap = preset.containerCap;
        exist.containerMode = preset.containerMode;
        exist.desc = preset.desc;
        exist.isConsume = preset.isConsume;
        exist.healHp = preset.healHp;
        exist.healMp = preset.healMp;
        exist.barName = preset.barName;
        exist.barDelta = preset.barDelta;
        exist.bonus = preset.bonus;
        exist.useEffect = preset.useEffect;
        exist.useAmount = preset.useAmount;
        exist.useTarget = preset.useTarget;
        saveGm();
        renderGmItemPresets();
        return exist;
    }
    if (gm.itemPresets.length >= 100) gm.itemPresets = gm.itemPresets.slice(-99);
    gm.itemPresets.push(preset);
    saveGm();
    renderGmItemPresets();
    return preset;
}

export function gmApplyItemPreset(id, count) {
    const sel = document.getElementById("gmItemTarget");
    const targetId = sel ? sel.value : "";
    if (!targetId) { alert("先选一个目标角色"); return; }
    const p = gm.itemPresets.find(x => x.id === id);
    if (!p) { alert("这个预设物品不存在了"); return; }
    const item = presetToItem(p);
    const n = clampInt(count == null ? p.qty : count, LIMITS.qty[0], LIMITS.qty[1], p.qty);
    item.qty = n;
    if (isRemoteTargetId(targetId)) {
        void editRemoteChar(targetId, full => {
            addItemToData(full, item);
        }, `🎁 给 ${remoteTargetLabel(targetId)} 发放预设物品「${p.name}」×${n}`, "hp");
        return;
    }
    const t = bagTargetData();
    if (!t) return;
    addItemToData(t.data, item);
    saveCharAndSync(t.id, t.data);
    if (t.id === activeCharId) loadActiveCharacter();
    gmLog(`🎁 给 ${t.data.name || "角色"} 发放预设物品「${p.name}」×${n}`);
    renderGmPanel();
}

// 预设行里的「发放」按钮：数量取同行的输入框，允许一次发 N 个
export function gmApplyPresetRow(id) {
    const el = document.getElementById("pq_" + id);
    gmApplyItemPreset(id, el ? el.value : null);
}

export function gmRemoveItemPreset(id) {
    const p = gm.itemPresets.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`从预设物品库删除「${p.name}」？（已发出去的物品不受影响）`)) return;
    gm.itemPresets = gm.itemPresets.filter(x => x.id !== id);
    saveGm();
    gmLog(`🗑 移除预设物品「${p.name}」`);
    renderGmPanel();
}

export function gmOpenPresetModal() {
    renderGmItemPresets();
    const el = document.getElementById("modalItemPresets");
    if (el) el.classList.remove("hide");
}

export function renderGmItemPresets() {
    const countEl = document.getElementById("gmPresetCount");
    if (countEl) countEl.innerText = String(gm.itemPresets.length);
    // 弹窗里的发放目标提示
    const targetEl = document.getElementById("gmPresetTarget");
    if (targetEl) {
        const sel = document.getElementById("gmItemTarget");
        const tv = sel ? sel.value : "";
        if (isRemoteTargetId(tv)) {
            targetEl.innerText = remoteTargetLabel(tv);
        } else {
            const data = tv ? loadRawChar(tv) : null;
            targetEl.innerText = data ? (data.name || "角色") : "未选择";
        }
    }
    const el = document.getElementById("gmPresetModalList");
    if (!el) return;
    if (!gm.itemPresets.length) {
        el.innerHTML = '<div class="empty">还没有预设 · 添加物品时勾选「存入预设物品库」</div>';
        return;
    }
    el.innerHTML = gm.itemPresets.map(p => `<div class="gm-preset-item">
    <span class="gm-preset-ico">${esc(p.icon)}</span>
    <div class="gm-preset-main">
        <div class="gm-preset-name">${esc(p.name)}</div>
        <div class="gm-preset-meta">${esc(BAG_CATS[p.category] || "📦 杂物")}${p.desc ? " · " + esc(p.desc) : ""}</div>
    </div>
    <input id="pq_${esc(p.id)}" class="gm-qty-input" type="number" min="1" value="${p.qty}" title="发放数量">
    <button class="small" onclick="gmApplyPresetRow('${esc(p.id)}')">发放</button>
    <i class="gm-remove" onclick="gmRemoveItemPreset('${esc(p.id)}')" title="从预设库删除">✖</i>
</div>`).join("");
}

// 直接改背包里某件物品的数量（给 20 瓶药不用点 20 次）
export function gmSetItemQty(idx, value) {
    const sel = document.getElementById("gmItemTarget");
    const targetId = sel ? sel.value : "";
    if (!targetId) { alert("先选一个目标角色"); return; }
    const n = clampInt(value, LIMITS.qty[0], LIMITS.qty[1], 1);
    if (isRemoteTargetId(targetId)) {
        let itName = "";
        void editRemoteChar(targetId, full => {
            const items = Array.isArray(full.items) ? full.items : [];
            const it = items[idx];
            if (!it) return false;
            it.qty = n;
            itName = it.name || "物品";
        }, () => `🎒 ${remoteTargetLabel(targetId)} 的「${itName}」数量 → ${n}`, "hp");
        return;
    }
    const t = bagTargetData();
    if (!t) return;
    const items = Array.isArray(t.data.items) ? t.data.items : [];
    const it = items[idx];
    if (!it) return;
    it.qty = n;
    saveCharAndSync(t.id, t.data);
    if (t.id === activeCharId) loadActiveCharacter();
    gmLog(`🎒 ${t.data.name || "角色"} 的「${it.name || "物品"}」数量 → ${n}`);
    renderGmPanel();
}

export function gmRemoveItem(idx) {
    const sel = document.getElementById("gmItemTarget");
    const targetId = sel ? sel.value : "";
    if (!targetId) { alert("先选一个目标角色"); return; }
    if (isRemoteTargetId(targetId)) {
        let removed = null;
        void editRemoteChar(targetId, full => {
            const items = Array.isArray(full.items) ? full.items : [];
            const it = items[idx];
            if (!it) return false;
            if (!confirm(`从 ${full.name || "角色"} 的背包删除「${it.name || "物品"}」？`)) return false;
            items.splice(idx, 1);
            // 同步清掉装备栏 / 快捷消耗槽里指向这件物品的引用
            if (full.gear && typeof full.gear === "object") {
                Object.keys(full.gear).forEach(k => { if (full.gear[k] === it.name) full.gear[k] = ""; });
            }
            if (Array.isArray(full.quickConsumeSlots)) {
                full.quickConsumeSlots = full.quickConsumeSlots.map(x => x === it.name ? null : x);
            }
            removed = it;
        }, () => `🗑 删除 ${remoteTargetLabel(targetId)} 的物品「${(removed && removed.name) || "物品"}」×${clampInt(removed && removed.qty, 1, LIMITS.qty[1], 1)}`, "hp");
        return;
    }
    const t = bagTargetData();
    if (!t) return;
    const items = Array.isArray(t.data.items) ? t.data.items : [];
    const it = items[idx];
    if (!it) return;
    if (!confirm(`从 ${t.data.name || "角色"} 的背包删除「${it.name || "物品"}」？`)) return;
    items.splice(idx, 1);
    // 同步清掉装备栏 / 快捷消耗槽里指向这件物品的引用
    if (t.data.gear && typeof t.data.gear === "object") {
        Object.keys(t.data.gear).forEach(k => { if (t.data.gear[k] === it.name) t.data.gear[k] = ""; });
    }
    if (Array.isArray(t.data.quickConsumeSlots)) {
        t.data.quickConsumeSlots = t.data.quickConsumeSlots.map(x => x === it.name ? null : x);
    }
    saveCharAndSync(t.id, t.data);
    if (t.id === activeCharId) loadActiveCharacter();
    gmLog(`🗑 删除 ${t.data.name || "角色"} 的物品「${it.name || "物品"}」×${clampInt(it.qty, 1, LIMITS.qty[1], 1)}`);
    renderGmPanel();
}

// 金币独立于物品：加钱 / 扣钱 / 直接设为
export function gmAdjustGold(mode) {
    const sel = document.getElementById("gmItemTarget");
    const targetId = sel ? sel.value : "";
    if (!targetId) { alert("先选一个目标角色"); return; }
    const label = mode === "add" ? "加" : (mode === "sub" ? "扣" : "设为");
    if (isRemoteTargetId(targetId)) {
        let info = null;
        void editRemoteChar(targetId, full => {
            const cur = clampNum(full.gold, LIMITS.gold[0], LIMITS.gold[1], 0);
            const raw = prompt(`给 ${full.name || "角色"} ${label}多少金币？（当前 ${cur}）`, mode === "set" ? String(cur) : (mode === "add" ? "100" : "50"));
            if (raw === null) return false;
            const v = clampNum(raw, 0, LIMITS.gold[1], 0);
            const next = mode === "add" ? cur + v : (mode === "sub" ? Math.max(0, cur - v) : v);
            full.gold = clampNum(next, LIMITS.gold[0], LIMITS.gold[1], 0);
            info = { cur, gold: full.gold, delta: full.gold - cur };
        }, () => {
            const i = info || { cur: 0, gold: 0, delta: 0 };
            return `💰 ${remoteTargetLabel(targetId)} 金币 ${i.cur} → ${i.gold}${i.delta ? `（${i.delta > 0 ? "+" : ""}${i.delta}）` : ""}`;
        }, "hp");
        return;
    }
    const t = bagTargetData();
    if (!t) return;
    const cur = clampNum(t.data.gold, LIMITS.gold[0], LIMITS.gold[1], 0);
    const raw = prompt(`给 ${t.data.name || "角色"} ${label}多少金币？（当前 ${cur}）`, mode === "set" ? String(cur) : (mode === "add" ? "100" : "50"));
    if (raw === null) return;
    const v = clampNum(raw, 0, LIMITS.gold[1], 0);
    const next = mode === "add" ? cur + v : (mode === "sub" ? Math.max(0, cur - v) : v);
    t.data.gold = clampNum(next, LIMITS.gold[0], LIMITS.gold[1], 0);
    saveCharAndSync(t.id, t.data);
    if (t.id === activeCharId) loadActiveCharacter();
    const delta = t.data.gold - cur;
    gmLog(`💰 ${t.data.name || "角色"} 金币 ${cur} → ${t.data.gold}${delta ? `（${delta > 0 ? "+" : ""}${delta}）` : ""}`);
    renderGmPanel();
}

// ---------- 玩家行动（角色卡 ⇄ 主持人面板联动） ----------
// 玩家在角色卡里每回合提交一次行动，写进 gm.actions（房间状态）；主持人那边实时看到，
// 点「回合结束」时把行动归档进日志并清空，然后才进入下一回合。
function myAction(cid) {
    const id = cid || activeCharId;
    if (!id) return null;
    return gm.actions.find(a => a && a.charId === id && a.round === gm.round) || null;
}

function renderGmActions() {
    const el = document.getElementById("gmActions");
    if (!el) return;
    // 玩家端不渲染主持人专属的结算/删除控件（玩家自己的行动撤回在角色卡页 #paActions）
    const playerView = !!roomSession() && !roomIsGm();
    const list = gm.actions.filter(a => a && a.round === gm.round);
    if (!list.length) {
        el.innerHTML = '<div class="empty">本回合还没有人提交行动</div>';
        return;
    }
    el.innerHTML = `<div class="gm-list-count">共 ${list.length} 条 · 列表内部滚动</div>
<div class="gm-scroll-list">${list.map(a => {
        const foe = a.target ? gm.enemies.find(e => e.id === a.target) : null;
        const itemTxt = a.type === "item" && a.itemName ? `🧪 ${a.itemName}` : "";
        const detail = [itemTxt, (a.target ? "目标 " + (foe ? foe.name : "已移除") : ""), a.text].filter(Boolean).join(" · ") || "—";
        let settle = "";
        if (playerView) {
            if (a.settled) settle = '<span class="gm-act-flag done">已结算</span>';
        } else if (a.preApplied) {
            // 客户端已即时生效的消耗品：不再给「结算 ±N」按钮，避免二次加血/扣血
            settle = a.settled
                ? '<span class="gm-act-flag done">已结算</span>'
                : '<span class="gm-act-flag">已在客户端生效</span>';
        } else if (a.effect && a.target) {
            if (a.settled) settle = '<span class="gm-act-flag done">已结算</span>';
            else if (a.effect === "buff") {
                settle = a.buff && a.buff.name
                    ? `<button class="small" onclick="gmSettleAction('${esc(a.id)}')">施加状态</button>`
                    : '<span class="gm-act-flag">状态缺失</span>';
            } else if (a.effect === "damage" && a.amount > 0) {
                settle = `<button class="small" onclick="gmSettleAction('${esc(a.id)}')">${a.type === "item" ? `🧪 ${esc(a.itemName || "物品")} -${a.amount}` : `结算 -${a.amount}`}</button>`;
            } else if (a.effect === "heal" && a.amount > 0) {
                settle = `<button class="small" onclick="gmSettleAction('${esc(a.id)}')">${a.type === "item" ? `🧪 ${esc(a.itemName || "物品")} +${a.amount}` : `结算 +${a.amount}`}</button>`;
            } else if (a.effect === "damage") {
                settle = '<span class="gm-act-flag">未命中</span>';
            }
        }
        return `<div class="gm-row gm-action-row">
    <span class="gm-name">${esc(a.charName)}</span>
    <span class="gm-badge">${esc(actionLabel(a))}</span>
    ${a.skillName ? `<span class="skill-formula">${esc(a.skillName)}</span>` : ""}
    <span class="gm-action-text">${esc(detail)}</span>
    ${settle}
    ${playerView ? "" : `<span class="gm-remove" onclick="gmRemoveAction('${esc(a.id)}')" title="删除这条行动">✖</span>`}
</div>`;
    }).join("")}</div>`;
}

// 玩家端只读版行动列表：和主持人面板同一份 gm.actions（不按 charId 过滤），
// 行结构/类名沿用 gm-action-row，主持人那条「结算按钮/删除」玩家端不渲染。
function playerActionListHtml(cid) {
    const list = gm.actions.filter(a => a && a.round === gm.round);
    if (!list.length) return '<div class="empty">本回合还没有人提交行动</div>';
    const me = String(cid || "");
    return `<div class="gm-list-count">共 ${list.length} 条 · 列表内部滚动</div>
<div class="gm-scroll-list">${list.map(a => {
        const foe = a.target ? gm.enemies.find(e => e.id === a.target) : null;
        const detail = [(a.target ? "目标 " + (foe ? foe.name : "已移除") : ""), a.text].filter(Boolean).join(" · ") || "—";
        const mine = !!me && String(a.charId || "") === me;
        const settle = a.settled ? '<span class="gm-act-flag done">已结算</span>' : "";
        return `<div class="gm-row gm-action-row">
    <span class="gm-name">${esc(a.charName)}</span>
    ${mine ? '<span class="gm-tag">我</span>' : ""}
    <span class="gm-badge">${esc(actionLabel(a))}</span>
    ${a.skillName ? `<span class="skill-formula">${esc(a.skillName)}</span>` : ""}
    <span class="gm-action-text">${esc(detail)}</span>
    ${settle}
</div>`;
    }).join("")}</div>`;
}

export function renderPlayerActionPanel() {
    const root = document.getElementById("playerActionPanel");
    if (!root) return;
    const cid = activeCharId;
    const cd = cid ? loadRawChar(cid) : null;

    const roundEl = document.getElementById("paRound");
    if (roundEl) roundEl.textContent = `第 ${gm.round} 回合`;

    // 队伍状态（只读，和主持人那边同一份数据）
    const partyEl = document.getElementById("paParty");
    if (partyEl) {
        const rows = [];
        heroes().forEach(meta => {
            const hs = heroSnapshot(meta.id);
            if (!hs) return;
            const maxHp = Math.max(1, hs.snap.total.maxHp);
            const hp = clampNum(hs.data.hp, 0, maxHp, 0);
            const maxMp = Math.max(1, hs.snap.total.maxMp);
            rows.push(`<div class="gm-row pa-row gm-unit${meta.id === cid ? " pa-self" : ""}">
    <div class="gm-head">
        <span class="gm-name">${esc(hs.data.name || meta.name || "无名")}</span>
        <span class="gm-sub">Lv ${hs.snap.lvl}</span>
    </div>
    ${unitBarsHtml(hp, maxHp, hs.data.mp, maxMp, hs.data)}
</div>`);
            companionUnits()
                .filter(u => u.meta.ownerId === meta.id && u.cc.combat === true)
                .forEach(u => {
                    const cmax = Math.max(1, u.cc.maxHp);
                    const chp = clampNum(u.cc.hp, 0, cmax, 0);
                    const cmaxMp = Math.max(1, u.cc.maxMp);
                    rows.push(`<div class="gm-row gm-companion-row pa-row gm-unit${u.meta.id === cid ? " pa-self" : ""}${u.cc.mode === "hero" ? " gm-form-row" : ""}">
    <div class="gm-head">
        <span class="gm-name">${esc(u.cc.icon || "🐾")} ${esc(u.cc.name || "随从")}</span>
        <span class="gm-sub">${u.cc.mode === "hero" ? "主角形态" : "随从"}</span>
    </div>
    ${unitBarsHtml(chp, cmax, u.cc.mp, cmaxMp, u.data)}
</div>`);
                });
        });
        // 本体被形态接管时，heroes() 里没有本体，这里单独补出它的参战单位（形态 + 随从）
        formTakeovers().forEach((units, ownerId) => {
            companionUnits()
                .filter(u => (u.meta.ownerId || u.data.ownerId) === ownerId && u.cc.combat === true)
                .forEach(u => {
                    const cmax = Math.max(1, u.cc.maxHp);
                    const chp = clampNum(u.cc.hp, 0, cmax, 0);
                    const cmaxMp = Math.max(1, u.cc.maxMp);
                    rows.push(`<div class="gm-row gm-companion-row pa-row gm-unit${u.meta.id === cid ? " pa-self" : ""}${u.cc.mode === "hero" ? " gm-form-row" : ""}">
    <div class="gm-head">
        <span class="gm-name">${esc(u.cc.icon || "🐾")} ${esc(u.cc.name || "随从")}</span>
        <span class="gm-sub">${u.cc.mode === "hero" ? "主角形态 · 接管本体" : "随从"}</span>
    </div>
    ${unitBarsHtml(chp, cmax, u.cc.mp, cmaxMp, u.data)}
</div>`);
                });
        });
        partyEl.innerHTML = rows.join("") || '<div class="empty">还没有角色</div>';
    }

    // 当前遭遇（只读）
    const foeEl = document.getElementById("paEnemies");
    if (foeEl) {
        foeEl.innerHTML = gm.enemies.length
            ? gm.enemies.map(e => {
                const pct = Math.max(0, Math.min(100, e.hp / Math.max(1, e.maxHp) * 100));
                return `<div class="gm-row pa-row gm-enemy${e.hp <= 0 ? " dead" : ""}">
    <span class="gm-name">${esc(e.icon)} ${esc(e.name)}</span>
    <span class="gm-sub">先攻 ${e.init} · AC ${e.ac}</span>
    <div class="gm-hpbar"><div style="width:${pct.toFixed(1)}%;background:var(--red)"></div></div>
    <span class="gm-hp">${e.hp}/${e.maxHp}</span>
</div>`;
            }).join("")
            : '<div class="empty">暂无遭遇 · 等主持人放怪</div>';
    }

    // 目标下拉：只列还活着的敌人
    const tgtSel = document.getElementById("paTarget");
    if (tgtSel) {
        const prev = tgtSel.value;
        const alive = gm.enemies.filter(e => e.hp > 0);
        tgtSel.innerHTML = ['<option value="">（无特定目标）</option>']
            .concat(alive.map(e => `<option value="${esc(e.id)}">${esc(e.icon)} ${esc(e.name)}</option>`))
            .join("");
        if (alive.some(e => e.id === prev)) tgtSel.value = prev;
    }

    // 提交状态 / 表单显隐
    const mine = myAction(cid);
    // 一个角色本回合可能有多条行动（先提交别的再吃药等）：逐条区分已结算/未结算
    const mineAll = gm.actions.filter(a => a && String(a.charId || "") === String(cid || "") && a.round === gm.round);
    const pendingMine = mineAll.filter(a => !a.settled);
    const settledMine = mineAll.filter(a => a.settled);
    const inCombat = cid ? unitInCombat(cid) : false;
    const stateEl = document.getElementById("paState");
    const formEl = document.getElementById("paForm");
    if (stateEl) {
        if (!cid) stateEl.innerHTML = `<span class="pa-pending">⏳ 先在顶部选择角色</span>`;
        else if (!inCombat && isReplacedOwner(cid)) stateEl.innerHTML = `<span class="pa-pending">🧬 本体正由「主角形态」接管 · 请切到形态角色卡再行动</span>`;
        else if (!inCombat) stateEl.innerHTML = `<span class="pa-pending">🚫 当前角色未参战 · 去「角色总览」点一下参战按钮</span>`;
        else if (mineAll.length) {
            // 只有还存在未结算行动时才给「撤回」按钮；已结算的行动撤回不了
            const parts = [];
            if (pendingMine.length) {
                parts.push(`<span class="pa-done">✅ 已提交：${esc(pendingMine.map(actionText).join("；"))}</span> <button class="small" onclick="gmWithdrawAction()">撤回</button>`);
            }
            if (settledMine.length) {
                parts.push(`<span class="pa-done">✅ 已结算：${esc(settledMine.map(actionText).join("；"))}</span>`);
            }
            stateEl.innerHTML = parts.join(" ");
        }
        else stateEl.innerHTML = `<span class="pa-pending">⏳ 本回合尚未提交行动</span>`;
    }
    if (formEl) formEl.style.display = (inCombat && !mine) ? "" : "none";

    // 本回合全队行动（只读）：每次重画都跟着刷新，index.html 里没有固定容器，首次渲染时插到 #paForm 之前
    let listEl = document.getElementById("paActions");
    if (!listEl) {
        listEl = document.createElement("div");
        listEl.id = "paActions";
        listEl.className = "gm-list";
        if (formEl && formEl.parentNode) formEl.parentNode.insertBefore(listEl, formEl);
        else if (root) root.appendChild(listEl);
    }
    if (listEl) listEl.innerHTML = playerActionListHtml(cid);
    // 快捷栏（消耗品 / 技能）：由 items_gear_ui / skills_buffs 实现，未加载时安全跳过
    try { globalThis.renderQuickConsume?.(); globalThis.renderQuickSkills?.(); } catch (e) { }
}

export function gmSubmitAction() {
    const cid = activeCharId;
    if (!cid) { alert("先选择一个角色"); return; }
    const data = loadRawChar(cid);
    if (!data) { alert("当前角色还没有存档"); return; }
    if (!unitInCombat(cid)) { alert("当前角色未参战，先在「角色总览」里点一下参战按钮"); return; }
    if (myAction(cid)) { alert("本回合已经提交过行动了，可以点「撤回」重新填写"); return; }
    const typeEl = document.getElementById("paType");
    const tgtEl = document.getElementById("paTarget");
    const txtEl = document.getElementById("paText");
    const type = typeEl && Object.prototype.hasOwnProperty.call(ACTION_TYPES, typeEl.value) ? typeEl.value : "other";
    const text = String(txtEl ? txtEl.value : "").trim().slice(0, 200);
    const target = String(tgtEl ? tgtEl.value : "").slice(0, 64);
    if (!text && !target) { alert("写一下你这一回合要做什么"); return; }
    const action = normalizeAction({
        round: gm.round, charId: cid, charName: data.name || "角色",
        type, target, text, at: Date.now()
    });
    gm.actions.push(action);
    if (gm.actions.length > 80) gm.actions = gm.actions.slice(-80);
    // 玩家端先写本地立刻有反馈，再上行给服务端；主持人端只走 saveGm 的全量同步，不重复提交
    if (!roomIsGm() && roomSession()) {
        Promise.resolve(globalThis.roomSubmitAction?.(action)).catch(() => { });
    }
    saveGm();
    if (txtEl) txtEl.value = "";
    gmLog(`📝 ${action.charName} 提交行动：${actionText(action)}`);
    renderGmPanel();
}

// 技能页要用：本回合还能不能行动 / 可选取的目标（敌人 + 队伍）
export function gmCanAct() {
    return !!activeCharId && unitInCombat(activeCharId) && !myAction(activeCharId);
}

export function gmActionTargets() {
    const out = [];
    const seen = new Set();
    const push = (t) => {
        if (!t || !t.id || seen.has(t.id)) return;
        seen.add(t.id);
        out.push(t);
    };
    gm.enemies.filter(e => e.hp > 0).forEach(e => push({
        id: e.id, name: `${e.icon} ${e.name}`, kind: "enemy", hp: e.hp, maxHp: e.maxHp, ac: e.ac
    }));
    heroes().forEach(meta => {
        const hs = heroSnapshot(meta.id);
        if (!hs) return;
        push({
            id: meta.id, name: hs.data.name || meta.name || "角色", kind: "ally",
            hp: clampNum(hs.data.hp, 0, Math.max(1, hs.snap.total.maxHp), 0), maxHp: Math.max(1, hs.snap.total.maxHp)
        });
    });
    companionUnits().forEach(u => {
        if (u.cc.combat !== true) return;
        push({
            id: u.meta.id, name: `${u.cc.icon || "🐾"} ${u.cc.name || "随从"}`, kind: "ally",
            hp: clampNum(u.cc.hp, 0, Math.max(1, u.cc.maxHp), 0), maxHp: Math.max(1, u.cc.maxHp)
        });
    });
    // 远端队友：玩家端只看得见自己的存档，快照里的其他成员要在这里补出来（否则没法给队友用药）。
    // 处于主角形态的成员跳过本体，只留形态（与伤害目标列表语义一致）。
    if (roomSession()) {
        const meId = String(roomMyMemberId() || "");
        ((roomSnapshot() || {}).members || []).forEach(m => {
            if (!m || !m.id || String(m.id) === meId) return;
            const ch = (m.char && typeof m.char === "object") ? m.char : null;
            if (!ch) return;
            const form = heroFormInChar(ch);
            if (form) {
                if (!form.id) return;
                const fmax = Math.max(1, clampNum(form.maxHp !== undefined ? form.maxHp : form.maxHpBase, 0, LIMITS.hpMp[1], 0));
                const ficon = String(form.icon || "").trim();
                push({
                    id: `remote:${m.id}:${form.id}`,
                    name: `${ficon ? ficon + " " : ""}${String(form.name || "").trim() || "主角形态"}`,
                    kind: "ally",
                    hp: clampNum(form.hp, 0, fmax, 0),
                    maxHp: fmax,
                    remote: true
                });
                return;
            }
            const maxHp = Math.max(1, clampNum(ch.maxHp !== undefined ? ch.maxHp : ch.maxHpBase, 0, LIMITS.hpMp[1], 0));
            push({
                id: "remote:" + m.id,
                name: String(ch.name || "").trim() || String(m.name || "").trim() || "玩家",
                kind: "ally",
                hp: clampNum(ch.hp, 0, maxHp, 0),
                maxHp,
                remote: true
            });
        });
    }
    return out;
}

// 角色卡「技能记录」里发动带公式的技能 → 直接进行动队列，等主持人一键结算
export function gmSubmitSkillAction(payload) {
    const cid = activeCharId;
    if (!cid) { alert("先选择一个角色"); return false; }
    const data = loadRawChar(cid);
    if (!data) { alert("当前角色还没有存档"); return false; }
    if (!unitInCombat(cid)) { alert("当前角色未参战，先在「角色总览」里点一下参战按钮"); return false; }
    if (myAction(cid)) { alert("本回合已经提交过行动了，先撤回再发动技能"); return false; }
    const p = (payload && typeof payload === "object") ? payload : {};
    const effect = p.effect === "heal" ? "heal" : (p.effect === "buff" ? "buff" : "damage");
    const targetId = String(p.targetId || "").slice(0, 64);
    if (!targetId) { alert("先选择一个目标"); return false; }
    const name = String(p.targetName || "").trim().slice(0, 40);
    const action = normalizeAction({
        round: gm.round, charId: cid, charName: data.name || "角色",
        type: "skill", target: targetId,
        text: String(p.detail || "").slice(0, 200),
        at: Date.now(),
        skillName: p.skillName, effect, targetId,
        amount: p.amount,
        buff: p.buff
    });
    gm.actions.push(action);
    if (gm.actions.length > 80) gm.actions = gm.actions.slice(-80);
    // 玩家端先写本地立刻有反馈，再上行给服务端；主持人端只走 saveGm 的全量同步，不重复提交
    if (!roomIsGm() && roomSession()) {
        Promise.resolve(globalThis.roomSubmitAction?.(action)).catch(() => { });
    }
    saveGm();
    gmLog(`✨ ${action.charName} 发动「${action.skillName || "技能"}」→ ${name || "目标"}：${action.text}`);
    renderGmPanel();
    return true;
}

// 角色卡「使用物品」→ 进行动队列，等主持人一键结算（伤害 / 治疗）
export function gmSubmitItemAction(payload) {
    const cid = activeCharId;
    if (!cid) return null;
    const data = loadRawChar(cid);
    if (!data) return null;
    const p = (payload && typeof payload === "object") ? payload : {};
    const targetId = String(p.targetId || p.target || "").slice(0, 64);
    const action = normalizeAction({
        round: gm.round,
        charId: cid,
        charName: data.name || "角色",
        type: "item",
        target: targetId || String(p.target || "").slice(0, 64),
        targetId: targetId || String(p.target || "").slice(0, 64),
        text: p.text || "",
        itemName: p.itemName || "",
        effect: p.effect === "damage" ? "damage" : "heal",
        amount: p.amount || 0,
        settled: p.settled === true,
        preApplied: p.preApplied === true,
        at: Date.now()
    });
    gm.actions.push(action);
    if (gm.actions.length > 80) gm.actions = gm.actions.slice(-80);
    // 玩家端先写本地立刻有反馈，再上行给服务端；主持人端只走 saveGm 的全量同步，不重复提交
    if (!roomIsGm() && roomSession()) {
        Promise.resolve(globalThis.roomSubmitAction?.(action)).catch(() => { });
    }
    saveGm();
    const targetName = String(p.targetName || "").trim() || action.target || "目标";
    gmLog(`🧪 ${action.charName} 使用「${action.itemName || "物品"}」→ ${targetName}：${action.effect === "damage" ? "-" : "+"}${action.amount} HP`);
    renderGmPanel();
    return action.id;
}

// 行动目标在本机找不到时，按房间成员解析远端玩家（房主专用）。
// action.memberId 是「提交人」不是目标：仅当 target/charName 都为空时，才把它当作自伤目标（自己给自己结算）。
function actionRemoteMemberId(a) {
    if (!roomSession() || !roomIsGm()) return "";
    const me = String(roomMyMemberId() || "");
    const members = (roomSnapshot()?.members || [])
        .filter(m => m && m.id && String(m.id) !== me);
    if (!members.length) return "";
    const targetTxt = String((a && a.target) || "").trim();
    const rawName = String((a && a.charName) || "").trim();
    // normalizeAction 会把空 charName 兜底成「角色」，这里按「没有目标文本」处理，否则自伤兜底永远走不到
    const nameTxt = rawName === "角色" ? "" : rawName;
    const txt = targetTxt || nameTxt;
    // 1) 有目标文本：只按角色名/昵称精确匹配，且必须唯一；匹配不上就当作没找到，绝不回落到 memberId
    if (txt) {
        const hits = members.filter(m => {
            const cname = String((m.char && m.char.name) || "").trim();
            const pname = String(m.name || "").trim();
            return (!!cname && cname === txt) || (!!pname && pname === txt);
        });
        return hits.length === 1 ? String(hits[0].id) : "";
    }
    // 2) 完全没有目标文本：memberId 才代表提交人自己（自伤/自疗）
    const mid = String((a && a.memberId) || "").trim();
    if (!mid) return "";
    const hit = members.find(m => String(m.id) === mid);
    return hit ? String(hit.id) : "";
}

// 把行动结算写到远端玩家卡上：拉完整卡 → 按 effect 改 hp / buffs → 推回。
// 返回 true 表示「已由远端路径处理」（成功或已提示失败），false 表示没有远端目标。
async function settleRemoteAction(a) {
    const mid = actionRemoteMemberId(a);
    if (!mid) return false;
    const label = remoteTargetLabel("remote:" + mid);
    if (a.effect === "buff") {
        const nb = normalizeBuff(a.buff);
        const ok = await editRemoteChar(mid, full => {
            if (!Array.isArray(full.buffs)) full.buffs = [];
            const before = JSON.stringify(full.buffs);
            const exist = full.buffs.find(b => b && b.name === nb.name);
            if (exist) exist.round = nb.round;
            else {
                full.buffs.push(nb);
                if (nb.barName && nb.barOnApply) adjustCustomBar(full, nb.barName, nb.barOnApply);
            }
            syncBarLinks(full);
            return JSON.stringify(full.buffs) !== before;
        }, () => `🎁 ${a.charName}「${a.skillName || "技能"}」→ ${label} 获得状态「${nb.name}」${Number(nb.round) > 0 ? `（${nb.round} 回合）` : "（永久）"}`, "hp");
        if (ok) { a.settled = true; saveGm(); renderGmPanel(); }
        return true;
    }
    const amount = clampInt(a.amount, 0, LIMITS.hpMp[1], 0);
    if (!amount) return true;
    const isHeal = a.effect === "heal";
    let note = "";
    const ok = await editRemoteChar(mid, full => {
        const snap = computeSnapshotWithOwner(full);
        const maxHp = Math.max(1, (snap && snap.total && snap.total.maxHp > 0)
            ? snap.total.maxHp
            : clampNum(full.maxHp !== undefined ? full.maxHp : full.maxHpBase, 0, LIMITS.hpMp[1], 1));
        const curHp = clampNum(full.hp, 0, maxHp, 0);
        if (isHeal) {
            const next = clampNum(Math.min(maxHp, curHp + amount), 0, maxHp, 0);
            if (next === curHp) return false;
            full.hp = next;
            note = `+${amount}，剩余 ${next}/${maxHp}`;
            return true;
        }
        // 与本地路径一致：减伤 → 护盾 → HP
        const sh = absorbShields(full, amount);
        const next = clampNum(Math.max(0, curHp - sh.rest), 0, maxHp, 0);
        if (next === curHp && !sh.saved && !sh.absorbed) return false;
        full.hp = next;
        note = `-${amount}${sh.saved ? `（减伤 ${sh.saved}）` : ""}${sh.absorbed ? `（🛡 吸收 ${sh.absorbed}）` : ""}，剩余 ${next}/${maxHp}`;
        return true;
    }, () => `⚖ ${a.charName}「${a.skillName || "技能"}」→ ${label} ${note}`, "hp");
    if (ok) { a.settled = true; saveGm(); renderGmPanel(); }
    return true;
}

// 物品行动结算：客户端把效果/数值算好带过来，主持人只负责落到目标身上。
// 返回 true = 已写回（调用方负责标记 settled）。
async function settleItemAction(a) {
    // 客户端已经即时生效（老式自用消耗品）：只标记结算，绝不能再加一次 HP
    if (a && a.preApplied) {
        a.settled = true;
        saveGm();
        renderGmPanel();
        return true;
    }
    const amount = clampInt(a.amount, 0, LIMITS.hpMp[1], 0);
    const targetId = String(a.targetId || a.target || "");
    const isHeal = a.effect === "heal";
    const itemName = String(a.itemName || "物品");
    const sign = isHeal ? "+" : "-";
    // 远端队友：完整卡在服务端，走 editRemoteChar / editRemoteCompanion 写回
    if (isRemoteTargetId(targetId)) {
        const parsed = parseRemoteTargetId(targetId) || {};
        const mid = parsed.memberId || "";
        if (!mid) return false;
        const logText = `🧪 ${a.charName} 对 ${remoteTargetLabel(targetId)} 使用 ${itemName}（${sign}${amount} HP）`;
        if (parsed.companionId) {
            return await editRemoteCompanion(mid, parsed.companionId, copy => {
                const cap = Math.max(1, Math.round(clampNum(copy.maxHp, 1, LIMITS.hpMp[1], 1)));
                const cur = clampNum(copy.hp, 0, cap, 0);
                const next = isHeal
                    ? clampNum(Math.min(cap, cur + amount), 0, cap, 0)
                    : clampNum(Math.max(0, cur - amount), 0, cap, 0);
                if (next === cur) return false;
                copy.hp = next;
                return true;
            }, logText);
        }
        return await editRemoteChar(mid, full => {
            const snap = computeSnapshotWithOwner(full);
            const cap = Math.max(1, Math.round(clampNum(snap && snap.total ? snap.total.maxHp : full.maxHp, 1, LIMITS.hpMp[1], 1)));
            const cur = clampNum(full.hp, 0, cap, 0);
            const next = isHeal
                ? clampNum(Math.min(cap, cur + amount), 0, cap, 0)
                : clampNum(Math.max(0, cur - amount), 0, cap, 0);
            if (next === cur) return false;
            full.hp = next;
            return true;
        }, logText, "hp");
    }
    // 伤害物品：只打敌人
    if (!isHeal) {
        const enemy = gm.enemies.find(e => e.id === targetId) || gm.enemies.find(e => e.id === a.target);
        if (!enemy) { gmLog("目标已不存在"); return false; }
        const max = Math.max(1, enemy.maxHp);
        enemy.hp = clampNum(Math.max(0, enemy.hp - amount), 0, max, 0);
        gmLog(`🧪 ${a.charName} 对 ${enemy.name} 使用 ${itemName}（-${amount} HP）`);
        return true;
    }
    // 治疗物品：本地队友 / 随从，直接夹 HP 上限后写回
    const t = partyTarget(targetId);
    if (!t) { gmLog("目标已不存在"); return false; }
    t.data.hp = clampNum(Math.min(t.maxHp, clampNum(t.hp, 0, t.maxHp, 0) + amount), 0, t.maxHp, 0);
    saveCharAndSync(targetId, t.data);
    if (t.isComp) pushHpToOwner(t.data);
    gmLog(`🧪 ${a.charName} 对 ${t.data.name || "角色"}${t.isComp ? "（随从）" : ""} 使用 ${itemName}（+${amount} HP）`);
    return true;
}

// 主持人一键结算：技能行动自带的数值直接落到目标身上
export async function gmSettleAction(id) {
    if (roomSession() && !roomIsGm()) return;
    const a = gm.actions.find(x => x && x.id === id);
    if (!a || a.settled) return;
    // 物品行动：使用物品（伤害 / 治疗）
    if (a.type === "item") {
        if (await settleItemAction(a)) {
            a.settled = true;
            saveGm();
            renderGmPanel();
        }
        return;
    }
    // 施加状态：直接写进目标的 Buff 列表（同名只刷新持续回合）
    if (a.effect === "buff") {
        if (!a.buff || !a.buff.name) { alert("这条技能没有带状态数据"); return; }
        const t = partyTarget(a.targetId);
        if (!t) {
            if (await settleRemoteAction(a)) return;
            alert("目标已经不在了（敌人暂不支持挂状态）");
            return;
        }
        if (!Array.isArray(t.data.buffs)) t.data.buffs = [];
        const nb = normalizeBuff(a.buff);
        const exist = t.data.buffs.find(b => b && b.name === nb.name);
        if (exist) exist.round = nb.round;
        else {
            t.data.buffs.push(nb);
            if (nb.barName && nb.barOnApply) adjustCustomBar(t.data, nb.barName, nb.barOnApply);
        }
        syncBarLinks(t.data);
        saveCharAndSync(a.targetId, t.data);
        if (t.isComp) pushHpToOwner(t.data);
        gmLog(`🎁 ${a.charName}「${a.skillName || "技能"}」→ ${t.data.name || "角色"}${t.isComp ? "（随从）" : ""} 获得状态「${nb.name}」${Number(nb.round) > 0 ? `（${nb.round} 回合）` : "（永久）"}`);
        a.settled = true;
        saveGm();
        renderGmPanel();
        return;
    }
    const amount = clampInt(a.amount, 0, LIMITS.hpMp[1], 0);
    if (!amount) return;
    const enemy = gm.enemies.find(e => e.id === a.targetId);
    if (enemy) {
        const max = Math.max(1, enemy.maxHp);
        const wasAlive = enemy.hp > 0;
        enemy.hp = a.effect === "heal"
            ? clampNum(Math.min(max, enemy.hp + amount), 0, max, 0)
            : clampNum(Math.max(0, enemy.hp - amount), 0, max, 0);
        gmLog(`⚖ ${a.charName}「${a.skillName || "技能"}」→ ${enemy.name} ${a.effect === "heal" ? "+" : "-"}${amount}，剩余 ${enemy.hp}/${max}`);
        // 击杀奖励：给行动者的大招条涨值
        if (wasAlive && enemy.hp <= 0 && a.charId) {
            const actor = loadRawChar(a.charId);
            if (actor) {
                const gain = applyBarGain(actor, "kill");
                saveCharAndSync(a.charId, actor);
                if (gain.gained.length) gmLog(`🔋 击杀奖励 ${actor.name || "角色"}：${gain.gained.join("、")}`);
                if (a.charId === activeCharId) loadActiveCharacter();
            }
        }
    } else {
        const t = partyTarget(a.targetId);
        if (!t) {
            if (await settleRemoteAction(a)) return;
            alert("目标已经不在了");
            return;
        }
        if (a.effect === "heal") {
            t.data.hp = clampNum(Math.min(t.maxHp, clampNum(t.hp, 0, t.maxHp, 0) + amount), 0, t.maxHp, 0);
            saveCharAndSync(a.targetId, t.data);
            if (t.isComp) pushHpToOwner(t.data);
            gmLog(`⚖ ${a.charName}「${a.skillName || "技能"}」→ ${t.data.name || "角色"}${t.isComp ? "（随从）" : ""} +${amount}，剩余 ${t.data.hp}/${t.maxHp}`);
        } else {
            // 主持人结算的技能伤害也走「减伤 → 护盾 → HP」
            const sh = absorbShields(t.data, amount);
            t.data.hp = clampNum(Math.max(0, clampNum(t.hp, 0, t.maxHp, 0) - sh.rest), 0, t.maxHp, 0);
            if (t.isComp) dropDeadCompanion(t.data);
            saveCharAndSync(a.targetId, t.data);
            if (t.isComp) pushHpToOwner(t.data);
            gmLog(`⚖ ${a.charName}「${a.skillName || "技能"}」→ ${t.data.name || "角色"}${t.isComp ? "（随从）" : ""} -${amount}${sh.saved ? `（减伤 ${sh.saved}）` : ""}${sh.absorbed ? `（🛡 吸收 ${sh.absorbed}）` : ""}，剩余 ${t.data.hp}/${t.maxHp}`);
        }
    }
    a.settled = true;
    saveGm();
    renderGmPanel();
}

export function gmWithdrawAction(charId) {
    const cid = charId || activeCharId;
    if (!cid) return;
    const mine = gm.actions.filter(a => a && a.charId === cid && a.round === gm.round);
    // 已结算的行动不能撤回：否则物品回来了、伤害/治疗却已经落账
    const removable = mine.filter(a => !a.settled);
    const settledCount = mine.length - removable.length;
    if (!removable.length) {
        if (settledCount) alert("该行动已经结算，无法撤回");
        return;
    }
    // 物品行动：先让客户端账本把物品 / HP / MP / 自定义条 / 快捷槽回退
    removable.forEach(a => {
        if (a.type === "item" && a.id) { try { globalThis.revertItemUse?.(a.id); } catch { /* ignore */ } }
    });
    gm.actions = gm.actions.filter(a => !(a && a.charId === cid && a.round === gm.round && !a.settled));
    // 玩家端撤回后要通知服务端删掉对应条目，否则下次快照又合并回来
    if (!roomIsGm() && roomSession()) {
        removable.forEach(a => {
            const id = String((a && a.id) || "").slice(0, 32);
            if (!id) return;
            try { Promise.resolve(globalThis.roomRemoveSubmit?.("actions", id)).catch(() => { }); } catch { /* ignore */ }
        });
    }
    saveGm();
    gmLog(`↩ ${(loadRawChar(cid) || {}).name || "角色"} 撤回本回合行动${settledCount ? `（另有 ${settledCount} 条已结算未撤回）` : ""}`);
    renderGmPanel();
}

export function gmRemoveAction(id) {
    if (roomSession() && !roomIsGm()) return;
    const a = gm.actions.find(x => x && x.id === id);
    if (!a) return;
    gm.actions = gm.actions.filter(x => !(x && x.id === id));
    // 主持人靠全量同步覆盖，不需要单独删；玩家端必须显式通知服务端
    if (!roomIsGm() && roomSession()) {
        const aid = String(id || "").slice(0, 32);
        if (aid) {
            try { Promise.resolve(globalThis.roomRemoveSubmit?.("actions", aid)).catch(() => { }); } catch { /* ignore */ }
        }
    }
    saveGm();
    gmLog(`✖ 移除 ${a.charName} 的行动`);
    renderGmPanel();
}

export function gmClearActions() {
    if (roomSession() && !roomIsGm()) return;
    if (!gm.actions.length) return;
    if (!confirm("清空本回合所有玩家行动？")) return;
    gm.actions = [];
    saveGm();
    gmLog("🗑 已清空行动队列");
    renderGmPanel();
}

// 回合结束前把行动写进日志并清空（主持人可回看这一回合发生了什么）
function archiveActionsToLog() {
    const list = gm.actions.filter(a => a && a.round === gm.round);
    gm.actions = gm.actions.filter(a => !(a && a.round === gm.round));
    if (!list.length) return;
    list.forEach(a => gm.log.push(`📝 第 ${gm.round} 回合 · ${a.charName}：${actionText(a)}`.slice(0, 200)));
    if (gm.log.length > 60) gm.log = gm.log.slice(-60);
}

// ---------- 统一回合结算 ----------
// 单个参战单位的回合结算：就地修改传入的角色卡对象（不落盘、不推送）。
// 返回 { changed: 是否值得写回, lines: 本次日志片段, formPct: 形态 HP%（仅形态接管时） }。
// opts.isComp / opts.ownerId 由本地随从传入；远端玩家角色卡按普通主角处理。
function tickCharData(data, opts = {}) {
    const none = { changed: false, lines: [], formPct: null };
    if (!data || typeof data !== "object") return none;
    const isComp = opts.isComp === true;
    const snap = isComp ? null : computeSnapshotWithOwner(data);
    if (!isComp && (!snap || !snap.total)) return none;
    const cc = isComp ? computeCompanion({ ...data, ownerId: data.ownerId || "" }) : null;
    const maxHp = Math.max(1, isComp ? cc.maxHp : snap.total.maxHp);
    const maxMp = Math.max(1, isComp ? cc.maxMp : snap.total.maxMp);
    // 回合计数每轮都会 +1，但单独一个计数不算「有内容变化」（远端按需写回时用）
    const snapOfData = (o) => {
        const c = { ...o };
        delete c.combatRounds;
        if (!Array.isArray(c.buffs)) c.buffs = [];
        return JSON.stringify(c);
    };
    const beforeRaw = snapOfData(data);
    const beforeRounds = Number(data.combatRounds) || 0;
    let hpSum = 0, mpSum = 0;
    const barSums = new Map();
    const notes = [];
    (Array.isArray(data.buffs) ? data.buffs : []).forEach(bf => {
        const nb = normalizeBuff(bf);
        hpSum += nb.hpPerRound;
        mpSum += nb.mpPerRound;
        if (nb.hpPerRound || nb.mpPerRound) {
            notes.push(`${nb.name || "Buff"} ${nb.hpPerRound ? `HP${nb.hpPerRound > 0 ? "+" : ""}${nb.hpPerRound}` : ""}${nb.mpPerRound ? ` MP${nb.mpPerRound > 0 ? "+" : ""}${nb.mpPerRound}` : ""}`.trim());
        }
    });
    (Array.isArray(data.extraMods) ? data.extraMods : []).forEach(m => {
        if (!m || m.enabled === false) return;
        const p = (m.passive && typeof m.passive === "object") ? m.passive : {};
        const hp = clampInt(p.hpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
        const mp = clampInt(p.mpPerRound, LIMITS.buffTick[0], LIMITS.buffTick[1], 0);
        if (!hp && !mp) return;
        hpSum += hp; mpSum += mp;
        notes.push(`${m.name || "修正"} ${hp ? `HP${hp > 0 ? "+" : ""}${hp}` : ""}${mp ? ` MP${mp > 0 ? "+" : ""}${mp}` : ""}`.trim());
    });
    // 形态接管本体时（本体已被隐藏、不结算），形态要正常吃每回合回复，最后再把 HP% 写回本体
    const ownerId = isComp ? (opts.ownerId || data.ownerId || "") : "";
    const ownerReplaced = !!ownerId && isReplacedOwner(ownerId);
    const syncHp = isComp && data.mode === "hero" && data.hpSync === true && !ownerReplaced;
    const beforeHp = clampNum(isComp ? cc.hp : data.hp, 0, maxHp, 0);
    const beforeMp = clampNum(isComp ? cc.mp : data.mp, 0, maxMp, 0);
    data.hp = syncHp ? beforeHp : clampNum(beforeHp + hpSum, 0, maxHp, 0);
    data.mp = clampNum(beforeMp + mpSum, 0, maxMp, 0);
    const expired = [];
    data.buffs = (Array.isArray(data.buffs) ? data.buffs : []).filter(bf => {
        if (!bf || typeof bf !== "object") return false;
        const r = clampInt(bf.round, LIMITS.round[0], LIMITS.round[1], 0);
        if (r <= 0) return true;
        bf.round = r - 1;
        if (bf.round <= 0) { expired.push(bf.name || "Buff"); return false; }
        return true;
    });
    // 状态每回合改自定义条
    (Array.isArray(data.buffs) ? data.buffs : []).forEach(bf => {
        const nb = normalizeBuff(bf);
        const bn = barNameOf(nb.barName);
        const delta = clampInt(nb.barPerRound, LIMITS.customVal[0], LIMITS.customVal[1], 0);
        if (bn && delta) barSums.set(bn, (barSums.get(bn) || 0) + delta);
    });
    barSums.forEach((delta, name) => {
        const r = adjustCustomBar(data, name, delta);
        if (r) notes.push(`${name}${delta > 0 ? "+" : ""}${delta} → ${r.after}`);
    });
    // 大招条：回合结束涨值（负数即倒扣）
    const gainRound = applyBarGain(data, "round");
    gainRound.gained.forEach(g => notes.push(g));
    if (gainRound.added.length) notes.push(`触发：${gainRound.added.join("、")}`);
    if (gainRound.removed.length) notes.push(`失效：${gainRound.removed.join("、")}`);
    // 条值联动：满值/归零触发状态；存续条件不满足时自动失效
    const linkRes = syncBarLinks(data);
    if (linkRes.added.length) notes.push(`触发：${linkRes.added.join("、")}`);
    if (linkRes.removed.length) notes.push(`失效：${linkRes.removed.join("、")}`);
    data.combatRounds = clampInt((Number(data.combatRounds) || 0) + 1, 0, 999999, 0);
    const hasAuto = (Array.isArray(data.extraMods) ? data.extraMods : []).some(m => m && m.enabled !== false && m.passive && m.passive.autoAttack === true);
    let autoText = "";
    if (hasAuto) {
        const foe = gm.enemies.find(e => e.hp > 0);
        const dmg = Math.max(0, Math.floor(isComp ? (cc.damage || 0) : (snap.total.damage || 0)));
        if (foe && dmg > 0) {
            foe.hp = clampNum(Math.max(0, foe.hp - dmg), 0, Math.max(1, foe.maxHp), 0);
            autoText = `自动攻击 ${foe.name} -${dmg}（剩余 ${foe.hp}/${foe.maxHp}）`;
        }
    }
    if (syncHp) {
        const owner = ownerId ? loadRawChar(ownerId) : null;
        const ownerSnap = owner ? computeSnapshotWithOwner(owner) : null;
        if (ownerSnap && ownerSnap.total.maxHp > 0) {
            const pct = clampNum(owner.hp, 0, ownerSnap.total.maxHp, 0) / ownerSnap.total.maxHp;
            data.hp = clampNum(Math.round(pct * maxHp), 0, maxHp, 0);
        }
    }
    const formPct = (isComp && ownerReplaced && data.mode === "hero" && data.hpSync === true)
        ? clampNum(data.hp, 0, maxHp, 0) / maxHp
        : null;
    const parts = [];
    if (data.hp !== beforeHp) parts.push(`HP ${beforeHp}→${data.hp}`);
    if (data.mp !== beforeMp) parts.push(`MP ${beforeMp}→${data.mp}`);
    if (notes.length) parts.push(notes.join("，"));
    if (expired.length) parts.push(`到期：${expired.join("、")}`);
    if (autoText) parts.push(autoText);
    const afterRaw = snapOfData(data);
    // 有依赖 combatRounds 的被动（自动攻击 / 每 N 回合闪避）时，计数本身也必须写回
    const roundsMatter = Number(data.combatRounds) !== beforeRounds
        && (Array.isArray(data.extraMods) ? data.extraMods : []).some(m => {
            if (!m || m.enabled === false || !m.passive) return false;
            return m.passive.autoAttack === true || clampInt(m.passive.dodgeEvery, 0, 999, 0) > 0;
        });
    return { changed: beforeRaw !== afterRaw || !!autoText || roundsMatter, lines: parts, formPct };
}

// 所有参战单位（主角 + 参战随从）：Buff/被动每回合回复、Buff 回合递减、被动自动攻击、回合计数；
// 房间里还有其他人时，房主顺便把远端玩家的完整卡也结算一遍（不写本地 charList）。
export async function gmTickRound() {
    const targets = [];
    heroes().forEach(h => targets.push({ id: h.id, kind: "hero", ownerId: "" }));
    companionUnits().forEach(u => {
        if (u.cc.combat === true) targets.push({ id: u.meta.id, kind: "companion", ownerId: u.meta.ownerId || u.data.ownerId || "" });
    });
    const lines = [];
    const ownerPct = new Map(); // 形态接管：ownerId -> [形态 HP%]
    targets.forEach(t => {
        const data = loadRawChar(t.id);
        if (!data) return;
        const isComp = t.kind === "companion";
        const r = tickCharData(data, { isComp, ownerId: isComp ? (t.ownerId || "") : "" });
        // 本地随从被打到 0 血：本回合结算后直接退出参战（主角的 outOfCombat 不动）
        const dropped = isComp ? dropDeadCompanion(data) : false;
        if ((!r || !r.changed) && !dropped) return;
        saveCharAndSync(t.id, data);
        if (r.formPct != null) {
            const oid = t.ownerId || "";
            if (!ownerPct.has(oid)) ownerPct.set(oid, []);
            ownerPct.get(oid).push(r.formPct);
        }
        if (r.lines.length) lines.push(`${data.name || "角色"}${isComp ? "（随从）" : ""}：${r.lines.join("；")}`);
    });
    // 多个形态（分裂）同时存在时取平均 HP%，再写回本体；单个形态就等于原样同步
    ownerPct.forEach((list, oid) => {
        const owner = loadRawChar(oid);
        if (!owner) return;
        const osnap = computeSnapshotWithOwner(owner);
        if (!osnap || !(osnap.total.maxHp > 0)) return;
        const omax = Math.max(1, osnap.total.maxHp);
        const pct = list.reduce((a, b) => a + b, 0) / list.length;
        owner.hp = clampNum(Math.round(pct * omax), 0, omax, 0);
        saveCharAndSync(oid, owner);
    });
    // 远端玩家：服务端只有完整卡，结算必须拉卡 → 改 → 推回；逐个 await，单个失败只跳过
    if (roomSession() && roomIsGm()) {
        const me = String(roomMyMemberId() || "");
        const remotes = (roomSnapshot()?.members || [])
            .filter(m => m && m.id && String(m.id) !== me && m.hasFull !== false);
        for (const m of remotes) {
            try {
                const full = await globalThis.roomFetchChar?.(String(m.id));
                if (!full || typeof full !== "object") continue;
                const r = tickCharData(full, { isComp: false, ownerId: "" });
                if (!r || !r.changed) continue;
                const ok = await globalThis.roomPushCharTo?.(String(m.id), full, "hp");
                if (ok) gmLog(`⏱ ${m.char && m.char.name ? m.char.name : (m.name || "玩家")}：${(r.lines || []).join("；") || "回合结算"}`);
            } catch (e) { /* 单个远端成员失败不影响整轮结算 */ }
        }
    }
    if (lines.length) gmLog(lines.join(" ｜ "));
    saveGm();
    const touched = new Set(targets.map(t => t.id));
    ownerPct.forEach((list, oid) => touched.add(oid));
    if (touched.has(activeCharId)) loadActiveCharacter();
    renderGmPanel();
}

// ---------- 回合 / 笔记 ----------
export function gmSetRound(value) {
    gm.round = clampInt(value, 1, 999999, 1);
    saveGm();
    const el = document.getElementById("gmRound");
    if (el) el.value = gm.round;
}

export function gmNextRound() {
    archiveActionsToLog(); // 玩家行动先入日志，再进入下一回合
    const rollCount = gm.rolls.filter(r => r && r.round === gm.round).length;
    gm.round = clampInt(gm.round + 1, 1, 999999, 1);
    gm.rolls = []; // 投骰记录只保留当前回合
    saveGm();
    gmLog(`—— 第 ${gm.round} 回合 ——`);
    if (rollCount) gmLog(`🎲 上一回合共 ${rollCount} 次投掷`);
    // 回合结算现在可能等待远端玩家写卡：不阻塞按钮，也不制造未捕获 rejection
    void gmTickRound().catch(() => { });
}

export function gmResetRound() {
    gm.round = 1;
    gm.actions = [];
    gm.rolls = [];
    saveGm();
    gmLog("—— 回合重置 ——");
    renderGmPanel();
}

export function gmSetNote(value) {
    gm.note = String(value || "").slice(0, 20000);
    saveGm();
}

export function clearGmLog() {
    gm.log = [];
    saveGm();
    renderGmLog();
}