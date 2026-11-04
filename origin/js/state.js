// === 共享可变状态 ===
// 通过 ES Module 的实时绑定共享给所有模块。任何模块对 d / charList / activeCharId /
// lastSnap 的重新赋值都要通过下面的 setter（ESM 不允许给 import 进来的绑定直接赋值），
// 其它 import 到它的模块会实时看到最新值。
export let d = null;
export let charList = [];
export let activeCharId = null;
export let lastSnap = null;

export function setD(v) { d = v; }
export function setCharList(v) { charList = v; }
export function setActiveCharId(v) { activeCharId = v; }
export function setLastSnap(v) { lastSnap = v; }