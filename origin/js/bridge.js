// === 公共 API 桥 ===
// index.html 与模块动态生成的 HTML 里大量使用 inline onclick/onchange，
// 这些处理器在全局作用域执行，因此把所有模块的导出函数挂到 globalThis。
// d / charList / activeCharId / lastSnap 用 getter/setter 暴露，保证 inline 代码
// 读写到的是 state.js 里的同一份实时数据。
import * as state from "./state.js";
import * as limits from "./limits.js";
import * as util from "./util.js";
import * as core from "./core.js";
import * as bonus from "./bonus.js";
import * as barLink from "./bar_link.js";
import * as aggregate from "./aggregate.js";
import * as compute from "./compute.js";
import * as display from "./display.js";
import * as companion from "./companion.js";
import * as sanitize from "./sanitize.js";
import * as persist from "./persist.js";
import * as statsUi from "./stats_ui.js";
import * as companionUi from "./companion_ui.js";
import * as itemsUi from "./items_gear_ui.js";
import * as skillsBuffs from "./skills_buffs.js";
import * as combatDice from "./combat_dice.js";
import * as modalMisc from "./modal_misc.js";
import * as gmUi from "./gm_ui.js";
import * as initModule from "./init.js";
import * as room from "./room.js";
import * as mirror from "./mirror.js";
import * as roomUi from "./room_ui.js";
import * as charManage from "./char_manage.js";

// 共享状态：实时 getter/setter（inline 处理器可读写全局 d）
for (const key of ["d", "charList", "activeCharId", "lastSnap"]) {
    const setter = "set" + key.charAt(0).toUpperCase() + key.slice(1);
    Object.defineProperty(globalThis, key, {
        configurable: true,
        enumerable: true,
        get: () => state[key],
        set: (v) => state[setter](v)
    });
}

Object.assign(globalThis,
    limits, util, core, bonus, barLink, aggregate, compute, display, companion,
    sanitize, persist, statsUi, companionUi, itemsUi, skillsBuffs,
    combatDice, modalMisc, gmUi, initModule,
    room, mirror, roomUi, charManage
);

// 模块加载完成、全局 API 就绪后再初始化界面
// 标记桥接成功：index.html 里的启动自检据此判断模块是否真的跑起来了
window.__jigeBooted = true;
initModule.init();
gmUi.initGmPanel();