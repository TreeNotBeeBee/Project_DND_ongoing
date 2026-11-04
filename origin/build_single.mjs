// 生成可双击运行的单文件版本：node build_single.mjs
// 原理：把所有 ES Module 按依赖顺序去掉 import/export 后拼进一个普通 <script>
// （普通脚本不受 file:// 的模块 CORS 限制），CSS 也内联进 <style>。
// 输出：JigeRPG.html（与本文件同目录，双击即可打开）
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const jsDir = root + "js/";

// 依赖顺序（被依赖的在前；循环引用靠函数声明提升，调用发生在 init() 时）
const ORDER = [
    "limits", "util", "core", "bar_link", "state", "bonus", "aggregate", "compute", "display",
    "companion", "sanitize", "persist", "stats_ui", "companion_ui", "items_gear_ui",
    "skills_buffs", "combat_dice", "modal_misc", "gm_ui", "room", "room_ui", "init"
];

function stripModuleSyntax(src, name) {
    let s = src;
    s = s.replace(/^import\b[^;]*;/gm, "");          // 去掉 import 语句
    s = s.replace(/^export\s*\{[^}]*\};?\s*$/gm, ""); // 去掉 export { ... }
    s = s.replace(/^export\s+/gm, "");                // export function/const/let/class -> 普通声明
    if (/^\s*import\b/m.test(s) || /^\s*export\b/m.test(s)) {
        throw new Error("仍有未处理的 import/export：" + name);
    }
    return s.trim();
}

const parts = ORDER.map(name => {
    const file = jsDir + name + ".js";
    if (!fs.existsSync(file)) throw new Error("缺少模块文件：" + file);
    const code = stripModuleSyntax(fs.readFileSync(file, "utf8"), name);
    return `// ==== ${name}.js ====\n${code}`;
});

const bundle = [
    "// 本文件由 build_single.mjs 自动生成，请勿手工修改；源码在 js/ 目录。",
    ...parts,
    "// ==== 把共享状态暴露到全局，兼容内联 onclick/onchange（与模块版 bridge.js 行为一致） ====",
    `(function () {
    var expose = function (name, get, set) {
        Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, get: get, set: set });
    };
    expose("d", function () { return d; }, function (v) { d = v; });
    expose("charList", function () { return charList; }, function (v) { charList = v; });
    expose("activeCharId", function () { return activeCharId; }, function (v) { activeCharId = v; });
    expose("lastSnap", function () { return lastSnap; }, function (v) { lastSnap = v; });
})();`,
    "// ==== 启动 ====",
    "init();",
    "initGmPanel();"
].join("\n\n");

let html = fs.readFileSync(root + "index.html", "utf8");

// 1) CSS 内联
const css = fs.readFileSync(root + "css/main.css", "utf8");
if (html.includes('<link rel="stylesheet" href="css/main.css">')) {
    html = html.replace('<link rel="stylesheet" href="css/main.css">', "<style>\n" + css + "\n</style>");
} else {
    throw new Error("index.html 中找不到 main.css 的 link 标签");
}

// 2) 去掉“启动自检”脚本和模块入口脚本，换成内联 bundle
const markIdx = html.indexOf("<!-- 启动自检");
if (markIdx < 0) throw new Error("index.html 中找不到启动自检标记");
const head = html.slice(0, markIdx);
html = head + "<script>\n" + bundle + "\n</script>\n</body>\n</html>\n";

// 3) 输出
const out = root + "JigeRPG.html";
fs.writeFileSync(out, html, "utf8");
console.log("已生成：" + out);
console.log("大小：" + (fs.statSync(out).size / 1024).toFixed(1) + " KB，模块数：" + ORDER.length);