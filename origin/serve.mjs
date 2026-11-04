// 本地开发服务器：禁用浏览器缓存，避免改完代码后仍加载旧模块（ESM 会被浏览器缓存）
// 用法：node serve.mjs [端口]，默认 8080，然后打开 http://localhost:8080
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2]) || 8080;
const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    ".mp3": "audio/mpeg", ".wav": "audio/wav"
};

const server = http.createServer(async (req, res) => {
    try {
        const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
        const full = normalize(join(root, rel));
        if (!full.startsWith(normalize(root))) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Forbidden");
            return;
        }
        const data = await readFile(full);
        res.writeHead(200, {
            "Content-Type": types[extname(full).toLowerCase()] || "application/octet-stream",
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        });
        res.end(data);
    } catch (e) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("404 Not Found");
    }
});

server.listen(port, () => {
    console.log(`JigeRPG 开发服务器已启动（已禁用缓存）：http://localhost:${port}`);
});