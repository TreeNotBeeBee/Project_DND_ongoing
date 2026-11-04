# Progress — 全部改为 ESM 格式

status: done
slug: esm-migration

## 任务
把 E:\JigeRPG\src 的 JS 文件 + index.html 从「经典 <script src> 平铺全局」改造为真正的 ESM（`import`/`export` + `<script type="module">`）。
关键难点：index.html 大量 inline onclick/onchange 依赖全局函数；ESM 模块作用域不暴露给全局。

## 方案（已实施）
- 每个模块 `import` 实际用到的符号，`export` 自己的顶层声明。
- 共享状态 `d / charList / activeCharId / lastSnap` 放在 `state.js`：`export let` + `setD/setCharList/setActiveCharId/setLastSnap`（ESM 不允许给 import 的绑定直接赋值）。
- 新增 `bridge.js` 作为公共 API 桥：用 `Object.assign(globalThis, ...)` 暴露所有模块导出，并用 getter/setter 暴露共享状态；末尾调用 `init()`。
- `index.html` 改为单一 `<script type="module" src="js/bridge.js"></script>`。

## 完成内容
- 新建：`state.js`、`limits.js`、`util.js`、`bridge.js`（此前已拆分）。
- 已转 ESM 并补全 import/export：core, bonus, aggregate, compute, display, companion, sanitize, persist, stats_ui, companion_ui, items_gear_ui, skills_buffs, combat_dice, modal_misc, init。
- persist.js 新增：`loadRawChar`、`saveRawChar`、`migrateHeroCompanions`、`createCompanion`；随从改为 charList 里的独立角色记录（type=companion, ownerId）。
- 删除主角时会连带删除其名下随从；角色下拉框用 🐾 标记随从。

## 验证
- `node` + 模拟 DOM 冒烟测试（18 项：初始化、存档、物品、快捷栏、技能、Buff、种族/等级、骰子/战斗、自定义机制、随从全流程、删除/导出）全部通过。
- 静态检查：所有跨模块符号均已 import；无残留 `$$$`；无乱码。

## 注意
- 浏览器的 ES Module 不能通过 `file://` 直接打开（CORS 限制），需用本地静态服务器（如 `python -m http.server` 或 `npx serve`）访问。