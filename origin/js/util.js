// === 通用小工具 ===
import { LIMITS, clampInt, clampNum, FINAL_MIN, FINAL_MAX } from "./limits.js";

export function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
export function rollOne(sides) { return Math.floor(Math.random() * clampInt(sides, LIMITS.diceSides[0], LIMITS.diceSides[1], 6)) + 1; }

export function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

export function mod(v) { return Math.floor((clampNum(v, FINAL_MIN, FINAL_MAX, 0) - 10) / 2); }
