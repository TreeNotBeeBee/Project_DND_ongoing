// === 主持人「镜像角色」===
// 主持人把玩家的完整角色卡拉到本地，存成一条独立的角色记录（id 稳定可重复写入），
// 改完再推回服务端。镜像不属于玩家自己的角色列表语义：UI 可以用 isMirrorMeta() 过滤，
// 只让它在主持人队伍看板里出现。
// 只依赖 state / persist 的少量接口，不碰 DOM。
import { charList, activeCharId, setCharList, setActiveCharId } from "./state.js";
import { saveCharListMeta, loadRawChar, loadActiveCharacter } from "./persist.js";

const PREFIX = "__gm_remote_";

/** 镜像角色的存档 id：同一个房间 + 同一个成员永远落到同一条记录 */
export function mirrorCharId(code, memberId) {
    return PREFIX + String(code || "") + "_" + String(memberId || "");
}

/** 镜像角色在角色列表里的元信息（名字带 🎭 只加在显示名上，不动 d.name） */
export function mirrorMeta(code, memberId, name) {
    const n = String(name || "").trim() || "玩家";
    return {
        id: mirrorCharId(code, memberId),
        name: "🎭 " + n,
        icon: "🎭",
        type: "hero",
        remoteMirror: { code: String(code || ""), memberId: String(memberId || ""), name: n }
    };
}

export function isMirrorId(id) {
    return String(id || "").startsWith(PREFIX);
}

/** UI 过滤用：角色列表项 / 角色数据是否是镜像 */
export function isMirrorMeta(meta) {
    if (!meta || typeof meta !== "object") return false;
    if (meta.remoteMirror && typeof meta.remoteMirror === "object") return true;
    return isMirrorId(meta.id);
}

/** 读镜像归属信息：优先角色列表 meta，其次读存档里的 remoteMirror */
export function mirrorInfo(id) {
    const mid = String(id || "");
    if (!mid) return null;
    const meta = (Array.isArray(charList) ? charList : []).find((m) => m && m.id === mid);
    if (meta && meta.remoteMirror && typeof meta.remoteMirror === "object") {
        return {
            code: String(meta.remoteMirror.code || ""),
            memberId: String(meta.remoteMirror.memberId || ""),
            name: String(meta.remoteMirror.name || "")
        };
    }
    const data = loadRawChar(mid);
    if (data && data.remoteMirror && typeof data.remoteMirror === "object") {
        return {
            code: String(data.remoteMirror.code || ""),
            memberId: String(data.remoteMirror.memberId || ""),
            name: String(data.remoteMirror.name || "")
        };
    }
    return null;
}

/**
 * 保存/更新一张镜像角色卡。
 * char 会被深拷贝，d.name 保留玩家原始角色名，只有列表显示名加 🎭。
 * 同一个 memberId 反复保存只会更新同一条记录。返回镜像角色 id（写入失败返回 ""）。
 */
export function saveMirror(code, memberId, name, char) {
    const c = String(code || "");
    const m = String(memberId || "");
    if (!c || !m || !char || typeof char !== "object") return "";
    const id = mirrorCharId(c, m);
    let data;
    try {
        data = JSON.parse(JSON.stringify(char));
    } catch (e) {
        return "";
    }
    if (!data || typeof data !== "object") return "";
    const displayName = String(name || "").trim() || String(char.name || "").trim() || "玩家";
    data.id = id;
    data.name = String(char.name || "").trim() || displayName; // 原始角色名，不加 🎭
    data.remoteMirror = { code: c, memberId: m, name: displayName };
    try {
        localStorage.setItem("jigerpg_char_" + id, JSON.stringify(data));
    } catch (e) {
        return "";
    }
    const list = (Array.isArray(charList) ? charList : []).slice();
    const meta = mirrorMeta(c, m, displayName);
    const at = list.findIndex((x) => x && x.id === id);
    if (at >= 0) list[at] = { ...list[at], ...meta };
    else list.push(meta);
    setCharList(list);
    try { saveCharListMeta(); } catch (e) { /* 隐私模式忽略 */ }
    return id;
}

/** 删除镜像角色：存档 + 列表项一起清；正开着就切回第一个非镜像角色 */
export function dropMirror(id) {
    const mid = String(id || "");
    if (!mid) return false;
    const list = (Array.isArray(charList) ? charList : []).filter((x) => !(x && x.id === mid));
    setCharList(list);
    try { saveCharListMeta(); } catch (e) { /* ignore */ }
    try { localStorage.removeItem("jigerpg_char_" + mid); } catch (e) { /* ignore */ }
    if (activeCharId === mid) {
        const next = list.find((x) => x && !isMirrorMeta(x)) || list[0] || null;
        if (next) {
            setActiveCharId(next.id);
            try { loadActiveCharacter(); } catch (e) { /* ignore */ }
        } else {
            setActiveCharId(null);
        }
    }
    return true;
}