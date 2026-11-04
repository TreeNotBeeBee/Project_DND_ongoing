# 共同指令：把指派文件转为 ESM

目标：把这些 JS 文件从「平铺全局」改为真正的 ESM：每个文件在顶部补 `import`（引用它所用到的、定义在其它 js 模块里的符号），并把自身所有顶层声明改成 `export`（顶层 `function`→`export function`，顶层 `let`/`const`→`export let`/`export const`）。

## 硬规则
1. **只编辑指派给你的文件**，绝对不碰任何其它 js 文件、不碰 index.html。
2. **不改变任何业务逻辑、函数体、字符串模板、DOM 操作**。仅在文件顶部加 `import`；仅在函数/变量定义处加 `export` 关键字；不重命名任何符号。
3. **全部加 `export`**：文件中每一个顶层 `function`、`let`、`const` 都要加 `export`（即使你认为没人用）。
4. 保留同一个文件内原有的相对 `import`（例如 compute.js 已有的 limits/core/state/util/bonus/aggregate imports），只新增缺失的。
5. import 路径写法：`import { a, b } from "./xxx.js";`
6. 若引用来自这些模块，按需 import：state.js(`d,charList,activeCharId,lastSnap`) / util.js(`esc,rollOne,makeId,mod`) / limits.js(`LIMITS,FINAL_MIN,FINAL_MAX,nativeNumLimits,clampNum,clampInt`) / core.js(`charBase,slots,catText,nativeFields,statKeys,statCn,bonusKeys,bonusCn,resistKeys,resistCn,buffTypeKeys,buffTypeCn,buffTypeIcon,buffTypeColor,normalizeBuffType,normalizeBuff,buffTickText`) / bonus.js / aggregate.js(`aggregateBonuses`) / compute.js / display.js / companion.js / persist.js / sanitize.js / stats_ui.js / companion_ui.js / items_gear_ui.js / skills_buffs.js / combat_dice.js / modal_misc.js。
   完整导出名见 `.slim/deepwork/esm-migration/export-map.md`。
7. 循环导入在 ESM 允许（只用函数体、无顶层 side-effect）。不用拆。
8. 每个文件只 import 你实际用到的符号；不要 import 整个 `*`。

## 完成时报告
- 列出改动的文件。
- 说明每个文件加了哪些 import、哪些 `export`。
- 明确哪一处你可能需要别的 lane 先导出某符号（我会在 reconcile 阶段核对）。
- 你无法运行（非浏览器），不要声称已验证运行，只保证「语法上看 import/export 与引用一致」。

## 验收证据（给 reconcile 用）
- 修改后文件顶部 import 块、以及导出声明。
